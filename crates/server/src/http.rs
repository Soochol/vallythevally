//! 브라우저 REST와 정적 파일(backend.md §8.2, §8.5).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{any, get};
use domain::{Feed, KstTime, Period, SeriesKey, Symbol, Venue};
use tower_http::compression::CompressionLayer;

use crate::api;
use crate::bars::{BarError, BarService, DEFAULT_LIMIT, MAX_LIMIT};
use crate::symbols::SymbolDirectory;

pub struct AppState {
    pub symbols: Arc<SymbolDirectory>,
    pub bars: Arc<BarService>,
    pub static_dir: PathBuf,
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/symbols", get(search))
        .route("/api/symbols/{code}", get(symbol))
        .route("/api/bars", get(bars))
        .route("/api", any(api_not_found))
        .route("/api/{*rest}", any(api_not_found))
        .fallback(static_file)
        .layer(CompressionLayer::new())
        .with_state(state)
}

/// 오류 응답. 코드마다 HTTP 상태가 하나다.
#[derive(Debug)]
pub struct ApiFailure {
    code: api::ApiErrorCode,
    message: String,
}

impl ApiFailure {
    fn new(code: api::ApiErrorCode, message: impl Into<String>) -> Self {
        ApiFailure { code, message: message.into() }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        ApiFailure::new(api::ApiErrorCode::BadRequest, message)
    }
}

