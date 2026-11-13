use std::collections::BTreeMap;

use domain::KstTime;

use super::client::{Row, field};
use super::model::{Collection, Dividend, Failure, Fetch, Report, Security, Statement, StatementRequest};

#[derive(Clone, Copy)]
pub enum AttemptKind { Recent, ResumedRecent, Continue }

pub struct CompanyRecord {
    collection: Collection,
    attempt: AttemptKind,
}

impl CompanyRecord {
    pub fn new(collection: Collection) -> Self { Self { collection, attempt: AttemptKind::Continue } }

    pub fn stored(&self) -> &Collection { &self.collection }

    pub fn into_stored(self) -> Collection { self.collection }

    pub fn begin_attempt(&mut self, attempt: AttemptKind, now: KstTime) -> bool {
        self.attempt = attempt;
        let collection = &mut self.collection;
        collection.last_attempt_at = Some(now.unix());
        if matches!(attempt, AttemptKind::Recent) || (collection.refresh_version == 0 && collection.last_checked_at.is_none()) { collection.refresh_version += 1; }
        let daily = matches!(attempt, AttemptKind::Recent) && collection.last_checked_at.is_none_or(|t| KstTime::from_unix(t).kst_date() != now.kst_date());
        daily || matches!(attempt, AttemptKind::ResumedRecent) || collection.last_checked_at.is_none() || collection.disclosure_version < collection.refresh_version || collection.disclosure_failure.is_some()
    }

    pub fn check_disclosures(&mut self, result: Result<Vec<BTreeMap<String, String>>, Failure>, now: i64) -> bool {
        let collection = &mut self.collection;
        match result {
            Ok(disclosures) => {
                if collection.disclosures != disclosures {
                    for report in collection.working_reports_mut().values_mut() { report.statement_request = None; }
                }
                let unpublished = unmatched_disclosures(collection, &disclosures);
                let resumed = matches!(self.attempt, AttemptKind::ResumedRecent);
                if (collection.disclosures != disclosures || (unpublished && !resumed)) && collection.disclosure_version == collection.refresh_version { collection.refresh_version += 1; }
                if unpublished && !resumed { collection.unpublished_check_version = collection.refresh_version; }
                collection.disclosures = disclosures;
                collection.disclosure_failure = None;
                collection.last_checked_at = Some(now);
                collection.disclosure_version = collection.refresh_version;
                true
            }
            Err(failure) => { collection.disclosure_failure = Some(failure); false }
        }
    }

    pub fn prepare_reports(&mut self) {
        let collection = &mut self.collection;
        if collection.staged_reports.is_none() && collection.reports.values().any(|report| statement_outdated(report, &collection.disclosures) || dividends_outdated(report, &collection.disclosures)) {
            collection.staged_reports = Some(collection.reports.clone());
        }
        validate_reused_reports(collection);
    }

    pub fn report(&mut self, year: i32, code: &str, changes_only: bool) -> Option<ReportUpdate<'_>> {
        let collection = &mut self.collection;
        let key = format!("{year}/{code}");
        if changes_only && collection.working_reports().get(&key).is_none_or(|report| {
            !statement_outdated(report, &collection.disclosures) && !dividends_outdated(report, &collection.disclosures)
                && report.statement.failure.is_none() && report.dividends.failure.is_none()
                && report.statement.data.as_ref().is_none_or(|statement| statement.source_failure.is_none())
        }) { return None; }
        let mut report = collection.working_reports().get(&key).cloned().unwrap_or_else(|| Report { statement_request: None, business_year: year, report_code: code.into(), statement: Default::default(), dividends: Default::default() });
        let outdated = statement_outdated(&report, &collection.disclosures) || dividends_outdated(&report, &collection.disclosures);
        let retry_source = report.statement.data.as_ref().is_some_and(|s| s.source_failure.is_some());
        let statement_due = report.statement_request.is_some() || statement_outdated(&report, &collection.disclosures) || report.statement.checked_at.is_none() || report.statement.failure.is_some() || retry_source || (report.statement.absent && (outdated || report.statement.snapshot_version() < collection.unpublished_check_version));
        let dividends_due = code == "11011" && (dividends_outdated(&report, &collection.disclosures) || report.dividends.checked_at.is_none() || report.dividends.failure.is_some() || (report.dividends.absent && (outdated || report.dividends.snapshot_version() < collection.unpublished_check_version)));
        if !statement_due { report.statement.validated_version = Some(collection.disclosure_version); }
        Some(ReportUpdate { collection, key, report, statement_due, dividends_due })
    }
}

pub struct ReportUpdate<'a> {
    collection: &'a mut Collection,
    key: String,
    report: Report,
    statement_due: bool,
    dividends_due: bool,
}

