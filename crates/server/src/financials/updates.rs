use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use domain::{SymbolInfo, SymbolKind};
use serde::{Deserialize, Serialize};

use crate::api::{FinancialUpdateFailure, FinancialUpdatePage, FinancialUpdateStatus as Status, FinancialUpdatePhase as Phase, FinancialUpdateStopReason as StopReason, UnixSeconds};
use super::{Financials, CollectionScope, model::{Failure, Security, Snapshot}};

#[derive(Default)]
pub(super) struct UpdateRun { running: bool, failure: Option<Failure> }

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "status", content = "value", rename_all = "snake_case")]
enum Resolution { Pending, Unsupported, Unverified, Failed(Failure), Resolved(Security) }

#[derive(Clone, Serialize, Deserialize)]
struct Target { code: String, name: String, preferred: bool, resolution: Resolution }

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(tag = "status", content = "failure", rename_all = "snake_case")]
enum Outcome { #[default] Pending, Running, Complete, Failed(Failure) }

#[derive(Clone, Serialize, Deserialize)]
struct Company { security: Security, outcome: Outcome, #[serde(default)] history: Outcome }

impl Company {
    fn progress(&mut self, phase: Phase) -> &mut Outcome {
        if phase == Phase::Recent { &mut self.outcome } else { &mut self.history }
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
}

fn failure(value: Failure) -> String { serde_json::to_value(value).unwrap().as_str().unwrap().to_owned() }

impl Update {
    fn empty(year: i32) -> Self {
        Self { id: 0, status: Status::Idle, phase: Phase::Planning, from_year: (year - 2).max(2015), through_year: year, targets: Vec::new(), companies: BTreeMap::new(), started_at: None, checked_at: None }
    }

