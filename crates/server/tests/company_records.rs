use server::financials::{
    company_records::{AttemptKind, CompanyRecord, ReadContext, ReadResolution, ReadSnapshot, ReadState, UnsupportedReason},
    model::{Account, Basis, Collection, Company, Failure, Fetch, Report, Security, Statement, StatementRequest, Verification},
};

fn disclosure(receipt: &str, title: &str) -> std::collections::BTreeMap<String, String> {
    [("rcept_no".into(), receipt.into()), ("report_nm".into(), title.into())].into_iter().collect()
}

fn statement(receipt: &str) -> Statement {
    Statement { basis: Basis::CFS, source_failure: None, accounts: vec![Account {
        fields: [("rcept_no".into(), receipt.into())].into_iter().collect(),
        current_period: Verification::Unverified("synthetic".into()),
        cumulative_period: Verification::Unverified("synthetic".into()),
    }] }
}

fn published_report(code: &str, receipt: &str) -> Report {
    Report {
        business_year: 2024, report_code: code.into(), statement_request: None, dividends: Default::default(),
        statement: Fetch { data: Some(statement(receipt)), checked_at: Some(100), last_success_at: Some(100), refresh_version: 1, validated_version: Some(1), ..Default::default() },
    }
}

fn receipt<'a>(collection: &'a Collection, code: &str) -> &'a str {
    &collection.reports[&format!("2024/{code}")].statement.data.as_ref().unwrap().accounts[0].fields["rcept_no"]
}

#[test]
fn correction_checkpoints_reopen_without_publishing_a_mixed_generation() {
    let old = [disclosure("20240101000001", "분기보고서 (2024.03)"), disclosure("20240101000002", "분기보고서 (2024.09)")];
    let corrected = [disclosure("20250101000001", "[기재정정]분기보고서 (2024.03)"), disclosure("20250101000002", "[첨부정정]분기보고서 (2024.09)")];
    let collection = Collection {
        reports: [("2024/11013".into(), published_report("11013", "20240101000001")), ("2024/11014".into(), published_report("11014", "20240101000002"))].into_iter().collect(),
        disclosures: old.to_vec(), refresh_version: 1, disclosure_version: 1, last_checked_at: Some(100), ..Default::default()
    };
    let mut record = CompanyRecord::new(collection);
    let now = server::clock::kst(domain::KstDate::parse_yyyymmdd("20250101").unwrap(), 12, 0, 0);
    record.begin_attempt(AttemptKind::Recent, now);
    record.check_disclosures(Ok(old.into_iter().chain(corrected).collect()), 200);
    record.prepare_reports();
    let mut report = record.report(2024, "11013", false).unwrap();
    assert!(report.needs_statement());
    report.continue_statement(StatementRequest::Xbrl { basis: Basis::CFS, rows: vec![disclosure("20250101000001", "synthetic")] });
    assert_eq!(receipt(report.stored(), "11013"), "20240101000001");
    let saved = serde_json::to_vec(report.stored()).unwrap();
    drop(report);
    let mut reopened = CompanyRecord::new(serde_json::from_slice(&saved).unwrap());
    reopened.prepare_reports();
    let mut report = reopened.report(2024, "11013", true).unwrap();
    assert!(matches!(report.pending_statement(), Some(StatementRequest::Xbrl { basis: Basis::CFS, .. })));
    report.complete_statement(Ok(Some(statement("20250101000001"))), 210);
    report.finish();
    assert_eq!(receipt(reopened.stored(), "11013"), "20240101000001");
    assert_eq!(receipt(reopened.stored(), "11014"), "20240101000002");
    let mut report = reopened.report(2024, "11014", true).unwrap();
    report.complete_statement(Err(Failure::Network), 220);
    report.finish();
    assert_eq!(receipt(reopened.stored(), "11013"), "20240101000001");
    let failed = &reopened.stored().reports["2024/11014"].statement;
    assert_eq!(failed.checked_at, Some(220));
    assert_eq!(failed.failure, Some(Failure::Network));
    assert_eq!(failed.last_success_at, Some(100));
    let saved = serde_json::to_vec(reopened.stored()).unwrap();
    let mut reopened = CompanyRecord::new(serde_json::from_slice(&saved).unwrap());
    reopened.prepare_reports();
    assert!(reopened.report(2024, "11013", true).is_none());
    let mut report = reopened.report(2024, "11014", true).unwrap();
    report.complete_statement(Ok(Some(statement("20250101000002"))), 230);
    assert!(report.stored().staged_reports.is_none());
    assert_eq!(receipt(report.stored(), "11013"), "20250101000001");
    assert_eq!(receipt(report.stored(), "11014"), "20250101000002");
    assert!(report.stored().reports.values().all(|r| r.statement.snapshot_version() == 2));
    report.finish();
}

