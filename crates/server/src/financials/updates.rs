use std::collections::BTreeMap;
use std::sync::Arc;

use domain::{SymbolInfo, SymbolKind};
use serde::{Deserialize, Serialize};

use crate::api::{FinancialUpdateFailure, FinancialUpdatePage, FinancialUpdateStatus as Status, FinancialUpdatePhase as Phase, FinancialUpdateStopReason as StopReason, UnixSeconds};
use super::{Financials, CollectionScope, model::{Failure, Security, Snapshot}};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Launch { Start, Resume, Automatic }

#[derive(Default)]
pub(super) struct UpdateRun { running: bool, probing: bool, failure: Option<Failure>, pending_symbols: Option<Vec<SymbolInfo>>, collecting: Option<String>, company_failures: BTreeMap<String, Failure> }

#[derive(Default)]
pub(super) struct CollectionState { pub collecting: bool, pub failure: Option<Failure> }

impl UpdateRun {
    fn begin_company(&mut self, corp: &str) {
        self.collecting = Some(corp.into());
        self.company_failures.remove(corp);
    }

    fn finish_company(&mut self, corp: &str, failure: Option<Failure>) {
        self.collecting = None;
        if let Some(failure) = failure.filter(|failure| !matches!(failure, Failure::Paused | Failure::Yielded)) {
            tracing::warn!(?failure, "재무 자료를 수집하지 못했습니다");
            self.company_failures.insert(corp.into(), failure);
        }
    }

    fn collection_state(&self, corp: &str) -> CollectionState {
        CollectionState { collecting: self.running && self.collecting.as_deref() == Some(corp), failure: self.company_failures.get(corp).copied() }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "status", content = "value", rename_all = "snake_case")]
enum Resolution { Pending, Unsupported, Unverified, Failed(Failure), Resolved(Security) }

