use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use domain::{SymbolInfo, SymbolKind};
use serde::{Deserialize, Serialize};

use crate::api::{FinancialUpdateFailure, FinancialUpdatePage, FinancialUpdateStatus as Status, UnixSeconds};
use super::{Financials, model::{Failure, Security, Snapshot}};

#[derive(Default)]
pub(super) struct UpdateRun { running: bool, failure: Option<Failure> }

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "status", content = "value", rename_all = "snake_case")]
enum Resolution { Pending, Unsupported, Unverified, Failed(Failure), Resolved(Security) }

#[derive(Clone, Serialize, Deserialize)]
struct Target { code: String, name: String, preferred: bool, resolution: Resolution }

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "status", content = "failure", rename_all = "snake_case")]
enum Outcome { Pending, Running, Complete, Failed(Failure) }

#[derive(Clone, Serialize, Deserialize)]
struct Company { security: Security, outcome: Outcome }

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Update {
    id: u64,
    status: Status,
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
        Self { id: 0, status: Status::Idle, from_year: (year - 2).max(2015), through_year: year, targets: Vec::new(), companies: BTreeMap::new(), started_at: None, checked_at: None }
    }

    fn page(&self) -> FinancialUpdatePage {
        let mut page = FinancialUpdatePage { id: self.id, status: self.status, from_year: self.from_year, through_year: self.through_year, total_symbols: self.targets.len(), processed_symbols: 0, unsupported_symbols: 0, unverified_symbols: 0, unverified_dividends: 0, total_companies: self.companies.len(), completed_companies: 0, failed_companies: 0, started_at: self.started_at.map(UnixSeconds), last_checked_at: self.checked_at.map(UnixSeconds), failure: None, failures: Vec::new() };
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
            match company.outcome {
                Outcome::Complete => page.completed_companies += 1,
                Outcome::Failed(error) => {
                    page.failed_companies += 1;
                    page.failures.push(FinancialUpdateFailure { code: corp.clone(), name: company.security.company.name.clone(), reason: None, failure: Some(failure(error)) });
                }
                Outcome::Pending | Outcome::Running => {}
            }
        }
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
        let mut page = stored.as_ref().ok().and_then(|job| job.as_ref()).cloned().unwrap_or_else(|| Update::empty(self.clock.now().kst_date().year())).page();
        if let Some(error) = stored.err().or(run.failure) { page.status = Status::Failed; page.failure = Some(failure(error)); }
        else if self.client.is_none() { page.status = Status::NotConfigured; }
        else if !run.running && matches!(page.status, Status::Planning | Status::Collecting) { page.status = Status::Interrupted; }
        page
    }

    pub async fn start_update(self: &Arc<Self>, symbols: Vec<SymbolInfo>) -> FinancialUpdatePage {
        if self.client.is_none() { return self.update_status().await; }
        let mut run = self.update.lock().await;
        if run.running { drop(run); return self.update_status().await; }
        let result = async {
            let store = self.store()?;
            let previous = store.update().await?;
            let mut update = if let Some(mut previous) = previous.as_ref().filter(|job| matches!(job.status, Status::Planning | Status::Collecting)).cloned() {
                for company in previous.companies.values_mut() { if matches!(company.outcome, Outcome::Running) { company.outcome = Outcome::Pending; } }
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
            update.status = Status::Planning;
            store.save_update(&update).await?;
            Ok::<_, Failure>(update)
        }.await;
        match result {
            Ok(update) => {
                run.running = true;
                run.failure = None;
                let service = self.clone();
                tokio::spawn(async move {
                    let result = service.perform_update(update).await;
                    let mut run = service.update.lock().await;
                    run.running = false;
                    run.failure = result.err();
                });
            }
            Err(error) => run.failure = Some(error),
        }
        drop(run);
        self.update_status().await
    }

    async fn perform_update(self: &Arc<Self>, mut update: Update) -> Result<(), Failure> {
        let store = self.store()?;
        for index in 0..update.targets.len() {
            if !matches!(update.targets[index].resolution, Resolution::Pending) { continue; }
            let target = &update.targets[index];
            let resolved = self.security(&target.code, target.preferred, true).await;
            update.targets[index].resolution = match resolved {
                Ok((Some(security), _)) => {
                    update.companies.entry(security.company.corp_code.clone()).or_insert_with(|| Company { security: security.clone(), outcome: Outcome::Pending });
                    Resolution::Resolved(security)
                }
                Ok((None, _)) => Resolution::Unverified,
                Err(Failure::Storage) => return Err(Failure::Storage),
                Err(error) => Resolution::Failed(error),
            };
            store.save_update(&update).await?;
        }
        update.status = Status::Collecting;
        store.save_update(&update).await?;
        let companies: Vec<_> = update.companies.keys().cloned().collect();
        for corp in companies {
            let company = &update.companies[&corp];
            if matches!(company.outcome, Outcome::Complete | Outcome::Failed(_)) { continue; }
            let security = company.security.clone();
            update.companies.get_mut(&corp).unwrap().outcome = Outcome::Running;
            store.save_update(&update).await?;
            let mut result = self.update_company_until(&security.stock_code, security.share_class.as_deref() != Some("보통주"), true, update.through_year).await;
            while result.status == "collecting" {
                tokio::time::sleep(Duration::from_millis(20)).await;
                result = self.read(&security.stock_code).await;
            }
            let error = result.failure.or(result.collection.disclosure_failure).or_else(|| result.collection.working_reports().values().find_map(|report| report.statement.failure.or(report.dividends.failure).or_else(|| report.statement.data.as_ref().and_then(|statement| statement.source_failure))));
            if error == Some(Failure::Storage) { return Err(Failure::Storage); }
            update.companies.get_mut(&corp).unwrap().outcome = if let Some(error) = error { Outcome::Failed(error) } else if result.status == "ready" { Outcome::Complete } else { Outcome::Failed(Failure::InvalidResponse) };
            store.save_update(&update).await?;
        }
        update.checked_at = Some(self.clock.now().unix());
        update.status = if update.page().failures.iter().any(|entry| entry.failure.is_some()) { Status::PartialFailure } else { Status::Ready };
        store.save_update(&update).await
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
