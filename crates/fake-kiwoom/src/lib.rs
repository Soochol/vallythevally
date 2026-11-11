use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use domain::{KstDate, Weekday};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub mod investors;
pub mod krx;
mod ws;
pub use krx::{KrxBar, KrxMarket, KrxStock};
pub use ws::{DEFAULT_PING_EVERY, WsHub, WsStats, tick_0j, trade_0b};

pub const APP_KEY: &str = "FAKE-APPKEY-e2e-7f3a91c2";
pub const APP_SECRET: &str = "FAKE-SECRET-e2e-c0ffee42";
pub const TOKEN: &str = "FAKE-TOKEN-e2e-5eed1234";

#[derive(Default)]
pub struct Seen {
    pub requests: AtomicUsize,
    pub api_ids: Mutex<Vec<String>>,
    pub authorizations: Mutex<Vec<String>>,
    pub token_bodies: Mutex<Vec<Value>>,
    pub overrides: Mutex<HashMap<String, (StatusCode, Value)>>,
    pub key_overrides: Mutex<HashMap<(String, String), (StatusCode, Value)>>,
    pub rejected_tokens: Mutex<Vec<String>>,
    pub delays: Mutex<HashMap<String, Duration>>,
    pub extra_kospi_stocks: AtomicUsize,
    pub krx_market: Mutex<Option<Arc<KrxMarket>>>,
    pub calls: Mutex<Vec<Call>>,
    pub ws: WsHub,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    pub api_id: String,
    pub body: Value,
    pub next_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub requests: usize,
    pub issued: usize,
    pub api_ids: Vec<String>,
}

impl Seen {
    pub fn respond_with(&self, api_id: &str, status: StatusCode, body: Value) {
        self.overrides.lock().unwrap().insert(api_id.to_owned(), (status, body));
    }

    pub fn respond_with_for_key(&self, api_id: &str, next_key: &str, status: StatusCode, body: Value) {
        self.key_overrides.lock().unwrap().insert((api_id.to_owned(), next_key.to_owned()), (status, body));
    }

    pub fn delay(&self, api_id: &str, by: Duration) {
        self.delays.lock().unwrap().insert(api_id.to_owned(), by);
    }

    pub fn reject_token(&self, token: &str) {
        self.rejected_tokens.lock().unwrap().push(format!("Bearer {token}"));
    }

    pub fn is_rejected(&self, token: &str) -> bool {
        self.rejected_tokens.lock().unwrap().contains(&format!("Bearer {token}"))
    }

    pub fn reset(&self) {
        self.ws.reset();
        self.overrides.lock().unwrap().clear();
        self.key_overrides.lock().unwrap().clear();
        self.delays.lock().unwrap().clear();
        self.rejected_tokens.lock().unwrap().clear();
    }

    pub fn stats(&self) -> Stats {
        let api_ids = self.api_ids.lock().unwrap().clone();
        Stats { requests: self.requests.load(Ordering::SeqCst), issued: api_ids.iter().filter(|a| *a == "au10001").count(), api_ids }
    }
}

pub struct FakeKiwoom {
    pub addr: SocketAddr,
    pub seen: Arc<Seen>,
}

impl FakeKiwoom {
    pub async fn start() -> FakeKiwoom {
        FakeKiwoom::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.unwrap()
    }

