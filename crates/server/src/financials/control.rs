use std::collections::BTreeMap;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

use domain::{KstTime, SymbolInfo};
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::api::{FinancialUpdatePage, FinancialUpdatePhase as Phase, FinancialUpdateStatus as Status, FinancialUpdateStopReason as StopReason, UnixSeconds};
use crate::clock::Clock;
use super::Financials;
use super::client::{Client, Fault, Request};
use super::model::{Collection, Failure, Halt, Interrupt};
use super::schedule::{due_check, next_check};
use super::store::Store;
use super::updates::{Update, failure_name};

#[derive(Clone, Serialize, Deserialize)]
struct Stop { failure: Failure, next_check_at: Option<i64>, request: Request }

pub(super) struct ControlState { pub job: Option<Update>, paused: bool, stop: Option<Stop>, legacy_confirmed_at: Option<i64> }

#[derive(Clone, Copy, Default)]
struct RunState { configured: bool, automatic: bool, running: bool, probing: bool, failure: Option<Failure>, latest_pending: bool }

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Launch { Start, Resume, Automatic }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Decision { Unchanged, Fail(Failure), Yield, Declined, Release, Begin { resume: bool } }

fn decide_launch(control: Result<&ControlState, Failure>, run: &RunState, mode: Launch, now: KstTime) -> Decision {
    let automatic = mode == Launch::Automatic;
    let due = due_check(now).unix();
    if !run.configured { return Decision::Unchanged; }
    if run.running {
        return match control {
            _ if !automatic || run.probing => Decision::Unchanged,
            Err(error) => Decision::Fail(error),
            Ok(state) if state.job.as_ref().is_some_and(|job| job.planned_before(due)) => Decision::Yield,
            Ok(_) => Decision::Unchanged,
        };
    }
    if automatic && run.failure.is_some() { return Decision::Unchanged; }
    let state = match control { Ok(state) => state, Err(error) => return Decision::Fail(error) };
    let active = state.job.as_ref().is_some_and(Update::is_active);
    let resume = match mode {
        Launch::Start => false,
        Launch::Resume => true,
        Launch::Automatic => {
            if state.paused { return Decision::Declined; }
            if let Some(stop) = &state.stop && (stop.failure != Failure::RateLimited || stop.next_check_at.is_none_or(|at| at > now.unix())) { return Decision::Declined; }
            if !active && state.job.as_ref().is_some_and(|job| job.covers(now.kst_date().year(), due, state.legacy_confirmed_at)) { return Decision::Declined; }
            state.stop.is_some() || active
        }
    };
    if (state.paused || state.stop.is_some()) && !resume { Decision::Declined }
    else if resume && !active { Decision::Release }
    else { Decision::Begin { resume } }
}

