use std::collections::{BTreeMap, HashMap};
use std::io::{Cursor, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{Router, extract::{Path, Query, State}, http::StatusCode, response::{IntoResponse, Response}, routing::get};
use serde_json::{Value, json};
use server::{api::{FinancialUpdatePage, FinancialUpdateStatus}, clock::{Clock, kst}, config::Secret, financials::{Financials, client::Client, company_records::{ReadSnapshot, ReadState, UnsupportedReason}, model::{Interrupt, Basis, Failure, FactPeriod, Verification, REPORT_CODES}, store::Store, xbrl}};
use domain::KstDate;

const KEY: &str = "synthetic-dart-secret-for-test-159";
const RECEIPT: &str = "20150331000001";
const CORP: &str = "00126380";

#[derive(Default)]
struct FakeState {
    calls: Vec<(String, BTreeMap<String, String>)>,
    requests_changed: Arc<tokio::sync::Notify>,
    failures: HashMap<String, String>,
    http_failure: Option<StatusCode>,
    request_times: Vec<std::time::Instant>,
    correction: bool,
    later_correction: bool,
    delayed: bool,
    preferred: bool,
    kind_other_code: bool,
    no_cfs: bool,
    xbrl_failure: bool,
    stale_statement: bool,
    mismatched_xbrl: bool,
    paused_report: Option<String>,
    nonstandard_account: bool,
    notice: Option<String>,
    notice_status: Option<StatusCode>,
    notice_network_failure: bool,
    kind_responses: HashMap<String, Value>,
    directory: Option<String>,
    company_code: Option<String>,
    preferred_dividend: bool,
    discovery_search: Option<String>,
    discovery_contents: Option<String>,
    discovery_failure: Option<(String, StatusCode)>,
    discovery_network: Option<String>,
    discovery_paused: Option<String>,
    stream_paused_report: Option<String>,
    stream_paused_company: Option<String>,
    stream_paused_year: Option<String>,
    paused_list: bool,
    list_pages: bool,
    statement_amounts: HashMap<String, String>,
    integrated_financials: bool,
    report_corrections: std::collections::BTreeSet<(i32, String)>,
}

impl FakeState {
    fn record(&mut self, endpoint: String, params: BTreeMap<String, String>) {
        self.calls.push((endpoint, params));
        self.requests_changed.notify_waiters();
    }
}

struct Fake { state: Arc<Mutex<FakeState>>, url: String, task: tokio::task::JoinHandle<()> }

impl Drop for Fake { fn drop(&mut self) { self.task.abort(); } }

impl Fake {
    async fn start() -> Self {
        let state = Arc::new(Mutex::new(FakeState::default()));
        let app = Router::new().route("/api/{endpoint}", get(respond)).route("/common/searchcorpname.do", get(kind)).route("/external/{*path}", get(notice)).route("/disclosure/searchtotalinfo.do", get(discovery)).route("/common/disclsviewer.do", get(discovery)).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        Self { state, url, task }
    }

    async fn wait_for_call(&self, endpoint: &str, count: usize) {
        self.wait_for_source(endpoint, || self.count(endpoint) >= count).await;
    }

    async fn wait_for_source(&self, label: &str, ready: impl Fn() -> bool) {
        let changed = self.state.lock().unwrap().requests_changed.clone();
        let reached = tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                let notified = changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if ready() { return; }
                tokio::time::timeout(Duration::from_secs(10), notified).await.unwrap_or_else(|error| panic!("{label} made no source progress: {error:?}; {:?}", self.observed()));
            }
        }).await;
        reached.unwrap_or_else(|error| panic!("{label} was not reached: {error:?}; {:?}", self.observed()));
    }

    fn client(&self) -> Client { Client::new(Secret::new(KEY.into()), self.url.clone(), self.url.clone()).unwrap() }
    fn count(&self, endpoint: &str) -> usize { self.state.lock().unwrap().calls.iter().filter(|(e, _)| e == endpoint).count() }

    fn observed(&self) -> Vec<(String, BTreeMap<String, String>)> {
        self.state.lock().unwrap().calls.iter().map(|(endpoint, params)| {
            let scope = params.iter().filter(|(key, _)| matches!(key.as_str(), "corp_code" | "bsns_year" | "reprt_code")).map(|(key, value)| (key.clone(), value.clone())).collect();
            (endpoint.clone(), scope)
        }).collect()
    }
}