    pub async fn bind(addr: SocketAddr) -> io::Result<FakeKiwoom> {
        if !addr.ip().is_loopback() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("가짜 키움은 루프백 주소(127.0.0.0/8, ::1)에만 엽니다: {addr}")));
        }
        let seen = Arc::new(Seen::default());
        let app = Router::new()
            .route("/oauth2/token", post(handle))
            .route("/api/dostk/chart", post(handle))
            .route("/api/dostk/stkinfo", post(handle))
            .route("/api/dostk/frgnistt", post(handle))
            .route("/_fake/respond-with", post(admin_respond_with))
            .route("/_fake/delay", post(admin_delay))
            .route("/_fake/reject-token", post(admin_reject_token))
            .route("/_fake/reset", post(admin_reset))
            .route("/_fake/krx-market", post(admin_krx_market))
            .route("/_fake/stats", get(admin_stats))
            .merge(ws::routes())
            .with_state(seen.clone());
        let listener = tokio::net::TcpListener::bind(addr).await?;
        let addr = listener.local_addr()?;
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Ok(FakeKiwoom { addr, seen })
    }

    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn ws_url(&self) -> String {
        format!("ws://{}/api/dostk/websocket", self.addr)
    }

    pub fn push_real(&self, kind: &str, item: &str, values: Value) -> usize {
        self.seen.ws.push_real(kind, item, values)
    }

    pub fn drop_sessions(&self, code: u16, reason: &str) {
        self.seen.ws.drop_sessions(code, reason);
    }

    pub fn mute_ws(&self, on: bool) {
        self.seen.ws.mute(on);
    }

    pub fn set_ping_every(&self, every: Duration) {
        self.seen.ws.set_ping_every(every);
    }

    pub fn set_reg_limit(&self, limit: usize) {
        self.seen.ws.set_reg_limit(limit);
    }

    pub fn set_extra_kospi_stocks(&self, n: usize) {
        self.seen.extra_kospi_stocks.store(n, Ordering::SeqCst);
    }

    pub fn set_krx_market(&self, market: KrxMarket) {
        *self.seen.krx_market.lock().unwrap() = Some(Arc::new(market));
    }

    pub fn calls(&self) -> Vec<Call> {
        self.seen.calls.lock().unwrap().clone()
    }

    pub fn ws_stats(&self) -> WsStats {
        self.seen.ws.stats()
    }

    pub fn respond_with(&self, api_id: &str, status: u16, body: Value) {
        self.seen.respond_with(api_id, StatusCode::from_u16(status).expect("HTTP 상태 코드"), body);
    }

    pub fn respond_with_for_key(&self, api_id: &str, next_key: &str, status: u16, body: Value) {
        self.seen.respond_with_for_key(api_id, next_key, StatusCode::from_u16(status).expect("HTTP 상태 코드"), body);
    }

    pub fn delay(&self, api_id: &str, by: Duration) {
        self.seen.delay(api_id, by);
    }

    pub fn reject_token(&self, token: &str) {
        self.seen.reject_token(token);
    }

    pub fn reset(&self) {
        self.seen.reset();
    }

    pub fn issued(&self) -> usize {
        self.seen.stats().issued
    }

    pub fn api_ids(&self) -> Vec<String> {
        self.seen.stats().api_ids
    }

    pub fn requests(&self) -> usize {
        self.seen.stats().requests
    }
}

