use std::collections::BTreeMap;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

use domain::{KstTime, SymbolInfo};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sqlx::{Row, sqlite::SqliteRow};

use crate::api::{FinancialUpdatePage, FinancialUpdatePhase as Phase, FinancialUpdateStatus as Status, FinancialUpdateStopReason as StopReason, UnixSeconds};
use crate::clock::Clock;
use super::Financials;
use super::client::{Client, Request};
use super::model::{Collection, Failure, Halt, Interrupt};
use super::schedule::{due_check, next_check};
use super::store::Store;
use super::updates::{Coverage, Update, failure_name};

pub(super) struct ControlTables(());

#[derive(Clone, Serialize, Deserialize)]
struct Stop { failure: Failure, next_check_at: Option<i64>, request: Request }

impl Stop {
    fn new(failure: Failure, request: Request, now: KstTime) -> Self {
        let mut stop = Self { failure, next_check_at: None, request };
        stop.refused(failure, now);
        stop
    }

    fn refused(&mut self, failure: Failure, now: KstTime) {
        if disposition(failure) == Disposition::StopJob { self.failure = failure; }
        self.next_check_at = (self.reason() == StopReason::RateLimited).then(|| next_check(now).unix());
    }

    fn reason(&self) -> StopReason { if self.failure == Failure::Authentication { StopReason::Authentication } else { StopReason::RateLimited } }

    fn opens_by(&self, now: KstTime) -> bool { self.reason() == StopReason::RateLimited && self.next_check_at.is_some_and(|at| at <= now.unix()) }
}

struct ControlState { job: Result<Option<Update>, Failure>, paused: Result<bool, Failure>, stop: Result<Option<Stop>, Failure>, companies_confirmed: Option<bool> }

enum Hold<'a> { Paused, Stopped(&'a Stop) }

impl ControlState {
    fn unavailable(failure: Failure) -> Self { Self { job: Err(failure), paused: Err(failure), stop: Err(failure), companies_confirmed: None } }

    async fn read(store: Result<&Store, Failure>) -> Self {
        match store { Ok(store) => store.control_state().await, Err(failure) => Self::unavailable(failure) }
    }

    fn failure(&self) -> Option<Failure> { self.job.as_ref().err().or(self.paused.as_ref().err()).or(self.stop.as_ref().err()).copied() }

    fn hold(&self) -> Option<Hold<'_>> {
        match (&self.paused, &self.stop) { (Ok(true), _) => Some(Hold::Paused), (_, Ok(Some(stop))) => Some(Hold::Stopped(stop)), _ => None }
    }
}

#[derive(Clone, Copy, Default)]
struct RunState { configured: bool, automatic: bool, running: bool, probing: bool, failure: Option<Failure>, latest_pending: bool }

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Launch { Start, Resume, Automatic }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Decision { Unchanged, Fail(Failure), Yield, CheckCompanies, Declined, Release, Begin { resume: bool } }

fn decide_launch(control: &ControlState, run: &RunState, mode: Launch, now: KstTime) -> Decision {
    let automatic = mode == Launch::Automatic;
    let due = due_check(now).unix();
    if !run.configured { return Decision::Unchanged; }
    if run.running {
        return match &control.job {
            _ if !automatic || run.probing => Decision::Unchanged,
            Err(error) => Decision::Fail(*error),
            Ok(Some(job)) if job.planned_before(due) => Decision::Yield,
            Ok(_) => Decision::Unchanged,
        };
    }
    if automatic && run.failure.is_some() { return Decision::Unchanged; }
    if let Some(error) = control.failure() { return Decision::Fail(error); }
    let job = control.job.as_ref().ok().and_then(Option::as_ref);
    let active = job.is_some_and(Update::is_active);
    let hold = control.hold();
    let resume = match mode {
        Launch::Start => false,
        Launch::Resume => true,
        Launch::Automatic => {
            match hold { Some(Hold::Paused) => return Decision::Declined, Some(Hold::Stopped(stop)) if !stop.opens_by(now) => return Decision::Declined, _ => {} }
            if !active && let Some(job) = job {
                match (job.coverage(now.kst_date().year(), due), control.companies_confirmed) {
                    (Coverage::Covered, _) | (Coverage::Companies, Some(true)) => return Decision::Declined,
                    (Coverage::Companies, None) => return Decision::CheckCompanies,
                    (Coverage::Uncovered, _) | (Coverage::Companies, Some(false)) => {}
                }
            }
            hold.is_some() || active
        }
    };
    if hold.is_some() && !resume { Decision::Declined }
    else if resume && !active { Decision::Release }
    else { Decision::Begin { resume } }
}

