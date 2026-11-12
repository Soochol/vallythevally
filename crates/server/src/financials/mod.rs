pub mod client;
pub mod calculate;
pub mod model;
mod routes;
mod updates;
pub mod store;
pub mod xbrl;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use domain::{KstDate, KstTime};

use crate::clock::Clock;
use client::{Client, Row, digits, field};
use model::{Collection, Dividend, Failure, Report, Security, Snapshot, Statement, StatementRequest, REPORT_CODES};
use store::Store;

pub use routes::routes;

pub struct Financials {
    client: Option<Client>,
    store: Result<Store, Failure>,
    clock: Clock,
    resolving: Mutex<HashMap<String, ResolutionAttempt>>,
    runs: Mutex<HashMap<String, Run>>,
    update: tokio::sync::Mutex<updates::UpdateRun>,
}

struct Run {
    running: bool,
    attempted_at: i64,
    failure: Option<Failure>,
    unpersisted_refresh: bool,
    pending_refresh: bool,
}

type ResolutionAttempt = Arc<tokio::sync::Mutex<Option<ResolutionFailure>>>;

struct ResolutionFailure {
    attempted_at: i64,
    failure: Failure,
    refresh_requested: bool,
}

enum StatementStep { Continue(StatementRequest), Done(Option<Statement>) }

#[derive(Clone, Copy)]
enum CollectionScope { Recent(i32), ResumedRecent(i32), History(i32) }

impl CollectionScope {
    fn years(self) -> std::ops::RangeInclusive<i32> {
        match self { Self::Recent(year) | Self::ResumedRecent(year) => (year - 3).max(2015)..=year, Self::History(year) => 2015..=year - 4 }
    }
}

impl Financials {
    pub fn new(client: Option<Client>, store: Store, clock: Clock) -> Arc<Self> {
        Self::with_store(client, Ok(store), clock)
    }

    pub fn with_store(client: Option<Client>, store: Result<Store, Failure>, clock: Clock) -> Arc<Self> {
        Arc::new(Self { client, store, clock, resolving: Mutex::new(HashMap::new()), runs: Mutex::new(HashMap::new()), update: Default::default() })
    }

    fn store(&self) -> Result<&Store, Failure> {
        self.store.as_ref().map_err(|failure| *failure)
    }

    pub async fn read(&self, stock: &str) -> Snapshot {
        let mut snapshot = Snapshot { status: "not_configured", security: None, collection: Collection::default(), failure: None, reason: None };
        let result = async {
            let store = self.store()?;
            snapshot.security = store.security(stock).await?;
            if let Some(security) = &snapshot.security { snapshot.collection = store.collection(&security.company.corp_code).await?; }
            Ok::<_, Failure>(())
        }.await;
        if let Err(failure) = result { snapshot.status = "failed"; snapshot.failure = Some(failure); return snapshot; }
        if self.client.is_none() { return snapshot; }
        let run = snapshot.security.as_ref().and_then(|s| self.runs.lock().unwrap().get(&s.company.corp_code).map(|r| (r.running, r.failure)));
        snapshot.failure = run.and_then(|r| r.1);
        snapshot.status = if run.is_some_and(|r| r.0) { "collecting" }
            else if has_failures(&snapshot.collection) || snapshot.failure.is_some() { "partial_failure" }
            else if snapshot.collection.reports.is_empty() { "not_collected" }
            else if has_pending(&snapshot.collection) { "stale" }
            else { "ready" };
        if snapshot.security.is_none() { self.read_resolution(stock, &mut snapshot).await; }
        snapshot
    }

    pub async fn update_company(self: &Arc<Self>, stock: &str, preferred: bool, force: bool) -> Snapshot {
        self.update_company_scope(stock, preferred, force, CollectionScope::Recent(self.clock.now().kst_date().year())).await
    }