fn zipped(name: &str, xml: &str) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
    zip.write_all(xml.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

async fn kind(State(state): State<Arc<Mutex<FakeState>>>, Query(params): Query<BTreeMap<String, String>>) -> axum::Json<Value> {
    let mut state = state.lock().unwrap();
    state.record("kind".into(), params.clone());
    if let Some(rows) = state.kind_responses.get(&params["searchCorpName"]) { return axum::Json(rows.clone()); }
    axum::Json(if state.kind_other_code { json!([{ "repisusrtcd2":"005930", "secugrpId":"ST", "fssunqno":CORP }]) } else if state.preferred && params["searchCorpName"] == "005935" { json!([{"repisusrtcd2":"005935","secugrpId":"ST","fssunqno":CORP}]) } else { json!([]) })
}

async fn discovery(State(state): State<Arc<Mutex<FakeState>>>, Query(params): Query<BTreeMap<String, String>>) -> Response {
    let stage = if params["method"] == "searchContents" { "contents" } else { "search" };
    state.lock().unwrap().record(stage.into(), params);
    loop {
        if state.lock().unwrap().discovery_paused.as_deref() != Some(stage) { break; }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let state = state.lock().unwrap();
    if state.discovery_network.as_deref() == Some(stage) {
        let stream = futures::stream::once(async { Err::<String, _>(std::io::Error::other("synthetic discovery body failure")) });
        return Response::new(axum::body::Body::from_stream(stream));
    }
    if let Some((failed, status)) = &state.discovery_failure && failed == stage { return (*status,"synthetic source failure").into_response(); }
    if stage == "search" {
        state.discovery_search.clone().unwrap_or_else(|| "<section class=\"paging-group\"><div class=\"info\"><em>0</em></div></section>검색결과가 없습니다.".into()).into_response()
    } else {
        state.discovery_contents.clone().unwrap_or_default().into_response()
    }
}

async fn notice(State(state): State<Arc<Mutex<FakeState>>>) -> Response {
    let mut state = state.lock().unwrap();
    state.record("notice".into(), BTreeMap::new());
    if state.notice_network_failure {
        let stream = futures::stream::once(async { Err::<String, _>(std::io::Error::other("synthetic body failure")) });
        return Response::new(axum::body::Body::from_stream(stream));
    }
    (state.notice_status.unwrap_or(StatusCode::OK), state.notice.clone().unwrap_or_else(|| "<HTML><PRE></PRE></HTML>".into())).into_response()
}

async fn respond(State(state): State<Arc<Mutex<FakeState>>>, Path(endpoint): Path<String>, Query(params): Query<BTreeMap<String, String>>) -> Response {
    let paused = {
        let mut state = state.lock().unwrap();
        let paused = (endpoint == "list.json" && state.paused_list) || (endpoint == "fnlttSinglAcntAll.json" && state.stream_paused_report.as_ref() == params.get("reprt_code") && state.stream_paused_company.as_ref().is_none_or(|company| Some(company) == params.get("corp_code")) && state.stream_paused_year.as_ref().is_none_or(|year| Some(year) == params.get("bsns_year")));
        if paused { state.record(if endpoint == "list.json" { "listing_stream" } else { "statement_stream" }.into(),params.clone()); }
        paused
    };
    if paused {
        let stream = futures::stream::once(async move {
            loop {
                let paused = { let state = state.lock().unwrap(); if endpoint == "list.json" { state.paused_list } else { state.stream_paused_report.is_some() } };
                if !paused { break; }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            let response = respond_data(State(state),Path(endpoint),Query(params)).await;
            axum::body::to_bytes(response.into_body(),1024*1024).await
        });
        return Response::new(axum::body::Body::from_stream(stream));
    }
    respond_data(State(state),Path(endpoint),Query(params)).await
}

async fn respond_data(State(state): State<Arc<Mutex<FakeState>>>, Path(endpoint): Path<String>, Query(params): Query<BTreeMap<String, String>>) -> Response {
    assert_eq!(params["crtfc_key"], KEY);
    {
        let mut state = state.lock().unwrap();
        state.request_times.push(std::time::Instant::now());
        if let Some(status) = state.http_failure { state.record(endpoint, params); return (status, "synthetic transport failure").into_response(); }
    }
    let (failure, correction, delayed, no_cfs, xbrl_failure, stale_statement, mismatched_xbrl, paused, nonstandard_account) = {
        let mut state = state.lock().unwrap();
        state.record(endpoint.clone(), params.clone());
        let scope = format!("{endpoint}/{}/{}", params.get("bsns_year").map_or("", String::as_str), params.get("reprt_code").map_or("", String::as_str));
        let company_scope = format!("{scope}/{}", params.get("corp_code").map_or("", String::as_str));
        (state.failures.get(&company_scope).or_else(|| state.failures.get(&scope)).or_else(|| state.failures.get(&endpoint)).cloned(), state.correction, state.delayed, state.no_cfs, state.xbrl_failure, state.stale_statement, state.mismatched_xbrl, endpoint == "fnlttSinglAcntAll.json" && state.paused_report.as_ref() == params.get("reprt_code"), state.nonstandard_account)
    };
    if paused { std::future::pending::<()>().await; }
    if delayed { tokio::time::sleep(Duration::from_millis(30)).await; }
    if let Some(status) = failure {
        return axum::Json(json!({"status":status,"message":format!("remote echoed {KEY}")})).into_response();
    }
    if state.lock().unwrap().integrated_financials && matches!(endpoint.as_str(), "list.json" | "fnlttSinglAcntAll.json" | "fnlttXbrl.xml" | "alotMatter.json") {
        return mapping::integrated_response(&endpoint, &params, &state.lock().unwrap().report_corrections);
    }
    let corp = params.get("corp_code").map(String::as_str).unwrap_or_else(|| if params.get("rcept_no").is_some_and(|receipt| ["20150331000011","20160401000012"].contains(&receipt.as_str())) { "00000002" } else { CORP });
    let original_receipt = if corp == CORP { RECEIPT } else { "20150331000011" };
    let corrected_receipt = if corp == CORP { "20160401000002" } else { "20160401000012" };
    let later_correction = state.lock().unwrap().later_correction;
    let later_receipt = if corp == CORP { "20160402000003" } else { "20160402000013" };
    let receipt = if correction && later_correction { later_receipt } else if correction { corrected_receipt } else { original_receipt };
    let amount = state.lock().unwrap().statement_amounts.get(corp).cloned().unwrap_or_else(|| if correction { "120" } else { "100" }.into());
    match endpoint.as_str() {
        "echo.json" => {
            let escaped:String = KEY.bytes().map(|b|format!("\\u{b:04x}")).collect();
            format!(r#"{{"status":"000","list":[{{"value":"{escaped}"}}]}}"#).into_response()
        }
        "corpCode.xml" => zipped("CORPCODE.xml", &fake_directory(&state)).into_response(),
        "company.json" => {
            let code = state.lock().unwrap().company_code.clone().unwrap_or_else(|| corp.into());
            axum::Json(json!({"status":"000","corp_code":code,"corp_name":"회사","acc_mt":"12"})).into_response()
        }
        "list.json" => {
            let mut rows = vec![json!({"corp_code":corp,"rcept_no":original_receipt,"rcept_dt":"20150331","report_nm":"사업보고서 (2015.12)"})];
            if correction { rows.push(json!({"corp_code":corp,"rcept_no":corrected_receipt,"rcept_dt":"20160401","report_nm":"[기재정정]사업보고서 (2015.12)"})); }
            if correction && later_correction { rows.push(json!({"corp_code":corp,"rcept_no":later_receipt,"rcept_dt":"20160402","report_nm":"[기재정정]사업보고서 (2015.12)"})); }
            if state.lock().unwrap().list_pages {
                let page = params["page_no"].parse::<u32>().unwrap();
                if page == 2 { rows = vec![json!({"corp_code":corp,"rcept_no":"20150331000009","rcept_dt":"20150331","report_nm":"분기보고서 (2015.03)"})]; }
                return axum::Json(json!({"status":"000","page_no":page,"total_page":2,"list":rows})).into_response();
            }
            axum::Json(json!({"status":"000","page_no":1,"total_page":1,"list":rows})).into_response()
        }
        "fnlttSinglAcntAll.json" => {
            if params["bsns_year"] != "2015" || (no_cfs && params["fs_div"] == "CFS") { return axum::Json(json!({"status":"013"})).into_response(); }
            let mut row = account("IS", "ifrs-full_Revenue", &amount);
            row.insert("corp_code".into(), corp.into());
            if nonstandard_account { row.insert("account_id".into(), "-표준계정코드 미사용-".into()); }
            row.insert("account_detail".into(), format!("echoed {KEY}"));
            row.insert("reprt_code".into(), params["reprt_code"].clone());
            row.insert("rcept_no".into(), if stale_statement { RECEIPT } else { receipt }.into());
            axum::Json(json!({"status":"000","list":[row]})).into_response()
        }
        "fnlttXbrl.xml" => {
            if xbrl_failure { return (StatusCode::BAD_GATEWAY, "failure").into_response(); }
            let basis = if no_cfs { "SeparateMember" } else { "ConsolidatedMember" };
            let start = if params["reprt_code"] == "11011" { "2015-01-01" } else { "2015-10-01" };
            let stamp = if mismatched_xbrl { RECEIPT } else { receipt };
            let xml = instance(&context("quarter", start, "2015-12-31", basis), &format!("<g:DocumentReceiptNumber>{stamp}</g:DocumentReceiptNumber><ifrs:Revenue contextRef=\"quarter\" unitRef=\"krw\">{}</ifrs:Revenue>", amount));
            zipped("statement.xbrl", &xml.replace(CORP,corp)).into_response()
        }
        "alotMatter.json" => {
            if params["bsns_year"] != "2015" { return axum::Json(json!({"status":"013"})).into_response(); }
            let mut rows = vec![json!({"corp_code":corp,"stlm_dt":"2015-12-31","rcept_no":receipt,"se":"주당 현금배당금(원)","stock_knd":"보통주","thstrm":"0"}),json!({"corp_code":corp,"stlm_dt":"2015-12-31","rcept_no":receipt,"se":"주당 현금배당금(원)","stock_knd":"종류불명","thstrm":"100"})];
            if state.lock().unwrap().preferred_dividend { rows.push(json!({"corp_code":corp,"stlm_dt":"2015-12-31","rcept_no":receipt,"se":"주당 현금배당금(원)","stock_knd":"우선주","thstrm":"7"})); }
            axum::Json(json!({"status":"000","list":rows})).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

fn fake_directory(state: &Mutex<FakeState>) -> String {
    state.lock().unwrap().directory.clone().unwrap_or_else(|| format!("<result><list><corp_code>{CORP}</corp_code><corp_name>회사</corp_name><stock_code>005930</stock_code></list><list><corp_code>00000002</corp_code><corp_name>다른 회사</corp_name><stock_code>000001</stock_code></list></result>"))
}

#[path = "financials/mapping.rs"]
mod mapping;

#[path = "financials/discovery.rs"]
mod discovery;

#[path = "financials/review_fix.rs"]
mod discovery_review_fix;

#[path = "financials/incremental.rs"]
mod incremental;

#[path = "financials/updates.rs"]
mod updates;

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
        let result = xbrl::accounts(rows, Basis::CFS, CORP, RECEIPT, &[("report.xbrl".into(),instance(&contexts,facts))],Some(&end[..7])).unwrap();
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
    let check = |xml:String, basis, receipt:&str| xbrl::accounts(vec![row.clone()],basis,CORP,receipt,&[("report.xbrl".into(),xml)],Some("2015-09")).unwrap()[0].current_period.clone();
    assert_eq!(check(xml.clone(),Basis::CFS,RECEIPT),Verification::Unverified("ambiguous_context".into()));
    assert_eq!(check(xml.clone(),Basis::CFS,"20160401000002"),Verification::Unverified("receipt_mismatch".into()));
    for xml in [xml.replace(CORP,"99999999"),xml.replace("iso:KRW","iso:USD"),xml.replace("ConsolidatedMember","SeparateMember")] {
        assert_eq!(check(xml,Basis::CFS,RECEIPT),Verification::Unverified("matching_context_missing".into()));
    }
}

fn clock() -> Clock { Clock::fake(kst(KstDate::new(2015,12,31).unwrap(),12,0,0)) }

fn symbol(code: &str, preferred: bool) -> domain::SymbolInfo {
    domain::SymbolInfo { symbol: domain::Symbol::parse(code).unwrap(), name: code.into(), kind: if preferred { domain::SymbolKind::Preferred } else { domain::SymbolKind::Common }, market: domain::Market::Kospi, nxt_enabled: false }
}

async fn run_update(service: &Arc<Financials>, stocks: &[(&str,bool)]) -> FinancialUpdatePage {
    service.start_update(stocks.iter().map(|(code,preferred)| symbol(code,*preferred)).collect()).await;
    tokio::time::timeout(Duration::from_secs(60),async {
        loop {
            let page = service.update_status().await;
            if !matches!(page.status,FinancialUpdateStatus::Planning|FinancialUpdateStatus::Collecting|FinancialUpdateStatus::Pausing|FinancialUpdateStatus::Checking) { break page; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.expect("financial update did not finish")
}

async fn settled_stock(service: &Arc<Financials>, stock: &str, preferred: bool) -> ReadSnapshot {
    run_update(service,&[(stock,preferred)]).await;
    service.read(stock).await
}

async fn settled(service: &Arc<Financials>) -> ReadSnapshot { settled_stock(service,"005930",false).await }

#[tokio::test]
async fn collects_only_requested_companies_and_reads_disk_after_restart() {
    let fake = Fake::start().await;
    fake.state.lock().unwrap().preferred = true;
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("financials.db")).await.unwrap();
    let clock = clock();
    let service = Financials::new(Some(fake.client()),store.clone(),clock.clone());
    let unknown = settled_stock(&service,"005939",true).await;
    assert_eq!(unknown.state,ReadState::Unsupported);
    assert_eq!(unknown.reason,Some(UnsupportedReason::CompanyMappingUnverified));
    assert_eq!(fake.count("fnlttSinglAcntAll.json"),0);
    run_update(&service,&[("005930",false),("005935",true)]).await;
    let (common,preferred) = (service.read("005930").await,service.read("005935").await);
    assert_eq!(common.security.unwrap().company.corp_code, preferred.security.as_ref().unwrap().company.corp_code);
    assert_eq!(preferred.security.unwrap().share_class_reason.as_deref(),Some("preferred_issue_class_unverified"));
    let result = service.read("005930").await;
    assert_eq!(result.state,ReadState::Ready);
    assert_eq!(fake.count("fnlttSinglAcntAll.json"),4);
    let report = &result.collection.reports["2015/11011"];
    assert_eq!(report.dividends.data.as_ref().unwrap()[0].fields["thstrm"],"0");
    assert!(report.dividends.data.as_ref().unwrap()[1].share_class_reason.is_some());
    fake.state.lock().unwrap().preferred = false;
    assert!(settled_stock(&service,"005935",true).await.security.is_some());
    let before = fake.count("list.json");
    let reopened = Store::open(&dir.path().join("financials.db")).await.unwrap();
    let restarted = Financials::new(Some(fake.client()),reopened,clock.clone());
    assert_eq!(restarted.read("005930").await.state,ReadState::Ready);
    assert_eq!(fake.count("list.json"),before);
    let disabled = Financials::new(None,store,clock);
    let saved = disabled.read("005930").await;
    assert_eq!(saved.state,ReadState::NotConfigured);
    assert_eq!(saved.collection.reports.len(),4);
    let bytes = serde_json::to_string(&(&result.security, &result.collection)).unwrap();
    assert!(!bytes.contains(KEY));
    let disk = std::fs::read(dir.path().join("financials.db")).unwrap();
    assert!(!disk.windows(KEY.len()).any(|w|w==KEY.as_bytes()));
}

#[tokio::test]
async fn first_and_mid_collection_failures_keep_successes_and_retry_only_failed_periods() {
    for code in ["11013","11014"] {
        let fake = Fake::start().await;
        fake.state.lock().unwrap().failures.insert(format!("fnlttSinglAcntAll.json/2015/{code}"),"800".into());
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("f.db")).await.unwrap();
        let service = Financials::new(Some(fake.client()),store,clock());
        let result = settled(&service).await;
        assert_eq!(result.state,ReadState::PartialFailure);
        assert_eq!(result.collection.reports[&format!("2015/{code}")].statement.failure,Some(Failure::Remote));
        assert!(result.collection.reports["2015/11011"].statement.data.is_some());
        assert_eq!(fake.count("fnlttSinglAcntAll.json"),6,"failed CFS is retried three times and never requests OFS");
        fake.state.lock().unwrap().failures.clear();
        let result = settled(&service).await;
        assert_eq!(result.state,ReadState::Ready);
        assert_eq!(fake.count("fnlttSinglAcntAll.json"),7);
    }
}

#[tokio::test]
async fn daily_and_manual_refresh_replace_historical_corrections_and_preserve_good_data_on_failure() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("f.db")).await.unwrap();
    let clock = clock();
    let service = Financials::new(Some(fake.client()),store,clock.clone());
    let original = settled(&service).await;
    fake.state.lock().unwrap().correction = true;
    clock.jump(86400);
    let revised = settled(&service).await;
    let account = &revised.collection.reports["2015/11011"].statement.data.as_ref().unwrap().accounts[0];
    assert_eq!(account.fields["thstrm_amount"],"120");
    assert_ne!(revised.collection.last_checked_at,original.collection.last_checked_at);
    fake.state.lock().unwrap().xbrl_failure = true;
    fake.state.lock().unwrap().later_correction = true;
    let failed = settled(&service).await;
    assert_eq!(failed.state,ReadState::PartialFailure);
    let report = &failed.collection.reports["2015/11011"];
    assert_eq!(report.statement.failure,Some(Failure::Remote));
    assert_eq!(report.statement.data.as_ref().unwrap().accounts[0].fields["thstrm_amount"],"120");
}

#[tokio::test]
async fn absence_can_fall_back_but_bad_cfs_cannot_and_missing_mapping_has_a_reason() {
    let fake = Fake::start().await;
    assert_eq!(fake.client().resolve("005935",true).await.unwrap_err(),Interrupt::Failure(Failure::InvalidResponse));
    fake.state.lock().unwrap().kind_other_code = true;
    assert!(fake.client().resolve("005935",true).await.unwrap().is_none(),"대표 보통주 응답을 우선주에 붙이지 않는다");
    fake.state.lock().unwrap().no_cfs = true;
    let result = fake.client().statement(CORP,2015,"11013").await.unwrap().unwrap();
    assert_eq!(result.0,Basis::OFS);
    fake.state.lock().unwrap().failures.insert("fnlttSinglAcntAll.json".into(),"020".into());
    assert_eq!(fake.client().statement(CORP,2015,"11013").await.unwrap_err(),Interrupt::Failure(Failure::RateLimited));
}

#[tokio::test]
async fn incomplete_run_resumes_and_disclosure_failures_do_not_discard_saved_data() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("f.db")).await.unwrap();
    let clock = clock();
    let service = Financials::new(Some(fake.client()),store.clone(),clock.clone());
    let original = settled(&service).await;
    let mut partial = original.collection.clone();
    partial.reports.remove("2015/11014");
    store.save(CORP,&partial).await.unwrap();
    let restarted = Financials::new(Some(fake.client()),store,clock.clone());
    let resumed = settled(&restarted).await;
    assert_eq!(resumed.collection.reports.len(),4);
    assert_eq!(fake.count("fnlttSinglAcntAll.json"),5);
    fake.state.lock().unwrap().failures.insert("list.json".into(),"800".into());
    clock.jump(61);
    let failed = settled(&restarted).await;
    assert_eq!(failed.collection.last_checked_at,resumed.collection.last_checked_at);
    assert_eq!(failed.collection.disclosure_failure,Some(Failure::Remote));
    assert!(failed.collection.reports["2015/11011"].statement.data.is_some());
}

mod common;

#[tokio::test]
async fn real_price_api_remains_available_without_key_and_during_collection_and_logs_redact_key() {
    let fake = Fake::start().await;
    fake.state.lock().unwrap().delayed = true;
    let kiwoom = common::ScriptedTransport::new();
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
        assert_eq!(value["status"],if configured {"not_collected"} else {"not_configured"});
        http_start(&client, &format!("http://{addr}")).await;
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
    let service = Financials::new(Some(fake.client()),Store::open(&dir.path().join("f.db")).await.unwrap(),clock());
    let first = settled(&service).await;
    assert_eq!(first.state,ReadState::PartialFailure);
    let statement = first.collection.reports["2015/11013"].statement.data.as_ref().unwrap();
    assert_eq!(statement.basis,Basis::CFS);
    assert_eq!(statement.source_failure,Some(Failure::Remote));
    assert_eq!(statement.accounts[0].fields["account_nm"],"원래 계정");
    assert!(matches!(statement.accounts[0].current_period,Verification::Unverified(_)));
    fake.state.lock().unwrap().xbrl_failure = false;
    let recovered = settled(&service).await;
    assert_eq!(recovered.state,ReadState::Ready);
    assert!(matches!(recovered.collection.reports["2015/11013"].statement.data.as_ref().unwrap().accounts[0].current_period,Verification::Verified {..}));
}

#[tokio::test]
async fn stale_receipt_after_correction_cannot_overwrite_saved_statement() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let service = Financials::new(Some(fake.client()),Store::open(&dir.path().join("f.db")).await.unwrap(),clock());
    settled(&service).await;
    {
        let mut state = fake.state.lock().unwrap();
        state.correction = true;
        state.stale_statement = true;
    }
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
    let missing = xbrl::accounts(rows.clone(),Basis::CFS,CORP,RECEIPT,&[("r.xbrl".into(),xml.clone())],None).unwrap();
    assert_eq!(missing[0].current_period,Verification::Unverified("report_period_anchor_missing".into()));
    let extra = xml.replace("</x:scenario>","<d:explicitMember dimension=\"ifrs:SegmentsAxis\">ifrs:OtherMember</d:explicitMember></x:scenario>");
    let extra = xbrl::accounts(rows,Basis::CFS,CORP,RECEIPT,&[("r.xbrl".into(),extra)],Some("2015-09")).unwrap();
    assert_eq!(extra[0].current_period,Verification::Unverified("matching_context_missing".into()));
}

#[test]
fn shortened_annual_period_is_preserved_without_synthesizing_a_year() {
    let xml = instance(&context("short","2015-11-01","2015-12-31","SeparateMember"),r#"<ifrs:Revenue contextRef="short" unitRef="krw">100</ifrs:Revenue>"#);
    let mut row = account("IS","ifrs-full_Revenue","100");
    row.insert("reprt_code".into(),"11011".into());
    let result = xbrl::accounts(vec![row],Basis::OFS,CORP,RECEIPT,&[("r.xbrl".into(),xml)],Some("2015-12")).unwrap();
    assert_eq!(period_of(&result[0]), &FactPeriod::Duration { start:"2015-11-01".into(),end:"2015-12-31".into() });
}

#[tokio::test]
async fn one_company_mapping_failure_does_not_poison_the_directory_retry() {
    let fake = Fake::start().await;
    let client = fake.client();
    fake.state.lock().unwrap().failures.insert("corpCode.xml".into(),"010".into());
    assert_eq!(client.resolve("005930",false).await.unwrap_err(),Interrupt::Failure(Failure::Authentication));
    fake.state.lock().unwrap().failures.clear();
    assert!(client.resolve("005930",false).await.unwrap().is_some());
}

#[tokio::test]
async fn json_escaped_secrets_are_redacted_after_decoding() {
    let fake = Fake::start().await;
    let rows = fake.client().rows("echo.json",&[]).await.unwrap();
    assert_eq!(rows[0]["value"],"[redacted]");
}

async fn http_snapshot(client: &reqwest::Client, base: &str) -> Value {
    let response = client.get(format!("{base}/api/symbols/005930/financial-source")).send().await.unwrap();
    assert_eq!(response.status(),StatusCode::OK);
    serde_json::from_slice(&response.bytes().await.unwrap()).unwrap()
}

fn assert_saved_report_fetches(current: &Value, previous: &Value) {
    for (key, report) in previous["reports"].as_object().unwrap() {
        for fetch in ["statement", "dividends"] {
            for field in ["data", "checked_at", "last_success_at", "refresh_version", "failure"] {
                assert_eq!(current["reports"][key][fetch][field], report[fetch][field], "{key}/{fetch}/{field}");
            }
        }
    }
}

async fn http_start(client: &reqwest::Client, base: &str) {
    client.post(format!("{base}/api/financial-update")).send().await.unwrap().error_for_status().unwrap();
}

async fn http_settled(fake: &Fake, client: &reqwest::Client, base: &str) -> Value {
    updates::finished(fake, client, base).await;
    let snapshot = http_snapshot(client, base).await;
    assert_ne!(snapshot["status"], "collecting", "a terminal job must leave readable company data");
    snapshot
}

fn process(fake: &Fake, kiwoom: &common::ScriptedTransport, dir: &std::path::Path, start: &str) -> common::Server {
    common::Server::spawn_with(kiwoom,&dir.join("run/server.lock"),dir,&[
        ("OPENDART_API_KEY",std::ffi::OsStr::new(KEY)),
        ("VALLY_DART_BASE_URL",std::ffi::OsStr::new(&fake.url)),
        ("VALLY_KIND_BASE_URL",std::ffi::OsStr::new(&fake.url)),
        ("VALLY_CLOCK_START",std::ffi::OsStr::new(start)),
    ])
}

fn report_calls(fake: &Fake, code: &str) -> usize {
    fake.state.lock().unwrap().calls.iter().filter(|(endpoint,params)| endpoint == "fnlttSinglAcntAll.json" && params.get("reprt_code").is_some_and(|c|c == code) && params.get("bsns_year").is_some_and(|y|y == "2015")).count()
}

#[tokio::test]
async fn review_restart_resumes_corrections_after_list_commit_and_partial_report_commit() {
    for paused in ["11013","11014"] {
        let fake = Fake::start().await;
        let kiwoom = common::ScriptedTransport::new();
        let dir = tempfile::tempdir().unwrap();
        let client = reqwest::Client::new();
        let server = process(&fake,&kiwoom,dir.path(),"20151231120000");
        let base = format!("http://{}",server.addr().await);
        assert_eq!(client.get(format!("{base}/api/symbols/005930")).send().await.unwrap().status(),StatusCode::OK);
        http_start(&client, &base).await;
        let original = http_settled(&fake,&client,&base).await;
        assert_eq!(original["status"],"ready");
        let before = report_calls(&fake,paused);
        {
            let mut state = fake.state.lock().unwrap();
            state.correction = true;
            state.paused_report = Some(paused.into());
        }
        client.post(format!("{base}/api/symbols/005930/financial-source")).send().await.unwrap();
        fake.wait_for_source(paused, || report_calls(&fake, paused) > before).await;
        let update: Value = serde_json::from_slice(&client.get(format!("{base}/api/financial-update")).send().await.unwrap().bytes().await.unwrap()).unwrap();
        assert!(report_calls(&fake,paused) > before, "manual update did not request {paused}: {update}");
        let interrupted = http_snapshot(&client,&base).await;
        assert_eq!(interrupted["collection"]["disclosures"][1]["rcept_no"],"20160401000002");
        if paused == "11014" {
            assert_eq!(interrupted["collection"]["reports"]["2015/11013"]["statement"]["data"]["accounts"][0]["fields"]["thstrm_amount"],"100","displayed reports retain the last coherent snapshot until all changed inputs are ready");
        }
        server.stop().await;
        fake.state.lock().unwrap().paused_report = None;
        let first_calls = report_calls(&fake,"11013");
        let restarted = process(&fake,&kiwoom,dir.path(),"20160101120000");
        let base = format!("http://{}",restarted.addr().await);
        assert_eq!(client.get(format!("{base}/api/symbols/005930")).send().await.unwrap().status(),StatusCode::OK);
        http_start(&client, &base).await;
        let recovered = http_settled(&fake,&client,&base).await;
        assert_eq!(recovered["status"],"ready");
        for code in ["11013","11012","11014","11011"] {
            assert_eq!(recovered["collection"]["reports"][format!("2015/{code}")]["statement"]["data"]["accounts"][0]["fields"]["thstrm_amount"],"120","restart at {paused}, report {code}");
        }
        if paused == "11014" { assert_eq!(report_calls(&fake,"11013"),first_calls,"already refreshed report must be reused"); }
        let counts = fake.count("fnlttSinglAcntAll.json");
        assert_eq!(http_snapshot(&client,&base).await["status"],"ready");
        assert_eq!(fake.count("fnlttSinglAcntAll.json"),counts,"ordinary reads must not refetch all years");
        restarted.stop().await;
    }
}

#[tokio::test]
async fn review_mismatched_xbrl_preserves_verified_data_and_recovers_on_retry() {
    for initial_failure in [false,true] {
        let fake = Fake::start().await;
        let dir = tempfile::tempdir().unwrap();
        let clock = clock();
        let service = Financials::new(Some(fake.client()),Store::open(&dir.path().join("f.db")).await.unwrap(),clock.clone());
        if initial_failure { fake.state.lock().unwrap().mismatched_xbrl = true; fake.state.lock().unwrap().correction = true; }
        let original = settled(&service).await;
        if !initial_failure {
            {
                let mut state = fake.state.lock().unwrap();
                state.correction = true;
                state.mismatched_xbrl = true;
            }
            clock.jump(61);
            settled(&service).await;
        }
        let bad = service.read("005930").await;
        let report = &bad.collection.reports["2015/11011"];
        assert_eq!(report.statement.failure,Some(Failure::ReceiptMismatch));
        assert_eq!(bad.state,ReadState::PartialFailure);
        assert!(bad.collection.refresh_version > report.statement.refresh_version);
        if initial_failure {
            assert!(report.statement.data.is_none());
            assert!(report.statement.last_success_at.is_none());
        } else {
            let previous = &original.collection.reports["2015/11011"];
            assert_eq!(report.statement.last_success_at,previous.statement.last_success_at);
            let account = &report.statement.data.as_ref().unwrap().accounts[0];
            assert_eq!(account.fields["rcept_no"],RECEIPT);
            assert_eq!(account.fields["thstrm_amount"],"100");
            assert!(matches!(account.current_period,Verification::Verified {..}));
        }
        let before = fake.count("fnlttXbrl.xml");
        fake.state.lock().unwrap().mismatched_xbrl = false;
        let recovered = settled(&service).await;
        assert_eq!(recovered.state,ReadState::Ready);
        assert!(fake.count("fnlttXbrl.xml") > before);
        let account = &recovered.collection.reports["2015/11011"].statement.data.as_ref().unwrap().accounts[0];
        assert_eq!(account.fields["thstrm_amount"],"120");
        assert!(matches!(account.current_period,Verification::Verified {..}));
    }
}

#[tokio::test]
async fn review_same_day_disclosure_failure_retries_failed_endpoint_and_finds_correction() {
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let clock = clock();
    let service = Financials::new(Some(fake.client()),Store::open(&dir.path().join("f.db")).await.unwrap(),clock.clone());
    let original = settled(&service).await;
    fake.state.lock().unwrap().failures.insert("list.json".into(),"800".into());
    clock.jump(61);
    let failed = settled(&service).await;
    assert_eq!(failed.collection.disclosure_failure,Some(Failure::Remote));
    assert_eq!(failed.collection.last_checked_at,original.collection.last_checked_at);
    let before = fake.count("list.json");
    fake.state.lock().unwrap().failures.clear();
    fake.state.lock().unwrap().correction = true;
    clock.jump(61);
    let recovered = settled(&service).await;
    assert!(fake.count("list.json") > before);
    assert_eq!(recovered.collection.disclosure_failure,None);
    assert!(recovered.collection.last_checked_at > original.collection.last_checked_at);
    assert_eq!(recovered.collection.reports["2015/11011"].statement.data.as_ref().unwrap().accounts[0].fields["thstrm_amount"],"120");
}

#[tokio::test]
async fn review_unavailable_financial_store_keeps_real_price_and_user_data_routes_running() {
    let fake = Fake::start().await;
    let kiwoom = common::ScriptedTransport::new();
    for configured in [false,true] {
        let dir = tempfile::tempdir().unwrap();
        let db_directory = dir.path().join("db-is-directory");
        std::fs::create_dir(&db_directory).unwrap();
        let key = if configured { KEY } else { "" };
        let server = common::Server::spawn_with(&kiwoom,&dir.path().join("run/server.lock"),dir.path(),&[
            ("OPENDART_API_KEY",std::ffi::OsStr::new(key)),
            ("VALLY_DART_BASE_URL",std::ffi::OsStr::new(&fake.url)),
            ("VALLY_KIND_BASE_URL",std::ffi::OsStr::new(&fake.url)),
            ("VALLY_FINANCIAL_DB_PATH",db_directory.as_os_str()),
        ]);
        let base = format!("http://{}",server.addr().await);
        let client = reqwest::Client::new();
        let price = client.get(format!("{base}/api/bars?symbol=005930&period=D&limit=5")).send().await.expect("price server must remain running");
        assert_eq!(price.status(),StatusCode::OK);
        assert_eq!(client.get(format!("{base}/api/layouts")).send().await.unwrap().status(),StatusCode::OK);
        let failed = http_snapshot(&client,&base).await;
        assert_eq!(failed["status"],"failed");
        assert_eq!(failed["failure"],"storage");
        assert_eq!(http_snapshot(&client,&base).await["failure"],"storage");
        let calculated:Value = serde_json::from_slice(&client.get(format!("{base}/api/symbols/005930/financials?period=Y")).send().await.unwrap().bytes().await.unwrap()).unwrap();
        assert_eq!(calculated["status"],"failed");assert_eq!(calculated["failure"],"storage");
        assert_eq!(fake.count("corpCode.xml"),0);
        server.stop().await;
    }
}

#[tokio::test]
async fn review_write_failure_retains_saved_data_and_earlier_company() {
    use sqlx::Connection;
    for initially in [true,false] {
        let fake = Fake::start().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.db");
        let store = Store::open(&path).await.unwrap();
        let clock = clock();
        let service = Financials::new(Some(fake.client()),store.clone(),clock.clone());
        let original = if initially { None } else { Some(settled(&service).await) };
        let mut connection = sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path)).await.unwrap();
        sqlx::query("CREATE TRIGGER fail_financial_company BEFORE INSERT ON companies WHEN NEW.corp_code = '00126380' BEGIN SELECT RAISE(FAIL,'synthetic storage failure'); END").execute(&mut connection).await.unwrap();
        let page = run_update(&service,&[("005930",false),("000001",false)]).await;
        assert_eq!(page.status,FinancialUpdateStatus::Failed);
        assert_eq!(page.failure.as_deref(),Some("storage"));
        let failed = service.read("005930").await;
        assert_eq!(failed.state,ReadState::PartialFailure);
        assert_eq!(failed.failure,Some(Failure::Storage));
        if let Some(original) = &original {
            assert_eq!(serde_json::to_value(&failed.collection).unwrap(),serde_json::to_value(&original.collection).unwrap());
            let disabled = Financials::new(None,store.clone(),clock.clone());
            let readable = disabled.read("005930").await;
            assert_eq!(readable.state,ReadState::NotConfigured);
            assert!(readable.collection.reports["2015/11011"].statement.data.is_some());
        }
        let other = service.read("000001").await;
        assert_eq!(other.state,ReadState::Ready);
        assert_eq!(other.security.as_ref().unwrap().company.corp_code,"00000002");
        assert!(matches!(other.collection.reports["2015/11011"].statement.data.as_ref().unwrap().accounts[0].current_period,Verification::Verified {..}));
        sqlx::query("DROP TRIGGER fail_financial_company").execute(&mut connection).await.unwrap();
        assert_eq!(settled(&service).await.state,ReadState::Ready);
        assert_eq!(service.read("000001").await.state,ReadState::Ready);
    }
}

#[tokio::test]
async fn review_permanently_unverified_accounts_do_not_trigger_automatic_source_retries() {
    let fake = Fake::start().await;
    fake.state.lock().unwrap().nonstandard_account = true;
    let dir = tempfile::tempdir().unwrap();
    let clock = clock();
    let service = Financials::new(Some(fake.client()),Store::open(&dir.path().join("f.db")).await.unwrap(),clock.clone());
    let result = settled(&service).await;
    assert_eq!(result.state,ReadState::Ready);
    assert_eq!(result.collection.reports["2015/11011"].statement.data.as_ref().unwrap().accounts[0].current_period,Verification::Unverified("nonstandard_account".into()));
    let before = fake.count("fnlttXbrl.xml");
    clock.jump(61);
    assert_eq!(settled(&service).await.state,ReadState::Ready);
    assert_eq!(fake.count("fnlttXbrl.xml"),before);
}

#[tokio::test]
async fn review_legacy_snapshots_without_versions_resume_already_saved_corrections() {
    use sqlx::Connection;
    let fake = Fake::start().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("f.db");
    let store = Store::open(&path).await.unwrap();
    let clock = clock();
    let service = Financials::new(Some(fake.client()),store,clock.clone());
    let mut body = serde_json::to_value(settled(&service).await.collection).unwrap();
    fake.state.lock().unwrap().correction = true;
    body["disclosures"] = serde_json::to_value(fake.client().disclosures(CORP,"20151231").await.unwrap()).unwrap();
    body.as_object_mut().unwrap().remove("refresh_version");
    body.as_object_mut().unwrap().remove("disclosure_version");
    body.as_object_mut().unwrap().remove("unpublished_check_version");
    body.as_object_mut().unwrap().remove("staged_reports");
    for report in body["reports"].as_object_mut().unwrap().values_mut() {
        report["statement"].as_object_mut().unwrap().remove("refresh_version");
        report["dividends"].as_object_mut().unwrap().remove("refresh_version");
        report["statement"].as_object_mut().unwrap().remove("validated_version");
        report["dividends"].as_object_mut().unwrap().remove("validated_version");
    }
    let mut connection = sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path)).await.unwrap();
    sqlx::query("UPDATE companies SET body = ? WHERE corp_code = ?").bind(body.to_string()).bind(CORP).execute(&mut connection).await.unwrap();
    let reopened = Financials::new(Some(fake.client()),Store::open(&path).await.unwrap(),clock.clone());
    let before = fake.count("list.json");
    let waiting = reopened.read("005930").await;
    assert_eq!(waiting.state,ReadState::Stale);
    assert_eq!(waiting.collection.reports["2015/11011"].statement.data.as_ref().unwrap().accounts[0].fields["thstrm_amount"],"100");
    let recovered = settled(&reopened).await;
    assert_eq!(recovered.state,ReadState::Ready);
    assert_eq!(recovered.collection.reports["2015/11011"].statement.data.as_ref().unwrap().accounts[0].fields["thstrm_amount"],"120");
    assert_eq!(fake.count("list.json"),before+1,"an update rechecks the disclosure list once and resumes the saved correction");
}

