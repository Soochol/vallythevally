use std::collections::{BTreeMap, HashMap};
use std::io::{Cursor, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{Router, extract::{Path, Query, State}, http::StatusCode, response::{IntoResponse, Response}, routing::get};
use serde_json::{Value, json};
use server::{clock::{Clock, kst}, config::Secret, financials::{Financials, client::Client, model::{Basis, Failure, FactPeriod, Verification}, store::Store, xbrl}};
use domain::KstDate;

const KEY: &str = "synthetic-dart-secret-for-test-159";
const RECEIPT: &str = "20150331000001";
const CORP: &str = "00126380";

#[derive(Default)]
struct FakeState {
    calls: Vec<(String, BTreeMap<String, String>)>,
    failures: HashMap<String, String>,
    correction: bool,
    delayed: bool,
    preferred: bool,
    kind_other_code: bool,
    no_cfs: bool,
    xbrl_failure: bool,
    stale_statement: bool,
}

struct Fake { state: Arc<Mutex<FakeState>>, url: String, task: tokio::task::JoinHandle<()> }

impl Drop for Fake { fn drop(&mut self) { self.task.abort(); } }

impl Fake {
    async fn start() -> Self {
        let state = Arc::new(Mutex::new(FakeState::default()));
        let app = Router::new().route("/api/{endpoint}", get(respond)).route("/common/searchcorpname.do", get(kind)).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        Self { state, url, task }
    }

    fn client(&self) -> Client { Client::new(Secret::new(KEY.into()), self.url.clone(), self.url.clone()).unwrap() }
    fn count(&self, endpoint: &str) -> usize { self.state.lock().unwrap().calls.iter().filter(|(e, _)| e == endpoint).count() }
}

fn zipped(name: &str, xml: &str) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
    zip.write_all(xml.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

async fn kind(State(state): State<Arc<Mutex<FakeState>>>, Query(params): Query<BTreeMap<String, String>>) -> axum::Json<Value> {
    let mut state = state.lock().unwrap();
    state.calls.push(("kind".into(), params.clone()));
    axum::Json(if state.kind_other_code { json!([{ "repisusrtcd2":"005930", "secugrpId":"ST", "fssunqno":CORP }]) } else if state.preferred && params["searchCorpName"] == "005935" { json!([{"repisusrtcd2":"005935","secugrpId":"ST","fssunqno":CORP}]) } else { json!([]) })
}

async fn respond(State(state): State<Arc<Mutex<FakeState>>>, Path(endpoint): Path<String>, Query(params): Query<BTreeMap<String, String>>) -> Response {
    assert_eq!(params["crtfc_key"], KEY);
    let (failure, correction, delayed, no_cfs, xbrl_failure, stale_statement) = {
        let mut state = state.lock().unwrap();
        state.calls.push((endpoint.clone(), params.clone()));
        let scope = format!("{endpoint}/{}/{}", params.get("bsns_year").map_or("", String::as_str), params.get("reprt_code").map_or("", String::as_str));
        (state.failures.get(&scope).or_else(|| state.failures.get(&endpoint)).cloned(), state.correction, state.delayed, state.no_cfs, state.xbrl_failure, state.stale_statement)
    };
    if delayed { tokio::time::sleep(Duration::from_millis(30)).await; }
    if let Some(status) = failure {
        return axum::Json(json!({"status":status,"message":format!("remote echoed {KEY}")})).into_response();
    }
    let receipt = if correction { "20160401000002" } else { RECEIPT };
    match endpoint.as_str() {
        "echo.json" => {
            let escaped:String = KEY.bytes().map(|b|format!("\\u{b:04x}")).collect();
            format!(r#"{{"status":"000","list":[{{"value":"{escaped}"}}]}}"#).into_response()
        }
        "corpCode.xml" => zipped("CORPCODE.xml", &format!("<result><list><corp_code>{CORP}</corp_code><corp_name>회사</corp_name><stock_code>005930</stock_code></list></result>")).into_response(),
        "company.json" => axum::Json(json!({"status":"000","corp_name":"회사","acc_mt":"12"})).into_response(),
        "list.json" => {
            let mut rows = vec![json!({"corp_code":CORP,"rcept_no":RECEIPT,"rcept_dt":"20150331","report_nm":"사업보고서 (2015.12)"})];
            if correction { rows.push(json!({"corp_code":CORP,"rcept_no":receipt,"rcept_dt":"20160401","report_nm":"[기재정정]사업보고서 (2015.12)"})); }
            axum::Json(json!({"status":"000","page_no":1,"total_page":1,"list":rows})).into_response()
        }
        "fnlttSinglAcntAll.json" => {
            if params["bsns_year"] != "2015" || (no_cfs && params["fs_div"] == "CFS") { return axum::Json(json!({"status":"013"})).into_response(); }
            let mut row = account("IS", "ifrs-full_Revenue", if correction { "120" } else { "100" });
            row.insert("account_detail".into(), format!("echoed {KEY}"));
            row.insert("reprt_code".into(), params["reprt_code"].clone());
            row.insert("rcept_no".into(), if stale_statement { RECEIPT } else { receipt }.into());
            axum::Json(json!({"status":"000","list":[row]})).into_response()
        }
        "fnlttXbrl.xml" => {
            if xbrl_failure { return (StatusCode::BAD_GATEWAY, "failure").into_response(); }
            let basis = if no_cfs { "SeparateMember" } else { "ConsolidatedMember" };
            let start = if params["reprt_code"] == "11011" { "2015-01-01" } else { "2015-10-01" };
            let xml = instance(&context("quarter", start, "2015-12-31", basis), &format!("<ifrs:Revenue contextRef=\"quarter\" unitRef=\"krw\">{}</ifrs:Revenue>", if correction { "120" } else { "100" }));
            zipped("statement.xbrl", &xml).into_response()
        }
        "alotMatter.json" => {
            if params["bsns_year"] != "2015" { return axum::Json(json!({"status":"013"})).into_response(); }
            axum::Json(json!({"status":"000","list":[{"corp_code":CORP,"stlm_dt":"2015-12-31","rcept_no":receipt,"se":"주당 현금배당금(원)","stock_knd":"보통주","thstrm":"0"},{"corp_code":CORP,"stlm_dt":"2015-12-31","rcept_no":receipt,"se":"주당 현금배당금(원)","stock_knd":"종류불명","thstrm":"100"}]})).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

fn account(section: &str, id: &str, amount: &str) -> BTreeMap<String, String> {
    [("corp_code",CORP),("bsns_year","2015"),("reprt_code","11014"),("rcept_no",RECEIPT),("sj_div",section),("account_id",id),("account_nm","원래 계정"),("currency","KRW"),("thstrm_nm","제 1기"),("thstrm_amount",amount),("thstrm_add_amount","300")].into_iter().map(|(k,v)|(k.into(),v.into())).collect()
}

fn context(id: &str, start: &str, end: &str, basis: &str) -> String {
    let period = if start.is_empty() { format!("<x:instant>{end}</x:instant>") } else { format!("<x:startDate>{start}</x:startDate><x:endDate>{end}</x:endDate>") };
    format!(r#"<x:context id="{id}"><x:entity><x:identifier scheme="http://dart.fss.or.kr/ifrs/CIK">{CORP}</x:identifier></x:entity><x:period>{period}</x:period><x:scenario><d:explicitMember dimension="ifrs:ConsolidatedAndSeparateFinancialStatementsAxis">ifrs:{basis}</d:explicitMember></x:scenario></x:context>"#)
}

fn instance(contexts: &str, facts: &str) -> String {
    format!(r#"<x:xbrl xmlns:x="http://www.xbrl.org/2003/instance" xmlns:d="http://xbrl.org/2006/xbrldi" xmlns:g="http://dart.fss.or.kr/taxonomy/2025/dart-gcd" xmlns:ifrs="http://xbrl.ifrs.org/taxonomy/2025/ifrs-full" xmlns:iso="http://www.xbrl.org/2003/iso4217"><x:unit id="krw"><x:measure>iso:KRW</x:measure></x:unit>{contexts}{facts}</x:xbrl>"#)
}

fn period_of(account: &server::financials::model::Account) -> &FactPeriod {
    match &account.current_period { Verification::Verified { period, .. } => period, other => panic!("{other:?}") }
}

#[test]
fn verifies_actual_non_december_periods_and_distinguishes_is_cf_and_instants() {
    for (start, end, cumulative_start) in [("2015-07-01","2015-09-30","2015-01-01"),("2015-04-01","2015-06-30","2014-10-01")] {
        let contexts = format!("{}{}{}", context("q",start,end,"ConsolidatedMember"), context("cum",cumulative_start,end,"ConsolidatedMember"), context("instant","",end,"ConsolidatedMember"));
        let facts = r#"<ifrs:Revenue contextRef="q" unitRef="krw">100</ifrs:Revenue><ifrs:Revenue contextRef="cum" unitRef="krw">300</ifrs:Revenue><ifrs:CashFlowsFromUsedInInvestingActivities contextRef="cum" unitRef="krw">-200</ifrs:CashFlowsFromUsedInInvestingActivities><ifrs:Equity contextRef="instant" unitRef="krw">500</ifrs:Equity>"#;
        let rows = vec![account("IS","ifrs-full_Revenue","100"), account("CF","ifrs-full_CashFlowsFromUsedInInvestingActivities","-200"),account("BS","ifrs-full_Equity","500")];
        let result = xbrl::accounts(rows, Basis::CFS, CORP, RECEIPT, &[("report.xbrl".into(),instance(&contexts,facts))],Some(&end[..7]));
        assert_eq!(period_of(&result[0]), &FactPeriod::Duration { start:start.into(),end:end.into() });
        assert_eq!(period_of(&result[1]), &FactPeriod::Duration { start:cumulative_start.into(),end:end.into() });
        assert_eq!(period_of(&result[2]), &FactPeriod::Instant { date:end.into() });
        assert!(matches!(&result[0].cumulative_period, Verification::Verified { period:FactPeriod::Duration { start,.. },.. } if start == cumulative_start));
    }
}

#[test]
fn ambiguous_contexts_mismatched_receipts_basis_currency_and_entity_stay_unverified() {
    let contexts = format!("{}{}",context("q","2015-07-01","2015-09-30","ConsolidatedMember"),context("cum","2015-01-01","2015-09-30","ConsolidatedMember"));
    let facts = r#"<ifrs:CashFlowsFromUsedInInvestingActivities contextRef="q" unitRef="krw">100</ifrs:CashFlowsFromUsedInInvestingActivities><ifrs:CashFlowsFromUsedInInvestingActivities contextRef="cum" unitRef="krw">100</ifrs:CashFlowsFromUsedInInvestingActivities>"#;
    let xml = instance(&contexts,facts);
    let row = account("CF","ifrs-full_CashFlowsFromUsedInInvestingActivities","100");
    let check = |xml:String, basis, receipt:&str| xbrl::accounts(vec![row.clone()],basis,CORP,receipt,&[("report.xbrl".into(),xml)],Some("2015-09"))[0].current_period.clone();
    assert_eq!(check(xml.clone(),Basis::CFS,RECEIPT),Verification::Unverified("ambiguous_context".into()));
    assert_eq!(check(xml.clone(),Basis::CFS,"20160401000002"),Verification::Unverified("receipt_mismatch".into()));
    for xml in [xml.replace(CORP,"99999999"),xml.replace("iso:KRW","iso:USD"),xml.replace("ConsolidatedMember","SeparateMember")] {
        assert_eq!(check(xml,Basis::CFS,RECEIPT),Verification::Unverified("matching_context_missing".into()));
    }
}

fn clock() -> Clock { Clock::fake(kst(KstDate::new(2015,12,31).unwrap(),12,0,0)) }

async fn settled(service: &Arc<Financials>) -> server::financials::model::Snapshot {
    for _ in 0..300 {
        let result = service.open("005930",false,false).await;
        if result.status != "collecting" { return result; }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("collection did not settle");
}

#[tokio::test]
async fn collects_only_requested_company_coalesces_and_reuses_disk_after_restart() {
    let fake = Fake::start().await;
    fake.state.lock().unwrap().preferred = true;
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("financials.db")).await.unwrap();
    let clock = clock();
    let service = Financials::new(Some(fake.client()),store.clone(),clock.clone());
    let unknown = service.open("005939",true,false).await;
    assert_eq!(unknown.status,"unsupported");
    assert_eq!(unknown.reason,Some("company_mapping_unverified"));
    assert_eq!(fake.count("fnlttSinglAcntAll.json"),0);
    let (common,preferred) = tokio::join!(service.open("005930",false,false), service.open("005935",true,false));
    assert_eq!(common.security.unwrap().company.corp_code, preferred.security.as_ref().unwrap().company.corp_code);
    assert_eq!(preferred.security.unwrap().share_class_reason.as_deref(),Some("preferred_issue_class_unverified"));
    let result = settled(&service).await;
    assert_eq!(result.status,"ready");
    assert_eq!(fake.count("fnlttSinglAcntAll.json"),4);
    let report = &result.collection.reports["2015/11011"];
    assert_eq!(report.dividends.data.as_ref().unwrap()[0].fields["thstrm"],"0");
    assert!(report.dividends.data.as_ref().unwrap()[1].share_class_reason.is_some());
    fake.state.lock().unwrap().preferred = false;
    assert!(service.open("005935",true,false).await.security.is_some());
    let before = fake.count("list.json");
    let reopened = Store::open(&dir.path().join("financials.db")).await.unwrap();
    let restarted = Financials::new(Some(fake.client()),reopened,clock.clone());
    assert_eq!(restarted.open("005930",false,false).await.status,"ready");
    assert_eq!(fake.count("list.json"),before);
    let disabled = Financials::new(None,store,clock);
    let saved = disabled.open("005930",false,false).await;
    assert_eq!(saved.status,"not_configured");
    assert_eq!(saved.collection.reports.len(),4);
    let bytes = serde_json::to_string(&result).unwrap();
    assert!(!bytes.contains(KEY));
    let disk = std::fs::read(dir.path().join("financials.db")).unwrap();
    assert!(!disk.windows(KEY.len()).any(|w|w==KEY.as_bytes()));
}

#[tokio::test]
async fn first_and_mid_collection_failures_keep_successes_and_retry_only_failed_periods() {
    for code in ["11013","11014"] {
        let fake = Fake::start().await;
        fake.state.lock().unwrap().failures.insert(format!("fnlttSinglAcntAll.json/2015/{code}"),"010".into());
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("f.db")).await.unwrap();
        let clock = clock();
        let service = Financials::new(Some(fake.client()),store,clock.clone());
        service.open("005930",false,false).await;
        let result = settled(&service).await;
        assert_eq!(result.status,"partial_failure");
        assert_eq!(result.collection.reports[&format!("2015/{code}")].statement.failure,Some(Failure::Authentication));
        assert!(result.collection.reports["2015/11011"].statement.data.is_some());
        assert_eq!(fake.count("fnlttSinglAcntAll.json"),4,"failed CFS must never request OFS");
        fake.state.lock().unwrap().failures.clear();
        clock.jump(61);
        let result = settled(&service).await;
        assert_eq!(result.status,"ready");
        assert_eq!(fake.count("fnlttSinglAcntAll.json"),5);
    }
}

#[tokio::test]
async fn daily_and_manual_refresh_replace_historical_corrections_and_preserve_good_data_on_failure() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("f.db")).await.unwrap();
    let clock = clock();
    let service = Financials::new(Some(fake.client()),store,clock.clone());
    service.open("005930",false,false).await;
    let original = settled(&service).await;
    service.open("005930",false,false).await;
    assert_eq!(fake.count("list.json"),1);
    fake.state.lock().unwrap().correction = true;
    clock.jump(86400);
    let revised = settled(&service).await;
    let account = &revised.collection.reports["2015/11011"].statement.data.as_ref().unwrap().accounts[0];
    assert_eq!(account.fields["thstrm_amount"],"120");
    assert_ne!(revised.collection.last_checked_at,original.collection.last_checked_at);
    fake.state.lock().unwrap().xbrl_failure = true;
    service.open("005930",false,true).await;
    let failed = settled(&service).await;
    assert_eq!(failed.status,"partial_failure");
    let report = &failed.collection.reports["2015/11011"];
    assert_eq!(report.statement.failure,Some(Failure::Remote));
    assert_eq!(report.statement.data.as_ref().unwrap().accounts[0].fields["thstrm_amount"],"120");
}

#[tokio::test]
async fn absence_can_fall_back_but_bad_cfs_cannot_and_missing_mapping_has_a_reason() {
    let fake = Fake::start().await;
    assert!(fake.client().resolve("005935",true).await.unwrap().is_none());
    fake.state.lock().unwrap().kind_other_code = true;
    assert!(fake.client().resolve("005935",true).await.unwrap().is_none(),"대표 보통주 응답을 우선주에 붙이지 않는다");
    fake.state.lock().unwrap().no_cfs = true;
    let result = fake.client().statement(CORP,2015,"11013").await.unwrap().unwrap();
    assert_eq!(result.0,Basis::OFS);
    fake.state.lock().unwrap().failures.insert("fnlttSinglAcntAll.json".into(),"020".into());
    assert_eq!(fake.client().statement(CORP,2015,"11013").await.unwrap_err(),Failure::RateLimited);
}

#[tokio::test]
async fn incomplete_run_resumes_and_disclosure_failures_do_not_discard_saved_data() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("f.db")).await.unwrap();
    let clock = clock();
    let service = Financials::new(Some(fake.client()),store.clone(),clock.clone());
    service.open("005930",false,false).await;
    let original = settled(&service).await;
    let mut partial = original.collection.clone();
    partial.reports.remove("2015/11014");
    store.save(CORP,&partial).await.unwrap();
    let restarted = Financials::new(Some(fake.client()),store,clock.clone());
    clock.jump(61);
    assert_eq!(settled(&restarted).await.collection.reports.len(),4);
    assert_eq!(fake.count("fnlttSinglAcntAll.json"),5);
    fake.state.lock().unwrap().failures.insert("list.json".into(),"010".into());
    restarted.open("005930",false,true).await;
    let failed = settled(&restarted).await;
    assert_eq!(failed.collection.last_checked_at,original.collection.last_checked_at);
    assert_eq!(failed.collection.disclosure_failure,Some(Failure::Authentication));
    assert!(failed.collection.reports["2015/11011"].statement.data.is_some());
}

mod common;

#[tokio::test]
async fn real_price_api_remains_available_without_key_and_during_collection_and_logs_redact_key() {
    let fake = Fake::start().await;
    fake.state.lock().unwrap().delayed = true;
    let kiwoom = common::FakeKiwoom::start().await;
    let client = reqwest::Client::new();
    for configured in [false,true] {
        let dir = tempfile::tempdir().unwrap();
        let key = if configured { KEY } else { "" };
        let server = common::Server::spawn_with(&kiwoom,&dir.path().join("run/server.lock"),dir.path(),&[
            ("OPENDART_API_KEY",std::ffi::OsStr::new(key)),
            ("VALLY_DART_BASE_URL",std::ffi::OsStr::new(&fake.url)),
            ("VALLY_KIND_BASE_URL",std::ffi::OsStr::new(&fake.url)),
        ]);
        let addr = server.addr().await;
        let price_url = format!("http://{addr}/api/bars?symbol=005930&period=D&limit=5");
        let initial = client.get(&price_url).send().await.unwrap();
        let status = initial.status();
        let body = initial.text().await.unwrap();
        assert_eq!(status,StatusCode::OK,"{body}\n{}",server.logs());
        let response = client.get(format!("http://{addr}/api/symbols/005930/financial-source")).send().await.unwrap();
        assert_eq!(response.status(),StatusCode::OK);
        let value:Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
        assert_eq!(value["status"],if configured {"collecting"} else {"not_configured"});
        let price = tokio::time::timeout(Duration::from_secs(1),client.get(&price_url).send()).await.unwrap().unwrap();
        assert_eq!(price.status(),StatusCode::OK);
        let logs = server.stop().await;
        assert!(!logs.contains(KEY),"{logs}");
    }
}

#[tokio::test]
async fn source_failures_retain_raw_accounts_and_resume_without_switching_basis() {
    let fake = Fake::start().await;
    fake.state.lock().unwrap().xbrl_failure = true;
    let dir = tempfile::tempdir().unwrap();
    let clock = clock();
    let service = Financials::new(Some(fake.client()),Store::open(&dir.path().join("f.db")).await.unwrap(),clock.clone());
    service.open("005930",false,false).await;
    let first = settled(&service).await;
    assert_eq!(first.status,"partial_failure");
    let statement = first.collection.reports["2015/11013"].statement.data.as_ref().unwrap();
    assert_eq!(statement.basis,Basis::CFS);
    assert_eq!(statement.source_failure,Some(Failure::Remote));
    assert_eq!(statement.accounts[0].fields["account_nm"],"원래 계정");
    assert!(matches!(statement.accounts[0].current_period,Verification::Unverified(_)));
    fake.state.lock().unwrap().xbrl_failure = false;
    clock.jump(61);
    let recovered = settled(&service).await;
    assert_eq!(recovered.status,"ready");
    assert!(matches!(recovered.collection.reports["2015/11013"].statement.data.as_ref().unwrap().accounts[0].current_period,Verification::Verified {..}));
}

#[tokio::test]
async fn stale_receipt_after_correction_cannot_overwrite_saved_statement() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let service = Financials::new(Some(fake.client()),Store::open(&dir.path().join("f.db")).await.unwrap(),clock());
    service.open("005930",false,false).await;
    settled(&service).await;
    {
        let mut state = fake.state.lock().unwrap();
        state.correction = true;
        state.stale_statement = true;
    }
    service.open("005930",false,true).await;
    let result = settled(&service).await;
    let report = &result.collection.reports["2015/11011"];
    assert_eq!(report.statement.failure,Some(Failure::ReceiptMismatch));
    assert_eq!(report.statement.data.as_ref().unwrap().accounts[0].fields["thstrm_amount"],"100");
}

#[test]
fn absent_period_anchor_and_extra_dimensions_cannot_be_verified() {
    let contexts = context("q","2015-07-01","2015-09-30","ConsolidatedMember");
    let facts = r#"<ifrs:Revenue contextRef="q" unitRef="krw">100</ifrs:Revenue>"#;
    let xml = instance(&contexts,facts);
    let rows = vec![account("IS","ifrs-full_Revenue","100")];
    let missing = xbrl::accounts(rows.clone(),Basis::CFS,CORP,RECEIPT,&[("r.xbrl".into(),xml.clone())],None);
    assert_eq!(missing[0].current_period,Verification::Unverified("report_period_anchor_missing".into()));
    let extra = xml.replace("</x:scenario>","<d:explicitMember dimension=\"ifrs:SegmentsAxis\">ifrs:OtherMember</d:explicitMember></x:scenario>");
    let extra = xbrl::accounts(rows,Basis::CFS,CORP,RECEIPT,&[("r.xbrl".into(),extra)],Some("2015-09"));
    assert_eq!(extra[0].current_period,Verification::Unverified("matching_context_missing".into()));
}

#[test]
fn shortened_annual_period_is_preserved_without_synthesizing_a_year() {
    let xml = instance(&context("short","2015-11-01","2015-12-31","SeparateMember"),r#"<ifrs:Revenue contextRef="short" unitRef="krw">100</ifrs:Revenue>"#);
    let mut row = account("IS","ifrs-full_Revenue","100");
    row.insert("reprt_code".into(),"11011".into());
    let result = xbrl::accounts(vec![row],Basis::OFS,CORP,RECEIPT,&[("r.xbrl".into(),xml)],Some("2015-12"));
    assert_eq!(period_of(&result[0]), &FactPeriod::Duration { start:"2015-11-01".into(),end:"2015-12-31".into() });
}

#[tokio::test]
async fn one_company_mapping_failure_does_not_poison_the_directory_retry() {
    let fake = Fake::start().await;
    let client = fake.client();
    fake.state.lock().unwrap().failures.insert("corpCode.xml".into(),"010".into());
    assert_eq!(client.resolve("005930",false).await.unwrap_err(),Failure::Authentication);
    fake.state.lock().unwrap().failures.clear();
    assert!(client.resolve("005930",false).await.unwrap().is_some());
}

#[tokio::test]
async fn json_escaped_secrets_are_redacted_after_decoding() {
    let fake = Fake::start().await;
    let rows = fake.client().rows("echo.json",&[]).await.unwrap();
    assert_eq!(rows[0]["value"],"[redacted]");
}