    async fn update_company_scope(self: &Arc<Self>, stock: &str, preferred: bool, force: bool, scope: CollectionScope) -> Snapshot {
        let mut snapshot = Snapshot { status: "not_configured", security: None, collection: Collection::default(), failure: None, reason: None };
        let store = match self.store() {
            Ok(store) => store,
            Err(failure) => { snapshot.status = "failed"; snapshot.failure = Some(failure); return snapshot; }
        };
        let result = self.security(stock, preferred, force).await;
        let force = match result {
            Ok((Some(security), refresh_requested)) => { snapshot.security = Some(security); force || refresh_requested }
            Ok((None, _)) => {
                snapshot.status = if self.client.is_some() { "unsupported" } else { "not_configured" };
                snapshot.reason = Some("company_mapping_unverified");
                return snapshot;
            }
            Err(failure) => { snapshot.status = "failed"; snapshot.failure = Some(failure); return snapshot; }
        };
        let corp = &snapshot.security.as_ref().unwrap().company.corp_code;
        snapshot.collection = match store.collection(corp).await {
            Ok(collection) => collection,
            Err(failure) => { snapshot.status = "failed"; snapshot.failure = Some(failure); return snapshot; }
        };
        if self.client.is_none() { return snapshot; }
        let now = self.clock.now();
        let daily = snapshot.collection.last_checked_at.is_none_or(|t| KstTime::from_unix(t).kst_date() != now.kst_date());
        let incomplete = scope.years().any(|year| REPORT_CODES.iter().any(|code| !snapshot.collection.working_reports().contains_key(&format!("{year}/{code}"))));
        let pending = has_pending(&snapshot.collection);
        let mut runs = self.runs.lock().unwrap();
        if force && let Some(run) = runs.get_mut(corp) && run.running { run.pending_refresh = true; }
        let run = runs.get(corp);
        let failed = has_failures(&snapshot.collection) || run.is_some_and(|run| run.failure.is_some());
        let last_attempt = snapshot.collection.last_attempt_at.into_iter().chain(run.map(|run| run.attempted_at)).max();
        let retry_due = last_attempt.is_none_or(|t| now.unix() - t >= 60);
        if (force || ((daily || failed || incomplete || pending) && retry_due)) && !run.is_some_and(|run| run.running) {
            let unpersisted_refresh = (force && matches!(scope, CollectionScope::Recent(_))) || run.is_some_and(|run| run.unpersisted_refresh);
            runs.insert(corp.clone(), Run { running: true, attempted_at: now.unix(), failure: None, unpersisted_refresh, pending_refresh: false });
            let service = self.clone();
            let security = snapshot.security.as_ref().unwrap().clone();
            tokio::spawn(async move {
                let mut register_refresh = unpersisted_refresh;
                loop {
                    let failure = service.collect(&security, register_refresh, scope).await.err().filter(|failure| *failure != Failure::Paused);
                    if let Some(failure) = failure {
                        tracing::warn!(?failure, "재무 자료 수집을 저장하지 못했습니다");
                    }
                    let mut runs = service.runs.lock().unwrap();
                    let run = runs.get_mut(&security.company.corp_code).unwrap();
                    run.failure = failure;
                    run.unpersisted_refresh |= run.pending_refresh;
                    if failure.is_none() && run.pending_refresh {
                        run.pending_refresh = false;
                        run.attempted_at = service.clock.now().unix();
                        register_refresh = true;
                    } else {
                        run.pending_refresh = false;
                        run.running = false;
                        break;
                    }
                }
            });
        }
        let run = runs.get(corp);
        snapshot.failure = run.and_then(|run| run.failure);
        snapshot.status = if run.is_some_and(|run| run.running) { "collecting" } else if failed { "partial_failure" } else if pending || incomplete { "stale" } else { "ready" };
        snapshot
    }

