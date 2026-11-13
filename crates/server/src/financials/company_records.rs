use super::model::{Collection, Failure, Security};

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
        report.statement_request.is_some() || report.statement.snapshot_version() < collection.disclosure_version || super::statement_outdated(report, &collection.disclosures)
            || (report.report_code == "11011" && (report.dividends.snapshot_version() < collection.disclosure_version || super::dividends_outdated(report, &collection.disclosures)))
    })
}
