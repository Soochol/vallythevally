pub mod client;
pub mod calculate;
pub mod company_records;
mod control;
pub mod model;
mod routes;
mod response;
mod updates;
mod schedule;
pub mod store;
pub mod xbrl;

use std::sync::Arc;

use domain::KstDate;

use crate::clock::Clock;
use client::{Client, Row, digits, field};
use model::{Collection, Dividend, Failure, Interrupt, Security, Statement, StatementRequest, REPORT_CODES};
use company_records::{AttemptKind, CompanyRecord, ReadContext, ReadResolution, ReadSnapshot, receipt_is_current};
use store::Store;

pub use routes::routes;
use control::{CollectionState, JobContext, UpdateControl};

pub struct Financials {
    client: Option<Client>,
    store: Result<Store, Failure>,
    clock: Clock,
    control: UpdateControl,
}

enum StatementStep { Continue(StatementRequest), Done(Option<Statement>) }

#[derive(Clone, Copy)]
enum CollectionScope { Recent(i32), ResumedRecent(i32), History(i32), Changes(i32) }

impl CollectionScope {
    fn years(self) -> std::ops::RangeInclusive<i32> {
        match self { Self::Recent(year) | Self::ResumedRecent(year) => (year - 3).max(2015)..=year, Self::History(year) | Self::Changes(year) => 2015..=year - 4 }
    }
}

impl Financials {
    pub fn new(client: Option<Client>, store: Store, clock: Clock) -> Arc<Self> {
        Self::with_store(client, Ok(store), clock)
    }

    pub fn with_store(client: Option<Client>, store: Result<Store, Failure>, clock: Clock) -> Arc<Self> {
        let control = UpdateControl::new(client.is_some(), clock.clone());
        Arc::new(Self { client, store, clock, control })
    }

    fn store(&self) -> Result<&Store, Failure> {
        self.store.as_ref().map_err(|failure| *failure)
    }

    pub async fn read(&self, stock: &str) -> ReadSnapshot {
        let mut security = None;
        let mut collection = Collection::default();
        let result = async {
            let store = self.store()?;
            security = store.security(stock).await?;
            if let Some(security) = &security { collection = store.collection(&security.company.corp_code).await?; }
            Ok::<_, Failure>(())
        }.await;
        if let Err(failure) = result { return ReadSnapshot::resolve(security, collection, ReadContext::StorageFailed(failure)); }
        if self.client.is_none() { return ReadSnapshot::resolve(security, collection, ReadContext::NotConfigured); }
        let observed = match &security { Some(security) => self.control.collection_state(&security.company.corp_code).await, None => CollectionState::default() };
        let resolution = if security.is_none() { self.read_resolution(stock).await } else { ReadResolution::Unchanged };
        ReadSnapshot::resolve(security, collection, ReadContext::Configured { collecting: observed.collecting, failure: observed.failure, resolution })
    }

    async fn security(&self, stock: &str, preferred: bool) -> Result<Option<Security>, Interrupt> {
        let store = self.store()?;
        if let Some(security) = store.security(stock).await? { return Ok(Some(security)); }
        let Some(client) = &self.client else { return Ok(None); };
        let security = client.resolve(stock, preferred).await?;
        if let Some(security) = &security { store.save_security(security).await?; }
        Ok(security)
    }

    async fn collect(&self, security: &Security, scope: CollectionScope, job: &JobContext) -> Result<Collection, Interrupt> {
        let client = self.client.as_ref().unwrap();
        let corp = &security.company.corp_code;
        let store = self.store()?;
        let mut record = CompanyRecord::new(store.collection(corp).await?);
        let now = self.clock.now();
        let attempt = match scope { CollectionScope::Recent(_) => AttemptKind::Recent, CollectionScope::ResumedRecent(_) => AttemptKind::ResumedRecent, _ => AttemptKind::Continue };
        let check_disclosures = record.begin_attempt(attempt, now);
        store.save(corp, record.stored()).await?;
        if check_disclosures {
            let confirmed = match client.disclosures(corp, &now.kst_date().yyyymmdd()).await {
                Ok(disclosures) => record.check_disclosures(Ok(disclosures), self.clock.now().unix()),
                Err(fault) => record.check_disclosures(Err(fault.recorded()?), now.unix()),
            };
            store.save(corp, record.stored()).await?;
            if !confirmed { return Ok(record.into_stored()); }
        }
        record.prepare_reports();
        let mut requests = std::collections::BTreeSet::new();
        for year in scope.years().rev() { for index in 0..REPORT_CODES.len() { requests.insert((year, index)); } }
        let requests: Vec<_> = if matches!(scope, CollectionScope::History(_)) { requests.into_iter().rev().collect() } else { requests.into_iter().collect() };
        for (year, index) in requests {
            job.check()?;
            let code = REPORT_CODES[index];
            let Some(mut report) = record.report(year, code, matches!(scope, CollectionScope::Changes(_))) else { continue; };
            if report.needs_statement() {
                loop {
                    let step = self.statement_step(client, corp, year, code, &report.stored().disclosures, report.pending_statement()).await;
                    let complete = match step {
                        Ok(StatementStep::Continue(next)) => { report.continue_statement(next); false }
                        result => {
                            let result = match result { Ok(StatementStep::Done(value)) => Ok(value), Ok(StatementStep::Continue(_)) => unreachable!(), Err(fault) => Err(fault.recorded()?) };
                            report.complete_statement(result, self.clock.now().unix());
                            true
                        }
                    };
                    store.save(corp, report.stored()).await?;
                    if complete { break; }
                }
            }
            if report.needs_dividends() {
                let result = match client.rows("alotMatter.json", &[("corp_code", corp.clone()), ("bsns_year", year.to_string()), ("reprt_code", code.into())]).await {
                    Ok(rows) if rows.iter().any(|row| !receipt_is_current(&report.stored().disclosures, field(row, "rcept_no"))) => Err(Failure::ReceiptMismatch),
                    Ok(rows) => dividends(rows, corp),
                    Err(fault) => Err(fault.recorded()?),
                };
                report.record_dividends(result, self.clock.now().unix());
            }
            report.finish();
            store.save(corp, record.stored()).await?;
        }
        Ok(record.into_stored())
    }