#[test]
fn attempts_and_disclosure_failures_preserve_the_confirmed_generation_after_reopening() {
    let now = server::clock::kst(domain::KstDate::parse_yyyymmdd("20250101").unwrap(), 12, 0, 0);
    let mut record = CompanyRecord::new(Collection::default());
    assert!(record.begin_attempt(AttemptKind::Recent, now));
    assert_eq!(record.stored().refresh_version, 1);
    assert_eq!(record.stored().last_attempt_at, Some(now.unix()));
    assert!(record.check_disclosures(Ok(Vec::new()), now.unix()));
    assert_eq!(record.stored().disclosure_version, 1);
    let saved = serde_json::to_vec(record.stored()).unwrap();
    let mut reopened = CompanyRecord::new(serde_json::from_slice(&saved).unwrap());
    assert!(!reopened.begin_attempt(AttemptKind::Continue, now));
    assert_eq!(reopened.stored().refresh_version, 1);
    assert!(reopened.begin_attempt(AttemptKind::Recent, now));
    assert!(!reopened.check_disclosures(Err(Failure::Network), now.unix() + 1));
    assert_eq!(reopened.stored().refresh_version, 2);
    assert_eq!(reopened.stored().disclosure_version, 1);
    assert_eq!(reopened.stored().last_checked_at, Some(now.unix()));
    assert_eq!(reopened.stored().disclosure_failure, Some(Failure::Network));
    assert!(reopened.begin_attempt(AttemptKind::ResumedRecent, now));
    assert_eq!(reopened.stored().refresh_version, 2);
    assert!(reopened.check_disclosures(Ok(Vec::new()), now.unix() + 2));
    assert_eq!(reopened.stored().disclosure_version, 2);
    assert_eq!(reopened.stored().disclosure_failure, None);
}

#[test]
fn unchanged_reuse_preserves_fetch_provenance_and_validates_absent_dividends_only_at_finish() {
    let mut annual = published_report("11011", "20240101000001");
    annual.statement_request = Some(StatementRequest::Separate);
    annual.dividends = Fetch { absent: true, checked_at: Some(100), last_success_at: Some(100), refresh_version: 1, validated_version: Some(1), ..Default::default() };
    let mut record = CompanyRecord::new(Collection {
        reports: [("2024/11011".into(), annual)].into_iter().collect(),
        refresh_version: 2, disclosure_version: 2, ..Default::default()
    });
    record.prepare_reports();
    let mut report = record.report(2024, "11011", false).unwrap();
    assert!(report.needs_statement());
    assert!(!report.needs_dividends());
    report.continue_statement(StatementRequest::Separate);
    let checkpoint = &report.stored().reports["2024/11011"];
    assert_eq!(checkpoint.statement.snapshot_version(), 2);
    assert_eq!(checkpoint.statement.refresh_version, 1);
    assert_eq!(checkpoint.statement.checked_at, Some(100));
    assert_eq!(checkpoint.statement.last_success_at, Some(100));
    assert_eq!(checkpoint.dividends.snapshot_version(), 1);
    report.complete_statement(Ok(Some(statement("20240101000001"))), 200);
    assert_eq!(report.stored().reports["2024/11011"].dividends.snapshot_version(), 1);
    report.finish();
    let saved = &record.stored().reports["2024/11011"].dividends;
    assert_eq!(saved.snapshot_version(), 2);
    assert_eq!(saved.refresh_version, 1);
    assert_eq!(saved.last_success_at, Some(100));
    assert_eq!(saved.checked_at, Some(100));
    let report = record.report(2024, "11011", false).unwrap();
    assert!(!report.needs_statement());
    assert!(!report.needs_dividends());
    report.finish();
}

#[test]
fn resumed_confirmation_retains_pending_requests_until_listing_changes_without_rechecking_absence() {
    let now = server::clock::kst(domain::KstDate::parse_yyyymmdd("20250101").unwrap(), 12, 0, 0);
    let listing = vec![disclosure("20240101000001", "분기보고서 (2024.03)")];
    let mut record = CompanyRecord::new(Collection::default());
    record.begin_attempt(AttemptKind::Recent, now);
    record.check_disclosures(Ok(listing.clone()), 100);
    let mut report = record.report(2024, "11013", false).unwrap();
    report.continue_statement(StatementRequest::Separate);
    report.finish();
    let saved = serde_json::to_vec(record.stored()).unwrap();
    let mut reopened = CompanyRecord::new(serde_json::from_slice(&saved).unwrap());
    reopened.begin_attempt(AttemptKind::ResumedRecent, now);
    reopened.check_disclosures(Ok(listing.clone()), 200);
    assert!(reopened.stored().reports["2024/11013"].statement_request.is_some());
    assert_eq!(reopened.stored().unpublished_check_version, 1);
    reopened.check_disclosures(Ok(listing.into_iter().chain([disclosure("20250101000001", "[기재정정]분기보고서 (2024.03)")]).collect()), 210);
    assert!(reopened.stored().reports["2024/11013"].statement_request.is_none());
    assert_eq!(reopened.stored().refresh_version, 2);
    assert_eq!(reopened.stored().disclosure_version, 2);
    assert_eq!(reopened.stored().unpublished_check_version, 1);
}