fn status(control: &ControlState, run: &RunState, now: KstTime) -> FinancialUpdatePage {
    let mut page = match &control.job { Ok(Some(job)) => job.page(), _ => Update::empty(now.kst_date().year()).page() };
    if let Some(error) = control.failure().or(run.failure) { page.status = Status::Failed; page.failure = Some(failure_name(error)); page.stop_reason = Some(StopReason::Storage); }
    else if !run.configured { page.status = Status::NotConfigured; page.stop_reason = Some(StopReason::NotConfigured); }
    else if let Some(hold) = control.hold() {
        match hold {
            Hold::Paused => { page.status = if run.running { Status::Pausing } else { Status::Paused }; page.stop_reason = Some(StopReason::User); }
            Hold::Stopped(stop) => {
                page.status = if run.probing { Status::Checking } else if run.running { Status::Pausing } else { Status::Stopped };
                page.failure = Some(failure_name(stop.failure));
                page.stop_reason = Some(stop.reason());
                page.next_check_at = stop.next_check_at.map(UnixSeconds);
                page.can_resume = !run.running;
            }
        }
    }
    else if !run.running && matches!(page.status, Status::Planning | Status::Collecting) { page.status = Status::Interrupted; page.stop_reason = Some(StopReason::Interrupted); }
    page.automatic = run.automatic;
    page.latest_check_pending = run.latest_pending;
    if matches!(page.status, Status::Paused | Status::Interrupted) || (page.status == Status::Failed && page.id > 0 && page.phase != Phase::Complete) { page.can_resume = true; }
    if page.stop_reason.is_none() && run.configured && run.automatic { page.next_check_at = Some(UnixSeconds(next_check(now).unix())); }
    page
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Disposition { StopJob, AbortJob, Record }

fn disposition(failure: Failure) -> Disposition {
    match failure {
        Failure::Authentication | Failure::RateLimited => Disposition::StopJob,
        Failure::Storage => Disposition::AbortJob,
        Failure::Network | Failure::Remote | Failure::InvalidResponse | Failure::SourceUnavailable | Failure::ReceiptMismatch => Disposition::Record,
    }
}

impl Interrupt {
    pub(super) fn recorded(self) -> Result<Failure, Interrupt> {
        match self { Interrupt::Failure(failure) if disposition(failure) == Disposition::Record => Ok(failure), interrupt => Err(interrupt) }
    }
}

#[derive(Default)]
struct Signal { paused: AtomicBool, yielding: AtomicBool }

impl Signal {
    fn check(&self) -> Result<(), Halt> {
        if self.is_paused() { Err(Halt::Paused) } else if self.yielding.load(Ordering::SeqCst) { Err(Halt::Yielded) } else { Ok(()) }
    }

    fn is_paused(&self) -> bool { self.paused.load(Ordering::SeqCst) }

    fn pause(&self, paused: bool) { self.paused.store(paused, Ordering::SeqCst); }

    fn yield_to_latest(&self, yielding: bool) { self.yielding.store(yielding, Ordering::SeqCst); }
}

#[derive(Default)]
struct UpdateRun { running: bool, probing: bool, failure: Option<Failure>, pending_symbols: Option<Vec<SymbolInfo>>, collecting: Option<String>, company_failures: BTreeMap<String, Failure> }

#[derive(Default)]
pub(super) struct CollectionState { pub collecting: bool, pub failure: Option<Failure> }

pub(super) struct UpdateControl { configured: bool, clock: Clock, automatic: AtomicBool, run: tokio::sync::Mutex<UpdateRun>, signal: Arc<Signal>, finished: tokio::sync::Notify }

#[derive(Clone)]
pub(super) struct JobContext { store: Store, journal: String, through_date: String, signal: Arc<Signal>, clock: Clock }

struct Begun { job: JobContext, update: Update, stop: Option<Stop> }

impl JobContext {
    pub(super) fn store(&self) -> &Store { &self.store }

    pub(super) fn journal(&self) -> &str { &self.journal }

    pub(super) fn through_date(&self) -> &str { &self.through_date }

    pub(super) fn check(&self) -> Result<(), Halt> { self.signal.check() }

    pub(super) async fn save(&self, update: &Update) -> Result<(), Failure> { self.store.save_update(update).await }

    pub(super) async fn stop_on(&self, failure: Failure, request: Request) -> Result<(), Failure> {
        if disposition(failure) != Disposition::StopJob { return Ok(()); }
        self.store.save_stop(Some(&Stop::new(failure, request, self.clock.now()))).await
    }
}

impl UpdateControl {
    pub(super) fn new(configured: bool, clock: Clock) -> Self {
        Self { configured, clock, automatic: AtomicBool::new(false), run: Default::default(), signal: Default::default(), finished: Default::default() }
    }

    pub(super) fn enable_automatic(&self) { self.automatic.store(true, Ordering::SeqCst); }

    pub(super) async fn finished(&self) { self.finished.notified().await }

    pub(super) async fn begin_company(&self, corp: &str) {
        let mut run = self.run.lock().await;
        run.collecting = Some(corp.into());
        run.company_failures.remove(corp);
    }

    pub(super) async fn finish_company(&self, corp: &str, result: &Result<Collection, Interrupt>) {
        let mut run = self.run.lock().await;
        run.collecting = None;
        if let Err(Interrupt::Failure(failure)) = *result {
            tracing::warn!(?failure, "재무 자료를 수집하지 못했습니다");
            run.company_failures.insert(corp.into(), failure);
        }
    }

    pub(super) async fn collection_state(&self, corp: &str) -> CollectionState {
        let run = self.run.lock().await;
        CollectionState { collecting: run.running && run.collecting.as_deref() == Some(corp), failure: run.company_failures.get(corp).copied() }
    }

    fn run_state(&self, run: &UpdateRun) -> RunState {
        RunState { configured: self.configured, automatic: self.automatic.load(Ordering::SeqCst), running: run.running, probing: run.probing, failure: run.failure, latest_pending: run.pending_symbols.is_some() }
    }

    async fn page(&self, store: Result<&Store, Failure>) -> FinancialUpdatePage {
        let run = self.run.lock().await;
        status(&ControlState::read(store).await, &self.run_state(&run), self.clock.now())
    }

    async fn pause(&self, store: Result<&Store, Failure>) {
        let mut run = self.run.lock().await;
        let result = async {
            let store = store?;
            if store.job().await?.is_some_and(|job| job.is_active()) {
                self.signal.pause(true);
                store.set_paused(true).await?;
            }
            Ok::<_, Failure>(())
        }.await;
        if let Err(error) = result { run.failure = Some(error); }
    }

    async fn launch(&self, store: Result<&Store, Failure>, client: Option<&Client>, symbols: Vec<SymbolInfo>, mode: Launch) -> Option<Begun> {
        let mut run = self.run.lock().await;
        let now = self.clock.now();
        let state = self.run_state(&run);
        let mut control = ControlState::read(store).await;
        let mut decision = decide_launch(&control, &state, mode, now);
        if decision == Decision::CheckCompanies {
            let confirmed = match (store, &control.job) { (Ok(store), Ok(Some(job))) => store.confirmed_since(&job.company_codes(), due_check(now).unix()).await, _ => Err(Failure::Storage) };
            decision = match confirmed { Ok(confirmed) => { control.companies_confirmed = Some(confirmed); decide_launch(&control, &state, mode, now) } Err(error) => Decision::Fail(error) };
        }
        match decision {
            Decision::Unchanged | Decision::CheckCompanies => None,
            Decision::Fail(error) => { run.failure = Some(error); None }
            Decision::Yield => { run.pending_symbols = Some(symbols); self.signal.yield_to_latest(true); None }
            Decision::Declined | Decision::Release => {
                let released = if decision == Decision::Release { self.release(store).await } else { Ok(()) };
                match released { Ok(()) => if mode == Launch::Resume { run.failure = None; }, Err(error) => run.failure = Some(error) }
                None
            }
            Decision::Begin { resume } => match self.begin(store, client.unwrap(), control, symbols, resume, now).await {
                Ok(begun) => { run.running = true; run.probing = begun.stop.is_some(); run.failure = None; Some(begun) }
                Err(error) => { run.failure = Some(error); None }
            },
        }
    }

    async fn release(&self, store: Result<&Store, Failure>) -> Result<(), Failure> {
        store?.set_paused(false).await?;
        self.signal.pause(false);
        Ok(())
    }

    async fn begin(&self, store: Result<&Store, Failure>, client: &Client, control: ControlState, symbols: Vec<SymbolInfo>, resume: bool, now: KstTime) -> Result<Begun, Failure> {
        let store = store?;
        let update = Update::plan(control.job?, symbols, self.automatic.load(Ordering::SeqCst), now);
        let job = self.prepare(store, client, &update).await?;
        if resume { store.set_paused(false).await?; }
        self.signal.pause(false);
        Ok(Begun { job, update, stop: control.stop? })
    }

    async fn prepare(&self, store: &Store, client: &Client, update: &Update) -> Result<JobContext, Failure> {
        store.save_update(update).await?;
        self.signal.yield_to_latest(false);
        let job = JobContext { store: store.clone(), journal: update.journal(), through_date: update.through_date(self.clock.now()), signal: self.signal.clone(), clock: self.clock.clone() };
        client.begin_job(job.clone()).await?;
        Ok(job)
    }

    async fn confirm(&self, store: &Store, mut stop: Stop, client: &Client) -> Result<bool, Interrupt> {
        match client.replay(&stop.request).await {
            Ok(()) => { store.save_stop(None).await?; Ok(true) }
            Err(Interrupt::Failure(failure)) if disposition(failure) != Disposition::AbortJob => {
                stop.refused(failure, self.clock.now());
                store.save_stop(Some(&stop)).await?;
                Ok(false)
            }
            Err(interrupt) => Err(interrupt),
        }
    }

    async fn probe(&self, client: &Client, job: &JobContext, stop: Stop) -> bool {
        let confirmed = self.confirm(job.store(), stop, client).await;
        let mut run = self.run.lock().await;
        match confirmed {
            Ok(true) => { run.probing = false; self.finished.notify_one(); true }
            Ok(false) | Err(Interrupt::Halt(_)) => { self.end(&mut run, Ok(())); false }
            Err(Interrupt::Failure(failure)) => { self.end(&mut run, Err(failure)); false }
        }
    }

    async fn advance(&self, client: &Client, job: &JobContext, pass: Result<Update, Interrupt>) -> Option<(JobContext, Update)> {
        let mut run = self.run.lock().await;
        let mut result = match pass { Ok(update) => Ok(Some(update)), Err(Interrupt::Halt(_)) => Ok(None), Err(Interrupt::Failure(failure)) => Err(failure) };
        if result.is_ok() && !self.signal.is_paused() && let Some(symbols) = run.pending_symbols.take() {
            match self.latest(client, job.store(), result.unwrap(), symbols).await {
                Ok(next) => return Some(next),
                Err(error) => result = Err(error),
            }
        }
        let result = match result {
            Ok(Some(update)) if !self.signal.is_paused() => job.save(&update).await,
            Ok(_) => Ok(()),
            Err(error) => Err(error),
        };
        self.end(&mut run, result);
        None
    }

    async fn latest(&self, client: &Client, store: &Store, finished: Option<Update>, symbols: Vec<SymbolInfo>) -> Result<(JobContext, Update), Failure> {
        let mut next = match finished { Some(next) => next, None => store.job().await?.ok_or(Failure::Storage)? };
        next.recheck(symbols, self.clock.now());
        Ok((self.prepare(store, client, &next).await?, next))
    }

    fn end(&self, run: &mut UpdateRun, result: Result<(), Failure>) {
        run.running = false;
        run.probing = false;
        run.pending_symbols = None;
        self.finished.notify_one();
        if let Err(error) = result && disposition(error) != Disposition::StopJob { run.failure = Some(error); }
    }
}

const TABLES: ControlTables = ControlTables(());

fn body<T: DeserializeOwned>(row: &SqliteRow, column: &str) -> Result<Option<T>, Failure> {
    row.try_get::<Option<&str>, _>(column).map_err(|_| Failure::Storage)?.map(|body| serde_json::from_str(body).map_err(|_| Failure::Storage)).transpose()
}

impl Store {
    async fn control_state(&self) -> ControlState {
        let query = "SELECT (SELECT body FROM financial_update WHERE id = 1) AS job, (SELECT paused FROM financial_update_control WHERE id = 1) AS paused, (SELECT body FROM financial_stop WHERE id = 1) AS stop";
        let Ok(row) = sqlx::query(query).fetch_one(self.pool(&TABLES)).await else { return ControlState::unavailable(Failure::Storage); };
        let paused = row.try_get::<Option<bool>, _>("paused").map(|paused| paused.unwrap_or(false)).map_err(|_| Failure::Storage);
        ControlState { job: body(&row, "job"), paused, stop: body(&row, "stop"), companies_confirmed: None }
    }

    pub(super) async fn job(&self) -> Result<Option<Update>, Failure> {
        let row = sqlx::query("SELECT body FROM financial_update WHERE id = 1").fetch_optional(self.pool(&TABLES)).await.map_err(|_| Failure::Storage)?;
        Ok(row.map(|row| body(&row, "body")).transpose()?.flatten())
    }

    async fn set_paused(&self, paused: bool) -> Result<(), Failure> {
        sqlx::query("INSERT INTO financial_update_control VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET paused = excluded.paused").bind(paused).execute(self.pool(&TABLES)).await.map_err(|_| Failure::Storage)?;
        Ok(())
    }

    async fn save_stop(&self, stop: Option<&Stop>) -> Result<(), Failure> {
        if let Some(stop) = stop {
            let body = serde_json::to_string(stop).map_err(|_| Failure::Storage)?;
            sqlx::query("INSERT INTO financial_stop VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body").bind(body).execute(self.pool(&TABLES)).await.map_err(|_| Failure::Storage)?;
        } else { sqlx::query("DELETE FROM financial_stop").execute(self.pool(&TABLES)).await.map_err(|_| Failure::Storage)?; }
        Ok(())
    }

    async fn save_update(&self, update: &Update) -> Result<(), Failure> {
        let body = serde_json::to_string(update).map_err(|_| Failure::Storage)?;
        sqlx::query("INSERT INTO financial_update VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body").bind(body).execute(self.pool(&TABLES)).await.map_err(|_| Failure::Storage)?;
        Ok(())
    }
}

impl Financials {
    pub async fn update_status(&self) -> FinancialUpdatePage { self.control.page(self.store()).await }

    pub async fn start_update(self: &Arc<Self>, symbols: Vec<SymbolInfo>) -> FinancialUpdatePage { self.launch_update(symbols, Launch::Start).await }

    pub async fn resume_update(self: &Arc<Self>, symbols: Vec<SymbolInfo>) -> FinancialUpdatePage { self.launch_update(symbols, Launch::Resume).await }

    pub async fn pause_update(&self) -> FinancialUpdatePage {
        self.control.pause(self.store()).await;
        self.update_status().await
    }

    pub(super) async fn launch_update(self: &Arc<Self>, symbols: Vec<SymbolInfo>, mode: Launch) -> FinancialUpdatePage {
        if let Some(begun) = self.control.launch(self.store(), self.client.as_ref(), symbols, mode).await {
            let service = self.clone();
            tokio::spawn(async move { service.execute_update(begun).await; });
        }
        self.update_status().await
    }

    async fn execute_update(self: &Arc<Self>, begun: Begun) {
        let Some(client) = &self.client else { return; };
        let Begun { mut job, mut update, stop } = begun;
        if let Some(stop) = stop && !self.control.probe(client, &job, stop).await { return; }
        loop {
            let pass = self.perform_update(update, &job).await;
            let Some((next_job, next)) = self.control.advance(client, &job, pass).await else { return; };
            (job, update) = (next_job, next);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{FinancialUpdateStatus as Status, FinancialUpdateStopReason as StopReason};
    use crate::clock::kst;
    use domain::KstDate;
    use serde_json::json;

    fn at(day: u8, hour: u32) -> KstTime { kst(KstDate::new(2016, 1, day).unwrap(), hour, 0, 0) }

    fn noon() -> KstTime { at(1, 12) }

    fn job(status: &str, phase: &str, requested_for: Option<KstTime>) -> Update {
        serde_json::from_value(json!({"id": 3, "status": status, "phase": phase, "from_year": 2014, "through_year": 2016, "targets": [], "companies": {}, "started_at": at(1, 8).unix(), "checked_at": null, "requested_for": requested_for.map(KstTime::unix)})).unwrap()
    }

    fn collecting() -> Update { job("collecting", "recent", Some(at(1, 7))) }

    fn stop(failure: Failure, next_check_at: Option<KstTime>) -> Stop {
        Stop { failure, next_check_at: next_check_at.map(KstTime::unix), request: Request::Json { endpoint: "list.json".into(), params: Vec::new() } }
    }

    fn state(job: Option<Update>, paused: bool, stop: Option<Stop>) -> ControlState { ControlState { job: Ok(job), paused: Ok(paused), stop: Ok(stop), companies_confirmed: None } }

    fn idle() -> RunState { RunState { configured: true, ..RunState::default() } }

    fn running() -> RunState { RunState { running: true, ..idle() } }

    type Summary = (Status, Option<StopReason>, Option<&'static str>, Option<KstTime>, bool);

    fn summary(page: FinancialUpdatePage) -> Summary {
        let failure = page.failure.map(|failure| match failure.as_str() { "storage" => "storage", "authentication" => "authentication", "rate_limited" => "rate_limited", other => panic!("{other}") });
        (page.status, page.stop_reason, failure, page.next_check_at.map(|at| KstTime::from_unix(at.0)), page.can_resume)
    }

    #[test]
    fn status_reports_storage_then_configuration_then_pause_then_stop_then_interruption() {
        let cases: Vec<(&str, ControlState, RunState, Summary)> = vec![
            ("nothing has run", state(None, false, None), idle(), (Status::Idle, None, None, None, false)),
            ("unreadable store", ControlState::unavailable(Failure::Storage), idle(), (Status::Failed, Some(StopReason::Storage), Some("storage"), None, false)),
            ("unreadable store before missing configuration", ControlState::unavailable(Failure::Storage), RunState::default(), (Status::Failed, Some(StopReason::Storage), Some("storage"), None, false)),
            ("earlier storage failure can resume the unfinished job", state(Some(collecting()), false, None), RunState { failure: Some(Failure::Storage), ..idle() }, (Status::Failed, Some(StopReason::Storage), Some("storage"), None, true)),
            ("storage failure before a pause", state(Some(collecting()), true, None), RunState { failure: Some(Failure::Storage), ..idle() }, (Status::Failed, Some(StopReason::Storage), Some("storage"), None, true)),
            ("missing configuration", state(None, false, None), RunState::default(), (Status::NotConfigured, Some(StopReason::NotConfigured), None, None, false)),
            ("corrupt stop row keeps the job page", ControlState { stop: Err(Failure::Storage), ..state(Some(collecting()), false, None) }, idle(), (Status::Failed, Some(StopReason::Storage), Some("storage"), None, true)),
            ("corrupt pause row keeps the job page", ControlState { paused: Err(Failure::Storage), ..state(Some(collecting()), false, None) }, idle(), (Status::Failed, Some(StopReason::Storage), Some("storage"), None, true)),
            ("missing configuration before a pause", state(Some(collecting()), true, None), RunState::default(), (Status::NotConfigured, Some(StopReason::NotConfigured), None, None, false)),
            ("pause while the job runs", state(Some(collecting()), true, None), running(), (Status::Pausing, Some(StopReason::User), None, None, false)),
            ("pause after the job ends", state(Some(collecting()), true, None), idle(), (Status::Paused, Some(StopReason::User), None, None, true)),
            ("pause before a limit stop", state(Some(collecting()), true, Some(stop(Failure::RateLimited, Some(at(2, 7))))), idle(), (Status::Paused, Some(StopReason::User), None, None, true)),
            ("authentication stop", state(Some(collecting()), false, Some(stop(Failure::Authentication, None))), idle(), (Status::Stopped, Some(StopReason::Authentication), Some("authentication"), None, true)),
            ("limit stop waits for its saved check", state(Some(collecting()), false, Some(stop(Failure::RateLimited, Some(at(2, 7))))), idle(), (Status::Stopped, Some(StopReason::RateLimited), Some("rate_limited"), Some(at(2, 7)), true)),
            ("confirmation request in flight", state(Some(collecting()), false, Some(stop(Failure::RateLimited, Some(at(1, 7))))), RunState { probing: true, ..running() }, (Status::Checking, Some(StopReason::RateLimited), Some("rate_limited"), Some(at(1, 7)), false)),
            ("stop reached while the job runs", state(Some(collecting()), false, Some(stop(Failure::Authentication, None))), running(), (Status::Pausing, Some(StopReason::Authentication), Some("authentication"), None, false)),
            ("unfinished job without a runner", state(Some(collecting()), false, None), idle(), (Status::Interrupted, Some(StopReason::Interrupted), None, None, true)),
            ("planning job without a runner", state(Some(job("planning", "planning", Some(at(1, 7)))), false, None), idle(), (Status::Interrupted, Some(StopReason::Interrupted), None, None, true)),
            ("running job", state(Some(collecting()), false, None), running(), (Status::Collecting, None, None, None, false)),
            ("finished job", state(Some(job("ready", "complete", Some(at(1, 7)))), false, None), idle(), (Status::Ready, None, None, None, false)),
            ("automatic schedule shows the next 07:00", state(Some(job("ready", "complete", Some(at(1, 7)))), false, None), RunState { automatic: true, ..idle() }, (Status::Ready, None, None, Some(at(2, 7)), false)),
            ("automatic schedule yields to the saved limit check", state(Some(collecting()), false, Some(stop(Failure::RateLimited, Some(at(3, 7))))), RunState { automatic: true, ..idle() }, (Status::Stopped, Some(StopReason::RateLimited), Some("rate_limited"), Some(at(3, 7)), true)),
            ("automatic schedule hides the check while paused", state(Some(collecting()), true, None), RunState { automatic: true, ..idle() }, (Status::Paused, Some(StopReason::User), None, None, true)),
            ("automatic schedule without configuration", state(None, false, None), RunState { automatic: true, ..RunState::default() }, (Status::NotConfigured, Some(StopReason::NotConfigured), None, None, false)),
        ];
        for (name, control, run, expected) in cases {
            assert_eq!(summary(status(&control, &run, noon())), expected, "{name}");
        }
    }

    type LaunchCase = (&'static str, ControlState, RunState, Launch, Decision);

    fn legacy(started_at: KstTime, pending_target: bool) -> Update {
        let targets = if pending_target { json!([{"code": "005930", "name": "삼성전자", "preferred": false, "resolution": {"status": "pending"}}]) } else { json!([]) };
        serde_json::from_value(json!({"id": 3, "status": "ready", "phase": "complete", "from_year": 2014, "through_year": 2016, "targets": targets, "companies": {}, "started_at": started_at.unix(), "checked_at": null})).unwrap()
    }

    #[test]
    fn launch_checks_the_runner_then_pause_then_stop_then_check_time() {
        use Decision::*;
        use Launch::{Automatic, Resume, Start};
        let finished_before_due = job("ready", "complete", Some(at(1, 6)));
        let finished_after_due = job("ready", "complete", Some(at(1, 7)));
        let old_scope = { let mut value = serde_json::to_value(job("ready", "complete", Some(at(1, 7)))).unwrap(); value["through_year"] = json!(2015); serde_json::from_value::<Update>(value).unwrap() };
        let limit_due = || stop(Failure::RateLimited, Some(at(1, 7)));
        let limit_later = || stop(Failure::RateLimited, Some(at(2, 7)));
        let confirmed = |companies_confirmed: Option<bool>| ControlState { companies_confirmed, ..state(Some(legacy(at(1, 6), false)), false, None) };
        let cases: Vec<LaunchCase> = vec![
            ("missing configuration never starts", state(None, false, None), RunState::default(), Start, Unchanged),
            ("missing configuration never resumes", state(Some(collecting()), true, None), RunState::default(), Resume, Unchanged),
            ("missing configuration never checks", state(None, false, None), RunState::default(), Automatic, Unchanged),
            ("manual start joins the running job", state(Some(collecting()), false, None), running(), Start, Unchanged),
            ("resume joins the running job", state(Some(collecting()), true, None), running(), Resume, Unchanged),
            ("check yields a job planned before 07:00", state(Some(job("collecting", "history", Some(at(1, 6)))), false, None), running(), Automatic, Yield),
            ("check yields a job planned before scheduling existed", state(Some(job("collecting", "history", None)), false, None), running(), Automatic, Yield),
            ("check joins a job planned after 07:00", state(Some(collecting()), false, None), running(), Automatic, Unchanged),
            ("check never yields a confirmation request", state(Some(job("collecting", "history", Some(at(1, 6)))), false, Some(limit_due())), RunState { probing: true, ..running() }, Automatic, Unchanged),
            ("check during a run reports an unreadable store", ControlState::unavailable(Failure::Storage), running(), Automatic, Fail(Failure::Storage)),
            ("manual start during a run ignores an unreadable store", ControlState::unavailable(Failure::Storage), running(), Start, Unchanged),
            ("check waits for an explicit resume after a storage failure", ControlState::unavailable(Failure::Storage), RunState { failure: Some(Failure::Storage), ..idle() }, Automatic, Unchanged),
            ("manual start reports an unreadable store", ControlState::unavailable(Failure::Storage), idle(), Start, Fail(Failure::Storage)),
            ("manual start creates the first job", state(None, false, None), idle(), Start, Begin { resume: false }),
            ("manual start continues an interrupted job", state(Some(collecting()), false, None), idle(), Start, Begin { resume: false }),
            ("manual start keeps a pause", state(Some(collecting()), true, None), idle(), Start, Declined),
            ("manual start keeps a stop", state(Some(collecting()), false, Some(limit_due())), idle(), Start, Declined),
            ("resume continues a paused job", state(Some(collecting()), true, None), idle(), Resume, Begin { resume: true }),
            ("resume confirms a stopped job", state(Some(collecting()), false, Some(stop(Failure::Authentication, None))), idle(), Resume, Begin { resume: true }),
            ("resume confirms a limit stop before its check time", state(Some(collecting()), false, Some(limit_later())), idle(), Resume, Begin { resume: true }),
            ("resume without an unfinished job only clears the pause", state(Some(finished_after_due.clone()), true, None), idle(), Resume, Release),
            ("resume with nothing to continue", state(None, false, None), idle(), Resume, Release),
            ("check keeps a pause", state(Some(collecting()), true, None), idle(), Automatic, Declined),
            ("check keeps a pause over a due limit check", state(Some(collecting()), true, Some(limit_due())), idle(), Automatic, Declined),
            ("check keeps an authentication stop", state(Some(collecting()), false, Some(stop(Failure::Authentication, None))), idle(), Automatic, Declined),
            ("check waits for the saved limit check", state(Some(collecting()), false, Some(limit_later())), idle(), Automatic, Declined),
            ("check keeps a limit stop without a check time", state(Some(collecting()), false, Some(stop(Failure::RateLimited, None))), idle(), Automatic, Declined),
            ("check confirms a due limit stop", state(Some(collecting()), false, Some(limit_due())), idle(), Automatic, Begin { resume: true }),
            ("check confirms a due limit stop at the second", state(Some(collecting()), false, Some(stop(Failure::RateLimited, Some(noon())))), idle(), Automatic, Begin { resume: true }),
            ("check with a due limit stop and no unfinished job clears the pause", state(Some(finished_before_due.clone()), false, Some(limit_due())), idle(), Automatic, Release),
            ("check with a due limit stop and a covered job", state(Some(finished_after_due.clone()), false, Some(limit_due())), idle(), Automatic, Declined),
            ("check resumes an interrupted job", state(Some(collecting()), false, None), idle(), Automatic, Begin { resume: true }),
            ("check after an earlier failure stays quiet", state(None, false, None), RunState { failure: Some(Failure::Storage), ..idle() }, Automatic, Unchanged),
            ("check creates the first job", state(None, false, None), idle(), Automatic, Begin { resume: false }),
            ("check skips a job planned after 07:00", state(Some(finished_after_due.clone()), false, None), idle(), Automatic, Declined),
            ("check repeats a job planned before 07:00", state(Some(finished_before_due.clone()), false, None), idle(), Automatic, Begin { resume: false }),
            ("check extends an older scope", state(Some(old_scope), false, None), idle(), Automatic, Begin { resume: false }),
            ("check repeats a legacy job with targets started before 07:00", state(Some(legacy(at(1, 6), true)), false, None), idle(), Automatic, Begin { resume: false }),
            ("check skips a legacy job with targets started after 07:00", state(Some(legacy(at(1, 7), true)), false, None), idle(), Automatic, Declined),
            ("check asks whether a legacy job's companies were confirmed after 07:00", confirmed(None), idle(), Automatic, CheckCompanies),
            ("check repeats a legacy job whose companies were not all confirmed after 07:00", confirmed(Some(false)), idle(), Automatic, Begin { resume: false }),
            ("check skips a legacy job whose companies were confirmed after 07:00", confirmed(Some(true)), idle(), Automatic, Declined),
            ("pause before the legacy confirmation question", ControlState { paused: Ok(true), ..confirmed(None) }, idle(), Automatic, Declined),
            ("manual start never asks about legacy confirmations", confirmed(None), idle(), Start, Begin { resume: false }),
            ("corrupt stop row fails the launch", ControlState { stop: Err(Failure::Storage), ..state(Some(collecting()), false, None) }, idle(), Start, Fail(Failure::Storage)),
            ("corrupt pause row fails the check", ControlState { paused: Err(Failure::Storage), ..state(Some(collecting()), false, None) }, idle(), Automatic, Fail(Failure::Storage)),
            ("check during a run only needs the job", ControlState { paused: Err(Failure::Storage), stop: Err(Failure::Storage), ..state(Some(job("collecting", "history", Some(at(1, 6)))), false, None) }, running(), Automatic, Yield),
            ("manual start ignores coverage", state(Some(finished_after_due.clone()), false, None), idle(), Start, Begin { resume: false }),
        ];
        for (name, control, run, mode, expected) in cases {
            assert_eq!(decide_launch(&control, &run, mode, noon()), expected, "{name}");
        }
    }

    struct FakeDart { base: String, calls: Arc<std::sync::atomic::AtomicUsize>, task: tokio::task::JoinHandle<()> }

    impl Drop for FakeDart { fn drop(&mut self) { self.task.abort(); } }

    async fn fake_dart(status: u16, body: &'static str) -> FakeDart {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = calls.clone();
        let app = axum::Router::new().fallback(move || { let counted = counted.clone(); async move { counted.fetch_add(1, Ordering::SeqCst); (axum::http::StatusCode::from_u16(status).unwrap(), body) } });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        FakeDart { base, calls, task }
    }

    fn dart_client(base: &str) -> Client { Client::new(crate::config::Secret::new("synthetic-dart-key".into()), base.into(), base.into()).unwrap() }

    async fn temp_store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir_in(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target")).unwrap();
        let store = Store::open(&dir.path().join("financials.db")).await.unwrap();
        (dir, store)
    }

    fn samsung() -> SymbolInfo {
        SymbolInfo { symbol: domain::Symbol::parse("005930").unwrap(), name: "삼성전자".into(), kind: domain::SymbolKind::Common, market: domain::Market::Kospi, nxt_enabled: false }
    }

    fn unfinished_with_target() -> Update {
        serde_json::from_value(json!({"id": 3, "status": "collecting", "phase": "planning", "from_year": 2014, "through_year": 2016, "targets": [{"code": "005930", "name": "삼성전자", "preferred": false, "resolution": {"status": "pending"}}], "companies": {}, "started_at": at(1, 5).unix(), "checked_at": null, "requested_for": at(1, 5).unix()})).unwrap()
    }

    async fn settled(service: &Financials) -> FinancialUpdatePage {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let page = service.update_status().await;
                if !matches!(page.status, Status::Planning | Status::Collecting | Status::Pausing | Status::Checking) { return page; }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await.unwrap()
    }

    #[tokio::test]
    async fn a_refused_confirmation_ends_the_run_even_when_a_latest_check_is_waiting() {
        let dart = fake_dart(200, r#"{"status":"020","message":"limit"}"#).await;
        let (_dir, store) = temp_store().await;
        store.save_update(&unfinished_with_target()).await.unwrap();
        store.save_stop(Some(&stop(Failure::RateLimited, Some(at(1, 7))))).await.unwrap();
        let service = Financials::new(Some(dart_client(&dart.base)), store, Clock::fake(at(1, 6)));
        service.control.run.lock().await.pending_symbols = Some(vec![samsung()]);
        service.resume_update(Vec::new()).await;
        let page = settled(&service).await;
        assert_eq!(dart.calls.load(Ordering::SeqCst), 1, "only the confirmation request may reach OpenDART while the stop is saved");
        assert_eq!((page.status, page.stop_reason, page.latest_check_pending), (Status::Stopped, Some(StopReason::RateLimited), false));
    }

    async fn confirm_against(dart: &str) -> (tempfile::TempDir, Store, Result<bool, Interrupt>) {
        let (dir, store) = temp_store().await;
        let limited = stop(Failure::RateLimited, Some(at(1, 5)));
        store.save_stop(Some(&limited)).await.unwrap();
        let confirmed = UpdateControl::new(true, Clock::fake(at(1, 6))).confirm(&store, limited, &dart_client(dart)).await;
        (dir, store, confirmed)
    }

    async fn saved_stop(store: &Store) -> Option<(Failure, Option<KstTime>)> {
        store.control_state().await.stop.unwrap().map(|stop| (stop.failure, stop.next_check_at.map(KstTime::from_unix)))
    }

    #[tokio::test]
    async fn a_confirmation_with_a_recorded_failure_keeps_the_stop_until_the_next_check() {
        let remote = fake_dart(500, "").await;
        let closed = { let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); format!("http://{}", listener.local_addr().unwrap()) };
        for dart in [remote.base.clone(), closed] {
            let (_dir, store, confirmed) = confirm_against(&dart).await;
            assert_eq!(confirmed, Ok(false), "{dart}");
            assert_eq!(saved_stop(&store).await, Some((Failure::RateLimited, Some(at(1, 7)))), "{dart}");
        }
    }

    #[tokio::test]
    async fn a_refused_confirmation_takes_the_new_stop_reason() {
        for (body, expected) in [(r#"{"status":"020"}"#, (Failure::RateLimited, Some(at(1, 7)))), (r#"{"status":"010"}"#, (Failure::Authentication, None))] {
            let dart = fake_dart(200, body).await;
            let (_dir, store, confirmed) = confirm_against(&dart.base).await;
            assert_eq!(confirmed, Ok(false), "{body}");
            assert_eq!(saved_stop(&store).await, Some(expected), "{body}");
        }
    }

    #[tokio::test]
    async fn a_successful_confirmation_clears_the_stop_and_a_storage_failure_aborts() {
        let dart = fake_dart(200, r#"{"status":"000"}"#).await;
        let (_dir, store, confirmed) = confirm_against(&dart.base).await;
        assert_eq!((confirmed, saved_stop(&store).await), (Ok(true), None));
        let (dir, store) = temp_store().await;
        let limited = stop(Failure::RateLimited, Some(at(1, 5)));
        store.save_stop(Some(&limited)).await.unwrap();
        let mut connection = <sqlx::SqliteConnection as sqlx::Connection>::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(dir.path().join("financials.db"))).await.unwrap();
        sqlx::query("CREATE TRIGGER keep_stop BEFORE DELETE ON financial_stop BEGIN SELECT RAISE(FAIL, 'synthetic stop write failure'); END").execute(&mut connection).await.unwrap();
        let confirmed = UpdateControl::new(true, Clock::fake(at(1, 6))).confirm(&store, limited, &dart_client(&dart.base)).await;
        assert_eq!(confirmed, Err(Interrupt::Failure(Failure::Storage)));
        assert_eq!(saved_stop(&store).await, Some((Failure::RateLimited, Some(at(1, 5)))));
    }

    #[test]
    fn status_carries_the_job_counts_and_the_runner_flags() {
        let page = status(&state(None, false, None), &RunState { automatic: true, latest_pending: true, ..running() }, noon());
        assert_eq!((page.id, page.from_year, page.through_year, page.automatic, page.latest_check_pending), (0, 2015, 2016, true, true));
        let page = status(&state(Some(collecting()), false, None), &idle(), noon());
        assert_eq!((page.id, page.phase, page.automatic, page.latest_check_pending), (3, crate::api::FinancialUpdatePhase::Recent, false, false));
        let page = status(&ControlState { stop: Err(Failure::Storage), ..state(Some(collecting()), false, None) }, &idle(), noon());
        assert_eq!((page.id, page.phase, page.total_symbols, page.status), (3, crate::api::FinancialUpdatePhase::Recent, 0, Status::Failed));
    }

    #[test]
    fn disposition_stops_on_source_refusals_aborts_on_storage_and_records_the_rest() {
        for (failure, expected) in [
            (Failure::Authentication, Disposition::StopJob),
            (Failure::RateLimited, Disposition::StopJob),
            (Failure::Storage, Disposition::AbortJob),
            (Failure::Network, Disposition::Record),
            (Failure::Remote, Disposition::Record),
            (Failure::InvalidResponse, Disposition::Record),
            (Failure::SourceUnavailable, Disposition::Record),
            (Failure::ReceiptMismatch, Disposition::Record),
        ] { assert_eq!(disposition(failure), expected, "{failure:?}"); }
    }

    #[test]
    fn interrupts_keep_only_recordable_failures_for_the_report() {
        assert_eq!(Interrupt::Halt(Halt::Paused).recorded(), Err(Interrupt::Halt(Halt::Paused)));
        assert_eq!(Interrupt::Halt(Halt::Yielded).recorded(), Err(Interrupt::Halt(Halt::Yielded)));
        assert_eq!(Interrupt::Failure(Failure::Storage).recorded(), Err(Interrupt::Failure(Failure::Storage)));
        assert_eq!(Interrupt::Failure(Failure::RateLimited).recorded(), Err(Interrupt::Failure(Failure::RateLimited)));
        assert_eq!(Interrupt::Failure(Failure::Remote).recorded(), Ok(Failure::Remote));
    }
}