fn assert_corrected_report(collection: &server::financials::model::Collection) {
    let report = &collection.reports["2015/11011"].statement;
    let account = &report.data.as_ref().unwrap().accounts[0];
    assert_eq!(account.fields["rcept_no"],"20160401000002");
    assert_eq!(account.fields["thstrm_amount"],"120");
    assert!(matches!(&account.current_period,Verification::Verified { period:FactPeriod::Duration { start,end },receipt,.. } if start == "2015-01-01" && end == "2015-12-31" && receipt == "20160401000002"));
    assert_eq!(report.refresh_version,collection.refresh_version);
    assert_eq!(collection.disclosure_version,collection.refresh_version);
    assert!(report.last_success_at.is_some());
}

async fn other_company_settled(service: &Arc<Financials>) {
    let snapshot = service.read("000001").await;
    assert_eq!(snapshot.state,ReadState::Ready);
    assert!(matches!(snapshot.collection.reports["2015/11011"].statement.data.as_ref().unwrap().accounts[0].current_period,Verification::Verified {..}));
}

#[tokio::test]
async fn review2_pending_list_intent_recovers_first_and_commit_writes_and_reopened_service() {
    use sqlx::Connection;
    for (initially,at_commit,reopen) in [(false,false,false),(false,true,false),(false,true,true),(true,false,false),(true,true,true)] {
        let fake = Fake::start().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.db");
        let clock = clock();
        let store = Store::open(&path).await.unwrap();
        let mut service = Financials::new(Some(fake.client()),store,clock.clone());
        let original = if initially { None } else { Some(settled(&service).await.collection) };
        let mut connection = sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path)).await.unwrap();
        let trigger = if at_commit {
            "CREATE TRIGGER fail_pending_list BEFORE INSERT ON companies WHEN NEW.corp_code = '00126380' AND json_array_length(NEW.body, '$.disclosures') = 2 BEGIN SELECT RAISE(FAIL,'synthetic list commit failure'); END"
        } else {
            "CREATE TRIGGER fail_pending_list BEFORE INSERT ON companies WHEN NEW.corp_code = '00126380' BEGIN SELECT RAISE(FAIL,'synthetic first write failure'); END"
        };
        sqlx::query(trigger).execute(&mut connection).await.unwrap();
        fake.state.lock().unwrap().correction = true;
        clock.jump(1);
        assert_eq!(run_update(&service,&[("005930",false),("000001",false)]).await.status,FinancialUpdateStatus::Failed);
        let failed = service.read("005930").await;
        assert_eq!(failed.failure,Some(Failure::Storage));
        if let Some(original) = &original {
            assert_eq!(serde_json::to_value(&failed.collection.reports).unwrap(),serde_json::to_value(&original.reports).unwrap());
        }
        if at_commit { assert!(failed.collection.disclosure_version < failed.collection.refresh_version); }
        other_company_settled(&service).await;
        sqlx::query("DROP TRIGGER fail_pending_list").execute(&mut connection).await.unwrap();
        if reopen {
            drop(service);
            service = Financials::new(Some(fake.client()),Store::open(&path).await.unwrap(),clock.clone());
            let pending = service.read("005930").await;
            assert_eq!(pending.state,if initially { ReadState::NotCollected } else { ReadState::Stale });
            if let Some(original) = &original { assert_eq!(serde_json::to_value(&pending.collection.reports).unwrap(),serde_json::to_value(&original.reports).unwrap()); }
        }
        let before = fake.count("list.json");
        let recovered = settled(&service).await;
        assert_eq!(fake.count("list.json"),before+usize::from(!at_commit),"the resumed update replays a list it already received and fetches one it never received");
        assert_corrected_report(&recovered.collection);
        if let Some(original) = original { assert!(recovered.collection.reports["2015/11011"].statement.last_success_at > original.reports["2015/11011"].statement.last_success_at); }
        let stored = Store::open(&path).await.unwrap().collection(CORP).await.unwrap();
        assert_corrected_report(&stored);
        let requests = fake.count("fnlttSinglAcntAll.json");
        assert_eq!(settled(&service).await.state,ReadState::Ready);
        assert_eq!(fake.count("fnlttSinglAcntAll.json"),requests);
    }
}