#[derive(Clone, Serialize, Deserialize)]
struct Target { code: String, name: String, preferred: bool, resolution: Resolution }

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(tag = "status", content = "failure", rename_all = "snake_case")]
enum Outcome { #[default] Pending, Running, Complete, Failed(Failure) }

#[derive(Clone, Serialize, Deserialize)]
struct Company { security: Security, outcome: Outcome, #[serde(default)] changes: Outcome, #[serde(default)] history: Outcome }

impl Company {
    fn progress(&mut self, phase: Phase) -> &mut Outcome {
        match phase { Phase::Recent => &mut self.outcome, Phase::Changes => &mut self.changes, _ => &mut self.history }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Update {
    id: u64,
    status: Status,
    #[serde(default)]
    phase: Phase,
    from_year: i32,
    through_year: i32,
    targets: Vec<Target>,
    companies: BTreeMap<String, Company>,
    started_at: Option<i64>,
    checked_at: Option<i64>,
    #[serde(default)]
    requested_for: Option<i64>,
    #[serde(default)]
    generation: u64,
    #[serde(default)]
    check_started_at: Option<i64>,
}

fn failure(value: Failure) -> String { serde_json::to_value(value).unwrap().as_str().unwrap().to_owned() }

impl Update {
    fn empty(year: i32) -> Self {
        Self { id: 0, status: Status::Idle, phase: Phase::Planning, from_year: (year - 2).max(2015), through_year: year, targets: Vec::new(), companies: BTreeMap::new(), started_at: None, checked_at: None, requested_for: None, generation: 0, check_started_at: None }
    }

    fn page(&self) -> FinancialUpdatePage {
        let mut page = FinancialUpdatePage { id: self.id, status: self.status, phase: self.phase, stop_reason: None, next_check_at: None, can_resume: false, automatic: false, latest_check_pending: false, history_completed_companies: 0, history_failed_companies: 0, recent_failed_companies: 0, history_complete: false, from_year: self.from_year, through_year: self.through_year, total_symbols: self.targets.len(), processed_symbols: 0, unsupported_symbols: 0, unverified_symbols: 0, unverified_dividends: 0, total_companies: self.companies.len(), completed_companies: 0, failed_companies: 0, started_at: self.started_at.map(UnixSeconds), last_checked_at: self.checked_at.map(UnixSeconds), failure: None, failures: Vec::new() };
        for target in &self.targets {
            if !matches!(target.resolution, Resolution::Pending) { page.processed_symbols += 1; }
            let (reason, error) = match &target.resolution {
                Resolution::Unsupported => { page.unsupported_symbols += 1; continue; }
                Resolution::Unverified => { page.unverified_symbols += 1; (Some("company_mapping_unverified".into()), None) }
                Resolution::Failed(error) => (None, Some(failure(*error))),
                Resolution::Resolved(security) => { if security.share_class_reason.is_some() { page.unverified_dividends += 1; } continue; }
                Resolution::Pending => continue,
            };
            page.failures.push(FinancialUpdateFailure { code: target.code.clone(), name: target.name.clone(), reason, failure: error });
        }
        for (corp, company) in &self.companies {
            match company.history {
                Outcome::Complete => page.history_completed_companies += 1,
                Outcome::Failed(_) => page.history_failed_companies += 1,
                _ => {}
            }
            if matches!(company.outcome, Outcome::Failed(_)) { page.recent_failed_companies += 1; }
            match company.outcome {
                Outcome::Complete => page.completed_companies += 1,
                Outcome::Failed(error) => {
                    page.failed_companies += 1;
                    page.failures.push(FinancialUpdateFailure { code: corp.clone(), name: company.security.company.name.clone(), reason: None, failure: Some(failure(error)) });
                }
                Outcome::Pending | Outcome::Running => {}
            }
            if let Outcome::Failed(error) = company.history && !matches!(company.outcome, Outcome::Failed(_)) {
                page.failed_companies += 1;
                page.failures.push(FinancialUpdateFailure { code: corp.clone(), name: company.security.company.name.clone(), reason: None, failure: Some(failure(error)) });
            }
        }
        page.history_complete = self.phase == Phase::Complete && page.completed_companies == page.total_companies && page.history_completed_companies == page.total_companies && !page.failures.iter().any(|entry| entry.failure.is_some());
        page
    }
}

fn targets(symbols: Vec<SymbolInfo>) -> Vec<Target> {
    symbols.into_iter().map(|info| Target { code: info.symbol.as_wire(), name: info.name, preferred: info.kind == SymbolKind::Preferred, resolution: if matches!(info.kind, SymbolKind::Common | SymbolKind::Preferred) { Resolution::Pending } else { Resolution::Unsupported } }).collect()
}

impl Update {
    fn recheck(&mut self, targets: Vec<Target>, now: domain::KstTime) {
        self.targets = targets.into_iter().map(|mut target| { if !matches!(target.resolution, Resolution::Unsupported) { target.resolution = Resolution::Pending; } target }).collect();
        self.companies.clear();
        self.generation += 1;
        self.requested_for = Some(super::schedule::due_check(now).unix());
        self.check_started_at = Some(now.unix());
        self.through_year = now.kst_date().year();
        self.from_year = (self.through_year - 2).max(2015);
        self.phase = Phase::Planning;
        self.status = Status::Planning;
    }
}

impl Financials {
    pub async fn update_status(&self) -> FinancialUpdatePage {
        let run = self.update.lock().await;
        let stored = match self.store() {
            Ok(store) => store.update().await,
            Err(error) => Err(error),
        };
        let paused = match self.store() { Ok(store) => store.paused().await, Err(error) => Err(error) };
        let stopped = match self.store() { Ok(store) => store.stop().await, Err(error) => Err(error) };
        let mut page = stored.as_ref().ok().and_then(|job| job.as_ref()).cloned().unwrap_or_else(|| Update::empty(self.clock.now().kst_date().year())).page();
        if let Some(error) = stored.err().or(paused.as_ref().err().copied()).or(stopped.as_ref().err().copied()).or(run.failure) { page.status = Status::Failed; page.failure = Some(failure(error)); page.stop_reason = Some(StopReason::Storage); }
        else if self.client.is_none() { page.status = Status::NotConfigured; page.stop_reason = Some(StopReason::NotConfigured); }
        else if paused.unwrap_or(false) { page.status = if run.running { Status::Pausing } else { Status::Paused }; page.stop_reason = Some(StopReason::User); }
        else if let Some(stop) = stopped.unwrap_or(None) { page.status = if run.probing { Status::Checking } else if run.running { Status::Pausing } else { Status::Stopped }; page.failure = Some(failure(stop.failure)); page.stop_reason = Some(if stop.failure == Failure::Authentication { StopReason::Authentication } else { StopReason::RateLimited }); page.next_check_at = stop.next_check_at.map(UnixSeconds); page.can_resume = !run.running; }
        else if !run.running && matches!(page.status, Status::Planning | Status::Collecting) { page.status = Status::Interrupted; page.stop_reason = Some(StopReason::Interrupted); }
        page.automatic = self.automatic.load(std::sync::atomic::Ordering::SeqCst);
        page.latest_check_pending = run.pending_symbols.is_some();
        if matches!(page.status, Status::Paused | Status::Interrupted) || (page.status == Status::Failed && page.id > 0 && page.phase != Phase::Complete) { page.can_resume = true; }
        if page.stop_reason.is_none() && self.client.is_some() && self.automatic.load(std::sync::atomic::Ordering::SeqCst) {
            page.next_check_at = Some(UnixSeconds(super::schedule::next_check(self.clock.now()).unix()));
        }
        page
    }

    pub async fn start_update(self: &Arc<Self>, symbols: Vec<SymbolInfo>) -> FinancialUpdatePage {
        self.launch_update(symbols, Launch::Start).await
    }

    pub async fn resume_update(self: &Arc<Self>, symbols: Vec<SymbolInfo>) -> FinancialUpdatePage { self.launch_update(symbols, Launch::Resume).await }

    pub async fn pause_update(&self) -> FinancialUpdatePage {
        let mut run = self.update.lock().await;
        let result = async {
            let store = self.store()?;
            if store.update().await?.is_some_and(|job| matches!(job.status, Status::Planning | Status::Collecting)) {
                if let Some(client) = &self.client { client.pause(true); }
                store.set_paused(true).await?;
            }
            Ok::<_, Failure>(())
        }.await;
        if let Err(error) = result { run.failure = Some(error); }
        drop(run);
        self.update_status().await
    }

    pub(super) async fn launch_update(self: &Arc<Self>, symbols: Vec<SymbolInfo>, mode: Launch) -> FinancialUpdatePage {
        if self.client.is_none() { return self.update_status().await; }
        let mut run = self.update.lock().await;
        if run.running {
            if mode == Launch::Automatic && !run.probing {
                let previous = match self.store() { Ok(store) => store.update().await, Err(error) => Err(error) };
                match previous {
                    Ok(Some(previous)) if previous.requested_for.is_none_or(|at| at < super::schedule::due_check(self.clock.now()).unix()) => {
                        run.pending_symbols = Some(symbols);
                        self.client.as_ref().unwrap().yield_to_latest(true);
                    }
                    Err(error) => run.failure = Some(error),
                    _ => {}
                }
            }
            drop(run);
            return self.update_status().await;
        }
        if mode == Launch::Automatic && run.failure.is_some() { drop(run); return self.update_status().await; }
        let result = async {
            let store = self.store()?;
            let previous = store.update().await?;
            let stop = store.stop().await?;
            let mut resume = mode == Launch::Resume;
            if mode == Launch::Automatic {
                if store.paused().await? { return Ok(None); }
                if let Some(stop) = &stop {
                    if stop.failure != Failure::RateLimited || stop.next_check_at.is_none_or(|at| at > self.clock.now().unix()) { return Ok(None); }
                    resume = true;
                }
                if let Some(previous) = &previous {
                    if matches!(previous.status, Status::Planning | Status::Collecting) { resume = true; }
                    else if previous.through_year >= self.clock.now().kst_date().year() {
                        let due = super::schedule::due_check(self.clock.now()).unix();
                        let covered = match previous.requested_for {
                            Some(at) => at >= due,
                            None if previous.targets.iter().any(|target| matches!(target.resolution, Resolution::Pending | Resolution::Unverified | Resolution::Failed(_))) => previous.started_at.is_some_and(|at| at >= due),
                            None => store.confirmed_since(&previous.companies.keys().map(String::as_str).collect::<Vec<_>>(), due).await?,
                        };
                        if covered { return Ok(None); }
                    }
                }
            }
            if stop.is_some() && !resume { return Ok(None); }
            if store.paused().await? && !resume { return Ok(None); }
            if resume && !previous.as_ref().is_some_and(|job| matches!(job.status, Status::Planning | Status::Collecting)) {
                store.set_paused(false).await?;
                self.client.as_ref().unwrap().pause(false);
                return Ok(None);
            }
            let mut update = if let Some(previous) = previous.as_ref().filter(|job| matches!(job.status, Status::Planning | Status::Collecting)).cloned() {
                previous
            } else {
                let mut update = Update::empty(self.clock.now().kst_date().year());
                update.checked_at = previous.as_ref().and_then(|job| job.checked_at);
                update.id = previous.map_or(1, |job| job.id + 1);
                update.status = Status::Planning;
                update.started_at = Some(self.clock.now().unix());
                update.requested_for = Some(super::schedule::due_check(self.clock.now()).unix());
                update.targets = targets(symbols.clone());
                update
            };
            if self.automatic.load(std::sync::atomic::Ordering::SeqCst) && update.requested_for.is_none_or(|at| at < super::schedule::due_check(self.clock.now()).unix()) {
                let current = if symbols.is_empty() { update.targets.clone() } else { targets(symbols) };
                update.recheck(current, self.clock.now());
            }
            update.status = if update.phase == Phase::Planning { Status::Planning } else { Status::Collecting };
            self.prepare_update(&update).await?;
            if resume { store.set_paused(false).await?; }
            self.client.as_ref().unwrap().pause(false);
            Ok::<_, Failure>(Some((update, stop)))
        }.await;
        match result {
            Ok(Some((update, stop))) => {
                run.running = true;
                run.probing = stop.is_some();
                run.failure = None;
                let service = self.clone();
                tokio::spawn(async move { service.execute_update(update, stop).await; });
            }
            Ok(None) => { if mode == Launch::Resume { run.failure = None; } }
            Err(error) => run.failure = Some(error),
        }
        drop(run);
        self.update_status().await
    }

    async fn prepare_update(&self, update: &Update) -> Result<(), Failure> {
        let store = self.store()?;
        store.save_update(update).await?;
        let through_date = domain::KstTime::from_unix(update.check_started_at.or(update.started_at).unwrap_or_else(|| self.clock.now().unix())).kst_date().yyyymmdd();
        let client = self.client.as_ref().unwrap();
        client.yield_to_latest(false);
        client.begin_job(store.clone(), update.id, update.generation, through_date, self.clock.clone()).await
    }

    async fn execute_update(self: &Arc<Self>, mut update: Update, mut stop: Option<super::client::Stop>) {
        loop {
            let mut result = async {
                if let Some(stop) = stop.take() {
                    let confirmed = match self.client.as_ref().unwrap().confirm(stop).await { Err(Failure::Paused | Failure::Yielded) => return Ok(None), other => other? };
                    self.update.lock().await.probing = false;
                    self.update_finished.notify_one();
                    if !confirmed { return Ok(None); }
                }
                self.perform_update(update).await
            }.await;
            let mut run = self.update.lock().await;
            if result.is_ok() && !self.client.as_ref().unwrap().is_paused() && let Some(symbols) = run.pending_symbols.take() {
                let next = async {
                    let mut next = match result.unwrap() { Some(next) => next, None => self.store()?.update().await?.ok_or(Failure::Storage)? };
                    next.recheck(targets(symbols), self.clock.now());
                    self.prepare_update(&next).await?;
                    Ok::<_, Failure>(next)
                }.await;
                match next {
                    Ok(next) => { update = next; drop(run); continue; }
                    Err(error) => result = Err(error),
                }
            }
            let result = match result {
                Ok(Some(update)) if !self.client.as_ref().unwrap().is_paused() => match self.store() {
                    Ok(store) => store.save_update(&update).await,
                    Err(error) => Err(error),
                },
                Ok(_) => Ok(()),
                Err(error) => Err(error),
            };
            run.running = false;
            run.probing = false;
            run.pending_symbols = None;
            self.update_finished.notify_one();
            if let Err(error) = result && !matches!(error, Failure::Authentication | Failure::RateLimited | Failure::Paused | Failure::Yielded) { run.failure = Some(error); }
            break;
        }
    }

    async fn perform_update(self: &Arc<Self>, mut update: Update) -> Result<Option<Update>, Failure> {
        let store = self.store()?;
        for index in 0..update.targets.len() {
            if self.client.as_ref().unwrap().is_paused() || self.client.as_ref().unwrap().is_yielding() { return Ok(None); }
            if !matches!(update.targets[index].resolution, Resolution::Pending) { continue; }
            let target = &update.targets[index];
            let resolved = self.security(&target.code, target.preferred).await;
            update.targets[index].resolution = match resolved {
                Ok(Some(security)) => {
                    update.companies.entry(security.company.corp_code.clone()).or_insert_with(|| Company { security: security.clone(), outcome: Outcome::Pending, changes: Outcome::Pending, history: Outcome::Pending });
                    Resolution::Resolved(security)
                }
                Ok(None) => Resolution::Unverified,
                Err(Failure::Paused | Failure::Yielded) => return Ok(None),
                Err(error @ (Failure::Storage | Failure::Authentication | Failure::RateLimited)) => return Err(error),
                Err(error) => Resolution::Failed(error),
            };
            store.save_update(&update).await?;
        }
        if update.phase == Phase::Planning { update.phase = Phase::Recent; }
        update.status = Status::Collecting;
        store.save_update(&update).await?;
        for phase in [Phase::Recent, Phase::Changes, Phase::History] {
            if self.client.as_ref().unwrap().is_paused() || self.client.as_ref().unwrap().is_yielding() { return Ok(None); }
            if phase == Phase::Recent && matches!(update.phase, Phase::Changes | Phase::History) { continue; }
            if phase == Phase::Changes && update.phase == Phase::History { continue; }
            update.phase = phase;
            store.save_update(&update).await?;
            let companies: Vec<_> = update.companies.keys().cloned().collect();
            for corp in companies {
                if self.client.as_ref().unwrap().is_paused() || self.client.as_ref().unwrap().is_yielding() { return Ok(None); }
                let company = update.companies.get_mut(&corp).unwrap();
                if matches!(company.progress(phase), Outcome::Complete | Outcome::Failed(_)) { continue; }
                let security = company.security.clone();
                let scope = if phase == Phase::Recent {
                    if matches!(company.outcome, Outcome::Running) { CollectionScope::ResumedRecent(update.through_year) } else { CollectionScope::Recent(update.through_year) }
                } else if phase == Phase::Changes { CollectionScope::Changes(update.through_year) } else { CollectionScope::History(update.through_year) };
                let outcome = if scope.years().is_empty() { Outcome::Complete } else {
                    let company = update.companies.get_mut(&corp).unwrap();
                    *company.progress(phase) = Outcome::Running;
                    store.save_update(&update).await?;
                    self.update.lock().await.begin_company(&corp);
                    let result = self.collect(&security, scope).await;
                    self.update.lock().await.finish_company(&corp, result.as_ref().err().copied());
                    let collection = match result {
                        Ok(collection) => collection,
                        Err(Failure::Paused | Failure::Yielded) => return Ok(None),
                        Err(error) => return Err(error),
                    };
                    if self.client.as_ref().unwrap().is_paused() || self.client.as_ref().unwrap().is_yielding() { return Ok(None); }
                    let reports = collection.working_reports();
                    let error = collection.disclosure_failure.or_else(|| reports.values().filter(|report| scope.years().contains(&report.business_year)).find_map(|report| report.statement.failure.or(report.dividends.failure).or_else(|| report.statement.data.as_ref().and_then(|statement| statement.source_failure))));
                    if let Some(error @ (Failure::Storage | Failure::Authentication | Failure::RateLimited)) = error { return Err(error); }
                    if let Some(error) = error { Outcome::Failed(error) }
                    else if matches!(scope, CollectionScope::Changes(_)) || scope.years().all(|year| super::model::REPORT_CODES.iter().all(|code| reports.get(&format!("{year}/{code}")).is_some_and(|report| report.statement.checked_at.is_some() && (*code != "11011" || report.dividends.checked_at.is_some())))) { Outcome::Complete }
                    else { Outcome::Failed(Failure::InvalidResponse) }
                };
                let company = update.companies.get_mut(&corp).unwrap();
                *company.progress(phase) = outcome;
                if phase == Phase::History && matches!(company.history, Outcome::Complete) { company.changes = Outcome::Complete; }
                store.save_update(&update).await?;
            }
            if phase == Phase::Recent { update.checked_at = Some(self.clock.now().unix()); store.save_update(&update).await?; }
        }
        if self.client.as_ref().unwrap().is_paused() || self.client.as_ref().unwrap().is_yielding() { return Ok(None); }
        update.phase = Phase::Complete;
        update.status = if update.page().failures.iter().any(|entry| entry.failure.is_some()) { Status::PartialFailure } else { Status::Ready };
        Ok(Some(update))
    }

    pub(super) async fn collection_state(&self, corp: &str) -> CollectionState { self.update.lock().await.collection_state(corp) }

    pub(super) async fn read_resolution(&self, stock: &str, snapshot: &mut Snapshot) {
        let update = match self.store() { Ok(store) => store.update().await, Err(error) => Err(error) };
        match update {
            Ok(Some(update)) => if let Some(target) = update.targets.iter().find(|target| target.code == stock) {
                match target.resolution {
                    Resolution::Unverified => { snapshot.status = "unsupported"; snapshot.reason = Some("company_mapping_unverified"); }
                    Resolution::Failed(error) => { snapshot.status = "failed"; snapshot.failure = Some(error); }
                    _ => {}
                }
            },
            Err(error) => { snapshot.status = "failed"; snapshot.failure = Some(error); }
            Ok(None) => {}
        }
    }
}
