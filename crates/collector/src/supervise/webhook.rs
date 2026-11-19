use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use server::collector::webhook::Webhook;
use tokio::sync::mpsc;

use super::status::{Alert, AlertKind};

const LEDGER_FILE: &str = "webhook-ledger.json";

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SentToday {
    date: u32,
    announced: BTreeSet<AlertKind>,
    notes: BTreeSet<String>,
}

impl SentToday {
    fn record(&mut self, outgoing: &Outgoing) {
        if self.date != outgoing.date {
            *self = SentToday { date: outgoing.date, ..SentToday::default() };
        }
        self.announced.extend(outgoing.kind);
        self.notes.extend(outgoing.notes.iter().cloned());
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Outgoing {
    date: u32,
    text: String,
    kind: Option<AlertKind>,
    notes: Vec<String>,
}

#[derive(Default)]
struct Ledger {
    date: u32,
    announced: BTreeSet<AlertKind>,
    suppressed: BTreeMap<AlertKind, usize>,
    notes: Vec<String>,
    delivered_notes: BTreeSet<String>,
}

struct LedgerFile {
    path: PathBuf,
}

impl LedgerFile {
    fn in_folder(state_folder: &Path) -> LedgerFile {
        LedgerFile { path: state_folder.join(LEDGER_FILE) }
    }

    fn load(&self) -> SentToday {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return SentToday::default(),
            Err(error) => {
                tracing::warn!(path = %self.path.display(), %error, "웹훅 전송 기록을 읽지 못해 처음부터 시작합니다");
                return SentToday::default();
            }
        };
        serde_json::from_str(&text).unwrap_or_else(|error| {
            tracing::warn!(path = %self.path.display(), %error, "웹훅 전송 기록이 깨져 있어 처음부터 시작합니다");
            SentToday::default()
        })
    }

    fn save(&self, sent: &SentToday) {
        let written = serde_json::to_vec(sent).map_err(std::io::Error::other).and_then(|bytes| {
            if let Some(folder) = self.path.parent() {
                std::fs::create_dir_all(folder)?;
            }
            let temporary = self.path.with_extension("tmp");
            std::fs::write(&temporary, bytes)?;
            std::fs::rename(&temporary, &self.path)
        });
        if let Err(error) = written {
            tracing::warn!(path = %self.path.display(), %error, "웹훅 전송 기록을 남기지 못했습니다");
        }
    }
}

fn alert_line(alert: &Alert) -> String {
    let time = alert.at.get(11..19).unwrap_or(&alert.at);
    format!("[수집 경보] {time} KST · {} · {}", alert.kind.label(), alert.message)
}

impl Ledger {
    fn restored(sent: SentToday) -> Ledger {
        Ledger { date: sent.date, announced: sent.announced, delivered_notes: sent.notes, ..Ledger::default() }
    }

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

    fn notes_text(notes: &[String]) -> Option<String> {
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

    fn offer(&mut self, date: u32, alert: &Alert) -> Option<Outgoing> {
        self.roll_to(date);
        if alert.kind.is_note() {
            if !self.delivered_notes.contains(&alert.message) {
                self.notes.push(alert.message.clone());
            }
            return None;
        }
        if !self.announced.insert(alert.kind) {
            *self.suppressed.entry(alert.kind).or_default() += 1;
            return None;
        }
        let text = self.with_suppressed(alert_line(alert));
        Some(Outgoing { date, text, kind: Some(alert.kind), notes: Vec::new() })
    }

    fn flush_notes(&mut self, date: u32) -> Option<Outgoing> {
        self.roll_to(date);
        let notes = std::mem::take(&mut self.notes);
        let text = Ledger::notes_text(&notes)?;
        let text = self.with_suppressed(text);
        Some(Outgoing { date, text, kind: None, notes })
    }

    fn close_day(&mut self, date: u32) -> Option<Outgoing> {
        self.roll_to(date);
        let notes = std::mem::take(&mut self.notes);
        let parts: Vec<String> = [Ledger::notes_text(&notes), self.suppressed_line()].into_iter().flatten().collect();
        (!parts.is_empty()).then(|| Outgoing { date, text: format!("[수집 경보] {date}일 마감\n{}", parts.join("\n")), kind: None, notes })
    }
}

#[derive(Clone)]
pub struct AlertWebhook {
    ledger: Arc<Mutex<Ledger>>,
    outbox: mpsc::UnboundedSender<Outgoing>,
}

impl AlertWebhook {
    pub fn spawn(webhook: Webhook, state_folder: &Path) -> AlertWebhook {
        let (outbox, mut inbox) = mpsc::unbounded_channel::<Outgoing>();
        let file = LedgerFile::in_folder(state_folder);
        let mut delivered = file.load();
        let ledger = Arc::new(Mutex::new(Ledger::restored(delivered.clone())));
        tokio::spawn(async move {
            while let Some(outgoing) = inbox.recv().await {
                match webhook.send(&outgoing.text).await {
                    Ok(()) => {
                        delivered.record(&outgoing);
                        file.save(&delivered);
                    }
                    Err(failure) => tracing::warn!(%failure, "수집 경보를 웹훅으로 보내지 못했습니다"),
                }
            }
        });
        AlertWebhook { ledger, outbox }
    }