fn company_calls(fake: &Fake) -> usize {
    fake.state.lock().unwrap().calls.iter().filter(|(endpoint,params)| endpoint == "company.json" && params.get("corp_code").is_some_and(|corp|corp == CORP)).count()
}

#[tokio::test]
async fn review2_security_save_failure_resumes_and_applies_manual_refresh() {
    use sqlx::Connection;
    for existing in [false,true] {
        let fake = Fake::start().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.db");
        let service = Financials::new(Some(fake.client()),Store::open(&path).await.unwrap(),clock());
        let mut connection = sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path)).await.unwrap();
        let original = if existing {
            let collection = settled(&service).await.collection;
            sqlx::query("DELETE FROM securities WHERE stock_code = '005930'").execute(&mut connection).await.unwrap();
            Some(collection)
        } else { None };
        sqlx::query("CREATE TRIGGER fail_mapping BEFORE INSERT ON securities WHEN NEW.stock_code = '005930' BEGIN SELECT RAISE(FAIL,'synthetic mapping write failure'); END").execute(&mut connection).await.unwrap();
        fake.state.lock().unwrap().correction = true;
        let page = run_update(&service,&[("005930",false)]).await;
        assert_eq!(page.status,FinancialUpdateStatus::Failed);
        assert_eq!(page.failure.as_deref(),Some("storage"));
        assert!(service.read("005930").await.security.is_none());
        let before = company_calls(&fake);
        if let Some(original) = &original {
            let retained = Store::open(&path).await.unwrap().collection(CORP).await.unwrap();
            assert_eq!(serde_json::to_value(&retained.reports).unwrap(),serde_json::to_value(&original.reports).unwrap());
        }
        sqlx::query("DROP TRIGGER fail_mapping").execute(&mut connection).await.unwrap();
        let recovered = settled(&service).await;
        assert_eq!(company_calls(&fake),before,"the resumed update replays the company response it already received");
        assert!(recovered.security.is_some());
        assert_corrected_report(&recovered.collection);
    }
}