    fn page(&self) -> FinancialUpdatePage {
        let mut page = FinancialUpdatePage { id: self.id, status: self.status, phase: self.phase, stop_reason: None, history_completed_companies: 0, history_failed_companies: 0, recent_failed_companies: 0, history_complete: false, from_year: self.from_year, through_year: self.through_year, total_symbols: self.targets.len(), processed_symbols: 0, unsupported_symbols: 0, unverified_symbols: 0, unverified_dividends: 0, total_companies: self.companies.len(), completed_companies: 0, failed_companies: 0, started_at: self.started_at.map(UnixSeconds), last_checked_at: self.checked_at.map(UnixSeconds), failure: None, failures: Vec::new() };
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

impl Financials {
    pub async fn update_status(&self) -> FinancialUpdatePage {
        let run = self.update.lock().await;
        let stored = match self.store() {
            Ok(store) => store.update().await,
            Err(error) => Err(error),
        };
        let paused = match self.store() { Ok(store) => store.paused().await, Err(error) => Err(error) };
        let mut page = stored.as_ref().ok().and_then(|job| job.as_ref()).cloned().unwrap_or_else(|| Update::empty(self.clock.now().kst_date().year())).page();
        if let Some(error) = stored.err().or(paused.as_ref().err().copied()).or(run.failure) { page.status = Status::Failed; page.failure = Some(failure(error)); page.stop_reason = Some(StopReason::Storage); }
        else if self.client.is_none() { page.status = Status::NotConfigured; if paused.unwrap_or(false) { page.stop_reason = Some(StopReason::User); } }
        else if paused.unwrap_or(false) { page.status = if run.running { Status::Pausing } else { Status::Paused }; page.stop_reason = Some(StopReason::User); }
        else if !run.running && matches!(page.status, Status::Planning | Status::Collecting) { page.status = Status::Interrupted; page.stop_reason = Some(StopReason::Interrupted); }
        page
    }

    pub async fn start_update(self: &Arc<Self>, symbols: Vec<SymbolInfo>) -> FinancialUpdatePage {
        self.launch_update(symbols, false).await
    }

    pub async fn resume_update(self: &Arc<Self>) -> FinancialUpdatePage { self.launch_update(Vec::new(), true).await }

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

    async fn launch_update(self: &Arc<Self>, symbols: Vec<SymbolInfo>, resume: bool) -> FinancialUpdatePage {
        if self.client.is_none() { return self.update_status().await; }
        let mut run = self.update.lock().await;
        if run.running { drop(run); return self.update_status().await; }
        let result = async {
            let store = self.store()?;
            let previous = store.update().await?;
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
                update.targets = symbols.into_iter().map(|info| Target { code: info.symbol.as_wire(), name: info.name, preferred: info.kind == SymbolKind::Preferred, resolution: if matches!(info.kind, SymbolKind::Common | SymbolKind::Preferred) { Resolution::Pending } else { Resolution::Unsupported } }).collect();
                update
            };
            update.status = if update.phase == Phase::Planning { Status::Planning } else { Status::Collecting };
            store.save_update(&update).await?;
            let through_date = domain::KstTime::from_unix(update.started_at.unwrap_or_else(|| self.clock.now().unix())).kst_date().yyyymmdd();
            self.client.as_ref().unwrap().begin_job(store.clone(), update.id, through_date).await?;
            if resume { store.set_paused(false).await?; }
            self.client.as_ref().unwrap().pause(false);
            Ok::<_, Failure>(Some(update))
        }.await;
        match result {
            Ok(Some(update)) => {
                run.running = true;
                run.failure = None;
                let service = self.clone();
                tokio::spawn(async move {
                    let result = service.perform_update(update).await;
                    let mut run = service.update.lock().await;
                    let result = match result {
                        Ok(Some(update)) if !service.client.as_ref().unwrap().is_paused() => match service.store() {
                            Ok(store) => store.save_update(&update).await,
                            Err(error) => Err(error),
                        },
                        Ok(_) => Ok(()),
                        Err(error) => Err(error),
                    };
                    run.running = false;
                    if let Err(error) = result { run.failure = Some(error); }
                });
            }
            Ok(None) => { if resume { run.failure = None; } }
            Err(error) => run.failure = Some(error),
        }
        drop(run);
        self.update_status().await
    }

    async fn perform_update(self: &Arc<Self>, mut update: Update) -> Result<Option<Update>, Failure> {
        let store = self.store()?;
        for index in 0..update.targets.len() {
            if self.client.as_ref().unwrap().is_paused() { return Ok(None); }
            if !matches!(update.targets[index].resolution, Resolution::Pending) { continue; }
            let target = &update.targets[index];
            let resolved = self.security(&target.code, target.preferred, true).await;
            update.targets[index].resolution = match resolved {
                Ok((Some(security), _)) => {
                    update.companies.entry(security.company.corp_code.clone()).or_insert_with(|| Company { security: security.clone(), outcome: Outcome::Pending, history: Outcome::Pending });
                    Resolution::Resolved(security)
                }
                Ok((None, _)) => Resolution::Unverified,
                Err(Failure::Paused) => return Ok(None),
                Err(Failure::Storage) => return Err(Failure::Storage),
                Err(error) => Resolution::Failed(error),
            };
            store.save_update(&update).await?;
        }
        if update.phase == Phase::Planning { update.phase = Phase::Recent; }
        update.status = Status::Collecting;
        store.save_update(&update).await?;
        for phase in [Phase::Recent, Phase::History] {
            if self.client.as_ref().unwrap().is_paused() { return Ok(None); }
            if phase == Phase::Recent && update.phase == Phase::History { continue; }
            update.phase = phase;
            store.save_update(&update).await?;
            let companies: Vec<_> = update.companies.keys().cloned().collect();
            for corp in companies {
                if self.client.as_ref().unwrap().is_paused() { return Ok(None); }
                let company = update.companies.get_mut(&corp).unwrap();
                if matches!(company.progress(phase), Outcome::Complete | Outcome::Failed(_)) { continue; }
                let security = company.security.clone();
                let scope = if phase == Phase::Recent {
                    if matches!(company.outcome, Outcome::Running) { CollectionScope::ResumedRecent(update.through_year) } else { CollectionScope::Recent(update.through_year) }
                } else { CollectionScope::History(update.through_year) };
                let outcome = if scope.years().is_empty() { Outcome::Complete } else {
                    let company = update.companies.get_mut(&corp).unwrap();
                    *company.progress(phase) = Outcome::Running;
                    store.save_update(&update).await?;
                    let mut result = self.update_company_scope(&security.stock_code, security.share_class.as_deref() != Some("보통주"), true, scope).await;
                    while result.status == "collecting" {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        result = self.read(&security.stock_code).await;
                    }
                    if result.failure == Some(Failure::Storage) { return Err(Failure::Storage); }
                    if self.client.as_ref().unwrap().is_paused() { return Ok(None); }
                    let reports = result.collection.working_reports();
                    let error = result.failure.or(result.collection.disclosure_failure).or_else(|| reports.values().filter(|report| scope.years().contains(&report.business_year)).find_map(|report| report.statement.failure.or(report.dividends.failure).or_else(|| report.statement.data.as_ref().and_then(|statement| statement.source_failure))));
                    if error == Some(Failure::Storage) { return Err(Failure::Storage); }
                    if let Some(error) = error { Outcome::Failed(error) }
                    else if scope.years().all(|year| super::model::REPORT_CODES.iter().all(|code| reports.get(&format!("{year}/{code}")).is_some_and(|report| report.statement.checked_at.is_some() && (*code != "11011" || report.dividends.checked_at.is_some())))) { Outcome::Complete }
                    else { Outcome::Failed(Failure::InvalidResponse) }
                };
                let company = update.companies.get_mut(&corp).unwrap();
                *company.progress(phase) = outcome;
                store.save_update(&update).await?;
            }
        }
        if self.client.as_ref().unwrap().is_paused() { return Ok(None); }
        update.phase = Phase::Complete;
        update.checked_at = Some(self.clock.now().unix());
        update.status = if update.page().failures.iter().any(|entry| entry.failure.is_some()) { Status::PartialFailure } else { Status::Ready };
        Ok(Some(update))
    }

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
