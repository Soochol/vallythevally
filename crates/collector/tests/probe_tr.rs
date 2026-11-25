use std::collections::BTreeMap;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use collector::collect::config::Variables;
use collector::probe_tr::{CapturedFixture, ProbeMethod, execute_probe, parse_arguments, scrub_json};
use collector::supervise::{kis_base_url, rest_base_url};
use domain::{KstDate, KstTime};
use serde_json::{Value, json};
use server::clock::{Clock, kst};
use server::kiwoom::token_file::credential_id;
use server::shared_data::Broker;
use tokio::net::TcpListener;

const KIS_APP_KEY: &str = "FAKE-KIS-APPKEY-PROBE-1001";
const KIS_APP_SECRET: &str = "FAKE-KIS-SECRET-PROBE-1002";
const KIS_TOKEN: &str = "FAKE-KIS-TOKEN-PROBE-1003";
const KIWOOM_APP_KEY: &str = "FAKE-KIWOOM-APPKEY-PROBE-2001";
const KIWOOM_APP_SECRET: &str = "FAKE-KIWOOM-SECRET-PROBE-2002";
const KIWOOM_TOKEN: &str = "FAKE-KIWOOM-TOKEN-PROBE-2003";
const SPARE_APP_KEY: &str = "FAKE-SPARE-APPKEY-PROBE-3001";
const SPARE_APP_SECRET: &str = "FAKE-SPARE-SECRET-PROBE-3002";
const FAKE_ACCOUNT: &str = "50012345-01";

fn fixed_clock() -> Clock {
    let day = KstDate::new(2026, 11, 25).unwrap();
    let now: KstTime = kst(day, 10, 0, 0);
    Clock::fake(now)
}