#[tokio::test]
async fn review2_failed_list_storage_keeps_real_price_usable_and_preserves_verified_data() {
    use sqlx::Connection;
    use std::os::unix::fs::PermissionsExt;
    let fake = Fake::start().await;
    let kiwoom = common::ScriptedTransport::new();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("run/financials.db");
    let service = Financials::new(Some(fake.client()),Store::open(&path).await.unwrap(),clock());
    let original = settled(&service).await.collection;
    std::fs::set_permissions(dir.path().join("run"),std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut connection = sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path)).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_list_storage BEFORE INSERT ON companies WHEN NEW.corp_code = '00126380' BEGIN SELECT RAISE(FAIL,'synthetic list storage failure'); END").execute(&mut connection).await.unwrap();
    let server = common::Server::spawn_with(&kiwoom,&dir.path().join("run/server.lock"),dir.path(),&[
        ("OPENDART_API_KEY",std::ffi::OsStr::new(KEY)),
        ("VALLY_DART_BASE_URL",std::ffi::OsStr::new(&fake.url)),
        ("VALLY_KIND_BASE_URL",std::ffi::OsStr::new(&fake.url)),
        ("VALLY_CLOCK_START",std::ffi::OsStr::new("20171231120000")),
    ]);
    let base = format!("http://{}",server.addr().await);
    let client = reqwest::Client::new();
    let price_url = format!("{base}/api/bars?symbol=005930&period=D&limit=5");
    assert_eq!(client.get(&price_url).send().await.unwrap().status(),StatusCode::OK);
    fake.state.lock().unwrap().correction = true;
    client.post(format!("{base}/api/symbols/005930/financial-source")).send().await.unwrap();
    let failed = http_settled(&fake,&client,&base).await;
    assert_eq!(failed["failure"],"storage");
    assert_eq!(failed["collection"]["reports"],serde_json::to_value(&original.reports).unwrap());
    assert_eq!(tokio::time::timeout(Duration::from_secs(1),client.get(&price_url).send()).await.unwrap().unwrap().status(),StatusCode::OK);
    sqlx::query("DROP TRIGGER fail_list_storage").execute(&mut connection).await.unwrap();
    client.post(format!("{base}/api/symbols/005930/financial-source")).send().await.unwrap();
    let mut repaired = false;
    for _ in 0..300 {
        let snapshot = http_snapshot(&client,&base).await;
        let collection: server::financials::model::Collection = serde_json::from_value(snapshot["collection"].clone()).unwrap();
        if collection.reports["2015/11011"].statement.data.as_ref().unwrap().accounts[0].fields["thstrm_amount"] == "120" {
            assert_corrected_report(&collection);
            repaired = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(repaired);
    assert_eq!(tokio::time::timeout(Duration::from_secs(1),client.get(&price_url).send()).await.unwrap().unwrap().status(),StatusCode::OK);
    server.stop().await;
}

#[tokio::test]
async fn calculated_http_contract_validates_period_and_preserves_price_during_collection() {
    let fake = Fake::start().await;
    fake.state.lock().unwrap().delayed = true;
    let kiwoom = common::ScriptedTransport::new();
    let client = reqwest::Client::new();
    for configured in [false,true] {
        let dir = tempfile::tempdir().unwrap();
        let key = if configured { KEY } else { "" };
        let server = common::Server::spawn_with(&kiwoom,&dir.path().join("run/server.lock"),dir.path(),&[
            ("OPENDART_API_KEY",std::ffi::OsStr::new(key)),
            ("VALLY_DART_BASE_URL",std::ffi::OsStr::new(&fake.url)),
            ("VALLY_KIND_BASE_URL",std::ffi::OsStr::new(&fake.url)),
        ]);
        let base = format!("http://{}",server.addr().await);
        let price = format!("{base}/api/bars?symbol=005930&period=Q&limit=5");
        assert_eq!(client.get(&price).send().await.unwrap().status(),StatusCode::OK);
        let url = format!("{base}/api/symbols/005930/financials");
        for query in ["","?period=D","?period=Q&venue=krx"] {
            assert_eq!(client.get(format!("{url}{query}")).send().await.unwrap().status(),StatusCode::BAD_REQUEST);
        }
        let response:Value = client.get(format!("{url}?period=Q")).send().await.unwrap().bytes().await.map(|bytes| serde_json::from_slice(&bytes).unwrap()).unwrap();
        assert_eq!(response["status"],if configured { "not_collected" } else { "not_configured" });
        assert_eq!(response["series"].as_array().unwrap().len(),6);
        assert_eq!(response["period"],"Q");
        for code in ["IDX:001","102780"] {
            let unsupported:Value = serde_json::from_slice(&client.get(format!("{base}/api/symbols/{code}/financials?period=Y")).send().await.unwrap().bytes().await.unwrap()).unwrap();
            assert_eq!(unsupported["status"],"unsupported");assert_eq!(unsupported["reason"],"unsupported_product");
        }
        assert_eq!(tokio::time::timeout(Duration::from_secs(1),client.get(&price).send()).await.unwrap().unwrap().status(),StatusCode::OK);
        let refresh:Value = client.post(format!("{url}?period=Y")).send().await.unwrap().bytes().await.map(|bytes| serde_json::from_slice(&bytes).unwrap()).unwrap();
        assert!(["not_collected", "collecting", "not_configured"].contains(&refresh["status"].as_str().unwrap()));
        if configured { assert!(["planning", "collecting"].contains(&serde_json::from_slice::<Value>(&client.get(format!("{base}/api/financial-update")).send().await.unwrap().bytes().await.unwrap()).unwrap()["status"].as_str().unwrap())); }
        assert!(!server.stop().await.contains(KEY));
    }
}

#[tokio::test]
async fn calculated_http_reads_saved_values_without_key_and_applies_correction_with_metadata() {
    use std::os::unix::fs::PermissionsExt;
    let fake = Fake::start().await;
    let kiwoom = common::ScriptedTransport::new();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("run/financials.db");
    let service = Financials::new(Some(fake.client()),Store::open(&path).await.unwrap(),clock());
    settled(&service).await;
    std::fs::set_permissions(dir.path().join("run"),std::fs::Permissions::from_mode(0o700)).unwrap();
    let client = reqwest::Client::new();
    for configured in [false,true] {
        let key = if configured { KEY } else { "" };
        let server = common::Server::spawn_with(&kiwoom,&dir.path().join("run/server.lock"),dir.path(),&[
            ("OPENDART_API_KEY",std::ffi::OsStr::new(key)),
            ("VALLY_DART_BASE_URL",std::ffi::OsStr::new(&fake.url)),
            ("VALLY_KIND_BASE_URL",std::ffi::OsStr::new(&fake.url)),
            ("VALLY_CLOCK_START",std::ffi::OsStr::new("20171231120000")),
        ]);
        let base = format!("http://{}",server.addr().await);
        let price = format!("{base}/api/bars?symbol=005930&period=D&limit=5");
        assert_eq!(client.get(&price).send().await.unwrap().status(),StatusCode::OK);
        let url = format!("{base}/api/symbols/005930/financials?period=Y");
        if configured {fake.state.lock().unwrap().correction=true;}
        let first:Value = client.get(&url).send().await.unwrap().bytes().await.map(|bytes| serde_json::from_slice(&bytes).unwrap()).unwrap();
        assert_eq!(first["status"],if configured {"ready"} else {"not_configured"});
        let p = &first["series"][0]["points"][0];
        assert_eq!(p["value"],100.0);assert_eq!(p["inputs"][0]["receipt"],RECEIPT);
        if configured {
            client.post(&url).send().await.unwrap();
            let mut corrected=None;
            for _ in 0..500 {
                let response:Value=client.get(&url).send().await.unwrap().bytes().await.map(|bytes| serde_json::from_slice(&bytes).unwrap()).unwrap();
                if response["series"][0]["points"][0]["value"]==120.0 {corrected=Some(response);break;}
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let corrected=corrected.expect("latest verified correction must be returned before entire history completes");
            let p=&corrected["series"][0]["points"][0];
            assert_eq!(p["inputs"][0]["receipt"],"20160401000002");assert_eq!(p["inputs"][0]["disclosedAt"],"2016-04-01");
            assert_eq!(p["period"]["start"],"2015-01-01");assert_eq!(p["basis"],"CFS");assert!(p["priceBucket"].is_number());
            assert_eq!(corrected["fiscalMonth"],12);assert_eq!(corrected["latestCorrections"],true);
            assert!(p["inputs"][0]["lastSuccessAt"].is_number());
        }
        assert_eq!(tokio::time::timeout(Duration::from_secs(1),client.get(&price).send()).await.unwrap().unwrap().status(),StatusCode::OK);
        server.stop().await;
    }
}

#[path = "financials/schedule.rs"]
mod schedule;

#[tokio::test(start_paused = true)]
async fn source_observation_waits_while_earlier_paced_requests_are_progressing() {
    let fake = Fake::start().await;
    let state = fake.state.clone();
    let producer = tokio::spawn(async move {
        for endpoint in ["corpCode.xml", "company.json", "statement_stream"] {
            tokio::time::sleep(Duration::from_secs(9)).await;
            state.lock().unwrap().record(endpoint.into(), BTreeMap::new());
        }
    });
    fake.wait_for_call("statement_stream", 1).await;
    producer.await.unwrap();
    assert_eq!(fake.count("corpCode.xml"), 1);
    assert_eq!(fake.count("company.json"), 1);
    assert_eq!(fake.count("statement_stream"), 1);
}

#[tokio::test(start_paused = true)]
#[should_panic(expected = "statement_stream made no source progress")]
async fn source_observation_stops_when_no_source_request_progresses() {
    let fake = Fake::start().await;
    fake.wait_for_call("statement_stream", 1).await;
}
