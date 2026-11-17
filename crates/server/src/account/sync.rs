use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use setup::{Document, DocumentKind};
use tokio::sync::broadcast;
use tokio::time::Instant;

use super::client::{ClientError, PushStatus};
use super::state_file::Login;
use super::{AccountState, Linked, Refusal, lock, owner};
use crate::api::{InitialSyncChoice, SyncState, SyncStatus, UnixSeconds};
use crate::db::AppDb;
use crate::http::AppState;
use crate::setup_bundle::{self, Received};
use crate::sync_log::{self, Direction};

pub const PUSH_DOCUMENTS: usize = 500;
pub const PUSH_BYTES: usize = 7 * 1024 * 1024;
pub const PULL_PAGE: usize = 500;
pub const WRITE_QUIET: Duration = Duration::from_secs(5);
pub const PULL_EVERY: Duration = Duration::from_secs(5 * 60);
pub const RETRY_FIRST: Duration = Duration::from_secs(5);
pub const RETRY_LAST: Duration = Duration::from_secs(5 * 60);
const APPLY_PASSES: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    PushOnly,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Synced,
    NeedsChoice,
}

#[derive(Clone, Default)]
struct Memory {
    last_success: Option<UnixSeconds>,
    last_error: Option<&'static str>,
    needs_choice: Option<(i64, i64)>,
}

pub struct Sync {
    memory: Mutex<Memory>,
    cycle: tokio::sync::Mutex<()>,
    setup_changes: broadcast::Sender<Vec<DocumentKind>>,
}

impl Default for Sync {
    fn default() -> Self {
        Sync { memory: Mutex::new(Memory::default()), cycle: tokio::sync::Mutex::new(()), setup_changes: broadcast::channel(16).0 }
    }
}

#[derive(Default)]
struct Report {
    applied: Vec<DocumentKind>,
    touched: bool,
}

