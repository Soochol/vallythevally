use server::financials::{
    company_records::{ReadContext, ReadResolution, ReadSnapshot, ReadState, UnsupportedReason},
    model::{Collection, Company, Failure, Fetch, Report, Security},
};

#[test]
fn collecting_takes_priority_over_failures_and_empty_published_reports() {
    let security = Security {
        stock_code: "005930".into(),
        company: Company { corp_code: "00126380".into(), name: "합성 회사".into(), fiscal_month: Some(12) },
        share_class: Some("보통주".into()),
        share_class_reason: None,
        evidence: "synthetic".into(),
    };
    let collection = Collection { disclosure_failure: Some(Failure::Network), ..Default::default() };

    let snapshot = ReadSnapshot::resolve(Some(security), collection, ReadContext::Configured {
        collecting: true,
        failure: Some(Failure::Storage),
        resolution: ReadResolution::Unchanged,
    });

    assert_eq!(snapshot.state, ReadState::Collecting);
    assert_eq!(snapshot.failure, Some(Failure::Storage));
    assert_eq!(snapshot.collection.disclosure_failure, Some(Failure::Network));
    assert!(snapshot.collection.reports.is_empty());
}

#[test]
fn mapping_results_override_company_state_only_without_a_saved_security() {
    let security = Security {
        stock_code: "005930".into(),
        company: Company { corp_code: "00126380".into(), name: "합성 회사".into(), fiscal_month: Some(12) },
        share_class: None, share_class_reason: None, evidence: "synthetic".into(),
    };
    for (resolution, expected, reason, failure) in [
        (ReadResolution::Unverified, ReadState::Unsupported, Some(UnsupportedReason::CompanyMappingUnverified), None),
        (ReadResolution::Failed(Failure::Network), ReadState::Failed, None, Some(Failure::Network)),
    ] {
        for saved in [None, Some(security.clone())] {
            let mapped = saved.is_some();
            let snapshot = ReadSnapshot::resolve(saved, Collection::default(), ReadContext::Configured {
                collecting: false, failure: None, resolution,
            });
            assert_eq!(snapshot.state, if mapped { ReadState::NotCollected } else { expected });
            assert_eq!(snapshot.reason, if mapped { None } else { reason });
            assert_eq!(snapshot.failure, if mapped { None } else { failure });
        }
    }
}

#[test]
fn only_published_reports_can_be_ready_or_stale() {
    let report = Report {
        business_year: 2024,
        report_code: "11013".into(),
        statement: Fetch { absent: true, checked_at: Some(100), ..Default::default() },
        statement_request: None,
        dividends: Default::default(),
    };
    let reports = std::collections::BTreeMap::from([("2024/11013".into(), report)]);
    for (collection, expected) in [
        (Collection { reports: reports.clone(), ..Default::default() }, ReadState::Ready),
        (Collection { reports: reports.clone(), refresh_version: 2, disclosure_version: 1, ..Default::default() }, ReadState::Stale),
        (Collection { staged_reports: Some(reports), refresh_version: 2, disclosure_version: 1, ..Default::default() }, ReadState::NotCollected),
    ] {
        let snapshot = ReadSnapshot::resolve(None, collection, ReadContext::Configured {
            collecting: false, failure: None, resolution: ReadResolution::Unchanged,
        });
        assert_eq!(snapshot.state, expected);
    }
}

#[test]
fn storage_failure_and_missing_configuration_keep_loaded_records() {
    for (context, state, failure) in [
        (ReadContext::StorageFailed(Failure::Storage), ReadState::Failed, Some(Failure::Storage)),
        (ReadContext::NotConfigured, ReadState::NotConfigured, None),
    ] {
        let collection = Collection { last_checked_at: Some(100), disclosure_failure: Some(Failure::Network), ..Default::default() };
        let snapshot = ReadSnapshot::resolve(None, collection, context);
        assert_eq!(snapshot.state, state);
        assert_eq!(snapshot.failure, failure);
        assert_eq!(snapshot.collection.last_checked_at, Some(100));
        assert_eq!(snapshot.collection.disclosure_failure, Some(Failure::Network));
    }
}

#[test]
fn report_failure_takes_priority_over_empty_published_reports_without_top_level_failure() {
    let report = server::financials::model::Report {
        business_year: 2024,
        report_code: "11013".into(),
        statement: server::financials::model::Fetch { failure: Some(Failure::Network), ..Default::default() },
        statement_request: None,
        dividends: Default::default(),
    };
    let collection = Collection {
        staged_reports: Some([("2024/11013".into(), report)].into_iter().collect()),
        refresh_version: 2,
        disclosure_version: 1,
        ..Default::default()
    };

    let snapshot = ReadSnapshot::resolve(None, collection, ReadContext::Configured {
        collecting: false,
        failure: None,
        resolution: ReadResolution::Unchanged,
    });

    assert_eq!(snapshot.state, ReadState::PartialFailure);
    assert_eq!(snapshot.failure, None);
    assert!(snapshot.collection.reports.is_empty());
    assert!(snapshot.collection.staged_reports.is_some());
}
