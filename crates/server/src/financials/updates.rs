use std::collections::BTreeMap;
use std::sync::Arc;

use domain::{KstTime, SymbolInfo, SymbolKind};
use serde::{Deserialize, Serialize};

use crate::api::{FinancialUpdateFailure, FinancialUpdatePage, FinancialUpdateStatus as Status, FinancialUpdatePhase as Phase, UnixSeconds};
use super::{Financials, CollectionScope, company_records::ReadResolution, control::JobContext, model::{Failure, Interrupt, Security}, schedule::due_check};

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Coverage { Covered, Uncovered, Companies }

pub(super) fn failure_name(value: Failure) -> String { serde_json::to_value(value).unwrap().as_str().unwrap().to_owned() }

impl Update {
    pub(super) fn empty(year: i32) -> Self {
        Self { id: 0, status: Status::Idle, phase: Phase::Planning, from_year: (year - 2).max(2015), through_year: year, targets: Vec::new(), companies: BTreeMap::new(), started_at: None, checked_at: None, requested_for: None, generation: 0, check_started_at: None }
    }

    pub(super) fn page(&self) -> FinancialUpdatePage {
        let mut page = FinancialUpdatePage { id: self.id, status: self.status, phase: self.phase, stop_reason: None, next_check_at: None, can_resume: false, automatic: false, latest_check_pending: false, history_completed_companies: 0, history_failed_companies: 0, recent_failed_companies: 0, history_complete: false, from_year: self.from_year, through_year: self.through_year, total_symbols: self.targets.len(), processed_symbols: 0, unsupported_symbols: 0, unverified_symbols: 0, unverified_dividends: 0, total_companies: self.companies.len(), completed_companies: 0, failed_companies: 0, started_at: self.started_at.map(UnixSeconds), last_checked_at: self.checked_at.map(UnixSeconds), failure: None, failures: Vec::new() };
        for target in &self.targets {
            if !matches!(target.resolution, Resolution::Pending) { page.processed_symbols += 1; }
            let (reason, error) = match &target.resolution {
                Resolution::Unsupported => { page.unsupported_symbols += 1; continue; }
                Resolution::Unverified => { page.unverified_symbols += 1; (Some("company_mapping_unverified".into()), None) }
                Resolution::Failed(error) => (None, Some(failure_name(*error))),
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
                    page.failures.push(FinancialUpdateFailure { code: corp.clone(), name: company.security.company.name.clone(), reason: None, failure: Some(failure_name(error)) });
                }
                Outcome::Pending | Outcome::Running => {}
            }
            if let Outcome::Failed(error) = company.history && !matches!(company.outcome, Outcome::Failed(_)) {
                page.failed_companies += 1;
                page.failures.push(FinancialUpdateFailure { code: corp.clone(), name: company.security.company.name.clone(), reason: None, failure: Some(failure_name(error)) });
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
    pub(super) fn is_active(&self) -> bool { matches!(self.status, Status::Planning | Status::Collecting) }

    pub(super) fn planned_before(&self, due: i64) -> bool { self.requested_for.is_none_or(|at| at < due) }

    fn has_unresolved_targets(&self) -> bool { self.targets.iter().any(|target| matches!(target.resolution, Resolution::Pending | Resolution::Unverified | Resolution::Failed(_))) }

    pub(super) fn company_codes(&self) -> Vec<&str> { self.companies.keys().map(String::as_str).collect() }

    pub(super) fn coverage(&self, year: i32, due: i64) -> Coverage {
        let covered = match self.requested_for {
            _ if self.through_year < year => false,
            Some(at) => at >= due,
            None if self.has_unresolved_targets() => self.started_at.is_some_and(|at| at >= due),
            None => return Coverage::Companies,
        };
        if covered { Coverage::Covered } else { Coverage::Uncovered }
    }

    pub(super) fn plan(previous: Option<Update>, symbols: Vec<SymbolInfo>, automatic: bool, now: KstTime) -> Self {
        let due = due_check(now).unix();
        let mut update = match previous {
            Some(previous) if previous.is_active() => previous,
            previous => {
                let mut update = Update::empty(now.kst_date().year());
                update.checked_at = previous.as_ref().and_then(|job| job.checked_at);
                update.id = previous.map_or(1, |job| job.id + 1);
                update.status = Status::Planning;
                update.started_at = Some(now.unix());
                update.requested_for = Some(due);
                update.targets = targets(symbols.clone());
                update
            }
        };
        if automatic && update.planned_before(due) {
            let current = if symbols.is_empty() { update.targets.clone() } else { targets(symbols) };
            update.recheck_targets(current, now);
        }
        update.status = if update.phase == Phase::Planning { Status::Planning } else { Status::Collecting };
        update
    }

    pub(super) fn journal(&self) -> String { if self.generation == 0 { self.id.to_string() } else { format!("{}/{}", self.id, self.generation) } }

    pub(super) fn through_date(&self, now: KstTime) -> String { KstTime::from_unix(self.check_started_at.or(self.started_at).unwrap_or_else(|| now.unix())).kst_date().yyyymmdd() }

    pub(super) fn recheck(&mut self, symbols: Vec<SymbolInfo>, now: KstTime) { self.recheck_targets(targets(symbols), now); }

    fn recheck_targets(&mut self, targets: Vec<Target>, now: KstTime) {
        self.targets = targets.into_iter().map(|mut target| { if !matches!(target.resolution, Resolution::Unsupported) { target.resolution = Resolution::Pending; } target }).collect();
        self.companies.clear();
        self.generation += 1;
        self.requested_for = Some(due_check(now).unix());
        self.check_started_at = Some(now.unix());
        self.through_year = now.kst_date().year();
        self.from_year = (self.through_year - 2).max(2015);
        self.phase = Phase::Planning;
        self.status = Status::Planning;
    }
}

impl Financials {
    pub(super) async fn perform_update(self: &Arc<Self>, mut update: Update, job: &JobContext) -> Result<Update, Interrupt> {
        for index in 0..update.targets.len() {
            job.check()?;
            if !matches!(update.targets[index].resolution, Resolution::Pending) { continue; }
            let target = &update.targets[index];
            let resolved = self.security(&target.code, target.preferred).await;
            update.targets[index].resolution = match resolved {
                Ok(Some(security)) => {
                    update.companies.entry(security.company.corp_code.clone()).or_insert_with(|| Company { security: security.clone(), outcome: Outcome::Pending, changes: Outcome::Pending, history: Outcome::Pending });
                    Resolution::Resolved(security)
                }
                Ok(None) => Resolution::Unverified,
                Err(fault) => Resolution::Failed(fault.recorded()?),
            };
            job.save(&update).await?;
        }
        if update.phase == Phase::Planning { update.phase = Phase::Recent; }
        update.status = Status::Collecting;
        job.save(&update).await?;
        for phase in [Phase::Recent, Phase::Changes, Phase::History] {
            job.check()?;
            if phase == Phase::Recent && matches!(update.phase, Phase::Changes | Phase::History) { continue; }
            if phase == Phase::Changes && update.phase == Phase::History { continue; }
            update.phase = phase;
            job.save(&update).await?;
            let companies: Vec<_> = update.companies.keys().cloned().collect();
            for corp in companies {
                job.check()?;
                let company = update.companies.get_mut(&corp).unwrap();
                if matches!(company.progress(phase), Outcome::Complete | Outcome::Failed(_)) { continue; }
                let security = company.security.clone();
                let scope = if phase == Phase::Recent {
                    if matches!(company.outcome, Outcome::Running) { CollectionScope::ResumedRecent(update.through_year) } else { CollectionScope::Recent(update.through_year) }
                } else if phase == Phase::Changes { CollectionScope::Changes(update.through_year) } else { CollectionScope::History(update.through_year) };
                let outcome = if scope.years().is_empty() { Outcome::Complete } else {
                    let company = update.companies.get_mut(&corp).unwrap();
                    *company.progress(phase) = Outcome::Running;
                    job.save(&update).await?;
                    self.control.begin_company(&corp).await;
                    let result = self.collect(&security, scope, job).await;
                    self.control.finish_company(&corp, &result).await;
                    let collection = result?;
                    job.check()?;
                    let reports = collection.working_reports();
                    let error = collection.disclosure_failure.or_else(|| reports.values().filter(|report| scope.years().contains(&report.business_year)).find_map(|report| report.statement.failure.or(report.dividends.failure).or_else(|| report.statement.data.as_ref().and_then(|statement| statement.source_failure))));
                    if let Some(error) = error { Outcome::Failed(Interrupt::Failure(error).recorded()?) }
                    else if matches!(scope, CollectionScope::Changes(_)) || scope.years().all(|year| super::model::REPORT_CODES.iter().all(|code| reports.get(&format!("{year}/{code}")).is_some_and(|report| report.statement.checked_at.is_some() && (*code != "11011" || report.dividends.checked_at.is_some())))) { Outcome::Complete }
                    else { Outcome::Failed(Failure::InvalidResponse) }
                };
                let company = update.companies.get_mut(&corp).unwrap();
                *company.progress(phase) = outcome;
                if phase == Phase::History && matches!(company.history, Outcome::Complete) { company.changes = Outcome::Complete; }
                job.save(&update).await?;
            }
            if phase == Phase::Recent { update.checked_at = Some(self.clock.now().unix()); job.save(&update).await?; }
        }
        job.check()?;
        update.phase = Phase::Complete;
        update.status = if update.page().failures.iter().any(|entry| entry.failure.is_some()) { Status::PartialFailure } else { Status::Ready };
        Ok(update)
    }


    pub(super) async fn read_resolution(&self, stock: &str) -> ReadResolution {
        let update = match self.store() { Ok(store) => store.job().await, Err(error) => Err(error) };
        match update {
            Ok(Some(update)) => match update.targets.iter().find(|target| target.code == stock).map(|target| &target.resolution) {
                Some(Resolution::Unverified) => ReadResolution::Unverified,
                Some(Resolution::Failed(error)) => ReadResolution::Failed(*error),
                _ => ReadResolution::Unchanged,
            },
            Err(error) => ReadResolution::Failed(error),
            Ok(None) => ReadResolution::Unchanged,
        }
    }
}