    async fn security(&self, stock: &str, preferred: bool, force: bool) -> Result<(Option<Security>, bool), Failure> {
        let attempt = self.resolving.lock().unwrap().entry(stock.into()).or_default().clone();
        let mut attempt = attempt.lock().await;
        let refresh_requested = force || attempt.as_ref().is_some_and(|attempt| attempt.refresh_requested);
        let store = self.store()?;
        if let Some(security) = store.security(stock).await? {
            *attempt = None;
            return Ok((Some(security), refresh_requested));
        }
        let Some(client) = &self.client else { return Ok((None, refresh_requested)); };
        let now = self.clock.now().unix();
        if !force && let Some(attempt) = attempt.as_ref() && now - attempt.attempted_at < 60 { return Err(attempt.failure); }
        let result = async {
            let security = client.resolve(stock, preferred).await?;
            if let Some(security) = &security { store.save_security(security).await?; }
            Ok(security)
        }.await;
        match result {
            Ok(security) => { *attempt = None; Ok((security, refresh_requested)) }
            Err(failure) => {
                *attempt = Some(ResolutionFailure { attempted_at: now, failure, refresh_requested });
                Err(failure)
            }
        }
    }

    async fn collect(&self, security: &Security, register_refresh: bool, scope: CollectionScope) -> Result<(), Failure> {
        let client = self.client.as_ref().unwrap();
        let corp = &security.company.corp_code;
        let store = self.store()?;
        let mut collection = store.collection(corp).await?;
        let now = self.clock.now();
        collection.last_attempt_at = Some(now.unix());
        if register_refresh || (collection.refresh_version == 0 && collection.last_checked_at.is_none()) { collection.refresh_version += 1; }
        store.save(corp, &collection).await?;
        self.runs.lock().unwrap().get_mut(corp).unwrap().unpersisted_refresh = false;
        let daily = matches!(scope, CollectionScope::Recent(_)) && collection.last_checked_at.is_none_or(|t| KstTime::from_unix(t).kst_date() != now.kst_date());
        if daily || matches!(scope, CollectionScope::ResumedRecent(_)) || collection.last_checked_at.is_none() || collection.disclosure_version < collection.refresh_version || collection.disclosure_failure.is_some() {
            match client.disclosures(corp, &now.kst_date().yyyymmdd()).await {
                Ok(disclosures) => {
                    if collection.disclosures != disclosures {
                        for report in collection.working_reports_mut().values_mut() { report.statement_request = None; }
                    }
                    let unpublished = unmatched_disclosures(&collection, &disclosures);
                    if (collection.disclosures != disclosures || (unpublished && !matches!(scope, CollectionScope::ResumedRecent(_)))) && collection.disclosure_version == collection.refresh_version { collection.refresh_version += 1; }
                    if unpublished && !matches!(scope, CollectionScope::ResumedRecent(_)) { collection.unpublished_check_version = collection.refresh_version; }
                    collection.disclosures = disclosures;
                    collection.disclosure_failure = None;
                    collection.last_checked_at = Some(self.clock.now().unix());
                    collection.disclosure_version = collection.refresh_version;
                }
                Err(error @ (Failure::Paused | Failure::Storage)) => return Err(error),
                Err(failure) => collection.disclosure_failure = Some(failure),
            }
            store.save(corp, &collection).await?;
            if collection.disclosure_failure.is_some() { return Ok(()); }
        }
        if collection.staged_reports.is_none() && collection.reports.values().any(|report| statement_outdated(report, &collection.disclosures) || dividends_outdated(report, &collection.disclosures)) {
            collection.staged_reports = Some(collection.reports.clone());
        }
        validate_reused_reports(&mut collection);
        let mut requests = std::collections::BTreeSet::new();
        for year in scope.years().rev() { for index in 0..REPORT_CODES.len() { requests.insert((year, index)); } }
        let requests: Vec<_> = if matches!(scope, CollectionScope::History(_)) { requests.into_iter().rev().collect() } else { requests.into_iter().collect() };
        for (year, index) in requests {
            let code = REPORT_CODES[index];
            let key = format!("{year}/{code}");
            let mut report = collection.working_reports_mut().remove(&key).unwrap_or_else(|| Report { statement_request: None, business_year: year, report_code: code.into(), statement: Default::default(), dividends: Default::default() });
            let report_outdated = statement_outdated(&report, &collection.disclosures) || dividends_outdated(&report, &collection.disclosures);
            let retry_source = report.statement.data.as_ref().is_some_and(|s| s.source_failure.is_some());
            if report.statement_request.is_some() || statement_outdated(&report, &collection.disclosures) || report.statement.checked_at.is_none() || report.statement.failure.is_some() || retry_source || (report.statement.absent && (report_outdated || report.statement.snapshot_version() < collection.unpublished_check_version)) {
                loop {
                    let step = self.statement_step(client, corp, year, code, &collection.disclosures, report.statement_request.as_ref()).await;
                    let complete = match step {
                        Err(error @ (Failure::Paused | Failure::Storage)) => return Err(error),
                        Ok(StatementStep::Continue(next)) => { report.statement_request = Some(next); false }
                        result => {
                            let result = result.map(|step| match step { StatementStep::Done(value) => value, StatementStep::Continue(_) => unreachable!() });
                            let result = match result {
                                Ok(Some(statement)) if report.statement.data.is_some() && statement.source_failure.is_some() => Err(statement.source_failure.unwrap()),
                                other => other,
                            };
                            report.statement.apply(result, self.clock.now().unix(), collection.refresh_version);
                            report.statement_request = None;
                            true
                        }
                    };
                    record_report(&mut collection, key.clone(), report.clone());
                    store.save(corp, &collection).await?;
                    if complete { break; }
                }
            } else { report.statement.validated_version = Some(collection.disclosure_version); }
            if code == "11011" && (dividends_outdated(&report, &collection.disclosures) || report.dividends.checked_at.is_none() || report.dividends.failure.is_some() || (report.dividends.absent && (report_outdated || report.dividends.snapshot_version() < collection.unpublished_check_version))) {
                let result = client.rows("alotMatter.json", &[("corp_code", corp.clone()), ("bsns_year", year.to_string()), ("reprt_code", code.into())]).await.and_then(|rows| {
                    if rows.iter().any(|row| !receipt_is_current(&collection.disclosures, field(row, "rcept_no"))) { return Err(Failure::ReceiptMismatch); }
                    dividends(rows, corp)
                });
                if let Err(error @ (Failure::Paused | Failure::Storage)) = result { return Err(error); }
                report.dividends.apply(result, self.clock.now().unix(), collection.refresh_version);
            } else if code == "11011" { report.dividends.validated_version = Some(collection.disclosure_version); }
            record_report(&mut collection, key, report);
            store.save(corp, &collection).await?;
        }
        Ok(())
    }