impl Report {
    fn applied(&mut self, kind: DocumentKind) {
        self.touched = true;
        if !self.applied.contains(&kind) {
            self.applied.push(kind);
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Upload {
    Plain,
    OverTombstones,
    ReplaceAccount,
}

enum Initial {
    Done,
    Choice,
}

fn storage(error: impl std::fmt::Display) -> Refusal {
    tracing::error!(%error, "동기화 기록을 읽거나 쓰지 못했습니다");
    Refusal::Storage
}

fn error_code(refusal: &Refusal) -> Option<&'static str> {
    match refusal {
        Refusal::ServerUnavailable(ClientError::Unreachable) => Some("unreachable"),
        Refusal::ServerUnavailable(ClientError::Rejected(_)) => Some("rejected"),
        Refusal::ServerUnavailable(ClientError::Malformed) => Some("malformed"),
        Refusal::Storage => Some("storage"),
        _ => None,
    }
}

fn retry_delay(failures: u32) -> Duration {
    RETRY_FIRST.saturating_mul(1u32 << failures.saturating_sub(1).min(16)).min(RETRY_LAST)
}

impl AccountState {
    pub fn subscribe_setup_changes(&self) -> broadcast::Receiver<Vec<DocumentKind>> {
        self.sync.setup_changes.subscribe()
    }

    pub(super) async fn sync_status(&self, db: &AppDb, owner_mismatch: bool) -> Result<SyncStatus, sqlx::Error> {
        let mut conn = db.read().acquire().await?;
        let pending_documents = sync_log::pending_count(&mut conn).await?;
        let refused_documents = sync_log::refused_count(&mut conn).await?;
        let memory = lock(&self.sync.memory).clone();
        let state = match (owner_mismatch, memory.needs_choice) {
            (true, _) => SyncState::OwnerMismatch,
            (false, Some((local_documents, account_documents))) => SyncState::NeedsChoice { local_documents, account_documents },
            (false, None) => SyncState::Running,
        };
        Ok(SyncStatus { state, last_success_at: memory.last_success, pending_documents, refused_documents, last_error: memory.last_error.map(str::to_owned) })
    }

    pub async fn sync_now(&self, st: &AppState, phase: Phase) -> Result<Outcome, Refusal> {
        let linked = self.linked_mode().ok_or(Refusal::LocalOnly)?;
        let _single = self.sync.cycle.lock().await;
        let mut report = Report::default();
        let result = self.cycle(st, linked, phase, &mut report).await;
        self.finish(st, &result, &report);
        result
    }

    pub async fn initial_sync(&self, st: &AppState, choice: InitialSyncChoice) -> Result<(), Refusal> {
        let linked = self.linked_mode().ok_or(Refusal::LocalOnly)?;
        let _single = self.sync.cycle.lock().await;
        let mut report = Report::default();
        let result = self.chosen(st, linked, choice, &mut report).await;
        self.finish(st, &result.as_ref().map(|()| Outcome::Synced).map_err(|e| *e), &report);
        result
    }

    async fn chosen(&self, st: &AppState, linked: &Linked, choice: InitialSyncChoice, report: &mut Report) -> Result<(), Refusal> {
        let login = self.checked_login(&st.db, linked).await?;
        if lock(&self.sync.memory).needs_choice.is_none() {
            return Err(Refusal::NoChoicePending);
        }
        match choice {
            InitialSyncChoice::UploadLocal => self.upload_local(st, linked, &login, Upload::ReplaceAccount).await?,
            InitialSyncChoice::TakeAccount => self.take_account(st, linked, &login, report).await?,
        }
        lock(&self.sync.memory).needs_choice = None;
        self.steps(st, linked, &login, Phase::Full, report).await
    }

    fn finish(&self, st: &AppState, result: &Result<Outcome, Refusal>, report: &Report) {
        {
            let mut memory = lock(&self.sync.memory);
            match result {
                Ok(Outcome::Synced) => {
                    memory.last_success = Some(UnixSeconds(st.clock.now().unix()));
                    memory.last_error = None;
                    memory.needs_choice = None;
                }
                Ok(Outcome::NeedsChoice) => {}
                Err(refusal) => {
                    if let Some(code) = error_code(refusal) {
                        memory.last_error = Some(code);
                    }
                }
            }
        }
        if !report.applied.is_empty() {
            let kinds: Vec<DocumentKind> = DocumentKind::ALL.into_iter().filter(|kind| report.applied.contains(kind)).collect();
            let _ = self.sync.setup_changes.send(kinds);
        }
        self.changed();
    }

    async fn checked_login(&self, db: &AppDb, linked: &Linked) -> Result<Login, Refusal> {
        let login = lock(&linked.login).clone().ok_or(Refusal::NotSignedIn)?;
        match owner::get(db).await.map_err(storage)? {
            Some(local_owner) if local_owner != login.account_id => Err(Refusal::OwnerMismatch),
            Some(_) => Ok(login),
            None => {
                owner::set_if_none(db, &login.account_id).await.map_err(storage)?;
                Ok(login)
            }
        }
    }

    async fn cycle(&self, st: &AppState, linked: &Linked, phase: Phase, report: &mut Report) -> Result<Outcome, Refusal> {
        let login = self.checked_login(&st.db, linked).await?;
        let initial_done = {
            let mut conn = st.db.read().acquire().await.map_err(storage)?;
            sync_log::initial_done(&mut conn).await.map_err(storage)?
        };
        if !initial_done {
            match self.initial(st, linked, &login, report).await? {
                Initial::Choice => return Ok(Outcome::NeedsChoice),
                Initial::Done => {}
            }
        }
        self.steps(st, linked, &login, phase, report).await?;
        Ok(Outcome::Synced)
    }

    async fn steps(&self, st: &AppState, linked: &Linked, login: &Login, phase: Phase, report: &mut Report) -> Result<(), Refusal> {
        let stale = self.push(st, linked, login, report).await?;
        if phase == Phase::Full || !stale.is_empty() {
            let since = {
                let mut conn = st.db.read().acquire().await.map_err(storage)?;
                sync_log::cursor(&mut conn).await.map_err(storage)?
            };
            self.pull(st, linked, login, since, stale, report).await?;
        }
        Ok(())
    }

    async fn guard<T>(&self, linked: &Linked, login: &Login, result: Result<T, ClientError>) -> Result<T, Refusal> {
        match result {
            Ok(value) => Ok(value),
            Err(ClientError::Rejected(401)) => {
                tracing::warn!("계정 서버가 토큰을 받지 않아 로그아웃 상태로 돌립니다");
                self.expire(linked, login).await;
                Err(Refusal::NotSignedIn)
            }
            Err(e) => Err(Refusal::ServerUnavailable(e)),
        }
    }

    async fn expire(&self, linked: &Linked, login: &Login) {
        let _write = self.write.lock().await;
        let still_current = lock(&linked.login).as_ref().is_some_and(|current| current.token.expose() == login.token.expose());
        if !still_current {
            return;
        }
        if let Err(e) = linked.file.remove() {
            tracing::error!(error = %e, "계정 상태 파일을 지우지 못했습니다");
            return;
        }
        *lock(&linked.login) = None;
        self.session_changed();
    }

    async fn push(&self, st: &AppState, linked: &Linked, login: &Login, report: &mut Report) -> Result<Vec<Document>, Refusal> {
        let outgoing = {
            let mut tx = st.db.read().begin().await.map_err(storage)?;
            let entries = sync_log::pending(&mut tx).await.map_err(storage)?;
            if entries.is_empty() {
                return Ok(Vec::new());
            }
            let mut live: HashMap<(DocumentKind, String), Document> =
                setup_bundle::live_documents_in(&mut tx).await.map_err(|e| storage(format!("{e:?}")))?.into_iter().map(|document| ((document.kind, document.id.clone()), document)).collect();
            let mut outgoing = Vec::new();
            for entry in entries {
                let document = if entry.deleted {
                    Document { kind: entry.kind, id: entry.id, revision: entry.revision, deleted: true, body: None }
                } else {
                    match live.remove(&(entry.kind, entry.id)) {
                        Some(document) => Document { revision: entry.revision, ..document },
                        None => continue,
                    }
                };
                outgoing.push(document);
            }
            outgoing
        };
        let mut stale = Vec::new();
        for chunk in chunked(outgoing) {
            let response = self.guard(linked, login, linked.client.push(&login.token, &chunk).await).await?;
            if response.results.len() != chunk.len() {
                return Err(Refusal::ServerUnavailable(ClientError::Malformed));
            }
            let mut tx = st.db.begin_write().await.map_err(storage)?;
            for (sent, result) in chunk.iter().zip(response.results) {
                match result.status {
                    PushStatus::Accepted => sync_log::acked(&mut tx, sent.kind, &sent.id, sent.revision).await.map_err(storage)?,
                    PushStatus::Stale { document } if document.revision == sent.revision => sync_log::acked(&mut tx, sent.kind, &sent.id, sent.revision).await.map_err(storage)?,
                    PushStatus::Stale { document } => stale.push(document),
                    PushStatus::Rejected { reason } => {
                        tracing::warn!(kind = sent.kind.wire_name(), id = sent.id, reason, "계정 서버가 문서를 거절했습니다");
                        sync_log::refuse(&mut tx, sent.kind, &sent.id, sent.revision, Direction::Push, &reason).await.map_err(storage)?;
                    }
                }
            }
            tx.commit().await.map_err(storage)?;
            report.touched = true;
        }
        Ok(stale)
    }

    async fn fetch_changes(&self, linked: &Linked, login: &Login, since: i64) -> Result<(Vec<Document>, i64), Refusal> {
        let mut documents = Vec::new();
        let mut cursor = since;
        loop {
            let page = self.guard(linked, login, linked.client.changes(&login.token, cursor, PULL_PAGE).await).await?;
            documents.extend(page.documents);
            cursor = page.seq;
            if !page.more {
                return Ok((documents, cursor));
            }
        }
    }

    async fn pull(&self, st: &AppState, linked: &Linked, login: &Login, since: i64, extra: Vec<Document>, report: &mut Report) -> Result<(), Refusal> {
        let (mut documents, cursor) = self.fetch_changes(linked, login, since).await?;
        documents.extend(extra);
        apply_all(st, documents, report).await?;
        let mut tx = st.db.begin_write().await.map_err(storage)?;
        sync_log::set_cursor(&mut tx, cursor).await.map_err(storage)?;
        tx.commit().await.map_err(storage)
    }

    async fn initial(&self, st: &AppState, linked: &Linked, login: &Login, report: &mut Report) -> Result<Initial, Refusal> {
        let summary = self.guard(linked, login, linked.client.summary(&login.token).await).await?;
        let local_documents = {
            let mut conn = st.db.read().acquire().await.map_err(storage)?;
            setup_bundle::live_documents_in(&mut conn).await.map_err(|e| storage(format!("{e:?}")))?.len() as i64
        };
        if summary.documents == 0 {
            let upload = if summary.seq > 0 { Upload::OverTombstones } else { Upload::Plain };
            self.upload_local(st, linked, login, upload).await?;
            return Ok(Initial::Done);
        }
        if setup_bundle::is_default(&st.db).await.map_err(|e| storage(e.message()))? {
            self.take_account(st, linked, login, report).await?;
            return Ok(Initial::Done);
        }
        lock(&self.sync.memory).needs_choice = Some((local_documents, summary.documents));
        Ok(Initial::Choice)
    }

    async fn upload_local(&self, st: &AppState, linked: &Linked, login: &Login, upload: Upload) -> Result<(), Refusal> {
        let account_documents = if upload == Upload::ReplaceAccount { self.fetch_changes(linked, login, 0).await?.0 } else { Vec::new() };
        let now = UnixSeconds(st.clock.now().unix()).millis();
        let mut tx = st.db.begin_write().await.map_err(storage)?;
        if upload != Upload::Plain {
            sync_log::raise_revisions(&mut tx, now).await.map_err(storage)?;
        }
        if upload == Upload::ReplaceAccount {
            for document in account_documents.iter().filter(|document| !document.deleted && !document.kind.is_singleton()) {
                if sync_log::recorded_revision(&mut tx, document.kind, &document.id).await.map_err(storage)?.is_none() {
                    sync_log::deleted(&mut tx, document.kind, &document.id, now.max(document.revision + 1)).await.map_err(storage)?;
                }
            }
        }
        sync_log::unack_all(&mut tx).await.map_err(storage)?;
        sync_log::set_cursor(&mut tx, 0).await.map_err(storage)?;
        sync_log::set_initial_done(&mut tx).await.map_err(storage)?;
        tx.commit().await.map_err(storage)
    }

    async fn take_account(&self, st: &AppState, linked: &Linked, login: &Login, report: &mut Report) -> Result<(), Refusal> {
        setup_bundle::reset_to_default(&st.db, &login.account_id).await.map_err(|e| storage(e.message()))?;
        report.touched = true;
        self.pull(st, linked, login, 0, Vec::new(), report).await
    }
}

fn chunked(documents: Vec<Document>) -> Vec<Vec<Document>> {
    let mut chunks: Vec<Vec<Document>> = Vec::new();
    let mut size = 0usize;
    for document in documents {
        let bytes = serde_json::to_string(&document).expect("셋업 문서는 언제나 직렬화된다").len() + 1;
        let full = chunks.last().is_none_or(|chunk| chunk.len() >= PUSH_DOCUMENTS || size + bytes > PUSH_BYTES);
        if full {
            chunks.push(Vec::new());
            size = 0;
        }
        size += bytes;
        chunks.last_mut().expect("방금 만들었거나 있던 묶음").push(document);
    }
    chunks
}

async fn apply_all(st: &AppState, mut documents: Vec<Document>, report: &mut Report) -> Result<(), Refusal> {
    setup_bundle::in_application_order(&mut documents);
    for _ in 0..APPLY_PASSES {
        let attempted = documents.len();
        let mut refused = Vec::new();
        for document in documents {
            match setup_bundle::apply_received(st, &document).await.map_err(|e| storage(format!("{e:?}")))? {
                Received::Applied => report.applied(document.kind),
                Received::Discarded => {}
                Received::Refused(why) => {
                    report.touched = true;
                    tracing::warn!(kind = document.kind.wire_name(), id = document.id, reason = why, "받은 문서를 적용하지 못했습니다");
                    refused.push(document);
                }
            }
        }
        if refused.is_empty() || refused.len() == attempted {
            break;
        }
        documents = refused;
    }
    Ok(())
}

async fn has_pending(st: &AppState) -> bool {
    match st.db.read().acquire().await {
        Ok(mut conn) => sync_log::pending_count(&mut conn).await.is_ok_and(|count| count > 0),
        Err(_) => false,
    }
}

pub async fn run(st: Arc<AppState>) {
    let account = st.system.account();
    if !account.is_linked() {
        return;
    }
    st.system.when_bound().await;
    let mut writes = st.db.write_releases();
    let mut sessions = account.subscribe_sessions();
    let mut failures = 0u32;
    let mut retry_not_before = Instant::now();
    let mut next_full = Instant::now();
    let mut push_at: Option<Instant> = None;
    loop {
        let phase = tokio::select! {
            _ = tokio::time::sleep_until(next_full.max(retry_not_before)) => Phase::Full,
            _ = async {
                match push_at {
                    Some(at) => tokio::time::sleep_until(at.max(retry_not_before)).await,
                    None => std::future::pending().await,
                }
            } => Phase::PushOnly,
            changed = writes.changed() => {
                if changed.is_err() {
                    return;
                }
                push_at.get_or_insert(Instant::now() + WRITE_QUIET);
                continue;
            }
            changed = sessions.changed() => {
                if changed.is_err() {
                    return;
                }
                failures = 0;
                retry_not_before = Instant::now();
                Phase::Full
            }
        };
        push_at = None;
        if phase == Phase::PushOnly && !has_pending(&st).await {
            continue;
        }
        let result = account.sync_now(&st, phase).await;
        match &result {
            Err(refusal) if error_code(refusal).is_some() => {
                failures += 1;
                let delay = retry_delay(failures);
                tracing::warn!(error = %refusal, ?delay, "계정 서버와 셋업을 동기화하지 못했습니다. 화면과 로컬 저장은 그대로 쓰고 다시 시도합니다");
                retry_not_before = Instant::now() + delay;
                next_full = retry_not_before;
            }
            _ => {
                failures = 0;
                if phase == Phase::Full {
                    next_full = Instant::now() + PULL_EVERY;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_retry_delay_doubles_from_five_seconds_up_to_five_minutes() {
        let seconds: Vec<u64> = (1..=9).map(|failures| retry_delay(failures).as_secs()).collect();
        assert_eq!(seconds, [5, 10, 20, 40, 80, 160, 300, 300, 300]);
    }

    #[test]
    fn a_push_is_split_by_the_document_count_and_the_message_size() {
        let body = |bytes: usize| serde_json::json!({ "pad": "x".repeat(bytes) });
        let document = |n: usize, bytes: usize| Document { kind: DocumentKind::Drawing, id: format!("D{n}"), revision: 1, deleted: false, body: Some(body(bytes)) };
        let many: Vec<Document> = (0..PUSH_DOCUMENTS + 1).map(|n| document(n, 1)).collect();
        let sizes: Vec<usize> = chunked(many).iter().map(Vec::len).collect();
        assert_eq!(sizes, [PUSH_DOCUMENTS, 1]);
        let large: Vec<Document> = (0..3).map(|n| document(n, PUSH_BYTES / 2)).collect();
        let sizes: Vec<usize> = chunked(large).iter().map(Vec::len).collect();
        assert_eq!(sizes, [1, 1, 1]);
        assert!(chunked(Vec::new()).is_empty());
    }
}