fn status(control: Result<&ControlState, Failure>, run: &RunState, now: KstTime) -> FinancialUpdatePage {
    let mut page = control.ok().and_then(|state| state.job.as_ref()).map_or_else(|| Update::empty(now.kst_date().year()).page(), Update::page);
    match (control, run.failure) {
        (Err(error), _) | (Ok(_), Some(error)) => { page.status = Status::Failed; page.failure = Some(failure_name(error)); page.stop_reason = Some(StopReason::Storage); }
        _ if !run.configured => { page.status = Status::NotConfigured; page.stop_reason = Some(StopReason::NotConfigured); }
        (Ok(state), None) if state.paused => { page.status = if run.running { Status::Pausing } else { Status::Paused }; page.stop_reason = Some(StopReason::User); }
        (Ok(ControlState { stop: Some(stop), .. }), None) => {
            page.status = if run.probing { Status::Checking } else if run.running { Status::Pausing } else { Status::Stopped };
            page.failure = Some(failure_name(stop.failure));
            page.stop_reason = Some(if stop.failure == Failure::Authentication { StopReason::Authentication } else { StopReason::RateLimited });
            page.next_check_at = stop.next_check_at.map(UnixSeconds);
            page.can_resume = !run.running;
        }
        _ if !run.running && matches!(page.status, Status::Planning | Status::Collecting) => { page.status = Status::Interrupted; page.stop_reason = Some(StopReason::Interrupted); }
        _ => {}
    }
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

impl Failure {
    pub(super) fn recorded(self) -> Result<Failure, Interrupt> {
        if disposition(self) == Disposition::Record { Ok(self) } else { Err(Interrupt::Abort(self)) }
    }
}

impl Fault {
    pub(super) fn recorded(self) -> Result<Failure, Interrupt> {
        match self { Fault::Halt(halt) => Err(Interrupt::Halt(halt)), Fault::Failure(failure) => failure.recorded() }
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
pub(super) struct JobContext { pub store: Store, pub journal: String, pub through_date: String, signal: Arc<Signal>, clock: Clock }

impl JobContext {
    pub(super) fn check(&self) -> Result<(), Halt> { self.signal.check() }

    pub(super) async fn stop_on(&self, failure: Failure, request: Request) -> Result<(), Failure> {
        if disposition(failure) != Disposition::StopJob { return Ok(()); }
        self.store.save_stop(Some(&Stop { failure, next_check_at: next_limit_check(failure, self.clock.now()), request })).await
    }
}

fn next_limit_check(failure: Failure, now: KstTime) -> Option<i64> { (failure == Failure::RateLimited).then(|| next_check(now).unix()) }

impl UpdateControl {
    pub(super) fn new(configured: bool, clock: Clock) -> Self {
        Self { configured, clock, automatic: AtomicBool::new(false), run: Default::default(), signal: Default::default(), finished: Default::default() }
    }

    pub(super) fn enable_automatic(&self) { self.automatic.store(true, Ordering::SeqCst); }

    pub(super) async fn finished(&self) { self.finished.notified().await }

    pub(super) fn check(&self) -> Result<(), Halt> { self.signal.check() }

    fn run_state(&self, run: &UpdateRun) -> RunState {
        RunState { configured: self.configured, automatic: self.automatic.load(Ordering::SeqCst), running: run.running, probing: run.probing, failure: run.failure, latest_pending: run.pending_symbols.is_some() }
    }

    pub(super) async fn begin_company(&self, corp: &str) {
        let mut run = self.run.lock().await;
        run.collecting = Some(corp.into());
        run.company_failures.remove(corp);
    }

    pub(super) async fn finish_company(&self, corp: &str, result: &Result<Collection, Interrupt>) {
        let mut run = self.run.lock().await;
        run.collecting = None;
        if let Err(Interrupt::Abort(failure)) = *result {
            tracing::warn!(?failure, "재무 자료를 수집하지 못했습니다");
            run.company_failures.insert(corp.into(), failure);
        }
    }

    pub(super) async fn collection_state(&self, corp: &str) -> CollectionState {
        let run = self.run.lock().await;
        CollectionState { collecting: run.running && run.collecting.as_deref() == Some(corp), failure: run.company_failures.get(corp).copied() }
    }

    pub(super) async fn save(&self, store: &Store, job: &Update) -> Result<(), Failure> { store.save_update(job).await }

    async fn page(&self, store: Result<&Store, Failure>) -> FinancialUpdatePage {
        let run = self.run.lock().await;
        let control = match store { Ok(store) => store.control_state().await, Err(error) => Err(error) };
        status(control.as_ref().map_err(|failure| *failure), &self.run_state(&run), self.clock.now())
    }

    async fn pause(&self, store: Result<&Store, Failure>) {
        let mut run = self.run.lock().await;
        let result = async {
            let store = store?;
            if store.control_state().await?.job.is_some_and(|job| job.is_active()) {
                self.signal.pause(true);
                store.set_paused(true).await?;
            }
            Ok::<_, Failure>(())
        }.await;
        if let Err(error) = result { run.failure = Some(error); }
    }

    async fn release(&self, store: &Store) -> Result<(), Failure> {
        store.set_paused(false).await?;
        self.signal.pause(false);
        Ok(())
    }

    async fn confirm(&self, store: &Store, mut stop: Stop, client: &Client) -> Result<bool, Interrupt> {
        let failure = match client.replay(&stop.request).await {
            Ok(()) => { store.save_stop(None).await?; return Ok(true); }
            Err(Fault::Halt(halt)) => return Err(halt.into()),
            Err(Fault::Failure(failure)) => failure,
        };
        match disposition(failure) {
            Disposition::AbortJob => return Err(failure.into()),
            Disposition::StopJob => stop.failure = failure,
            Disposition::Record => {}
        }
        stop.next_check_at = next_limit_check(stop.failure, self.clock.now());
        store.save_stop(Some(&stop)).await?;
        Ok(false)
    }
}

impl Store {
    pub(super) async fn control_state(&self) -> Result<ControlState, Failure> {
        let row = sqlx::query("SELECT (SELECT body FROM financial_update WHERE id = 1) AS job, (SELECT paused FROM financial_update_control WHERE id = 1) AS paused, (SELECT body FROM financial_stop WHERE id = 1) AS stop").fetch_one(self.pool()).await.map_err(|_| Failure::Storage)?;
        let job: Option<Update> = row.try_get::<Option<&str>, _>("job").map_err(|_| Failure::Storage)?.map(|body| serde_json::from_str(body).map_err(|_| Failure::Storage)).transpose()?;
        let paused = row.try_get::<Option<bool>, _>("paused").map_err(|_| Failure::Storage)?.unwrap_or(false);
        let stop = row.try_get::<Option<&str>, _>("stop").map_err(|_| Failure::Storage)?.map(|body| serde_json::from_str(body).map_err(|_| Failure::Storage)).transpose()?;
        let legacy_confirmed_at = match job.as_ref().and_then(Update::legacy_companies) { Some(corps) => self.confirmed_at(&corps).await?, None => None };
        Ok(ControlState { job, paused, stop, legacy_confirmed_at })
    }

    async fn set_paused(&self, paused: bool) -> Result<(), Failure> {
        sqlx::query("INSERT INTO financial_update_control VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET paused = excluded.paused").bind(paused).execute(self.pool()).await.map_err(|_| Failure::Storage)?;
        Ok(())
    }

    async fn save_stop(&self, stop: Option<&Stop>) -> Result<(), Failure> {
        if let Some(stop) = stop {
            let body = serde_json::to_string(stop).map_err(|_| Failure::Storage)?;
            sqlx::query("INSERT INTO financial_stop VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body").bind(body).execute(self.pool()).await.map_err(|_| Failure::Storage)?;
        } else { sqlx::query("DELETE FROM financial_stop").execute(self.pool()).await.map_err(|_| Failure::Storage)?; }
        Ok(())
    }

    async fn save_update(&self, update: &Update) -> Result<(), Failure> {
        let body = serde_json::to_string(update).map_err(|_| Failure::Storage)?;
        sqlx::query("INSERT INTO financial_update VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body").bind(body).execute(self.pool()).await.map_err(|_| Failure::Storage)?;
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
        let mut run = self.control.run.lock().await;
        let control = match self.store() { Ok(store) => store.control_state().await, Err(error) => Err(error) };
        match decide_launch(control.as_ref().map_err(|failure| *failure), &self.control.run_state(&run), mode, self.clock.now()) {
            Decision::Unchanged => {}
            Decision::Fail(error) => run.failure = Some(error),
            Decision::Yield => { run.pending_symbols = Some(symbols); self.control.signal.yield_to_latest(true); }
            Decision::Declined => if mode == Launch::Resume { run.failure = None; },
            Decision::Release => match self.store() {
                Ok(store) => match self.control.release(store).await { Ok(()) => if mode == Launch::Resume { run.failure = None; }, Err(error) => run.failure = Some(error) },
                Err(error) => run.failure = Some(error),
            },
            Decision::Begin { resume } => match self.begin_update(control, symbols, resume).await {
                Ok((update, stop)) => {
                    run.running = true;
                    run.probing = stop.is_some();
                    run.failure = None;
                    let service = self.clone();
                    tokio::spawn(async move { service.execute_update(update, stop).await; });
                }
                Err(error) => run.failure = Some(error),
            },
        }
        drop(run);
        self.update_status().await
    }

    async fn begin_update(&self, control: Result<ControlState, Failure>, symbols: Vec<SymbolInfo>, resume: bool) -> Result<(Update, Option<Stop>), Failure> {
        let control = control?;
        let store = self.store()?;
        let update = Update::plan(control.job, symbols, self.control.automatic.load(Ordering::SeqCst), self.clock.now());
        self.prepare_update(&update).await?;
        if resume { store.set_paused(false).await?; }
        self.control.signal.pause(false);
        Ok((update, control.stop))
    }

    async fn prepare_update(&self, update: &Update) -> Result<(), Failure> {
        let store = self.store()?;
        store.save_update(update).await?;
        self.control.signal.yield_to_latest(false);
        let job = JobContext { store: store.clone(), journal: update.journal(), through_date: update.through_date(self.clock.now()), signal: self.control.signal.clone(), clock: self.clock.clone() };
        self.client.as_ref().unwrap().begin_job(job).await
    }

    async fn execute_update(self: &Arc<Self>, mut update: Update, mut stop: Option<Stop>) {
        loop {
            let result = async {
                if let Some(stop) = stop.take() {
                    let confirmed = self.control.confirm(self.store()?, stop, self.client.as_ref().unwrap()).await?;
                    self.control.run.lock().await.probing = false;
                    self.control.finished.notify_one();
                    if !confirmed { return Ok(None); }
                }
                self.perform_update(update).await.map(Some)
            }.await;
            let mut result = match result { Err(Interrupt::Halt(_)) => Ok(None), Err(Interrupt::Abort(failure)) => Err(failure), Ok(update) => Ok(update) };
            let mut run = self.control.run.lock().await;
            if result.is_ok() && !self.control.signal.is_paused() && let Some(symbols) = run.pending_symbols.take() {
                let next = async {
                    let mut next = match result.unwrap() { Some(next) => next, None => self.store()?.control_state().await?.job.ok_or(Failure::Storage)? };
                    next.recheck(symbols, self.clock.now());
                    self.prepare_update(&next).await?;
                    Ok::<_, Failure>(next)
                }.await;
                match next {
                    Ok(next) => { update = next; drop(run); continue; }
                    Err(error) => result = Err(error),
                }
            }
            let result = match result {
                Ok(Some(update)) if !self.control.signal.is_paused() => match self.store() {
                    Ok(store) => store.save_update(&update).await,
                    Err(error) => Err(error),
                },
                Ok(_) => Ok(()),
                Err(error) => Err(error),
            };
            run.running = false;
            run.probing = false;
            run.pending_symbols = None;
            self.control.finished.notify_one();
            if let Err(error) = result && disposition(error) != Disposition::StopJob { run.failure = Some(error); }
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::model::Halt;
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

    fn state(job: Option<Update>, paused: bool, stop: Option<Stop>) -> ControlState { ControlState { job, paused, stop, legacy_confirmed_at: None } }

    fn idle() -> RunState { RunState { configured: true, ..RunState::default() } }

    fn running() -> RunState { RunState { running: true, ..idle() } }

    type Summary = (Status, Option<StopReason>, Option<&'static str>, Option<KstTime>, bool);

    fn summary(page: FinancialUpdatePage) -> Summary {
        let failure = page.failure.map(|failure| match failure.as_str() { "storage" => "storage", "authentication" => "authentication", "rate_limited" => "rate_limited", other => panic!("{other}") });
        (page.status, page.stop_reason, failure, page.next_check_at.map(|at| KstTime::from_unix(at.0)), page.can_resume)
    }

    #[test]
    fn status_reports_storage_then_configuration_then_pause_then_stop_then_interruption() {
        let cases: Vec<(&str, Result<ControlState, Failure>, RunState, Summary)> = vec![
            ("nothing has run", Ok(state(None, false, None)), idle(), (Status::Idle, None, None, None, false)),
            ("unreadable store", Err(Failure::Storage), idle(), (Status::Failed, Some(StopReason::Storage), Some("storage"), None, false)),
            ("unreadable store before missing configuration", Err(Failure::Storage), RunState::default(), (Status::Failed, Some(StopReason::Storage), Some("storage"), None, false)),
            ("earlier storage failure can resume the unfinished job", Ok(state(Some(collecting()), false, None)), RunState { failure: Some(Failure::Storage), ..idle() }, (Status::Failed, Some(StopReason::Storage), Some("storage"), None, true)),
            ("storage failure before a pause", Ok(state(Some(collecting()), true, None)), RunState { failure: Some(Failure::Storage), ..idle() }, (Status::Failed, Some(StopReason::Storage), Some("storage"), None, true)),
            ("missing configuration", Ok(state(None, false, None)), RunState::default(), (Status::NotConfigured, Some(StopReason::NotConfigured), None, None, false)),
            ("missing configuration before a pause", Ok(state(Some(collecting()), true, None)), RunState::default(), (Status::NotConfigured, Some(StopReason::NotConfigured), None, None, false)),
            ("pause while the job runs", Ok(state(Some(collecting()), true, None)), running(), (Status::Pausing, Some(StopReason::User), None, None, false)),
            ("pause after the job ends", Ok(state(Some(collecting()), true, None)), idle(), (Status::Paused, Some(StopReason::User), None, None, true)),
            ("pause before a limit stop", Ok(state(Some(collecting()), true, Some(stop(Failure::RateLimited, Some(at(2, 7)))))), idle(), (Status::Paused, Some(StopReason::User), None, None, true)),
            ("authentication stop", Ok(state(Some(collecting()), false, Some(stop(Failure::Authentication, None)))), idle(), (Status::Stopped, Some(StopReason::Authentication), Some("authentication"), None, true)),
            ("limit stop waits for its saved check", Ok(state(Some(collecting()), false, Some(stop(Failure::RateLimited, Some(at(2, 7)))))), idle(), (Status::Stopped, Some(StopReason::RateLimited), Some("rate_limited"), Some(at(2, 7)), true)),
            ("confirmation request in flight", Ok(state(Some(collecting()), false, Some(stop(Failure::RateLimited, Some(at(1, 7)))))), RunState { probing: true, ..running() }, (Status::Checking, Some(StopReason::RateLimited), Some("rate_limited"), Some(at(1, 7)), false)),
            ("stop reached while the job runs", Ok(state(Some(collecting()), false, Some(stop(Failure::Authentication, None)))), running(), (Status::Pausing, Some(StopReason::Authentication), Some("authentication"), None, false)),
            ("unfinished job without a runner", Ok(state(Some(collecting()), false, None)), idle(), (Status::Interrupted, Some(StopReason::Interrupted), None, None, true)),
            ("planning job without a runner", Ok(state(Some(job("planning", "planning", Some(at(1, 7)))), false, None)), idle(), (Status::Interrupted, Some(StopReason::Interrupted), None, None, true)),
            ("running job", Ok(state(Some(collecting()), false, None)), running(), (Status::Collecting, None, None, None, false)),
            ("finished job", Ok(state(Some(job("ready", "complete", Some(at(1, 7)))), false, None)), idle(), (Status::Ready, None, None, None, false)),
            ("automatic schedule shows the next 07:00", Ok(state(Some(job("ready", "complete", Some(at(1, 7)))), false, None)), RunState { automatic: true, ..idle() }, (Status::Ready, None, None, Some(at(2, 7)), false)),
            ("automatic schedule yields to the saved limit check", Ok(state(Some(collecting()), false, Some(stop(Failure::RateLimited, Some(at(3, 7)))))), RunState { automatic: true, ..idle() }, (Status::Stopped, Some(StopReason::RateLimited), Some("rate_limited"), Some(at(3, 7)), true)),
            ("automatic schedule hides the check while paused", Ok(state(Some(collecting()), true, None)), RunState { automatic: true, ..idle() }, (Status::Paused, Some(StopReason::User), None, None, true)),
            ("automatic schedule without configuration", Ok(state(None, false, None)), RunState { automatic: true, ..RunState::default() }, (Status::NotConfigured, Some(StopReason::NotConfigured), None, None, false)),
        ];
        for (name, control, run, expected) in cases {
            assert_eq!(summary(status(control.as_ref().map_err(|failure| *failure), &run, noon())), expected, "{name}");
        }
    }

    type LaunchCase = (&'static str, Result<ControlState, Failure>, RunState, Launch, Decision);

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
        let confirmed = |at: Option<KstTime>| ControlState { legacy_confirmed_at: at.map(KstTime::unix), ..state(Some(legacy(super::tests::at(1, 6), false)), false, None) };
        let cases: Vec<LaunchCase> = vec![
            ("missing configuration never starts", Ok(state(None, false, None)), RunState::default(), Start, Unchanged),
            ("missing configuration never resumes", Ok(state(Some(collecting()), true, None)), RunState::default(), Resume, Unchanged),
            ("missing configuration never checks", Ok(state(None, false, None)), RunState::default(), Automatic, Unchanged),
            ("manual start joins the running job", Ok(state(Some(collecting()), false, None)), running(), Start, Unchanged),
            ("resume joins the running job", Ok(state(Some(collecting()), true, None)), running(), Resume, Unchanged),
            ("check yields a job planned before 07:00", Ok(state(Some(job("collecting", "history", Some(at(1, 6)))), false, None)), running(), Automatic, Yield),
            ("check yields a job planned before scheduling existed", Ok(state(Some(job("collecting", "history", None)), false, None)), running(), Automatic, Yield),
            ("check joins a job planned after 07:00", Ok(state(Some(collecting()), false, None)), running(), Automatic, Unchanged),
            ("check never yields a confirmation request", Ok(state(Some(job("collecting", "history", Some(at(1, 6)))), false, Some(limit_due()))), RunState { probing: true, ..running() }, Automatic, Unchanged),
            ("check during a run reports an unreadable store", Err(Failure::Storage), running(), Automatic, Fail(Failure::Storage)),
            ("manual start during a run ignores an unreadable store", Err(Failure::Storage), running(), Start, Unchanged),
            ("check waits for an explicit resume after a storage failure", Err(Failure::Storage), RunState { failure: Some(Failure::Storage), ..idle() }, Automatic, Unchanged),
            ("manual start reports an unreadable store", Err(Failure::Storage), idle(), Start, Fail(Failure::Storage)),
            ("manual start creates the first job", Ok(state(None, false, None)), idle(), Start, Begin { resume: false }),
            ("manual start continues an interrupted job", Ok(state(Some(collecting()), false, None)), idle(), Start, Begin { resume: false }),
            ("manual start keeps a pause", Ok(state(Some(collecting()), true, None)), idle(), Start, Declined),
            ("manual start keeps a stop", Ok(state(Some(collecting()), false, Some(limit_due()))), idle(), Start, Declined),
            ("resume continues a paused job", Ok(state(Some(collecting()), true, None)), idle(), Resume, Begin { resume: true }),
            ("resume confirms a stopped job", Ok(state(Some(collecting()), false, Some(stop(Failure::Authentication, None)))), idle(), Resume, Begin { resume: true }),
            ("resume confirms a limit stop before its check time", Ok(state(Some(collecting()), false, Some(limit_later()))), idle(), Resume, Begin { resume: true }),
            ("resume without an unfinished job only clears the pause", Ok(state(Some(finished_after_due.clone()), true, None)), idle(), Resume, Release),
            ("resume with nothing to continue", Ok(state(None, false, None)), idle(), Resume, Release),
            ("check keeps a pause", Ok(state(Some(collecting()), true, None)), idle(), Automatic, Declined),
            ("check keeps a pause over a due limit check", Ok(state(Some(collecting()), true, Some(limit_due()))), idle(), Automatic, Declined),
            ("check keeps an authentication stop", Ok(state(Some(collecting()), false, Some(stop(Failure::Authentication, None)))), idle(), Automatic, Declined),
            ("check waits for the saved limit check", Ok(state(Some(collecting()), false, Some(limit_later()))), idle(), Automatic, Declined),
            ("check keeps a limit stop without a check time", Ok(state(Some(collecting()), false, Some(stop(Failure::RateLimited, None)))), idle(), Automatic, Declined),
            ("check confirms a due limit stop", Ok(state(Some(collecting()), false, Some(limit_due()))), idle(), Automatic, Begin { resume: true }),
            ("check confirms a due limit stop at the second", Ok(state(Some(collecting()), false, Some(stop(Failure::RateLimited, Some(noon()))))), idle(), Automatic, Begin { resume: true }),
            ("check with a due limit stop and no unfinished job clears the pause", Ok(state(Some(finished_before_due.clone()), false, Some(limit_due()))), idle(), Automatic, Release),
            ("check with a due limit stop and a covered job", Ok(state(Some(finished_after_due.clone()), false, Some(limit_due()))), idle(), Automatic, Declined),
            ("check resumes an interrupted job", Ok(state(Some(collecting()), false, None)), idle(), Automatic, Begin { resume: true }),
            ("check after an earlier failure stays quiet", Ok(state(None, false, None)), RunState { failure: Some(Failure::Storage), ..idle() }, Automatic, Unchanged),
            ("check creates the first job", Ok(state(None, false, None)), idle(), Automatic, Begin { resume: false }),
            ("check skips a job planned after 07:00", Ok(state(Some(finished_after_due.clone()), false, None)), idle(), Automatic, Declined),
            ("check repeats a job planned before 07:00", Ok(state(Some(finished_before_due.clone()), false, None)), idle(), Automatic, Begin { resume: false }),
            ("check extends an older scope", Ok(state(Some(old_scope), false, None)), idle(), Automatic, Begin { resume: false }),
            ("check repeats a legacy job with targets started before 07:00", Ok(state(Some(legacy(at(1, 6), true)), false, None)), idle(), Automatic, Begin { resume: false }),
            ("check skips a legacy job with targets started after 07:00", Ok(state(Some(legacy(at(1, 7), true)), false, None)), idle(), Automatic, Declined),
            ("check repeats a legacy job without confirmed companies", Ok(confirmed(None)), idle(), Automatic, Begin { resume: false }),
            ("check repeats a legacy job confirmed before 07:00", Ok(confirmed(Some(at(1, 6)))), idle(), Automatic, Begin { resume: false }),
            ("check skips a legacy job confirmed after 07:00", Ok(confirmed(Some(at(1, 7)))), idle(), Automatic, Declined),
            ("manual start ignores coverage", Ok(state(Some(finished_after_due.clone()), false, None)), idle(), Start, Begin { resume: false }),
        ];
        for (name, control, run, mode, expected) in cases {
            assert_eq!(decide_launch(control.as_ref().map_err(|failure| *failure), &run, mode, noon()), expected, "{name}");
        }
    }

    #[test]
    fn status_carries_the_job_counts_and_the_runner_flags() {
        let page = status(Ok(&state(None, false, None)), &RunState { automatic: true, latest_pending: true, ..running() }, noon());
        assert_eq!((page.id, page.from_year, page.through_year, page.automatic, page.latest_check_pending), (0, 2015, 2016, true, true));
        let page = status(Ok(&state(Some(collecting()), false, None)), &idle(), noon());
        assert_eq!((page.id, page.phase, page.automatic, page.latest_check_pending), (3, crate::api::FinancialUpdatePhase::Recent, false, false));
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
    fn faults_become_recorded_failures_or_job_interrupts() {
        assert_eq!(Fault::Halt(Halt::Paused).recorded(), Err(Interrupt::Halt(Halt::Paused)));
        assert_eq!(Fault::Halt(Halt::Yielded).recorded(), Err(Interrupt::Halt(Halt::Yielded)));
        assert_eq!(Fault::Failure(Failure::Storage).recorded(), Err(Interrupt::Abort(Failure::Storage)));
        assert_eq!(Fault::Failure(Failure::RateLimited).recorded(), Err(Interrupt::Abort(Failure::RateLimited)));
        assert_eq!(Fault::Failure(Failure::Remote).recorded(), Ok(Failure::Remote));
    }
}