    async fn statement_step(&self, client: &Client, corp: &str, year: i32, code: &str, disclosures: &[Row], pending: Option<&StatementRequest>) -> Result<StatementStep, Interrupt> {
        let (basis, rows) = match pending {
            Some(StatementRequest::Xbrl { basis, rows }) => (*basis, rows.clone()),
            pending => {
                let basis = if pending.is_some() { model::Basis::OFS } else { model::Basis::CFS };
                return match client.statement_basis(corp, year, code, basis).await? {
                    Some(rows) => Ok(StatementStep::Continue(StatementRequest::Xbrl { basis, rows })),
                    None if basis == model::Basis::CFS => Ok(StatementStep::Continue(StatementRequest::Separate)),
                    None => Ok(StatementStep::Done(None)),
                };
            }
        };
        let mut receipts: Vec<_> = rows.iter().map(|r| field(r, "rcept_no").to_owned()).collect();
        receipts.sort();
        receipts.dedup();
        if receipts.len() != 1 { return Err(Failure::ReceiptMismatch.into()); }
        let receipt = &receipts[0];
        if !receipt_is_current(disclosures, receipt) { return Err(Failure::ReceiptMismatch.into()); }
        let (files, source_failure) = match client.archive("fnlttXbrl.xml", &[("rcept_no", receipt.clone()), ("reprt_code", code.into())]).await {
            Ok(files) => (files, None),
            Err(fault) => match fault.recorded() { Ok(failure) => (Vec::new(), Some(failure)), Err(_) => return Err(fault) },
        };
        let reporting_month = disclosures.iter().find(|r| field(r, "rcept_no") == receipt).and_then(|r| reporting_month(field(r, "report_nm")));
        let corp = corp.to_owned();
        let receipt = receipt.clone();
        let mut accounts = tokio::task::spawn_blocking(move || xbrl::accounts(rows, basis, &corp, &receipt, &files, reporting_month.as_deref())).await.map_err(|_| Failure::InvalidResponse)??;
        for account in &mut accounts {
            for verification in [&mut account.current_period, &mut account.cumulative_period] {
                if let model::Verification::Verified { context_id, source_file, .. } = verification {
                    *context_id = client.redact(context_id);
                    *source_file = client.redact(source_file);
                }
            }
        }
        Ok(StatementStep::Done(Some(Statement { basis, accounts, source_failure })))
    }
}

fn dividends(rows: Vec<Row>, corp: &str) -> Result<Option<Vec<Dividend>>, Failure> {
    if rows.is_empty() { return Ok(None); }
    if rows.iter().any(|r| field(r, "corp_code") != corp || !digits(field(r, "rcept_no"), 14)) { return Err(Failure::InvalidResponse); }
    Ok(Some(rows.into_iter().map(|fields| {
        let class = field(&fields, "stock_knd");
        let share_class = ["보통주", "우선주"].contains(&class).then(|| class.to_owned());
        let share_class_reason = share_class.is_none().then(|| "dividend_share_class_unverified".into());
        let settlement_date = fields.get("stlm_dt").filter(|s| s.len() == 10 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-' && KstDate::parse_yyyymmdd(&s.replace('-', "")).is_some()).cloned();
        let period_reason = settlement_date.is_none().then(|| "dividend_settlement_date_unverified".into());
        Dividend { fields, settlement_date, period_reason, share_class, share_class_reason }
    }).collect()))
}

fn reporting_month(title: &str) -> Option<String> {
    let (_, suffix) = title.rsplit_once('(')?;
    let month = suffix.strip_suffix(')')?;
    let (year, month) = month.split_once('.')?;
    if !digits(year, 4) || !digits(month, 2) || !(1..=12).contains(&month.parse::<u8>().ok()?) { return None; }
    Some(format!("{year}-{month}"))
}