    fn ledger(&self) -> std::sync::MutexGuard<'_, Ledger> {
        self.ledger.lock().expect("웹훅 장부 잠금")
    }

    fn deliver(&self, outgoing: Option<Outgoing>) {
        if let Some(outgoing) = outgoing {
            let _ = self.outbox.send(outgoing);
        }
    }

    pub(super) fn alert(&self, date: u32, alert: &Alert) {
        let outgoing = self.ledger().offer(date, alert);
        self.deliver(outgoing);
    }

    pub(super) fn flush_notes(&self, date: u32) {
        let outgoing = self.ledger().flush_notes(date);
        self.deliver(outgoing);
    }

    pub(super) fn close_day(&self, date: u32) {
        let outgoing = self.ledger().close_day(date);
        self.deliver(outgoing);
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
        assert_eq!(first.text, "[수집 경보] 09:00:05 KST · 키 멈춤 · collect-01를 멈췄습니다");
        assert_eq!(ledger.offer(DATE, &alert(AlertKind::KeyStopped, "collect-02를 멈췄습니다")), None);
        assert_eq!(ledger.offer(DATE, &alert(AlertKind::KeyStopped, "collect-03를 멈췄습니다")), None);
        let next = ledger.offer(DATE, &alert(AlertKind::StageFailed, "정리 실패")).unwrap().text;
        assert!(next.ends_with("\n같은 종류 경보가 더 있었습니다: 키 멈춤 2건"), "{next}");
        assert_eq!(ledger.close_day(DATE), None);
    }

    #[test]
    fn what_is_left_over_is_sent_once_when_the_day_closes() {
        let mut ledger = Ledger::default();
        ledger.offer(DATE, &alert(AlertKind::StageFailed, "하나"));
        ledger.offer(DATE, &alert(AlertKind::StageFailed, "둘"));
        let closing = ledger.close_day(DATE).unwrap().text;
        assert!(closing.contains("단계 실패 1건"), "{closing}");
        assert_eq!(ledger.close_day(DATE), None);
    }

    fn deliver(file: &LedgerFile, sent: &mut SentToday, outgoing: &Outgoing) {
        sent.record(outgoing);
        file.save(sent);
    }

    #[test]
    fn a_restarted_day_does_not_announce_the_kinds_and_notes_that_were_delivered() {
        let folder = tempfile::tempdir().unwrap();
        let file = LedgerFile::in_folder(folder.path());
        let mut sent = file.load();
        let mut first = Ledger::restored(sent.clone());
        deliver(&file, &mut sent, &first.offer(DATE, &alert(AlertKind::StageFailed, "하나")).unwrap());
        first.offer(DATE, &alert(AlertKind::PlanNote, "메모"));
        deliver(&file, &mut sent, &first.flush_notes(DATE).unwrap());
        let mut second = Ledger::restored(file.load());
        assert_eq!(second.offer(DATE, &alert(AlertKind::StageFailed, "둘")), None);
        assert!(second.offer(DATE, &alert(AlertKind::KeyStopped, "새 종류")).is_some());
        second.offer(DATE, &alert(AlertKind::PlanNote, "메모"));
        assert_eq!(second.flush_notes(DATE), None);
        second.offer(DATE, &alert(AlertKind::PlanNote, "다시 시작한 뒤 새로 생긴 메모"));
        assert!(second.close_day(DATE).unwrap().text.contains("다시 시작한 뒤 새로 생긴 메모"));
        assert!(second.offer(DATE + 1, &alert(AlertKind::StageFailed, "다음 날")).is_some());
    }

    #[test]
    fn what_was_never_delivered_is_not_recorded_so_a_restart_sends_it_again() {
        let folder = tempfile::tempdir().unwrap();
        let file = LedgerFile::in_folder(folder.path());
        let mut sent = file.load();
        let mut first = Ledger::restored(sent.clone());
        deliver(&file, &mut sent, &first.offer(DATE, &alert(AlertKind::KeyStopped, "전달됨")).unwrap());
        first.offer(DATE, &alert(AlertKind::StageFailed, "큐에서 멈춤")).unwrap();
        let mut second = Ledger::restored(file.load());
        assert!(second.offer(DATE, &alert(AlertKind::StageFailed, "다시")).is_some());
        assert_eq!(second.offer(DATE, &alert(AlertKind::KeyStopped, "또")), None);
    }

    #[test]
    fn a_broken_or_unwritable_record_falls_back_to_sending() {
        let folder = tempfile::tempdir().unwrap();
        std::fs::write(folder.path().join(LEDGER_FILE), "{깨짐").unwrap();
        let mut ledger = Ledger::restored(LedgerFile::in_folder(folder.path()).load());
        let outgoing = ledger.offer(DATE, &alert(AlertKind::StageFailed, "하나")).unwrap();
        let blocked = folder.path().join("파일");
        std::fs::write(&blocked, "").unwrap();
        let mut sent = SentToday::default();
        deliver(&LedgerFile::in_folder(&blocked), &mut sent, &outgoing);
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
        let batch = ledger.flush_notes(DATE).unwrap().text;
        assert_eq!(batch, "[수집 계획] 알릴 내용 2건\n- 3종목 제외\n- 예비 키 없음");
        assert_eq!(ledger.flush_notes(DATE), None);
    }
}