fn write_secret_file(path: &Path, app_key: &str, app_secret: &str) {
    std::fs::write(path, format!("VALLY_COLLECTOR_APP_KEY={app_key}\nVALLY_COLLECTOR_APP_SECRET={app_secret}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

fn write_test_keys(dir: &Path) -> (PathBuf, PathBuf) {
    let state_dir = dir.join("state");
    std::fs::create_dir_all(&state_dir).unwrap();
    let spare_secret = dir.join("spare.env");
    let kis_secret = dir.join("kis.env");
    let kiwoom_secret = dir.join("kiwoom.env");
    write_secret_file(&spare_secret, SPARE_APP_KEY, SPARE_APP_SECRET);
    write_secret_file(&kis_secret, KIS_APP_KEY, KIS_APP_SECRET);
    write_secret_file(&kiwoom_secret, KIWOOM_APP_KEY, KIWOOM_APP_SECRET);
    let keys_path = dir.join("collector-keys.json");
    let payload = json!({
        "version": 2,
        "keys": [
            {
                "name": "spare-key",
                "active": false,
                "role": "spare",
                "broker": "kiwoom",
                "app_key_hash": credential_id(SPARE_APP_KEY),
                "secret_file": spare_secret
            },
            {
                "name": "kis-rest",
                "active": true,
                "role": "rest",
                "broker": "kis",
                "app_key_hash": credential_id(KIS_APP_KEY),
                "secret_file": kis_secret
            },
            {
                "name": "kw-rest",
                "active": true,
                "role": "rest",
                "broker": "kiwoom",
                "app_key_hash": credential_id(KIWOOM_APP_KEY),
                "secret_file": kiwoom_secret
            }
        ]
    });
    std::fs::write(&keys_path, serde_json::to_string_pretty(&payload).unwrap()).unwrap();
    (keys_path, state_dir)
}

#[derive(Clone, Default)]
struct RecordedRequest {
    uri: String,
    headers: BTreeMap<String, String>,
    body: String,
}

#[derive(Default)]
struct ServerState {
    token_hits: AtomicUsize,
    tr_hits: AtomicUsize,
    tr_requests: Mutex<Vec<RecordedRequest>>,
}

fn extract_headers(headers: &HeaderMap) -> BTreeMap<String, String> {
    headers
        .iter()
        .filter_map(|(name, value)| value.to_str().ok().map(|text| (name.as_str().to_owned(), text.to_owned())))
        .collect()
}

async fn kis_token_handler(State(state): State<Arc<ServerState>>) -> Response {
    state.token_hits.fetch_add(1, Ordering::SeqCst);
    let body = json!({
        "access_token": KIS_TOKEN,
        "token_type": "Bearer",
        "expires_in": 86400
    });
    (StatusCode::OK, body.to_string()).into_response()
}

async fn kis_tr_handler(State(state): State<Arc<ServerState>>, uri: Uri, headers: HeaderMap) -> Response {
    state.tr_hits.fetch_add(1, Ordering::SeqCst);
    state.tr_requests.lock().unwrap().push(RecordedRequest {
        uri: uri.to_string(),
        headers: extract_headers(&headers),
        body: String::new(),
    });
    let payload = json!({
        "rt_cd": "0",
        "msg_cd": "MCA00000",
        "msg1": format!("정상처리 ({KIS_APP_KEY} / {KIS_TOKEN})"),
        "access_token": KIS_TOKEN,
        "appsecret": KIS_APP_SECRET,
        "output": [
            {
                "bass_dt": "20261125",
                "opnd_yn": "Y",
                "CANO": FAKE_ACCOUNT,
                "acnt_prdt_cd": "01",
                "nested": {
                    "app_key": KIS_APP_KEY,
                    "accountNumber": FAKE_ACCOUNT
                }
            }
        ]
    });
    let mut response = (StatusCode::OK, payload.to_string()).into_response();
    response.headers_mut().insert("tr_cont", HeaderValue::from_static("M"));
    response
}

async fn kiwoom_token_handler(State(state): State<Arc<ServerState>>) -> Response {
    state.token_hits.fetch_add(1, Ordering::SeqCst);
    let body = json!({
        "return_code": 0,
        "return_msg": "정상적으로 처리되었습니다",
        "token": KIWOOM_TOKEN,
        "expires_dt": "20261126100000"
    });
    (StatusCode::OK, body.to_string()).into_response()
}

async fn kiwoom_tr_handler(State(state): State<Arc<ServerState>>, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    state.tr_hits.fetch_add(1, Ordering::SeqCst);
    state.tr_requests.lock().unwrap().push(RecordedRequest {
        uri: uri.to_string(),
        headers: extract_headers(&headers),
        body: String::from_utf8_lossy(&body).into_owned(),
    });
    let payload = json!({
        "return_code": 0,
        "return_msg": format!("OK {KIWOOM_APP_KEY} {KIWOOM_APP_SECRET} {KIWOOM_TOKEN}"),
        "secretkey": KIWOOM_APP_SECRET,
        "appkey": KIWOOM_APP_KEY,
        "acnt_no": FAKE_ACCOUNT,
        "opmr_invsr_trde": [
            {
                "stk_cd": "005930",
                "stk_nm": "삼성전자",
                "netprps_amt": "12345"
            }
        ]
    });
    let mut response = (StatusCode::OK, payload.to_string()).into_response();
    response.headers_mut().insert("cont-yn", HeaderValue::from_static("Y"));
    response.headers_mut().insert("next-key", HeaderValue::from_static("NEXT-PAGE-001"));
    response
}

async fn spawn_server(router: Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    format!("http://{address}")
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

#[tokio::test]
async fn kis_probe_issues_once_then_reuses_cached_token_and_scrubs_secrets() {
    let state = Arc::new(ServerState::default());
    let router = Router::new()
        .route("/oauth2/tokenP", post(kis_token_handler))
        .route("/uapi/domestic-stock/v1/quotations/chk-holiday", get(kis_tr_handler))
        .with_state(state.clone());
    let base_url = spawn_server(router).await;

    let temp = tempfile::tempdir().unwrap();
    let (keys_path, state_dir) = write_test_keys(temp.path());
    let out_dir = temp.path().join("fixtures");
    let process = Variables::new();
    let raw_args = strings(&[
        "--broker",
        "kis",
        "--tr",
        "CTCA0903R",
        "--path",
        "/uapi/domestic-stock/v1/quotations/chk-holiday",
        "--query",
        "BASS_DT=20261125&CTX_AREA_NK=&CTX_AREA_FK=",
        "--key",
        "kis-rest",
        "--keys",
        keys_path.to_str().unwrap(),
        "--state",
        state_dir.to_str().unwrap(),
        "--out",
        out_dir.to_str().unwrap(),
    ]);
    let request = parse_arguments(&raw_args, &process).unwrap();
    assert_eq!(request.broker, Broker::Kis);
    assert_eq!(request.method, ProbeMethod::Get);

    let result = execute_probe(&request, &base_url, &process, fixed_clock()).await.unwrap();
    assert_eq!(state.token_hits.load(Ordering::SeqCst), 1);
    assert_eq!(state.tr_hits.load(Ordering::SeqCst), 1);
    assert_eq!(result.output_path, out_dir.join("kis-CTCA0903R.json"));

    let recorded = state.tr_requests.lock().unwrap().clone();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].headers.get("tr_id").map(String::as_str), Some("CTCA0903R"));
    assert_eq!(recorded[0].headers.get("appkey").map(String::as_str), Some(KIS_APP_KEY));
    assert_eq!(recorded[0].headers.get("appsecret").map(String::as_str), Some(KIS_APP_SECRET));
    assert_eq!(recorded[0].headers.get("authorization").map(String::as_str), Some(format!("Bearer {KIS_TOKEN}").as_str()));
    assert!(recorded[0].uri.contains("BASS_DT=20261125"), "{}", recorded[0].uri);

    let file_text = std::fs::read_to_string(&result.output_path).unwrap();
    for secret in [KIS_APP_KEY, KIS_APP_SECRET, KIS_TOKEN, FAKE_ACCOUNT] {
        assert!(!file_text.contains(secret), "secret leaked into fixture: {secret}\n{file_text}");
    }
    let parsed: CapturedFixture = serde_json::from_str(&file_text).unwrap();
    assert_eq!(parsed.broker, "kis");
    assert_eq!(parsed.tr_id, "CTCA0903R");
    assert_eq!(parsed.path, "/uapi/domestic-stock/v1/quotations/chk-holiday");
    assert_eq!(parsed.method, "GET");
    assert_eq!(parsed.status, 200);
    assert_eq!(parsed.tr_cont.as_deref(), Some("M"));
    assert_eq!(parsed.cont_yn, None);
    assert_eq!(parsed.next_key, None);
    assert_eq!(parsed.body["access_token"], "[REDACTED]");
    assert_eq!(parsed.body["appsecret"], "[REDACTED]");
    assert_eq!(parsed.body["output"][0]["CANO"], "[REDACTED]");
    assert_eq!(parsed.body["output"][0]["acnt_prdt_cd"], "[REDACTED]");
    assert_eq!(parsed.body["output"][0]["nested"]["app_key"], "[REDACTED]");
    assert_eq!(parsed.body["output"][0]["nested"]["accountNumber"], "[REDACTED]");
    assert_eq!(parsed.body["output"][0]["bass_dt"], "20261125");
    assert_eq!(parsed.body["output"][0]["opnd_yn"], "Y");

    let second = execute_probe(&request, &base_url, &process, fixed_clock()).await.unwrap();
    assert_eq!(second.fixture.status, 200);
    assert_eq!(state.token_hits.load(Ordering::SeqCst), 1);
    assert_eq!(state.tr_hits.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn kiwoom_probe_posts_once_with_api_id_and_scrubs_all_secrets() {
    let state = Arc::new(ServerState::default());
    let router = Router::new()
        .route("/oauth2/token", post(kiwoom_token_handler))
        .route("/api/dostk/mrkcond", post(kiwoom_tr_handler))
        .with_state(state.clone());
    let base_url = spawn_server(router).await;

    let temp = tempfile::tempdir().unwrap();
    let (keys_path, state_dir) = write_test_keys(temp.path());
    let out_dir = temp.path().join("fixtures");
    let process = Variables::new();
    let raw_args = strings(&[
        "--broker",
        "kiwoom",
        "--tr",
        "ka10063",
        "--path",
        "/api/dostk/mrkcond",
        "--body",
        r#"{"mrkt_tp":"001","amt_qty_tp":"1","invsr":"6","frgn_all":"0","smtm_netprps_tp":"0","stex_tp":"1"}"#,
        "--key",
        "kw-rest",
        "--keys",
        keys_path.to_str().unwrap(),
        "--state",
        state_dir.to_str().unwrap(),
        "--out",
        out_dir.to_str().unwrap(),
    ]);
    let request = parse_arguments(&raw_args, &process).unwrap();
    assert_eq!(request.broker, Broker::Kiwoom);
    assert_eq!(request.method, ProbeMethod::Post);

    let result = execute_probe(&request, &base_url, &process, fixed_clock()).await.unwrap();
    assert_eq!(state.token_hits.load(Ordering::SeqCst), 1);
    assert_eq!(state.tr_hits.load(Ordering::SeqCst), 1);
    assert_eq!(result.output_path, out_dir.join("kiwoom-ka10063.json"));

    let recorded = state.tr_requests.lock().unwrap().clone();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].headers.get("api-id").map(String::as_str), Some("ka10063"));
    assert_eq!(recorded[0].headers.get("authorization").map(String::as_str), Some(format!("Bearer {KIWOOM_TOKEN}").as_str()));
    let sent_body: Value = serde_json::from_str(&recorded[0].body).unwrap();
    assert_eq!(sent_body["mrkt_tp"], "001");

    let file_text = std::fs::read_to_string(&result.output_path).unwrap();
    for secret in [KIWOOM_APP_KEY, KIWOOM_APP_SECRET, KIWOOM_TOKEN, FAKE_ACCOUNT] {
        assert!(!file_text.contains(secret), "secret leaked into fixture: {secret}\n{file_text}");
    }
    let parsed: CapturedFixture = serde_json::from_str(&file_text).unwrap();
    assert_eq!(parsed.broker, "kiwoom");
    assert_eq!(parsed.tr_id, "ka10063");
    assert_eq!(parsed.path, "/api/dostk/mrkcond");
    assert_eq!(parsed.method, "POST");
    assert_eq!(parsed.status, 200);
    assert_eq!(parsed.tr_cont, None);
    assert_eq!(parsed.cont_yn.as_deref(), Some("Y"));
    assert_eq!(parsed.next_key.as_deref(), Some("NEXT-PAGE-001"));
    assert_eq!(parsed.body["secretkey"], "[REDACTED]");
    assert_eq!(parsed.body["appkey"], "[REDACTED]");
    assert_eq!(parsed.body["acnt_no"], "[REDACTED]");
    assert_eq!(parsed.body["opmr_invsr_trde"][0]["stk_cd"], "005930");

    let second = execute_probe(&request, &base_url, &process, fixed_clock()).await.unwrap();
    assert_eq!(second.fixture.status, 200);
    assert_eq!(state.token_hits.load(Ordering::SeqCst), 1);
    assert_eq!(state.tr_hits.load(Ordering::SeqCst), 2);
}

#[test]
fn argument_validation_rejects_missing_flags_and_invalid_paths() {
    let process = Variables::from([("HOME".to_owned(), "/home/operator".to_owned())]);

    let missing_broker = strings(&["--tr", "ka10063", "--path", "/api/dostk/mrkcond", "--key", "kw-rest", "--out", "/tmp/out"]);
    assert!(parse_arguments(&missing_broker, &process).is_err());

    let missing_tr = strings(&["--broker", "kiwoom", "--path", "/api/dostk/mrkcond", "--key", "kw-rest", "--out", "/tmp/out"]);
    assert!(parse_arguments(&missing_tr, &process).is_err());

    let missing_path = strings(&["--broker", "kiwoom", "--tr", "ka10063", "--key", "kw-rest", "--out", "/tmp/out"]);
    assert!(parse_arguments(&missing_path, &process).is_err());

    let missing_out = strings(&["--broker", "kiwoom", "--tr", "ka10063", "--path", "/api/dostk/mrkcond", "--key", "kw-rest"]);
    assert!(parse_arguments(&missing_out, &process).is_err());

    let missing_key = strings(&["--broker", "kiwoom", "--tr", "ka10063", "--path", "/api/dostk/mrkcond", "--out", "/tmp/out"]);
    assert!(parse_arguments(&missing_key, &process).is_err());

    let relative_path = strings(&["--broker", "kis", "--tr", "CTCA0903R", "--path", "uapi/no-leading-slash", "--key", "kis-rest", "--out", "/tmp/out"]);
    assert!(parse_arguments(&relative_path, &process).is_err());

    let scheme_relative_path = strings(&["--broker", "kis", "--tr", "CTCA0903R", "--path", "//evil.example/path", "--key", "kis-rest", "--out", "/tmp/out"]);
    assert!(parse_arguments(&scheme_relative_path, &process).is_err());

    let bad_broker = strings(&["--broker", "other", "--tr", "CTCA0903R", "--path", "/uapi/x", "--key", "kis-rest", "--out", "/tmp/out"]);
    assert!(parse_arguments(&bad_broker, &process).is_err());

    let bad_tr = strings(&["--broker", "kis", "--tr", "../escape", "--path", "/uapi/x", "--key", "kis-rest", "--out", "/tmp/out"]);
    assert!(parse_arguments(&bad_tr, &process).is_err());

    let bad_body = strings(&["--broker", "kiwoom", "--tr", "ka10063", "--path", "/api/dostk/mrkcond", "--body", "{bad", "--key", "kw-rest", "--out", "/tmp/out"]);
    assert!(parse_arguments(&bad_body, &process).is_err());

    let body_on_get = strings(&["--broker", "kis", "--tr", "CTCA0903R", "--path", "/uapi/x", "--body", "{}", "--key", "kis-rest", "--out", "/tmp/out"]);
    assert!(parse_arguments(&body_on_get, &process).is_err());

    let valid_defaults = strings(&["--broker", "kiwoom", "--tr", "ka10063", "--path", "/api/dostk/mrkcond", "--key", "kw-rest", "--out", "/tmp/out"]);
    let parsed = parse_arguments(&valid_defaults, &process).unwrap();
    assert_eq!(parsed.method, ProbeMethod::Post);
    assert_eq!(parsed.body.as_deref(), Some("{}"));
    assert_eq!(parsed.keys_path, PathBuf::from("/home/operator/.config/vally/collector-keys.json"));
}

#[test]
fn scrub_json_masks_nested_sensitive_keys_and_preserves_market_fields() {
    let mut payload = json!({
        "rt_cd": "0",
        "access_token": "secret-token-value",
        "output": {
            "stck_prpr": "71500",
            "AppKey": "secret-app-key",
            "app_key": "secret-app-key-2",
            "secretKey": "secret-key-value",
            "CANO": 50012345,
            "acnt_no": "12345678-01",
            "accountInfo": {
                "holder": "홍길동",
                "number": 99887766
            }
        },
        "items": [
            {
                "stk_cd": "005930",
                "refreshToken": "refresh-xyz"
            }
        ]
    });
    scrub_json(&mut payload);
    assert_eq!(payload["rt_cd"], "0");
    assert_eq!(payload["access_token"], "[REDACTED]");
    assert_eq!(payload["output"]["stck_prpr"], "71500");
    assert_eq!(payload["output"]["AppKey"], "[REDACTED]");
    assert_eq!(payload["output"]["app_key"], "[REDACTED]");
    assert_eq!(payload["output"]["secretKey"], "[REDACTED]");
    assert_eq!(payload["output"]["CANO"], "[REDACTED]");
    assert_eq!(payload["output"]["acnt_no"], "[REDACTED]");
    assert_eq!(payload["output"]["accountInfo"]["holder"], "[REDACTED]");
    assert_eq!(payload["output"]["accountInfo"]["number"], "[REDACTED]");
    assert_eq!(payload["items"][0]["stk_cd"], "005930");
    assert_eq!(payload["items"][0]["refreshToken"], "[REDACTED]");
}

#[test]
fn cli_binary_rejects_incomplete_probe_tr_arguments() {
    let output = Command::new(env!("CARGO_BIN_EXE_collector"))
        .args(["probe-tr", "--broker", "kis"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("probe-tr:"), "{stderr}");
}

fn write_custom_kis_keys(dir: &Path, kis_key: &str, kis_secret: &str) -> (PathBuf, PathBuf) {
    let state_dir = dir.join("state");
    std::fs::create_dir_all(&state_dir).unwrap();
    let spare_secret_file = dir.join("spare.env");
    let kis_secret_file = dir.join("kis.env");
    write_secret_file(&spare_secret_file, SPARE_APP_KEY, SPARE_APP_SECRET);
    write_secret_file(&kis_secret_file, kis_key, kis_secret);
    let keys_path = dir.join("collector-keys.json");
    let payload = json!({
        "version": 2,
        "keys": [
            {
                "name": "spare-key",
                "active": false,
                "role": "spare",
                "broker": "kiwoom",
                "app_key_hash": credential_id(SPARE_APP_KEY),
                "secret_file": spare_secret_file
            },
            {
                "name": "kis-rest",
                "active": true,
                "role": "rest",
                "broker": "kis",
                "app_key_hash": credential_id(kis_key),
                "secret_file": kis_secret_file
            }
        ]
    });
    std::fs::write(&keys_path, serde_json::to_string_pretty(&payload).unwrap()).unwrap();
    (keys_path, state_dir)
}

#[tokio::test]
async fn kis_probe_does_not_follow_http_redirects_or_leak_headers() {
    let sink_hits = Arc::new(AtomicUsize::new(0));
    let sink_router = Router::new().route(
        "/stolen",
        any({
            let sink_hits = sink_hits.clone();
            move || async move {
                sink_hits.fetch_add(1, Ordering::SeqCst);
                (StatusCode::OK, r#"{"rt_cd":"0"}"#).into_response()
            }
        }),
    );
    let sink_url = spawn_server(sink_router).await;
    let redirect_target = format!("{sink_url}/stolen");

    let primary_hits = Arc::new(AtomicUsize::new(0));
    let state = Arc::new(ServerState::default());
    let primary_router = Router::new()
        .route("/oauth2/tokenP", post(kis_token_handler).with_state(state))
        .route(
            "/uapi/redirect-307",
            any({
                let primary_hits = primary_hits.clone();
                let target = redirect_target.clone();
                move || async move {
                    primary_hits.fetch_add(1, Ordering::SeqCst);
                    ([(axum::http::header::LOCATION, target)], StatusCode::TEMPORARY_REDIRECT).into_response()
                }
            }),
        )
        .route(
            "/uapi/redirect-302",
            get({
                let primary_hits = primary_hits.clone();
                let target = redirect_target.clone();
                move || async move {
                    primary_hits.fetch_add(1, Ordering::SeqCst);
                    ([(axum::http::header::LOCATION, target)], StatusCode::FOUND).into_response()
                }
            }),
        );
    let base_url = spawn_server(primary_router).await;

    let temp = tempfile::tempdir().unwrap();
    let (keys_path, state_dir) = write_test_keys(temp.path());
    let out_dir = temp.path().join("fixtures");
    let process = Variables::new();

    let post_args = strings(&[
        "--broker",
        "kis",
        "--tr",
        "REDIR307",
        "--method",
        "POST",
        "--path",
        "/uapi/redirect-307",
        "--body",
        r#"{"probe":"1"}"#,
        "--key",
        "kis-rest",
        "--keys",
        keys_path.to_str().unwrap(),
        "--state",
        state_dir.to_str().unwrap(),
        "--out",
        out_dir.to_str().unwrap(),
    ]);
    let post_result = execute_probe(&parse_arguments(&post_args, &process).unwrap(), &base_url, &process, fixed_clock()).await.unwrap();
    assert_eq!(post_result.fixture.status, 307);

    let get_args = strings(&[
        "--broker",
        "kis",
        "--tr",
        "REDIR302",
        "--path",
        "/uapi/redirect-302",
        "--key",
        "kis-rest",
        "--keys",
        keys_path.to_str().unwrap(),
        "--state",
        state_dir.to_str().unwrap(),
        "--out",
        out_dir.to_str().unwrap(),
    ]);
    let get_result = execute_probe(&parse_arguments(&get_args, &process).unwrap(), &base_url, &process, fixed_clock()).await.unwrap();
    assert_eq!(get_result.fixture.status, 302);

    assert_eq!(primary_hits.load(Ordering::SeqCst), 2);
    assert_eq!(sink_hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn kis_probe_decodes_percent_encoded_query_values_without_double_encoding() {
    let observed_uris = Arc::new(Mutex::new(Vec::<String>::new()));
    let observed_queries = Arc::new(Mutex::new(Vec::<BTreeMap<String, String>>::new()));
    let state = Arc::new(ServerState::default());
    let router = Router::new()
        .route("/oauth2/tokenP", post(kis_token_handler).with_state(state))
        .route(
            "/uapi/test",
            get({
                let observed_uris = observed_uris.clone();
                let observed_queries = observed_queries.clone();
                move |uri: Uri, Query(query): Query<BTreeMap<String, String>>| async move {
                    observed_uris.lock().unwrap().push(uri.to_string());
                    observed_queries.lock().unwrap().push(query);
                    (StatusCode::OK, r#"{"rt_cd":"0"}"#).into_response()
                }
            }),
        );
    let base_url = spawn_server(router).await;

    let temp = tempfile::tempdir().unwrap();
    let (keys_path, state_dir) = write_test_keys(temp.path());
    let out_dir = temp.path().join("fixtures");
    let process = Variables::new();

    for query_text in [
        "NEXT_KEY=ABC%2B123%3D%3D&FILTER=A%26B&NOTE=hello%20world",
        "NAME=%EC%82%BC%EC%84%B1&PAIR=A%26B",
    ] {
        let raw_args = strings(&[
            "--broker",
            "kis",
            "--tr",
            "QUERY001",
            "--path",
            "/uapi/test",
            "--query",
            query_text,
            "--key",
            "kis-rest",
            "--keys",
            keys_path.to_str().unwrap(),
            "--state",
            state_dir.to_str().unwrap(),
            "--out",
            out_dir.to_str().unwrap(),
        ]);
        execute_probe(&parse_arguments(&raw_args, &process).unwrap(), &base_url, &process, fixed_clock()).await.unwrap();
    }

    let uris = observed_uris.lock().unwrap().clone();
    let queries = observed_queries.lock().unwrap().clone();
    assert_eq!(uris.len(), 2);
    assert!(!uris[0].contains("%25"), "{}", uris[0]);
    assert!(!uris[1].contains("%25"), "{}", uris[1]);
    assert_eq!(queries[0].get("NEXT_KEY").map(String::as_str), Some("ABC+123=="));
    assert_eq!(queries[0].get("FILTER").map(String::as_str), Some("A&B"));
    assert_eq!(queries[0].get("NOTE").map(String::as_str), Some("hello world"));
    assert_eq!(queries[1].get("NAME").map(String::as_str), Some("삼성"));
    assert_eq!(queries[1].get("PAIR").map(String::as_str), Some("A&B"));
}

#[tokio::test]
async fn probe_scrubs_non_json_and_truncated_json_sensitive_values() {
    let html_body = "<html><body>Error CANO=50012345-01 acnt_no=9988776601 account=5001234501 \
        Authorization: Bearer EXTERNAL-TOKEN-999 auth_bearer=OTHER-LIVE-TOKEN-9999 \
        access_token=EXTERNAL-ACCESS-888 appkey=OTHER-APPKEY-7777</body></html>";
    let truncated_json = r#"{"rt_cd":"1","CANO":"50012345-01","acnt_no":"9988776601","access_token":"TRUNCATED-TOKEN-777""#;

    let state = Arc::new(ServerState::default());
    let router = Router::new()
        .route("/oauth2/tokenP", post(kis_token_handler).with_state(state))
        .route("/uapi/bad-gateway", get(move || async move { (StatusCode::BAD_GATEWAY, html_body).into_response() }))
        .route("/uapi/truncated", get(move || async move { (StatusCode::OK, truncated_json).into_response() }));
    let base_url = spawn_server(router).await;

    let temp = tempfile::tempdir().unwrap();
    let (keys_path, state_dir) = write_test_keys(temp.path());
    let out_dir = temp.path().join("fixtures");
    let process = Variables::new();

    let html_args = strings(&[
        "--broker",
        "kis",
        "--tr",
        "HTML502",
        "--path",
        "/uapi/bad-gateway",
        "--key",
        "kis-rest",
        "--keys",
        keys_path.to_str().unwrap(),
        "--state",
        state_dir.to_str().unwrap(),
        "--out",
        out_dir.to_str().unwrap(),
    ]);
    let html_res = execute_probe(&parse_arguments(&html_args, &process).unwrap(), &base_url, &process, fixed_clock()).await.unwrap();
    let html_disk = std::fs::read_to_string(&html_res.output_path).unwrap();
    for leaked in [
        "50012345-01",
        "9988776601",
        "5001234501",
        "EXTERNAL-TOKEN-999",
        "OTHER-LIVE-TOKEN-9999",
        "EXTERNAL-ACCESS-888",
        "OTHER-APPKEY-7777",
    ] {
        assert!(!html_disk.contains(leaked), "leaked {leaked}:\n{html_disk}");
    }

    let trunc_args = strings(&[
        "--broker",
        "kis",
        "--tr",
        "TRUNC001",
        "--path",
        "/uapi/truncated",
        "--key",
        "kis-rest",
        "--keys",
        keys_path.to_str().unwrap(),
        "--state",
        state_dir.to_str().unwrap(),
        "--out",
        out_dir.to_str().unwrap(),
    ]);
    let trunc_res = execute_probe(&parse_arguments(&trunc_args, &process).unwrap(), &base_url, &process, fixed_clock()).await.unwrap();
    let trunc_disk = std::fs::read_to_string(&trunc_res.output_path).unwrap();
    for leaked in ["50012345-01", "9988776601", "TRUNCATED-TOKEN-777"] {
        assert!(!trunc_disk.contains(leaked), "leaked {leaked}:\n{trunc_disk}");
    }
}

#[tokio::test]
async fn probe_scrubs_case_variants_urlencoded_overlapping_secrets_json_keys_headers_and_broker_fields() {
    let overlapping_key = "KEY123";
    let overlapping_secret = "FAKE+KIS/SECRET=1002";
    let overlapping_token = "TOK-KEY123-SECRET-TAIL";
    let urlencoded_secret_upper = "FAKE%2BKIS%2FSECRET%3D1002";
    let urlencoded_secret_lower = "fake%2bkis%2fsecret%3d1002";
    let lower_key = "key123";

    let router = Router::new()
        .route(
            "/oauth2/tokenP",
            post(move || async move {
                let body = json!({
                    "access_token": overlapping_token,
                    "token_type": "Bearer",
                    "expires_in": 86400
                });
                (StatusCode::OK, body.to_string()).into_response()
            }),
        )
        .route(
            "/uapi/echo",
            get(move || async move {
                let mut echo_map = serde_json::Map::new();
                echo_map.insert(overlapping_key.to_owned(), json!("seen"));
                echo_map.insert(overlapping_token.to_owned(), json!("seen"));
                let payload = json!({
                    "rt_cd": "1",
                    "echo_keys": echo_map,
                    "echo_urlencoded": format!("a={urlencoded_secret_upper} b={urlencoded_secret_lower}"),
                    "echo_lowercase": format!("k={lower_key}"),
                    "echo_overlap": overlapping_token,
                    "acctNo": "5001234501",
                    "acct_no": "50012345-01",
                    "hts_id": "fakehtsuser01",
                    "htsId": "fakehtsuser02",
                    "approval_key": "FAKE-APPROVAL-KEY-9999",
                    "api_key": "FAKE-API-KEY-4444"
                });
                let mut response = (StatusCode::OK, payload.to_string()).into_response();
                response.headers_mut().insert("next-key", HeaderValue::from_str(&format!("cursor-{urlencoded_secret_upper}")).unwrap());
                response
            }),
        );
    let base_url = spawn_server(router).await;

    let temp = tempfile::tempdir().unwrap();
    let (keys_path, state_dir) = write_custom_kis_keys(temp.path(), overlapping_key, overlapping_secret);
    let out_dir = temp.path().join("fixtures");
    let process = Variables::new();
    let raw_args = strings(&[
        "--broker",
        "kis",
        "--tr",
        "SCRUBALL",
        "--path",
        "/uapi/echo",
        "--key",
        "kis-rest",
        "--keys",
        keys_path.to_str().unwrap(),
        "--state",
        state_dir.to_str().unwrap(),
        "--out",
        out_dir.to_str().unwrap(),
    ]);
    let result = execute_probe(&parse_arguments(&raw_args, &process).unwrap(), &base_url, &process, fixed_clock()).await.unwrap();
    let written = std::fs::read_to_string(&result.output_path).unwrap();

    for leaked in [
        overlapping_key,
        overlapping_secret,
        overlapping_token,
        urlencoded_secret_upper,
        urlencoded_secret_lower,
        lower_key,
        "SECRET-TAIL",
        "5001234501",
        "50012345-01",
        "fakehtsuser01",
        "fakehtsuser02",
        "FAKE-APPROVAL-KEY-9999",
        "FAKE-API-KEY-4444",
    ] {
        assert!(!written.contains(leaked), "leaked {leaked}:\n{written}");
    }
    assert_eq!(result.fixture.body["acctNo"], "[REDACTED]");
    assert_eq!(result.fixture.body["hts_id"], "[REDACTED]");
    assert_eq!(result.fixture.body["htsId"], "[REDACTED]");
    assert_eq!(result.fixture.body["approval_key"], "[REDACTED]");
    assert_eq!(result.fixture.body["api_key"], "[REDACTED]");
    assert!(result.fixture.next_key.as_deref().is_some_and(|value| !value.contains(urlencoded_secret_upper)));
}

#[tokio::test]
async fn base_url_validation_rejects_malformed_ipv6_paths_queries_and_fragments() {
    let bad_ipv6 = Variables::from([("VALLY_COLLECTOR_KIS_URL".to_owned(), "http://[::1]evil.example:8080".to_owned())]);
    assert!(kis_base_url(&bad_ipv6).is_err());

    let hits = Arc::new(AtomicUsize::new(0));
    let router = Router::new().fallback(any({
        let hits = hits.clone();
        move || async move {
            hits.fetch_add(1, Ordering::SeqCst);
            (StatusCode::OK, r#"{"rt_cd":"0"}"#).into_response()
        }
    }));
    let base_url = spawn_server(router).await;
    let fragment_base = format!("{base_url}/override#frag");

    assert!(rest_base_url(&Variables::from([("VALLY_COLLECTOR_REST_URL".to_owned(), fragment_base.clone())])).is_err());
    assert!(kis_base_url(&Variables::from([("VALLY_COLLECTOR_KIS_URL".to_owned(), fragment_base.clone())])).is_err());
    assert!(kis_base_url(&Variables::from([("VALLY_COLLECTOR_KIS_URL".to_owned(), format!("{base_url}?x=1"))])).is_err());
    assert!(kis_base_url(&Variables::from([("VALLY_COLLECTOR_KIS_URL".to_owned(), format!("{base_url}/prefix"))])).is_err());

    let temp = tempfile::tempdir().unwrap();
    let (keys_path, state_dir) = write_test_keys(temp.path());
    let out_dir = temp.path().join("fixtures");
    let kis_state = state_dir.join("kis-rest");
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&kis_state).unwrap();
    let token_path = kis_state.join("token.json");
    let saved_token = json!({
        "credential": credential_id(KIS_APP_KEY),
        "token": {
            "value": KIS_TOKEN,
            "expires_at": 4_102_444_800_i64,
            "issued_at": 1_700_000_000_i64
        },
        "last_request_at": 1_700_000_000_i64
    });
    std::fs::write(&token_path, saved_token.to_string()).unwrap();
    std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o600)).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_collector"))
        .env("VALLY_COLLECTOR_KIS_URL", &fragment_base)
        .args([
            "probe-tr",
            "--broker",
            "kis",
            "--tr",
            "FRAG0001",
            "--path",
            "/uapi/real-tr",
            "--key",
            "kis-rest",
            "--keys",
            keys_path.to_str().unwrap(),
            "--state",
            state_dir.to_str().unwrap(),
            "--out",
            out_dir.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2));
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}