impl ReportUpdate<'_> {
    pub fn stored(&self) -> &Collection { self.collection }

    pub fn needs_statement(&self) -> bool { self.statement_due }

    pub fn needs_dividends(&self) -> bool { self.dividends_due }

    pub fn pending_statement(&self) -> Option<&StatementRequest> { self.report.statement_request.as_ref() }

    pub fn continue_statement(&mut self, next: StatementRequest) {
        self.report.statement_request = Some(next);
        record_report(self.collection, self.key.clone(), self.report.clone());
    }

    pub fn complete_statement(&mut self, result: Result<Option<Statement>, Failure>, now: i64) {
        let result = match result {
            Ok(Some(statement)) if self.report.statement.data.is_some() && statement.source_failure.is_some() => Err(statement.source_failure.unwrap()),
            other => other,
        };
        self.report.statement.apply(result, now, self.collection.refresh_version);
        self.report.statement_request = None;
        record_report(self.collection, self.key.clone(), self.report.clone());
    }

    pub fn record_dividends(&mut self, result: Result<Option<Vec<Dividend>>, Failure>, now: i64) {
        self.report.dividends.apply(result, now, self.collection.refresh_version);
    }

    pub fn finish(mut self) {
        if self.report.report_code == "11011" && !self.dividends_due { self.report.dividends.validated_version = Some(self.collection.disclosure_version); }
        record_report(self.collection, self.key, self.report);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadState { NotConfigured, Unsupported, Collecting, PartialFailure, NotCollected, Stale, Ready, Failed }

impl ReadState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotConfigured => "not_configured", Self::Unsupported => "unsupported", Self::Collecting => "collecting",
            Self::PartialFailure => "partial_failure", Self::NotCollected => "not_collected", Self::Stale => "stale", Self::Ready => "ready", Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnsupportedReason { UnsupportedProduct, CompanyMappingUnverified }

impl UnsupportedReason {
    pub fn as_str(self) -> &'static str {
        match self { Self::UnsupportedProduct => "unsupported_product", Self::CompanyMappingUnverified => "company_mapping_unverified" }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadResolution { Unchanged, Unverified, Failed(Failure) }

#[derive(Clone, Copy, Debug)]
pub enum ReadContext {
    StorageFailed(Failure),
    NotConfigured,
    Unsupported(UnsupportedReason),
    Configured { collecting: bool, failure: Option<Failure>, resolution: ReadResolution },
}

#[derive(Clone, Debug)]
pub struct ReadSnapshot {
    pub state: ReadState,
    pub security: Option<Security>,
    pub collection: Collection,
    pub failure: Option<Failure>,
    pub reason: Option<UnsupportedReason>,
}

impl ReadSnapshot {
    pub fn unsupported_product() -> Self {
        Self::resolve(None, Collection::default(), ReadContext::Unsupported(UnsupportedReason::UnsupportedProduct))
    }

    pub fn resolve(security: Option<Security>, collection: Collection, context: ReadContext) -> Self {
        let (state, failure, reason) = match context {
            ReadContext::StorageFailed(failure) => (ReadState::Failed, Some(failure), None),
            ReadContext::NotConfigured => (ReadState::NotConfigured, None, None),
            ReadContext::Unsupported(reason) => (ReadState::Unsupported, None, Some(reason)),
            ReadContext::Configured { collecting, failure, resolution } => {
                let state = if collecting { ReadState::Collecting }
                    else if has_failures(&collection) || failure.is_some() { ReadState::PartialFailure }
                    else if collection.reports.is_empty() { ReadState::NotCollected }
                    else if has_pending(&collection) { ReadState::Stale }
                    else { ReadState::Ready };
                match resolution {
                    ReadResolution::Unverified if security.is_none() => (ReadState::Unsupported, failure, Some(UnsupportedReason::CompanyMappingUnverified)),
                    ReadResolution::Failed(error) if security.is_none() => (ReadState::Failed, Some(error), None),
                    _ => (state, failure, None),
                }
            }
        };
        Self { state, security, collection, failure, reason }
    }
}

fn has_failures(collection: &Collection) -> bool {
    collection.disclosure_failure.is_some() || collection.working_reports().values().any(|r| r.statement.failure.is_some() || r.dividends.failure.is_some() || r.statement.data.as_ref().is_some_and(|s| s.source_failure.is_some()))
}

fn has_pending(collection: &Collection) -> bool {
    collection.disclosure_version < collection.refresh_version || collection.working_reports().values().any(|report| {
        report.statement_request.is_some() || report.statement.snapshot_version() < collection.disclosure_version || statement_outdated(report, &collection.disclosures)
            || (report.report_code == "11011" && (report.dividends.snapshot_version() < collection.disclosure_version || dividends_outdated(report, &collection.disclosures)))
    })
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

pub(super) fn receipt_is_current(disclosures: &[Row], receipt: &str) -> bool {
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

fn statement_outdated(report: &Report, disclosures: &[Row]) -> bool {
    report.statement.data.as_ref().is_some_and(|statement| statement.accounts.iter().any(|account| !receipt_is_current(disclosures, field(&account.fields, "rcept_no"))))
}

fn dividends_outdated(report: &Report, disclosures: &[Row]) -> bool {
    report.dividends.data.as_ref().is_some_and(|rows| rows.iter().any(|dividend| !receipt_is_current(disclosures, field(&dividend.fields, "rcept_no"))))
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

impl<T> Fetch<T> {
    pub fn snapshot_version(&self) -> u64 { self.validated_version.unwrap_or(self.refresh_version) }

    pub fn apply(&mut self, result: Result<Option<T>, Failure>, now: i64, refresh_version: u64) {
        self.checked_at = Some(now);
        match result {
            Ok(value) => { self.absent = value.is_none(); self.data = value; self.failure = None; self.last_success_at = Some(now); self.refresh_version = refresh_version; self.validated_version = Some(refresh_version); }
            Err(e) => self.failure = Some(e),
        }
    }
}

impl Collection {
    pub(crate) fn working_reports(&self) -> &BTreeMap<String, Report> { self.staged_reports.as_ref().unwrap_or(&self.reports) }

    fn working_reports_mut(&mut self) -> &mut BTreeMap<String, Report> { self.staged_reports.as_mut().unwrap_or(&mut self.reports) }
}