#[test]
fn first_failure_and_partial_source_retry_preserve_the_last_successful_statement() {
    let mut record = CompanyRecord::new(Collection { refresh_version: 1, disclosure_version: 1, ..Default::default() });
    let mut report = record.report(2024, "11013", false).unwrap();
    report.complete_statement(Err(Failure::Network), 100);
    report.finish();
    let failed = &record.stored().reports["2024/11013"].statement;
    assert!(failed.data.is_none());
    assert_eq!(failed.last_success_at, None);
    assert_eq!(failed.failure, Some(Failure::Network));
    let mut partial = statement("20240101000001");
    partial.source_failure = Some(Failure::SourceUnavailable);
    let mut report = record.report(2024, "11013", false).unwrap();
    report.complete_statement(Ok(Some(partial)), 200);
    report.finish();
    assert_eq!(record.stored().reports["2024/11013"].statement.data.as_ref().unwrap().source_failure, Some(Failure::SourceUnavailable));
    let mut report = record.report(2024, "11013", false).unwrap();
    assert!(report.needs_statement());
    report.complete_statement(Ok(Some(statement("20240101000001"))), 300);
    report.finish();
    let mut partial = statement("20250101000001");
    partial.source_failure = Some(Failure::Network);
    let mut report = record.report(2024, "11013", false).unwrap();
    report.complete_statement(Ok(Some(partial)), 400);
    report.finish();
    assert_eq!(receipt(record.stored(), "11013"), "20240101000001");
    let saved = &record.stored().reports["2024/11013"].statement;
    assert_eq!(saved.last_success_at, Some(300));
    assert_eq!(saved.checked_at, Some(400));
    assert_eq!(saved.failure, Some(Failure::Network));
}

#[test]
fn selecting_and_abandoning_a_report_retains_the_last_checkpoint() {
    let mut record = CompanyRecord::new(Collection {
        reports: [("2024/11013".into(), published_report("11013", "20240101000001"))].into_iter().collect(),
        ..Default::default()
    });
    let report = record.report(2024, "11013", false).unwrap();
    assert_eq!(report.stored().reports.keys().map(String::as_str).collect::<Vec<_>>(), vec!["2024/11013"]);
    drop(report);
    assert_eq!(receipt(record.stored(), "11013"), "20240101000001");
    assert_eq!(record.into_stored().reports["2024/11013"].statement.last_success_at, Some(100));
}

#[test]
fn a_current_receipt_in_a_different_generation_cannot_publish_staging() {
    let published = published_report("11013", "20240101000001");
    let mut record = CompanyRecord::new(Collection {
        reports: [("2024/11013".into(), published.clone())].into_iter().collect(),
        staged_reports: Some([("2024/11013".into(), published)].into_iter().collect()),
        refresh_version: 3, disclosure_version: 2, ..Default::default()
    });
    let mut report = record.report(2024, "11013", false).unwrap();
    report.complete_statement(Ok(Some(statement("20240101000001"))), 300);
    assert!(report.stored().staged_reports.is_some());
    assert_eq!(report.stored().reports["2024/11013"].statement.last_success_at, Some(100));
    assert_eq!(report.stored().staged_reports.as_ref().unwrap()["2024/11013"].statement.last_success_at, Some(300));
    report.finish();
    assert!(record.stored().staged_reports.is_some());
}

#[test]
fn an_annual_statement_can_publish_at_its_checkpoint_before_absent_dividends_are_retried() {
    let mut annual = published_report("11011", "20240101000001");
    annual.dividends = Fetch { absent: true, checked_at: Some(100), last_success_at: Some(100), refresh_version: 1, validated_version: Some(1), ..Default::default() };
    let mut record = CompanyRecord::new(Collection {
        reports: [("2024/11011".into(), annual)].into_iter().collect(),
        disclosures: vec![disclosure("20240101000001", "사업보고서 (2024.12)"), disclosure("20250101000001", "[정정]사업보고서 (2024.12)")],
        refresh_version: 2, disclosure_version: 2, ..Default::default()
    });
    record.prepare_reports();
    let mut report = record.report(2024, "11011", false).unwrap();
    assert!(report.needs_dividends());
    report.complete_statement(Ok(Some(statement("20250101000001"))), 200);
    assert!(report.stored().staged_reports.is_none());
    assert_eq!(receipt(report.stored(), "11011"), "20250101000001");
    assert_eq!(report.stored().reports["2024/11011"].dividends.snapshot_version(), 1);
    report.record_dividends(Err(Failure::Network), 210);
    report.finish();
    assert_eq!(receipt(record.stored(), "11011"), "20250101000001");
    let dividends = &record.stored().reports["2024/11011"].dividends;
    assert_eq!(dividends.failure, Some(Failure::Network));
    assert_eq!(dividends.last_success_at, Some(100));
}

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
