use std::sync::Arc;

use axum::{body::{Body, to_bytes}, http::{Request, StatusCode}};
use domain::{Market, Symbol, SymbolInfo, SymbolKind};
use serde_json::{Value, json};
use server::{clock::Clock, financials::{Financials, model::{Collection, Failure, Security}, routes, store::Store}, symbols::{Directory, SymbolDirectory}};
use tower::ServiceExt;

fn symbols() -> Arc<SymbolDirectory> {
    let symbols = Arc::new(SymbolDirectory::default());
    symbols.replace(Directory::build(vec![
        SymbolInfo { symbol: Symbol::parse("005930").unwrap(), name: "합성 회사".into(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled: false },
        SymbolInfo { symbol: Symbol::parse("102780").unwrap(), name: "합성 ETF".into(), kind: SymbolKind::Etf, market: Market::Kospi, nxt_enabled: false },
    ]));
    symbols
}

#[tokio::test]
async fn source_http_preserves_all_record_fields_and_nested_tags_without_configuration() {
    let report = json!({
        "business_year": 2024, "report_code": "11011", "statement_request": null,
        "statement": {
            "data": { "basis": "CFS", "source_failure": "source_unavailable", "accounts": [{
                "fields": { "rcept_no": "20250331000001", "thstrm_amount": "100" },
                "current_period": { "status": "verified", "detail": {
                    "period": { "kind": "instant", "date": "2024-12-31" },
                    "context_id": "ctx", "source_file": "synthetic.xbrl", "receipt": "20250331000001"
                } },
                "cumulative_period": { "status": "unverified", "detail": "matching_context_missing" }
            }] },
            "absent": false, "checked_at": 200, "last_success_at": 100, "failure": "network", "refresh_version": 1, "validated_version": 2
        },
        "dividends": {
            "data": [{ "settlement_date": "2024-12-31", "period_reason": null, "fields": { "thstrm": "10" }, "share_class": "보통주", "share_class_reason": null }],
            "absent": false, "checked_at": 200, "last_success_at": 100, "failure": null, "refresh_version": 1, "validated_version": null
        }
    });
    let mut staged = report.clone();
    staged["statement_request"] = json!({ "next": "xbrl", "basis": "OFS", "rows": [{ "rcept_no": "20250331000002" }] });
    staged["statement"]["data"]["accounts"][0]["current_period"]["detail"]["period"] = json!({ "kind": "duration", "start": "2024-01-01", "end": "2024-12-31" });
    let mut separate = report.clone();
    separate["business_year"] = json!(2025);
    separate["report_code"] = json!("11013");
    separate["statement_request"] = json!({ "next": "separate" });
    let expected = json!({
        "status": "not_configured", "reason": null, "failure": null,
        "security": { "stock_code": "005930", "company": { "corp_code": "00126380", "name": "합성 회사", "fiscal_month": 12 }, "share_class": "보통주", "share_class_reason": null, "evidence": "synthetic" },
        "collection": {
            "reports": { "2024/11011": report }, "staged_reports": { "2024/11011": staged, "2025/11013": separate },
            "disclosures": [{ "rcept_no": "20250331000002" }], "last_checked_at": 100, "last_attempt_at": 200,
            "disclosure_failure": "remote", "refresh_version": 3, "disclosure_version": 2, "unpublished_check_version": 1
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("financials.db")).await.unwrap();
    let security: Security = serde_json::from_value(expected["security"].clone()).unwrap();
    let collection: Collection = serde_json::from_value(expected["collection"].clone()).unwrap();
    store.save_security(&security).await.unwrap();
    store.save(&security.company.corp_code, &collection).await.unwrap();
    let app = routes(Financials::new(None, store, Clock::fake(domain::KstTime::from_unix(300))), symbols());
    let response = app.oneshot(Request::builder().uri("/api/symbols/005930/financial-source").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let actual: Value = serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(actual, expected);
}

#[tokio::test]
async fn unsupported_product_http_returns_before_storage_failure_or_update() {
    for method in ["GET", "POST"] {
        let service = Financials::with_store(None, Err(Failure::Storage), Clock::fake(domain::KstTime::from_unix(300)));
        let response = routes(service, symbols()).oneshot(Request::builder().method(method).uri("/api/symbols/102780/financial-source").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let actual: Value = serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
        assert_eq!(actual, json!({
            "status": "unsupported", "security": null, "failure": null, "reason": "unsupported_product",
            "collection": { "reports": {}, "staged_reports": null, "disclosures": [], "last_checked_at": null, "last_attempt_at": null, "disclosure_failure": null, "refresh_version": 0, "disclosure_version": 0, "unpublished_check_version": 0 }
        }));
    }
}