pub fn status_of(code: api::ApiErrorCode) -> StatusCode {
    use api::ApiErrorCode::*;
    match code {
        BadRequest => StatusCode::BAD_REQUEST,
        NotFound | UnknownSymbol => StatusCode::NOT_FOUND,
        KiwoomUnavailable => StatusCode::SERVICE_UNAVAILABLE,
        // 키움이 우리 인증을 거절했다. 다시 시도해도 낫지 않으므로 503이 아니라 502로 둔다.
        KiwoomAuthFailed => StatusCode::BAD_GATEWAY,
        Conflict => StatusCode::CONFLICT,
        PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

impl IntoResponse for ApiFailure {
    fn into_response(self) -> Response {
        let body = api::ApiError { error: api::ApiErrorBody { code: self.code, message: self.message } };
        (status_of(self.code), Json(body)).into_response()
    }
}

impl From<BarError> for ApiFailure {
    fn from(e: BarError) -> Self {
        use api::ApiErrorCode::*;
        match e {
            BarError::BadRequest(m) => ApiFailure::new(BadRequest, m),
            BarError::UnknownSymbol => ApiFailure::new(UnknownSymbol, "없는 종목입니다"),
            BarError::Unavailable(m) => {
                tracing::warn!(reason = %m, "봉 요청에 답하지 못했습니다");
                ApiFailure::new(KiwoomUnavailable, "키움 조회에 실패했습니다. 잠시 뒤 다시 시도하세요")
            }
            BarError::AuthFailed => ApiFailure::new(KiwoomAuthFailed, "키움 인증에 실패했습니다. 운영자가 설정을 확인해야 합니다"),
            BarError::Internal(m) => {
                tracing::error!(reason = %m, "봉 요청 처리 중 내부 오류");
                ApiFailure::new(Internal, "서버 내부 오류입니다")
            }
        }
    }
}

fn not_ready() -> ApiFailure {
    ApiFailure::new(api::ApiErrorCode::KiwoomUnavailable, "종목 목록을 아직 받지 못했습니다. 잠시 뒤 다시 시도하세요")
}

async fn search(State(st): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Result<Json<Vec<api::SymbolInfo>>, ApiFailure> {
    let query = q.get("q").map_or("", String::as_str);
    if crate::symbols::normalize(query).is_empty() {
        return Ok(Json(Vec::new()));
    }
    let dir = st.symbols.ready().await.map_err(|_| not_ready())?;
    Ok(Json(dir.search(query).iter().map(api::SymbolInfo::from).collect()))
}

async fn symbol(State(st): State<Arc<AppState>>, Path(code): Path<String>) -> Result<Json<api::SymbolInfo>, ApiFailure> {
    let symbol = Symbol::parse(&code).map_err(|e| ApiFailure::bad_request(e.to_string()))?;
    let dir = st.symbols.ready().await.map_err(|_| not_ready())?;
    dir.get(symbol)
        .map(|i| Json(api::SymbolInfo::from(i)))
        .ok_or_else(|| ApiFailure::new(api::ApiErrorCode::UnknownSymbol, format!("없는 종목입니다: {code}")))
}

struct BarsQuery {
    key: SeriesKey,
    before: Option<KstTime>,
    limit: usize,
}

fn parse_bars_query(q: &HashMap<String, String>) -> Result<BarsQuery, ApiFailure> {
    let required = |k: &str| q.get(k).ok_or_else(|| ApiFailure::bad_request(format!("{k}가 없습니다")));
    let symbol = Symbol::parse(required("symbol")?).map_err(|e| ApiFailure::bad_request(e.to_string()))?;
    let period = Period::parse(required("period")?).map_err(|e| ApiFailure::bad_request(e.to_string()))?;
    let venue = match q.get("venue") {
        None => None,
        Some(s) => Some(Venue::parse(s).ok_or_else(|| ApiFailure::bad_request(format!("거래소는 combined, krx, nxt 중 하나입니다: {s}")))?),
    };
    let feed = Feed::new(symbol, venue).ok_or_else(|| ApiFailure::bad_request("지수에는 거래소가 없습니다"))?;
    let limit = match q.get("limit") {
        None => DEFAULT_LIMIT,
        Some(s) => s
            .parse::<usize>()
            .ok()
            .filter(|n| (1..=MAX_LIMIT).contains(n))
            .ok_or_else(|| ApiFailure::bad_request(format!("limit은 1부터 {MAX_LIMIT}까지입니다: {s}")))?,
    };
    let before = match q.get("before") {
        None => None,
        Some(s) => Some(KstTime::from_unix(
            s.parse().map_err(|_| ApiFailure::bad_request(format!("before는 Unix 초여야 합니다: {s}")))?,
        )),
    };
    Ok(BarsQuery { key: SeriesKey { feed, period }, before, limit })
}

async fn bars(State(st): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Result<Json<api::BarsPage>, ApiFailure> {
    let q = parse_bars_query(&q)?;
    let page = st.bars.page(q.key, q.before, q.limit).await?;
    Ok(Json(api::BarsPage {
        symbol: api::SymbolCode(q.key.feed.symbol().as_wire()),
        venue: q.key.feed.venue().map(api::Venue::from),
        period: q.key.period.into(),
        bars: page.bars.iter().map(api::Bar::from).collect(),
        current: page.current.map(|c| api::Bar::new(c.bucket, &c.ohlcv)),
        next_before: page.next_before.map(|t| api::UnixSeconds(t.unix())),
        seq: None,
    }))
}

async fn api_not_found(uri: Uri) -> ApiFailure {
    ApiFailure::new(api::ApiErrorCode::NotFound, format!("없는 API 경로입니다: {}", uri.path()))
}

const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const NO_CACHE: &str = "no-cache";

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// §8.5 표. `/assets/*`와 확장자가 있는 경로는 파일이거나 404, 그 밖은 SPA 경로라 index.html이다.
async fn static_file(State(st): State<Arc<AppState>>, uri: Uri) -> Response {
    let rel = uri.path().trim_start_matches('/');
    if rel.split('/').any(|seg| seg == ".." || seg.contains('\\')) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let is_asset = rel.starts_with("assets/");
    let has_ext = rel.rsplit('/').next().is_some_and(|last| last.contains('.'));
    if is_asset || has_ext {
        let cache = if is_asset {
            Some(IMMUTABLE)
        } else if rel == "index.html" {
            Some(NO_CACHE)
        } else {
            None
        };
        return match tokio::fs::read(st.static_dir.join(rel)).await {
            Ok(bytes) => file_response(bytes, mime(rel), cache),
            Err(_) => StatusCode::NOT_FOUND.into_response(),
        };
    }
    match tokio::fs::read(st.static_dir.join("index.html")).await {
        Ok(bytes) => file_response(bytes, mime("index.html"), Some(NO_CACHE)),
        Err(_) => (StatusCode::NOT_FOUND, format!("{}에 index.html이 없습니다. web을 먼저 빌드하세요", st.static_dir.display())).into_response(),
    }
}

fn file_response(bytes: Vec<u8>, content_type: &'static str, cache: Option<&'static str>) -> Response {
    let mut resp = (StatusCode::OK, bytes).into_response();
    let headers = resp.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    if let Some(c) = cache {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(c));
    }
    resp
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use super::*;
    use crate::clock::{Clock, kst};
    use crate::config::Secret;
    use crate::kiwoom::api::ApiId;
    use crate::kiwoom::auth::KiwoomAuth;
    use crate::kiwoom::rest::KiwoomRest;
    use crate::kiwoom::rest::testing::{FakeTransport, ok, status, token};
    use crate::symbols::Directory;
    use domain::{KstDate, Market, SymbolInfo, SymbolKind};

    struct Fixture {
        app: Router,
        _dir: tempfile::TempDir,
    }

    fn fixture(kiwoom_down: bool, loaded: bool) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("assets")).unwrap();
        std::fs::write(dir.path().join("index.html"), "<!doctype html><title>vally</title>").unwrap();
        std::fs::write(dir.path().join("assets/app-1234.js"), "console.log('x');".repeat(100)).unwrap();
        std::fs::write(dir.path().join("assets/ind_bg.wasm"), b"\0asm\x01\0\0\0").unwrap();
        std::fs::write(dir.path().join("favicon.ico"), b"ico").unwrap();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| {
            if s.api_id == ApiId::Au10001 {
                return token(1);
            }
            if kiwoom_down {
                return status(503, json!({}));
            }
            ok(json!({"stk_dt_pole_chart_qry": [
                {"dt": "20261106", "open_pric": "185000", "high_pric": "196500", "low_pric": "175300", "cur_prc": "193400", "trde_qty": "56147847"},
                {"dt": "20261105", "open_pric": "211500", "high_pric": "214000", "low_pric": "199800", "cur_prc": "201500", "trde_qty": "38560685"}
            ], "return_code": 0}), None)
        }));
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 0, 34, 0));
        let rest = KiwoomRest::new(Arc::new(fake), KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into())), clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        if loaded {
            symbols.replace(Directory::build(vec![SymbolInfo {
                symbol: Symbol::parse("005930").unwrap(),
                name: "삼성전자".into(),
                kind: SymbolKind::Common,
                market: Market::Kospi,
                nxt_enabled: true,
            }]));
        }
        let bars = Arc::new(BarService::new(rest, symbols.clone(), clock));
        Fixture { app: router(Arc::new(AppState { symbols, bars, static_dir: dir.path().to_owned() })), _dir: dir }
    }

    async fn get(app: &Router, uri: &str) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        get_with(app, uri, None).await
    }

    async fn get_with(app: &Router, uri: &str, accept_encoding: Option<&str>) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let mut req = Request::get(uri);
        if let Some(enc) = accept_encoding {
            req = req.header("accept-encoding", enc);
        }
        let resp = app.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        let (parts, body) = resp.into_parts();
        (parts.status, parts.headers, body.collect().await.unwrap().to_bytes().to_vec())
    }

    async fn json(app: &Router, uri: &str) -> (StatusCode, Value) {
        let (s, _, b) = get(app, uri).await;
        (s, serde_json::from_slice(&b).unwrap_or_else(|_| panic!("{uri}: JSON이 아님: {}", String::from_utf8_lossy(&b))))
    }

    fn header<'a>(h: &'a axum::http::HeaderMap, k: &str) -> &'a str {
        h.get(k).map_or("", |v| v.to_str().unwrap())
    }

    #[tokio::test(start_paused = true)]
    async fn symbols_endpoints() {
        let f = fixture(false, true);
        let (s, v) = json(&f.app, "/api/symbols?q=%EC%82%BC%EC%84%B1").await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v, json!([{"code": "005930", "name": "삼성전자", "kind": "common", "market": "kospi", "nxtEnabled": true}]));
        assert_eq!(json(&f.app, "/api/symbols?q=").await, (StatusCode::OK, json!([])));
        assert_eq!(json(&f.app, "/api/symbols").await, (StatusCode::OK, json!([])));
        assert_eq!(json(&f.app, "/api/symbols/IDX:101").await.1["name"], "코스닥");
        let (s, v) = json(&f.app, "/api/symbols/000660").await;
        assert_eq!((s, v["error"]["code"].as_str()), (StatusCode::NOT_FOUND, Some("unknown_symbol")));
        assert_eq!(json(&f.app, "/api/symbols/bad").await.0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test(start_paused = true)]
    async fn bars_endpoint_shape_and_errors() {
        let f = fixture(false, true);
        let (s, v) = json(&f.app, "/api/bars?symbol=005930&period=D").await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v["symbol"], "005930");
        assert_eq!(v["period"], "D");
        assert_eq!(v["seq"], Value::Null);
        assert_eq!(v["current"], Value::Null);
        assert_eq!(v["nextBefore"], Value::Null);
        assert_eq!(v["bars"][1], json!({"t": 1_793_890_800, "o": 185000.0, "h": 196500.0, "l": 175300.0, "c": 193400.0, "v": 56147847}));
        for (uri, code, status) in [
            ("/api/bars?symbol=005930", "bad_request", StatusCode::BAD_REQUEST),
            ("/api/bars?symbol=005930&period=X", "bad_request", StatusCode::BAD_REQUEST),
            ("/api/bars?symbol=005930&period=D&limit=0", "bad_request", StatusCode::BAD_REQUEST),
            ("/api/bars?symbol=005930&period=D&limit=1001", "bad_request", StatusCode::BAD_REQUEST),
            ("/api/bars?symbol=005930&period=D&before=abc", "bad_request", StatusCode::BAD_REQUEST),
            ("/api/bars?symbol=005930&period=5m", "bad_request", StatusCode::BAD_REQUEST),
            ("/api/bars?symbol=000660&period=D", "unknown_symbol", StatusCode::NOT_FOUND),
        ] {
            let (s, v) = json(&f.app, uri).await;
            assert_eq!((s, v["error"]["code"].as_str().unwrap()), (status, code), "{uri}");
            assert!(!v["error"]["message"].as_str().unwrap().is_empty());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn kiwoom_down_and_list_missing_are_503() {
        let f = fixture(true, true);
        let (s, v) = json(&f.app, "/api/bars?symbol=005930&period=D").await;
        assert_eq!((s, v["error"]["code"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("kiwoom_unavailable")));
        let f = fixture(false, false);
        let (s, v) = json(&f.app, "/api/symbols?q=x").await;
        assert_eq!((s, v["error"]["code"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("kiwoom_unavailable")));
    }

    #[test]
    fn every_error_code_has_one_status() {
        use api::ApiErrorCode::*;
        let table = [
            (BadRequest, 400),
            (NotFound, 404),
            (UnknownSymbol, 404),
            (KiwoomUnavailable, 503),
            (KiwoomAuthFailed, 502),
            (Conflict, 409),
            (PayloadTooLarge, 413),
            (Internal, 500),
        ];
        for (code, want) in table {
            assert_eq!(status_of(code).as_u16(), want, "{code:?}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn static_files_follow_the_table() {
        let f = fixture(false, true);
        let (s, v) = json(&f.app, "/api/nope").await;
        assert_eq!((s, v["error"]["code"].as_str()), (StatusCode::NOT_FOUND, Some("not_found")));
        assert_eq!(json(&f.app, "/api").await.0, StatusCode::NOT_FOUND);
        assert_eq!(json(&f.app, "/api/symbols/005930/extra").await.1["error"]["code"], "not_found");

        let (s, h, b) = get(&f.app, "/").await;
        assert_eq!((s, header(&h, "cache-control")), (StatusCode::OK, "no-cache"));
        assert!(String::from_utf8(b).unwrap().contains("<title>vally"));
        let (s, h, _) = get(&f.app, "/index.html").await;
        assert_eq!((s, header(&h, "cache-control")), (StatusCode::OK, "no-cache"));
        let (s, h, b) = get(&f.app, "/layout/0193abc").await;
        assert_eq!((s, header(&h, "cache-control"), header(&h, "content-type")), (StatusCode::OK, "no-cache", "text/html; charset=utf-8"));
        assert!(!b.is_empty());

        let (s, h, _) = get(&f.app, "/assets/app-1234.js").await;
        assert_eq!((s, header(&h, "cache-control")), (StatusCode::OK, IMMUTABLE));
        assert!(header(&h, "content-type").starts_with("text/javascript"));
        let (s, h, _) = get(&f.app, "/assets/ind_bg.wasm").await;
        assert_eq!((s, header(&h, "content-type"), header(&h, "cache-control")), (StatusCode::OK, "application/wasm", IMMUTABLE));
        let (s, _, b) = get(&f.app, "/assets/missing.js").await;
        assert_eq!((s, b.len()), (StatusCode::NOT_FOUND, 0));
        let (s, _, b) = get(&f.app, "/assets/noext").await;
        assert_eq!((s, b.len()), (StatusCode::NOT_FOUND, 0));
        assert_eq!(get(&f.app, "/favicon.ico").await.0, StatusCode::OK);
        assert_eq!(get(&f.app, "/robots.txt").await.0, StatusCode::NOT_FOUND);
        assert_eq!(get(&f.app, "/assets/../index.html").await.0, StatusCode::NOT_FOUND);
    }

    #[tokio::test(start_paused = true)]
    async fn js_is_compressed() {
        let f = fixture(false, true);
        let (_, h, _) = get_with(&f.app, "/assets/app-1234.js", Some("br")).await;
        assert_eq!(header(&h, "content-encoding"), "br");
        let (_, h, _) = get_with(&f.app, "/assets/app-1234.js", Some("gzip")).await;
        assert_eq!(header(&h, "content-encoding"), "gzip");
    }
}