pub fn fixture(name: &str) -> Value {
    let path = format!("{}/{name}.json", concat!(env!("CARGO_MANIFEST_DIR"), "/../server/tests/fixtures/kiwoom"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}

pub fn token_for(app_key: &str) -> String {
    if app_key == APP_KEY { TOKEN.to_owned() } else { format!("FAKE-TOKEN-for-{app_key}") }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RespondWith {
    api_id: String,
    status: u16,
    body: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Delay {
    api_id: String,
    ms: u64,
}

#[derive(Deserialize)]
struct RejectToken {
    token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SampleKrxMarket {
    as_of: String,
}

async fn admin_respond_with(State(seen): State<Arc<Seen>>, Json(r): Json<RespondWith>) -> Response {
    match StatusCode::from_u16(r.status) {
        Ok(status) => {
            seen.respond_with(&r.api_id, status, r.body);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(_) => (StatusCode::BAD_REQUEST, format!("HTTP 상태 코드가 아닙니다: {}", r.status)).into_response(),
    }
}

async fn admin_delay(State(seen): State<Arc<Seen>>, Json(d): Json<Delay>) -> StatusCode {
    seen.delay(&d.api_id, Duration::from_millis(d.ms));
    StatusCode::NO_CONTENT
}

async fn admin_reject_token(State(seen): State<Arc<Seen>>, Json(r): Json<RejectToken>) -> StatusCode {
    seen.reject_token(&r.token);
    StatusCode::NO_CONTENT
}

async fn admin_reset(State(seen): State<Arc<Seen>>) -> StatusCode {
    seen.reset();
    StatusCode::NO_CONTENT
}

async fn admin_krx_market(State(seen): State<Arc<Seen>>, Json(m): Json<SampleKrxMarket>) -> Response {
    match KstDate::parse_yyyymmdd(&m.as_of) {
        Some(as_of) => {
            *seen.krx_market.lock().unwrap() = Some(Arc::new(KrxMarket::sample(as_of)));
            StatusCode::NO_CONTENT.into_response()
        }
        None => (StatusCode::BAD_REQUEST, format!("asOf는 YYYYMMDD입니다: {}", m.as_of)).into_response(),
    }
}

async fn admin_stats(State(seen): State<Arc<Seen>>) -> Json<Stats> {
    Json(seen.stats())
}

async fn handle(State(seen): State<Arc<Seen>>, headers: HeaderMap, body: String) -> Response {
    seen.requests.fetch_add(1, Ordering::SeqCst);
    let h = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    let api_id = h("api-id");
    seen.api_ids.lock().unwrap().push(api_id.clone());
    seen.authorizations.lock().unwrap().push(h("authorization"));
    let continuation = h("cont-yn") == "Y";
    let next_key = continuation.then(|| h("next-key"));
    let request: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    seen.calls.lock().unwrap().push(Call { api_id: api_id.clone(), body: request.clone(), next_key: next_key.clone() });
    let delay = seen.delays.lock().unwrap().get(&api_id).copied();
    if let Some(by) = delay {
        tokio::time::sleep(by).await;
    }
    let keyed = next_key.clone().and_then(|k| seen.key_overrides.lock().unwrap().get(&(api_id.clone(), k)).cloned());
    if let Some((status, body)) = keyed.or_else(|| seen.overrides.lock().unwrap().get(&api_id).cloned()) {
        let mut resp = if body.get("_headers").is_some() { respond(body, false) } else { (status, body.to_string()).into_response() };
        *resp.status_mut() = status;
        resp.headers_mut().insert("content-type", "application/json;charset=UTF-8".parse().unwrap());
        return resp;
    }
    if seen.rejected_tokens.lock().unwrap().contains(&h("authorization")) {
        return respond(json!({"return_code": 3, "return_msg": "인증에 실패했습니다[8005:Token이 유효하지 않습니다]"}), true);
    }
    let market = seen.krx_market.lock().unwrap().clone();
    if let Some(resp) = market.as_deref().and_then(|m| investors::answer(m, &api_id, &request, next_key.as_deref())) {
        return resp;
    }
    if let Some(page) = market.and_then(|m| krx::respond(&m, &api_id, &request, next_key.as_deref())) {
        return match page {
            krx::KrxPage::Page { body, last } => respond(body, last),
            krx::KrxPage::UnknownNextKey(k) => (StatusCode::INTERNAL_SERVER_ERROR, format!("가짜 키움이 모르는 next-key: {k}")).into_response(),
        };
    }
    if api_id == "ka10081" {
        let req = &request;
        if let Some(stk_cd) = req["stk_cd"].as_str().filter(|c| c.starts_with(DEEP_DAILY_SYMBOL)) {
            let next_key = if continuation { h("next-key") } else { String::new() };
            return deep_daily(stk_cd, &next_key);
        }
    }
    let name = match api_id.as_str() {
        "au10001" => {
            let body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let mut v = fixture("au10001_ok");
            v["token"] = token_for(body["appkey"].as_str().unwrap_or("")).into();
            seen.token_bodies.lock().unwrap().push(body);
            v["expires_dt"] = "20991231000000".into();
            return respond(v, false);
        }
        "ka10099" if body.contains("\"10\"") => "ka10099_10",
        "ka10099" => "ka10099_0",
        // 거래소는 stk_cd 접미사로 고른다(kiwoom.md 3·12·13절).
        "ka10081" if body.contains("_NX") => "ka10081_005930_NX",
        "ka10081" if body.contains("_AL") => "ka10081_005930_AL",
        "ka10081" => "ka10081_005930",
        "ka10080" if body.contains("005935_NX") => "ka10080_005935_NX_1",
        "ka10080" if body.contains("_NX") => "ka10080_005930_NX_1",
        "ka10080" => "ka10080_005930_3",
        "ka20005" => "ka20005_001_1",
        "ka10095" => "ka10095_synthetic",
        "ka10001" if body.contains("086520") => "ka10001_086520_AL",
        "ka10001" if body.contains("069500") => "ka10001_069500_AL",
        "ka10001" => "ka10001_005930_AL",
        "ka10082" => "ka10082_005930_AL",
        "ka10083" => "ka10083_005930_AL",
        "ka20006" => "ka20006_001",
        "ka20007" => "ka20007_001",
        "ka20008" => "ka20008_001",
        _ => return (StatusCode::INTERNAL_SERVER_ERROR, "가짜 키움이 모르는 api-id").into_response(),
    };
    let v = if continuation { without_rows(fixture(name)) } else { fixture(name) };
    let v = if name == "ka10099_0" { with_extra_stocks(v, seen.extra_kospi_stocks.load(Ordering::SeqCst)) } else { v };
    respond(v, continuation)
}

pub fn extra_stock_code(i: usize) -> String {
    format!("{:06}", 950_000 + i * 10)
}

fn with_extra_stocks(mut page: Value, n: usize) -> Value {
    let Some(rows) = page["list"].as_array_mut() else {
        return page;
    };
    let Some(template) = rows.first().cloned() else {
        return page;
    };
    rows.extend((0..n).map(|i| {
        let mut row = template.clone();
        row["code"] = extra_stock_code(i).into();
        row["name"] = format!("합성종목{i:03}").into();
        row["marketCode"] = "0".into();
        row["nxtEnable"] = "N".into();
        row
    }));
    page
}

fn without_rows(mut first_page: Value) -> Value {
    for (_, field) in first_page.as_object_mut().unwrap().iter_mut() {
        if let Value::Array(rows) = field {
            rows.clear();
        }
    }
    first_page
}

const DEEP_DAILY_SYMBOL: &str = "086520";
const DEEP_DAILY_PAGES: usize = 4;
const DEEP_DAILY_ROWS_PER_PAGE: usize = 300;

fn deep_daily(stk_cd: &str, next_key: &str) -> Response {
    let page = match next_key {
        "" => 0,
        k => match k.strip_prefix('P').and_then(|n| n.parse::<usize>().ok()).filter(|n| (2..=DEEP_DAILY_PAGES).contains(n)) {
            Some(n) => n - 1,
            None => return (StatusCode::INTERNAL_SERVER_ERROR, format!("가짜 키움이 모르는 next-key: {k}")).into_response(),
        },
    };
    let last = page + 1 == DEEP_DAILY_PAGES;
    let dates = weekdays_back_from(KstDate::new(2026, 11, 6).unwrap());
    let rows: Vec<Value> = (page * DEEP_DAILY_ROWS_PER_PAGE..(page + 1) * DEEP_DAILY_ROWS_PER_PAGE).map(|i| deep_daily_row(i, dates[i])).collect();
    let v = json!({
        "_source": "합성",
        "_headers": {"cont-yn": if last { "N" } else { "Y" }, "next-key": if last { String::new() } else { format!("P{}", page + 2) }},
        "return_code": 0,
        "return_msg": "정상적으로 처리되었습니다",
        "stk_cd": stk_cd,
        "stk_dt_pole_chart_qry": rows,
    });
    respond(v, last)
}

fn weekdays_back_from(newest: KstDate) -> Vec<KstDate> {
    std::iter::successors(Some(newest), |d| Some(d.add_days(-1)))
        .filter(|d| !matches!(d.weekday(), Weekday::Sat | Weekday::Sun))
        .take(DEEP_DAILY_PAGES * DEEP_DAILY_ROWS_PER_PAGE)
        .collect()
}

fn deep_daily_row(rows_back: usize, dt: KstDate) -> Value {
    let close = |rows_back: usize| 100_000 + (rows_back * 37 % 97) as i64 * 500;
    let c = close(rows_back);
    let o = if rows_back.is_multiple_of(2) { c - 1_500 } else { c + 1_500 };
    let (high, low) = (o.max(c) + 2_000, o.min(c) - 2_000);
    let change = c - close(rows_back + 1);
    let (sig, pred_pre) = match change.signum() {
        1 => ("2", format!("+{change}")),
        0 => ("3", "0".to_owned()),
        _ => ("5", change.to_string()),
    };
    let qty = 500_000 + (rows_back * 7_919 % 400_000) as i64;
    json!({
        "cur_prc": c.to_string(),
        "dt": dt.yyyymmdd(),
        "high_pric": high.to_string(),
        "low_pric": low.to_string(),
        "open_pric": o.to_string(),
        "pred_pre": pred_pre,
        "pred_pre_sig": sig,
        "trde_prica": (qty * c / 1_000_000).to_string(),
        "trde_qty": qty.to_string(),
        "trde_tern_rt": "+0.50",
        "upd_rt": "",
        "upd_stkpc_tp": "",
    })
}

fn respond(mut v: Value, last_page: bool) -> Response {
    let obj = v.as_object_mut().unwrap();
    let headers = obj.remove("_headers").unwrap_or(Value::Null);
    let status = obj.remove("_status").and_then(|s| s.as_u64()).unwrap_or(200) as u16;
    obj.retain(|k, _| !k.starts_with('_'));
    let (cont, next) = if last_page {
        ("N".to_owned(), String::new())
    } else {
        (
            headers["cont-yn"].as_str().unwrap_or("N").to_owned(),
            headers["next-key"].as_str().unwrap_or("").to_owned(),
        )
    };
    let mut resp = (StatusCode::from_u16(status).unwrap(), v.to_string()).into_response();
    resp.headers_mut().insert("content-type", "application/json;charset=UTF-8".parse().unwrap());
    resp.headers_mut().insert("cont-yn", cont.parse().unwrap());
    resp.headers_mut().insert("next-key", next.parse().unwrap());
    resp
}
