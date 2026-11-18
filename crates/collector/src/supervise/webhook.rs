use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use server::collector::webhook::Webhook;
use tokio::sync::mpsc;

use super::status::{Alert, AlertKind};

#[derive(Default)]
struct Ledger {
    date: u32,
    announced: BTreeSet<AlertKind>,
    suppressed: BTreeMap<AlertKind, usize>,
    notes: Vec<String>,
}

fn alert_line(alert: &Alert) -> String {
    let time = alert.at.get(11..19).unwrap_or(&alert.at);
    format!("[수집 경보] {time} KST · {} · {}", alert.kind.label(), alert.message)
}

impl Ledger {
    fn roll_to(&mut self, date: u32) {
        if self.date != date {
            *self = Ledger { date, ..Ledger::default() };
        }
    }

    fn suppressed_line(&mut self) -> Option<String> {
        let suppressed = std::mem::take(&mut self.suppressed);
        (!suppressed.is_empty()).then(|| {
            let counts: Vec<String> = suppressed.iter().map(|(kind, count)| format!("{} {count}건", kind.label())).collect();
            format!("같은 종류 경보가 더 있었습니다: {}", counts.join(", "))
        })
    }

    fn notes_text(&mut self) -> Option<String> {
        let notes = std::mem::take(&mut self.notes);
        (!notes.is_empty()).then(|| {
            let lines: Vec<String> = notes.iter().map(|note| format!("- {note}")).collect();
            format!("[수집 계획] 알릴 내용 {}건\n{}", notes.len(), lines.join("\n"))
        })
    }

    fn with_suppressed(&mut self, text: String) -> String {
        match self.suppressed_line() {
            Some(line) => format!("{text}\n{line}"),
            None => text,
        }
    }

    fn offer(&mut self, date: u32, alert: &Alert) -> Option<String> {
        self.roll_to(date);
        if alert.kind.is_note() {
            self.notes.push(alert.message.clone());
            return None;
        }
        if !self.announced.insert(alert.kind) {
            *self.suppressed.entry(alert.kind).or_default() += 1;
            return None;
        }
        Some(self.with_suppressed(alert_line(alert)))
    }

    fn flush_notes(&mut self, date: u32) -> Option<String> {
        self.roll_to(date);
        let text = self.notes_text()?;
        Some(self.with_suppressed(text))
    }

    fn close_day(&mut self, date: u32) -> Option<String> {
        self.roll_to(date);
        let parts: Vec<String> = [self.notes_text(), self.suppressed_line()].into_iter().flatten().collect();
        (!parts.is_empty()).then(|| format!("[수집 경보] {date}일 마감\n{}", parts.join("\n")))
    }
}

#[derive(Clone)]
pub struct AlertWebhook {
    ledger: Arc<Mutex<Ledger>>,
    outbox: mpsc::UnboundedSender<String>,
}

impl AlertWebhook {
    pub fn spawn(webhook: Webhook) -> AlertWebhook {
        let (outbox, mut inbox) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(text) = inbox.recv().await {
                if let Err(failure) = webhook.send(&text).await {
                    tracing::warn!(%failure, "수집 경보를 웹훅으로 보내지 못했습니다");
                }
            }
        });
        AlertWebhook { ledger: Arc::default(), outbox }
    }

    fn ledger(&self) -> std::sync::MutexGuard<'_, Ledger> {
        self.ledger.lock().expect("웹훅 장부 잠금")
    }

    fn deliver(&self, text: Option<String>) {
        if let Some(text) = text {
            let _ = self.outbox.send(text);
        }
    }

    pub(super) fn alert(&self, date: u32, alert: &Alert) {
        let text = self.ledger().offer(date, alert);
        self.deliver(text);
    }

    pub(super) fn flush_notes(&self, date: u32) {
        let text = self.ledger().flush_notes(date);
        self.deliver(text);
    }

    pub(super) fn close_day(&self, date: u32) {
        let text = self.ledger().close_day(date);
        self.deliver(text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DATE: u32 = 20261118;

    fn alert(kind: AlertKind, message: &str) -> Alert {
        Alert { at: "2026-11-18T09:00:05+09:00".to_owned(), kind, message: message.to_owned() }
    }

    #[test]
    fn a_kind_is_announced_once_a_day_and_the_extras_are_counted_into_the_next_message() {
        let mut ledger = Ledger::default();
        let first = ledger.offer(DATE, &alert(AlertKind::KeyStopped, "collect-01를 멈췄습니다")).unwrap();
        assert_eq!(first, "[수집 경보] 09:00:05 KST · 키 멈춤 · collect-01를 멈췄습니다");
        assert_eq!(ledger.offer(DATE, &alert(AlertKind::KeyStopped, "collect-02를 멈췄습니다")), None);
        assert_eq!(ledger.offer(DATE, &alert(AlertKind::KeyStopped, "collect-03를 멈췄습니다")), None);
        let next = ledger.offer(DATE, &alert(AlertKind::StageFailed, "정리 실패")).unwrap();
        assert!(next.ends_with("\n같은 종류 경보가 더 있었습니다: 키 멈춤 2건"), "{next}");
        assert_eq!(ledger.close_day(DATE), None);
    }

    #[test]
    fn what_is_left_over_is_sent_once_when_the_day_closes() {
        let mut ledger = Ledger::default();
        ledger.offer(DATE, &alert(AlertKind::StageFailed, "하나"));
        ledger.offer(DATE, &alert(AlertKind::StageFailed, "둘"));
        let closing = ledger.close_day(DATE).unwrap();
        assert!(closing.contains("단계 실패 1건"), "{closing}");
        assert_eq!(ledger.close_day(DATE), None);
    }

    #[test]
    fn a_new_day_announces_each_kind_again() {
        let mut ledger = Ledger::default();
        assert!(ledger.offer(DATE, &alert(AlertKind::StageFailed, "하나")).is_some());
        assert!(ledger.offer(DATE, &alert(AlertKind::StageFailed, "둘")).is_none());
        assert!(ledger.offer(DATE + 1, &alert(AlertKind::StageFailed, "셋")).is_some());
    }

    #[test]
    fn informational_kinds_wait_for_one_batched_message() {
        let mut ledger = Ledger::default();
        assert_eq!(ledger.offer(DATE, &alert(AlertKind::Excluded, "3종목 제외")), None);
        assert_eq!(ledger.offer(DATE, &alert(AlertKind::PlanNote, "예비 키 없음")), None);
        let batch = ledger.flush_notes(DATE).unwrap();
        assert_eq!(batch, "[수집 계획] 알릴 내용 2건\n- 3종목 제외\n- 예비 키 없음");
        assert_eq!(ledger.flush_notes(DATE), None);
    }
}
