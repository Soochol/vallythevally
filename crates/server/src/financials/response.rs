use std::collections::BTreeMap;

use serde::Serialize;

use super::{company_records::ReadSnapshot, model::{Collection, Failure, Report, Security}};

#[derive(Serialize)]
pub(super) struct FinancialSourceResponse {
    status: &'static str,
    security: Option<Security>,
    collection: CollectionResponse,
    failure: Option<Failure>,
    reason: Option<&'static str>,
}

#[derive(Serialize)]
struct CollectionResponse {
    reports: BTreeMap<String, Report>,
    staged_reports: Option<BTreeMap<String, Report>>,
    disclosures: Vec<BTreeMap<String, String>>,
    last_checked_at: Option<i64>,
    last_attempt_at: Option<i64>,
    disclosure_failure: Option<Failure>,
    refresh_version: u64,
    disclosure_version: u64,
    unpublished_check_version: u64,
}

impl From<ReadSnapshot> for FinancialSourceResponse {
    fn from(snapshot: ReadSnapshot) -> Self {
        Self { status: snapshot.state.as_str(), security: snapshot.security, collection: snapshot.collection.into(), failure: snapshot.failure, reason: snapshot.reason.map(|reason| reason.as_str()) }
    }
}

impl From<Collection> for CollectionResponse {
    fn from(collection: Collection) -> Self {
        let Collection { reports, staged_reports, disclosures, last_checked_at, last_attempt_at, disclosure_failure, refresh_version, disclosure_version, unpublished_check_version } = collection;
        Self { reports, staged_reports, disclosures, last_checked_at, last_attempt_at, disclosure_failure, refresh_version, disclosure_version, unpublished_check_version }
    }
}