    async fn statement_step(&self, client: &Client, corp: &str, year: i32, code: &str, disclosures: &[Row], pending: Option<&StatementRequest>) -> Result<StatementStep, Failure> {
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
        if receipts.len() != 1 { return Err(Failure::ReceiptMismatch); }
        let receipt = &receipts[0];
        if !receipt_is_current(disclosures, receipt) { return Err(Failure::ReceiptMismatch); }
        let (files, source_failure) = match client.archive("fnlttXbrl.xml", &[("rcept_no", receipt.clone()), ("reprt_code", code.into())]).await {
            Ok(files) => (files, None),
            Err(error @ (Failure::Paused | Failure::Storage)) => return Err(error),
            Err(failure) => (Vec::new(), Some(failure)),
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

fn filing_title(mut title: &str) -> &str {
    loop {
        let prefix = ["[기재정정]", "[첨부정정]", "[첨부추가]", "[정정]", "[변경등록]"].into_iter().find(|prefix| title.starts_with(prefix));
        match prefix {
            Some(prefix) => title = title.strip_prefix(prefix).unwrap().trim(),
            None => return title.trim(),
        }
    }
}

fn receipt_is_current(disclosures: &[Row], receipt: &str) -> bool {
    let Some(original) = disclosures.iter().find(|r| field(r, "rcept_no") == receipt) else { return true; };
    let title = filing_title(field(original, "report_nm"));
    !disclosures.iter().any(|r| filing_title(field(r, "report_nm")) == title && field(r, "rcept_no") > receipt)
}

fn unmatched_disclosures(collection: &Collection, disclosures: &[Row]) -> bool {
    let receipts: std::collections::BTreeSet<_> = collection.working_reports().values().flat_map(|report| {
        report.statement.data.iter().flat_map(|s| s.accounts.iter().map(|a| field(&a.fields, "rcept_no")))
            .chain(report.dividends.data.iter().flatten().map(|d| field(&d.fields, "rcept_no")))
    }).collect();
    disclosures.iter().any(|row| {
        !collection.disclosures.iter().chain(disclosures).any(|known| {
            receipts.contains(field(known, "rcept_no")) && filing_title(field(known, "report_nm")) == filing_title(field(row, "report_nm"))
        })
    })
}

fn has_failures(collection: &Collection) -> bool {
    collection.disclosure_failure.is_some() || collection.working_reports().values().any(|r| r.statement.failure.is_some() || r.dividends.failure.is_some() || r.statement.data.as_ref().is_some_and(|s| s.source_failure.is_some()))
}

fn validate_reused_reports(collection: &mut Collection) {
    let Collection { reports, staged_reports, disclosures, disclosure_version, .. } = collection;
    for report in staged_reports.as_mut().unwrap_or(reports).values_mut() {
        if report.statement.data.is_some() && !statement_outdated(report, disclosures) { report.statement.validated_version = Some(*disclosure_version); }
        if report.dividends.data.is_some() && !dividends_outdated(report, disclosures) { report.dividends.validated_version = Some(*disclosure_version); }
    }
}

fn record_report(collection: &mut Collection, key: String, report: Report) {
    if collection.staged_reports.is_some() && let Some(published) = collection.reports.get_mut(&key) {
        published.statement.checked_at = report.statement.checked_at;
        published.statement.failure = report.statement.failure;
        published.dividends.checked_at = report.dividends.checked_at;
        published.dividends.failure = report.dividends.failure;
    }
    collection.working_reports_mut().insert(key, report);
    let coherent = collection.staged_reports.as_ref().is_some_and(|reports| reports.values().all(|report| {
        report.statement_request.is_none() && !statement_outdated(report, &collection.disclosures) && !dividends_outdated(report, &collection.disclosures)
            && (report.statement.data.is_none() || report.statement.snapshot_version() == collection.disclosure_version)
            && (report.dividends.data.is_none() || report.dividends.snapshot_version() == collection.disclosure_version)
    }));
    if coherent { collection.reports = collection.staged_reports.take().unwrap(); }
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

fn statement_outdated(report: &Report, disclosures: &[Row]) -> bool {
    report.statement.data.as_ref().is_some_and(|statement| statement.accounts.iter().any(|account| !receipt_is_current(disclosures, field(&account.fields, "rcept_no"))))
}

fn dividends_outdated(report: &Report, disclosures: &[Row]) -> bool {
    report.dividends.data.as_ref().is_some_and(|rows| rows.iter().any(|dividend| !receipt_is_current(disclosures, field(&dividend.fields, "rcept_no"))))
}

fn has_pending(collection: &Collection) -> bool {
    collection.disclosure_version < collection.refresh_version || collection.working_reports().values().any(|report| {
        report.statement_request.is_some() || report.statement.snapshot_version() < collection.disclosure_version || statement_outdated(report, &collection.disclosures)
            || (report.report_code == "11011" && (report.dividends.snapshot_version() < collection.disclosure_version || dividends_outdated(report, &collection.disclosures)))
    })
}
