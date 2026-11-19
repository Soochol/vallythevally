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
    notes_sent: bool,
}

#[derive(Default)]
struct Ledger {
    date: u32,
    announced: BTreeSet<AlertKind>,
    suppressed: BTreeMap<AlertKind, usize>,
    notes: Vec<String>,
    notes_sent: bool,
    notes_sent_before_start: bool,
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
        Ledger { date: sent.date, announced: sent.announced, notes_sent: sent.notes_sent, notes_sent_before_start: sent.notes_sent, ..Ledger::default() }
    }

    fn sent_today(&self) -> SentToday {
        SentToday { date: self.date, announced: self.announced.clone(), notes_sent: self.notes_sent }
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

    fn notes_text(&mut self) -> Option<String> {
        let notes = std::mem::take(&mut self.notes);
        (!notes.is_empty()).then(|| {
            self.notes_sent = true;
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
            if !self.notes_sent_before_start {
                self.notes.push(alert.message.clone());
            }
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
    file: Arc<LedgerFile>,
    outbox: mpsc::UnboundedSender<String>,
}

impl AlertWebhook {
    pub fn spawn(webhook: Webhook, state_folder: &Path) -> AlertWebhook {
        let (outbox, mut inbox) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(text) = inbox.recv().await {
                if let Err(failure) = webhook.send(&text).await {
                    tracing::warn!(%failure, "수집 경보를 웹훅으로 보내지 못했습니다");
                }
            }
        });
        let file = LedgerFile::in_folder(state_folder);
        AlertWebhook { ledger: Arc::new(Mutex::new(Ledger::restored(file.load()))), file: Arc::new(file), outbox }
    }

    fn with_ledger(&self, change: impl FnOnce(&mut Ledger) -> Option<String>) -> Option<String> {
        let mut ledger = self.ledger.lock().expect("웹훅 장부 잠금");
        let before = ledger.sent_today();
        let text = change(&mut ledger);
        let after = ledger.sent_today();
        if after != before {
            self.file.save(&after);
        }
        text
    }

    fn deliver(&self, text: Option<String>) {
        if let Some(text) = text {
            let _ = self.outbox.send(text);
        }
    }

    pub(super) fn alert(&self, date: u32, alert: &Alert) {
        let text = self.with_ledger(|ledger| ledger.offer(date, alert));
        self.deliver(text);
    }

    pub(super) fn flush_notes(&self, date: u32) {
        let text = self.with_ledger(|ledger| ledger.flush_notes(date));
        self.deliver(text);
    }

    pub(super) fn close_day(&self, date: u32) {
        let text = self.with_ledger(|ledger| ledger.close_day(date));
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
    fn a_restarted_day_does_not_announce_the_kinds_and_notes_it_already_sent() {
        let folder = tempfile::tempdir().unwrap();
        let file = LedgerFile::in_folder(folder.path());
        let mut first = Ledger::restored(file.load());
        assert!(first.offer(DATE, &alert(AlertKind::StageFailed, "하나")).is_some());
        first.offer(DATE, &alert(AlertKind::PlanNote, "메모"));
        assert!(first.flush_notes(DATE).is_some());
        file.save(&first.sent_today());
        let mut second = Ledger::restored(file.load());
        assert_eq!(second.offer(DATE, &alert(AlertKind::StageFailed, "둘")), None);
        assert!(second.offer(DATE, &alert(AlertKind::KeyStopped, "새 종류")).is_some());
        second.offer(DATE, &alert(AlertKind::PlanNote, "메모"));
        assert_eq!(second.flush_notes(DATE), None);
        assert!(second.offer(DATE + 1, &alert(AlertKind::StageFailed, "다음 날")).is_some());
    }

    #[test]
    fn a_broken_or_unwritable_record_falls_back_to_sending() {
        let folder = tempfile::tempdir().unwrap();
        std::fs::write(folder.path().join(LEDGER_FILE), "{깨짐").unwrap();
        let mut ledger = Ledger::restored(LedgerFile::in_folder(folder.path()).load());
        assert!(ledger.offer(DATE, &alert(AlertKind::StageFailed, "하나")).is_some());
        let blocked = folder.path().join("파일");
        std::fs::write(&blocked, "").unwrap();
        LedgerFile::in_folder(&blocked).save(&ledger.sent_today());
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
