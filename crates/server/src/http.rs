//! 브라우저 REST와 정적 파일(backend.md §8.2, §8.5).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{any, get};
use domain::{Feed, KstTime, Period, SeriesKey, Symbol, Venue};
use tower_http::compression::CompressionLayer;

use crate::api;
use crate::bars::{BarError, BarService, DEFAULT_LIMIT, MAX_LIMIT};
use crate::clock::Clock;
use crate::db::AppDb;
use crate::kiwoom::error::{Category, Failure, Note, Surface};
use crate::kiwoom::rest::{KiwoomError, KiwoomRest};
use crate::market::hub::{HubHandle, HubSnapshot};
use crate::screener::Screener;
use crate::symbols::{NotReady, SymbolDirectory};

pub struct AppState {
    pub symbols: Arc<SymbolDirectory>,
    pub bars: Arc<BarService>,
    pub rest: KiwoomRest,
    pub db: AppDb,
    pub clock: Clock,
    pub static_dir: PathBuf,
    pub hub: HubHandle,
    pub screener: Arc<Screener>,
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/symbols", get(search))
        .route("/api/symbols/{code}", get(symbol))
        .route("/api/symbols/{code}/fundamentals", get(fundamentals))
        .route("/api/bars", get(bars))
        .route("/api/quotes", get(quotes))
        .route("/api/ws", get(crate::ws::upgrade))
        .merge(crate::user_routes::routes())
        .merge(crate::drawings::routes())
        .merge(crate::screener::routes())
        .merge(crate::investors::routes())
        .route("/api", any(api_not_found))
        .route("/api/{*rest}", any(api_not_found))
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(static_file)
        .layer(CompressionLayer::new())
        .with_state(state)
}

/// 오류 응답. 코드마다 HTTP 상태가 하나다.
#[derive(Debug)]
pub struct ApiFailure {
    code: api::ApiErrorCode,
    message: String,
    reason: Option<api::ApiErrorReason>,
    retry_at: Option<KstTime>,
    manual_action_required: bool,
}

impl ApiFailure {
    pub(crate) fn new(code: api::ApiErrorCode, message: impl Into<String>) -> Self {
        ApiFailure { code, message: message.into(), reason: None, retry_at: None, manual_action_required: false }
    }

    fn kiwoom(e: &KiwoomError) -> Self {
        use api::ApiErrorCode::*;
        let code = match e.failure().map(Failure::surface) {
            Some(Surface::Unavailable) => KiwoomUnavailable,
            Some(Surface::AuthFailed) => KiwoomAuthFailed,
            Some(Surface::UnknownSymbol) => UnknownSymbol,
            Some(Surface::Internal) => Internal,
            None if matches!(e, KiwoomError::TokenFile(_)) => KiwoomAuthFailed,
            None => KiwoomUnavailable,
        };
        ApiFailure {
            code,
            message: e.to_string(),
            reason: Some(reason(e)),
            retry_at: e.retry_at(),
            manual_action_required: e.manual_action_required(),
        }
    }

    fn list_not_ready(now: KstTime) -> Self {
        ApiFailure {
            reason: Some(api::ApiErrorReason::SymbolListLoading),
            retry_at: Some(now),
            ..ApiFailure::new(api::ApiErrorCode::KiwoomUnavailable, "종목 목록을 아직 받지 못했습니다. 잠시 뒤 다시 시도하세요")
        }
    }

    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        ApiFailure::new(api::ApiErrorCode::BadRequest, message)
    }

    pub(crate) fn screener_not_ready(reason: api::ApiErrorReason, message: impl Into<String>) -> Self {
        ApiFailure { reason: Some(reason), ..ApiFailure::new(api::ApiErrorCode::ScreenerNotReady, message) }
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
        Conflict | StaleRevision | ScreenerNotReady => StatusCode::CONFLICT,
        PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        MethodNotAllowed => StatusCode::METHOD_NOT_ALLOWED,
        Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

impl ApiFailure {
    pub(crate) fn into_body(self) -> api::ApiErrorBody {
        api::ApiErrorBody {
            code: self.code,
            message: self.message,
            reason: self.reason,
            retry_at: self.retry_at.map(|t| api::UnixSeconds(t.unix())),
            manual_action_required: self.manual_action_required,
        }
    }
}

impl IntoResponse for ApiFailure {
    fn into_response(self) -> Response {
        let status = status_of(self.code);
        (status, Json(api::ApiError { error: self.into_body() })).into_response()
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Lookup {
    Symbols,
    Bars,
    Quotes,
    Fundamentals,
    ForeignHoldings,
    InvestorNetShares,
    ScreenerUpdate,
    ScreenerRun,
}

impl Lookup {
    fn label(self) -> &'static str {
        match self {
            Lookup::Symbols => "종목",
            Lookup::Bars => "봉",
            Lookup::Quotes => "현재가",
            Lookup::Fundamentals => "종목 기본 정보",
            Lookup::ForeignHoldings => "외국인 보유",
            Lookup::InvestorNetShares => "투자자별 순매수",
            Lookup::ScreenerUpdate => "스크리너 업데이트",
            Lookup::ScreenerRun => "스크리너 실행",
        }
    }

    pub(crate) fn failure(self, e: BarError, now: KstTime) -> ApiFailure {
        use api::ApiErrorCode::*;
        let what = self.label();
        match e {
            BarError::BadRequest(m) => ApiFailure::new(BadRequest, m),
            BarError::UnknownSymbol => ApiFailure::new(UnknownSymbol, "없는 종목입니다"),
            BarError::ListNotReady => ApiFailure::list_not_ready(now),
            BarError::IncompleteHistory => ApiFailure::new(KiwoomUnavailable, BarError::IncompleteHistory.to_string()),
            BarError::Kiwoom(e) => {
                let failure = ApiFailure::kiwoom(&e);
                if failure.code == Internal {
                    tracing::error!(reason = %e, "{what} 요청에 답하지 못했습니다");
                } else {
                    tracing::warn!(reason = %e, "{what} 요청에 답하지 못했습니다");
                }
                failure
            }
            BarError::Internal(m) => {
                tracing::error!(reason = %m, "{what} 요청 처리 중 내부 오류");
                ApiFailure::new(Internal, "서버 내부 오류입니다")
            }
        }
    }
}

fn reason(e: &KiwoomError) -> api::ApiErrorReason {
    use api::ApiErrorReason as R;
    let Some(f) = e.failure() else {
        return if matches!(e, KiwoomError::TokenFile(_)) { R::TokenFile } else { R::IssueInterval };
    };
    match f.category() {
        Category::RateLimit => R::RateLimited,
        Category::Transient => match f.note() {
            Note::Transport(t) if t.timed_out => R::KiwoomTimeout,
            Note::Transport(_) | Note::QueueGone => R::KiwoomUnreachable,
            _ => R::KiwoomError,
        },
        Category::TokenInvalid => R::TokenInvalid,
        Category::AuthBlocked => R::AuthBlocked,
        Category::AuthIndeterminate => R::AuthIndeterminate,
        Category::InvalidRequest | Category::BatchLimit => R::InvalidRequest,
        Category::SymbolMismatch => R::SymbolMismatch,
        Category::Unsupported => R::Unsupported,
        Category::Protocol => R::Protocol,
        Category::Unknown | Category::RealtimeCapacity | Category::ControlRejected | Category::SubscriptionMismatch => R::UnknownFailure,
    }
}

pub(crate) async fn symbol_list(st: &AppState) -> Result<Arc<crate::symbols::Directory>, ApiFailure> {
    st.symbols.ready(&st.rest).await.map_err(|e| match e {
        NotReady::Kiwoom(e) => Lookup::Symbols.failure(e.into(), st.clock.now()),
        NotReady::Timeout => ApiFailure::list_not_ready(st.clock.now()),
    })
}

async fn search(State(st): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Result<Json<Vec<api::SymbolInfo>>, ApiFailure> {
    let query = q.get("q").map_or("", String::as_str);
    if crate::symbols::normalize(query).is_empty() {
        return Ok(Json(Vec::new()));
    }
    let dir = symbol_list(&st).await?;
    Ok(Json(dir.search(query).iter().map(api::SymbolInfo::from).collect()))
}

async fn symbol(State(st): State<Arc<AppState>>, Path(code): Path<String>) -> Result<Json<api::SymbolInfo>, ApiFailure> {
    let symbol = Symbol::parse(&code).map_err(|e| ApiFailure::bad_request(e.to_string()))?;
    let dir = symbol_list(&st).await?;
    dir.get(symbol)
        .map(|i| Json(api::SymbolInfo::from(i)))
        .ok_or_else(|| ApiFailure::new(api::ApiErrorCode::UnknownSymbol, format!("없는 종목입니다: {code}")))
}

async fn fundamentals(State(st): State<Arc<AppState>>, Path(code): Path<String>) -> Result<Json<api::Fundamentals>, ApiFailure> {
    let Symbol::Stock(stock) = Symbol::parse(&code).map_err(|e| ApiFailure::bad_request(e.to_string()))? else {
        return Err(ApiFailure::bad_request("지수에는 종목 기본 정보가 없습니다"));
    };
    if symbol_list(&st).await?.get(Symbol::Stock(stock)).is_none() {
        return Err(ApiFailure::new(api::ApiErrorCode::UnknownSymbol, format!("없는 종목입니다: {code}")));
    }
    Ok(Json(crate::fundamentals::fundamentals(&st.rest, stock).await.map_err(|e| Lookup::Fundamentals.failure(e, st.clock.now()))?))
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
    let snapshot_before_page = match q.before {
        None => st.hub.snapshot(q.key).await,
        Some(_) => None,
    };
    let page = st.bars.page(q.key, q.before, q.limit).await.map_err(|e| Lookup::Bars.failure(e, st.clock.now()))?;
    let (bars, current, seq) = with_snapshot(page.bars, page.current, snapshot_before_page);
    Ok(Json(api::BarsPage {
        symbol: api::SymbolCode(q.key.feed.symbol().as_wire()),
        venue: q.key.feed.venue().map(api::Venue::from),
        period: q.key.period.into(),
        bars: bars.iter().map(api::Bar::from).collect(),
        current,
        next_before: page.next_before.map(|t| api::UnixSeconds(t.unix())),
        seq,
    }))
}

fn with_snapshot(
    mut bars: Vec<domain::ConfirmedBar>,
    kiwoom_current: Option<crate::kiwoom::wire::KiwoomBar>,
    snapshot: Option<HubSnapshot>,
) -> (Vec<domain::ConfirmedBar>, Option<api::Bar>, Option<u64>) {
    let Some(snap) = snapshot else {
        return (bars, kiwoom_current.map(|c| api::Bar::new(c.bucket, &c.ohlcv)), None);
    };
    for b in snap.recent_confirmed {
        if bars.last().is_none_or(|last| last.bucket.start() < b.bucket.start()) {
            bars.push(b);
        }
    }
    let after_confirmed = |b: domain::Bucket| bars.last().is_none_or(|last| last.bucket < b);
    let current = match snap.current.filter(|c| after_confirmed(c.bucket())) {
        Some(c) => Some(api::Bar::new(c.bucket(), c.ohlcv())),
        None => kiwoom_current.filter(|c| after_confirmed(c.bucket)).map(|c| api::Bar::new(c.bucket, &c.ohlcv)),
    };
    (bars, current, Some(snap.seq))
}

/// 한 번에 묻는 종목 수 상한. ka10095 두 번(100개씩)이다.
pub const MAX_QUOTE_SYMBOLS: usize = 200;

async fn quotes(State(st): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Result<Json<Vec<api::Quote>>, ApiFailure> {
    let raw = q.get("symbols").map_or("", String::as_str);
    if raw.is_empty() {
        return Ok(Json(Vec::new()));
    }
    if raw.split(',').count() > MAX_QUOTE_SYMBOLS {
        return Err(ApiFailure::bad_request(format!("종목은 한 번에 {MAX_QUOTE_SYMBOLS}개까지입니다")));
    }
    let mut symbols: Vec<Symbol> = Vec::new();
    for code in raw.split(',') {
        let s = Symbol::parse(code).map_err(|e| ApiFailure::bad_request(format!("{e}: {code}")))?;
        if !symbols.contains(&s) {
            symbols.push(s);
        }
    }
    Ok(Json(crate::quotes::quotes(&st.rest, &st.bars, &symbols).await.map_err(|e| Lookup::Quotes.failure(e, st.clock.now()))?))
}

async fn method_not_allowed(method: Method, uri: Uri) -> ApiFailure {
    ApiFailure::new(api::ApiErrorCode::MethodNotAllowed, format!("{}에는 {method}를 쓸 수 없습니다", uri.path()))
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
    use crate::user_routes::LAYOUT_LIMIT;
    use crate::config::Secret;
    use crate::kiwoom::api::ApiId;
    use crate::kiwoom::auth::KiwoomAuth;
    use crate::kiwoom::rest::KiwoomRest;
    use crate::kiwoom::rest::testing::{FakeTransport, ok, status, token};
    use crate::symbols::Directory;
    use domain::{KstDate, Market, SymbolInfo, SymbolKind};

    struct Fixture {
        app: Router,
        fake: Arc<FakeTransport>,
        hub: HubHandle,
        _dir: tempfile::TempDir,
    }

    /// `start_paused` 테스트용. 멈춘 시계는 sqlx 연결 대기 시간을 곧바로 넘겨 버리므로 DB는 시계를 잠깐 풀고 연다.
    async fn fixture(kiwoom_down: bool, loaded: bool) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        tokio::time::resume();
        let db = AppDb::open(&dir.path().join("vally.db")).await.unwrap();
        tokio::time::pause();
        build(kiwoom_down, loaded, dir, db)
    }

    async fn live_fixture(loaded: bool) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let db = AppDb::open(&dir.path().join("vally.db")).await.unwrap();
        build(false, loaded, dir, db)
    }

    fn build(kiwoom_down: bool, loaded: bool, dir: tempfile::TempDir, db: AppDb) -> Fixture {
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
            if s.api_id == ApiId::Ka10095 {
                let path = format!("{}/tests/fixtures/kiwoom/ka10095_synthetic.json", env!("CARGO_MANIFEST_DIR"));
                return ok(serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap(), None);
            }
            if s.api_id == ApiId::Ka10001 {
                let name = if s.body.contains("005935") { "ka10001_999999_AL" } else { "ka10001_005930_AL" };
                let path = format!("{}/tests/fixtures/kiwoom/{name}.json", env!("CARGO_MANIFEST_DIR"));
                return ok(serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap(), None);
            }
            if s.api_id == ApiId::Ka20006 && s.body.contains("\"101\"") {
                return ok(json!({"inds_dt_pole_qry": [
                    {"dt": "20261109", "open_pric": "90000", "high_pric": "90500", "low_pric": "89000", "cur_prc": "-89900", "trde_qty": "77"},
                    {"dt": "20261106", "open_pric": "90100", "high_pric": "91000", "low_pric": "89500", "cur_prc": "90000", "trde_qty": "66"}
                ], "return_code": 0}), None);
            }
            if s.api_id == ApiId::Ka20006 {
                return ok(json!({"inds_dt_pole_qry": [
                    {"dt": "20261106", "open_pric": "250100", "high_pric": "251000", "low_pric": "249000", "cur_prc": "-250050", "trde_qty": "4321"},
                    {"dt": "20261105", "open_pric": "249000", "high_pric": "250500", "low_pric": "248000", "cur_prc": "250000", "trde_qty": "1234"}
                ], "return_code": 0}), None);
            }
            if s.api_id == ApiId::Ka10080 {
                return ok(json!({"stk_min_pole_chart_qry": [
                    {"cntr_tm": "20261106195500", "open_pric": "-193700", "high_pric": "-193700", "low_pric": "-193400", "cur_prc": "-193400", "trde_qty": "79320"},
                    {"cntr_tm": "20261106195000", "open_pric": "-193600", "high_pric": "+193800", "low_pric": "-193500", "cur_prc": "-193700", "trde_qty": "1000"}
                ], "return_code": 0}), None);
            }
            ok(json!({"stk_dt_pole_chart_qry": [
                {"dt": "20261106", "open_pric": "185000", "high_pric": "196500", "low_pric": "175300", "cur_prc": "193400", "trde_qty": "56147847"},
                {"dt": "20261105", "open_pric": "211500", "high_pric": "214000", "low_pric": "199800", "cur_prc": "201500", "trde_qty": "38560685"}
            ], "return_code": 0}), None)
        }));
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 0, 34, 0));
        let rest = KiwoomRest::new(Arc::new(fake.clone()), KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None), clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        if loaded {
            let stock = |code: &str, name: &str, kind, nxt_enabled| SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: name.into(), kind, market: Market::Kospi, nxt_enabled };
            symbols.replace(Directory::build(vec![
                stock("005930", "삼성전자", SymbolKind::Common, true),
                stock("005935", "삼성전자우", SymbolKind::Preferred, false),
            ]));
        }
        let bars = Arc::new(BarService::new(rest.clone(), symbols.clone(), clock.clone()));
        let (hub, _events) = crate::market::hub::MarketHub::detached(bars.clone(), clock.clone());
        let screener = Arc::new(Screener::new(crate::screener::store::Store::open(&dir.path().join("screener.duckdb")).unwrap(), rest.clone(), bars.clone(), symbols.clone(), clock.clone()));
        let app = router(Arc::new(AppState { symbols, bars, rest, db, clock, static_dir: dir.path().to_owned(), hub: hub.clone(), screener }));
        Fixture { app, fake, hub, _dir: dir }
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

    async fn send(app: &Router, method: &str, uri: &str, body: impl Into<Body>) -> (StatusCode, Value) {
        let req = Request::builder().method(method).uri(uri).header("content-type", "application/json").body(body.into()).unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        (status, if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or_else(|_| panic!("{uri}: JSON이 아님: {}", String::from_utf8_lossy(&bytes))) })
    }

    async fn put(app: &Router, uri: &str, body: &Value) -> (StatusCode, Value) {
        send(app, "PUT", uri, body.to_string()).await
    }

    fn code(v: &Value) -> &str {
        v["error"]["code"].as_str().unwrap_or("")
    }

    const DEFAULT_ID: &str = "01900000-0000-7000-8000-000000000001";

    fn two_cells(nxt_symbol: &str) -> Value {
        json!({"id": "L2", "name": "둘", "arrangement": "2h", "sync": {"crosshair": false}, "revision": 1, "cells": [
            {"slot": 1, "symbol": nxt_symbol, "venue": "nxt", "period": "5m", "symbolLink": true, "chartSettings": {"v": 1, "x": [1]}},
            {"slot": 0, "symbol": "IDX:101", "venue": null, "period": "D", "symbolLink": false, "chartSettings": {}}
        ]})
    }

    #[tokio::test(start_paused = true)]
    async fn quotes_follow_request_order_and_omit_what_has_no_value() {
        let f = fixture(false, true).await;
        let (s, mut v) = json(&f.app, "/api/quotes?symbols=IDX:001,000660,005930,IDX:999,005935,005930,IDX:101").await;
        assert_eq!(s, StatusCode::OK, "{v}");
        let rates: Vec<f64> = v.as_array_mut().unwrap().iter_mut().map(|q| q.as_object_mut().unwrap().remove("changeRate").unwrap().as_f64().unwrap()).collect();
        for (got, want) in rates.iter().zip([0.5 / 2500.0 * 100.0, 500.0 / 120_000.0 * 100.0, -1_000.0 / 51_000.0 * 100.0, -1.0 / 900.0 * 100.0]) {
            assert!((got - want).abs() < 1e-9, "{rates:?}");
        }
        assert_eq!(
            v,
            json!([
                {"symbol": "IDX:001", "price": 2500.5, "change": 0.5, "volume": 4321, "t": 1_793_890_800, "source": "polled"},
                {"symbol": "000660", "price": 120_500.0, "change": 500.0, "volume": 765_432, "t": 1_793_890_800 + 15 * 3600 + 30 * 60, "source": "polled"},
                {"symbol": "005930", "price": 50_000.0, "change": -1_000.0, "volume": 1_234_567, "t": 1_793_890_800 + 71_999, "source": "polled"},
                {"symbol": "IDX:101", "price": 899.0, "change": -1.0, "volume": 77, "t": 1_794_150_000, "source": "polled"},
            ]),
            "요청 순서. 없는 지수, 빈 행, 중복은 빠진다. IDX:101은 진행 중인 오늘 봉과 그 앞 확정 봉"
        );
        let bodies: Vec<String> = f.fake.market_sent().into_iter().filter(|s| s.api_id == ApiId::Ka10095).map(|s| s.body).collect();
        assert_eq!(bodies, [r#"{"stk_cd":"000660_AL|005930_AL|005935_AL"}"#]);

        assert_eq!(json(&f.app, "/api/quotes?symbols=").await, (StatusCode::OK, json!([])));
        assert_eq!(json(&f.app, "/api/quotes").await, (StatusCode::OK, json!([])));
        let many: Vec<String> = (1..=150).map(|i| format!("{i:06}")).collect();
        assert_eq!(json(&f.app, &format!("/api/quotes?symbols={}", many.join(","))).await.0, StatusCode::OK);
        let sizes: Vec<usize> = f.fake.market_sent().into_iter().filter(|s| s.api_id == ApiId::Ka10095).skip(1).map(|s| s.body.matches("_AL").count()).collect();
        assert_eq!(sizes, [100, 50], "ka10095는 100개씩 나눠 보낸다");
        let too_many: Vec<String> = (1..=201).map(|i| format!("{i:06}")).collect();
        for uri in ["/api/quotes?symbols=bad".to_owned(), "/api/quotes?symbols=005930,,000660".to_owned(), format!("/api/quotes?symbols={}", too_many.join(","))] {
            let (s, v) = json(&f.app, &uri).await;
            assert_eq!((s, code(&v)), (StatusCode::BAD_REQUEST, "bad_request"), "{v}");
        }
        let f = fixture(true, true).await;
        let (s, v) = json(&f.app, "/api/quotes?symbols=005930").await;
        assert_eq!((s, code(&v)), (StatusCode::SERVICE_UNAVAILABLE, "kiwoom_unavailable"));
    }

    #[tokio::test(start_paused = true)]
    async fn fundamentals_come_from_one_combined_basic_info_request() {
        let f = fixture(false, true).await;
        let (s, v) = json(&f.app, "/api/symbols/005930/fundamentals").await;
        assert_eq!(s, StatusCode::OK, "{v}");
        assert_eq!(
            v,
            json!({"symbol": "005930", "marketCap": 1_093_838_700_000_000u64, "listedShares": 5_846_279_000u64, "per": 28.51, "pbr": 2.92, "roe": 10.9,
                   "eps": 6564, "bps": 63997, "foreignExhaustionRate": 45.93, "high52w": 380_000, "low52w": 93_500})
        );
        let bodies: Vec<String> = f.fake.market_sent().into_iter().filter(|s| s.api_id == ApiId::Ka10001).map(|s| s.body).collect();
        assert_eq!(bodies, [r#"{"stk_cd":"005930_AL"}"#]);

        for (uri, want) in [
            ("/api/symbols/IDX:001/fundamentals", (StatusCode::BAD_REQUEST, "bad_request")),
            ("/api/symbols/bad/fundamentals", (StatusCode::BAD_REQUEST, "bad_request")),
            ("/api/symbols/000660/fundamentals", (StatusCode::NOT_FOUND, "unknown_symbol")),
            ("/api/symbols/005935/fundamentals", (StatusCode::NOT_FOUND, "unknown_symbol")),
        ] {
            let (s, v) = json(&f.app, uri).await;
            assert_eq!((s, code(&v)), want, "{uri}: {v}");
        }
        let asked: Vec<String> = f.fake.market_sent().into_iter().filter(|s| s.api_id == ApiId::Ka10001).map(|s| s.body).collect();
        assert_eq!(asked.len(), 2, "지수와 목록에 없는 종목은 키움에 묻지 않는다: {asked:?}");

        let f = fixture(true, true).await;
        let (s, v) = json(&f.app, "/api/symbols/005930/fundamentals").await;
        assert_eq!((s, code(&v)), (StatusCode::SERVICE_UNAVAILABLE, "kiwoom_unavailable"));
    }

    #[tokio::test]
    async fn watchlists_round_trip_and_rejections() {
        let f = live_fixture(true).await;
        let first = "01900000-0000-7000-8000-000000000002";
        assert_eq!(
            json(&f.app, "/api/watchlists").await,
            (StatusCode::OK, json!({"lists": [{"id": first, "name": "기본", "symbols": []}], "revision": 0}))
        );
        let all = json!({"lists": [
            {"id": first, "name": "기본", "symbols": ["005930", "IDX:001", "999990"]},
            {"id": "B", "name": "반도체", "symbols": ["000660", "005930"]},
            {"id": "C", "name": "빈 목록", "symbols": []},
        ], "revision": 1});
        assert_eq!(put(&f.app, "/api/watchlists", &all).await, (StatusCode::OK, all.clone()), "목록에 없는 코드, 목록 사이 같은 종목도 받는다");
        assert_eq!(json(&f.app, "/api/watchlists").await, (StatusCode::OK, all));
        let one = |name: &str, symbols: Value| json!({"id": "X", "name": name, "symbols": symbols});
        let body = |lists: Value, revision: i64| json!({"lists": lists, "revision": revision}).to_string();
        let many: Vec<Value> = (0..21).map(|i| json!({"id": format!("L{i}"), "name": format!("목록 {i}"), "symbols": []})).collect();
        for (body, status, want) in [
            (body(json!([one("가", json!(["005930", "005930"]))]), 2), StatusCode::BAD_REQUEST, "bad_request"),
            (body(json!([one("가", json!(["abc"]))]), 2), StatusCode::BAD_REQUEST, "bad_request"),
            (body(json!([]), 2), StatusCode::BAD_REQUEST, "bad_request"),
            (body(json!(many), 2), StatusCode::BAD_REQUEST, "bad_request"),
            (body(json!([one("가", json!([])), {"id": "Y", "name": "가", "symbols": []}]), 2), StatusCode::BAD_REQUEST, "bad_request"),
            (body(json!([one("가", json!([])), {"id": "X", "name": "나", "symbols": []}]), 2), StatusCode::BAD_REQUEST, "bad_request"),
            (body(json!([one(" ", json!([]))]), 2), StatusCode::BAD_REQUEST, "bad_request"),
            (body(json!([one(" 가", json!([]))]), 2), StatusCode::BAD_REQUEST, "bad_request"),
            (body(json!([one(&"가".repeat(21), json!([]))]), 2), StatusCode::BAD_REQUEST, "bad_request"),
            (json!({"lists": [one("가", json!([]))]}).to_string(), StatusCode::BAD_REQUEST, "bad_request"),
            ("{\"lists\": [".to_owned(), StatusCode::BAD_REQUEST, "bad_request"),
            (json!({"lists": [one("가", json!([]))], "revision": 2, "pad": "x".repeat(70_000)}).to_string(), StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"),
            (body(json!([one("가", json!([]))]), 1), StatusCode::CONFLICT, "stale_revision"),
        ] {
            let (s, v) = send(&f.app, "PUT", "/api/watchlists", body).await;
            assert_eq!((s, code(&v)), (status, want), "{v}");
            assert!(!v["error"]["message"].as_str().unwrap().is_empty());
        }
        assert_eq!(json(&f.app, "/api/watchlists").await.1["lists"].as_array().unwrap().len(), 3, "거절한 PUT은 목록을 바꾸지 않는다");
        let twenty: Vec<Value> = many[..20].to_vec();
        assert_eq!(put(&f.app, "/api/watchlists", &json!({"lists": twenty, "revision": 3})).await.0, StatusCode::OK, "20개까지 받는다");
    }

    #[tokio::test]
    async fn watchlists_take_every_list_the_old_single_list_limit_took() {
        let f = live_fixture(true).await;
        let legacy_body = |codes: &[String]| json!({"symbols": codes, "revision": i64::MAX}).to_string();
        let mut codes: Vec<String> = Vec::new();
        while legacy_body(&codes).len() <= crate::user_routes::JSON_LIMIT {
            codes.push(format!("{:06}", 100_000 + codes.len()));
        }
        codes.pop();
        assert!(codes.len() >= 7_274, "리뷰 반례(7,274종목)보다 크다: {}", codes.len());

        let lists: Vec<Value> = (0..20)
            .map(|i| json!({"id": format!("{i:0>64}"), "name": format!("{i:𝄞>20}"), "symbols": if i == 0 { codes.clone() } else { vec![] }}))
            .collect();
        let all = json!({"lists": lists, "revision": i64::MAX});
        let (s, v) = put(&f.app, "/api/watchlists", &all).await;
        assert_eq!(s, StatusCode::OK, "옛 한도에 들던 목록을 가장 긴 감싸개 20개로 감싸도 받는다: {}", v["error"]);
        assert_eq!(json(&f.app, "/api/watchlists").await, (StatusCode::OK, all));
    }

    #[tokio::test]
    async fn watchlists_body_limit_is_exact() {
        let f = live_fixture(true).await;
        let padded = |bytes: usize, revision: i64| {
            let bare = json!({"lists": [{"id": "X", "name": "가", "symbols": []}], "revision": revision, "pad": ""}).to_string();
            json!({"lists": [{"id": "X", "name": "가", "symbols": []}], "revision": revision, "pad": "x".repeat(bytes - bare.len())}).to_string()
        };
        let limit = crate::user_routes::WATCHLISTS_LIMIT;
        assert_eq!(send(&f.app, "PUT", "/api/watchlists", padded(limit, 10)).await.0, StatusCode::OK);
        let (s, v) = send(&f.app, "PUT", "/api/watchlists", padded(limit + 1, 11)).await;
        assert_eq!((s, code(&v)), (StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"));
    }

    #[tokio::test]
    async fn layouts_round_trip_and_rejections() {
        let f = live_fixture(true).await;
        let (s, v) = json(&f.app, "/api/layouts").await;
        assert_eq!((s, v), (StatusCode::OK, json!([{"id": DEFAULT_ID, "name": "기본", "arrangement": "1", "updatedAt": 0}])));
        let (s, v) = json(&f.app, &format!("/api/layouts/{DEFAULT_ID}")).await;
        assert_eq!((s, v["cells"][0]["symbol"].as_str(), v["sync"].clone()), (StatusCode::OK, Some("IDX:001"), json!({"crosshair": true, "scroll": true})));

        let (s, saved) = put(&f.app, "/api/layouts/L2", &two_cells("005930")).await;
        assert_eq!(s, StatusCode::OK, "{saved}");
        assert_eq!(saved["updatedAt"], 1_794_152_040, "서버 시계(2026-11-09 00:34 KST)");
        assert_eq!(saved["sync"], json!({"crosshair": false, "scroll": true}), "빠진 키는 true");
        assert_eq!(saved["cells"][0]["slot"], 0, "slot 순서로 돌려준다");
        assert_eq!(json(&f.app, "/api/layouts/L2").await, (StatusCode::OK, saved));
        assert_eq!(put(&f.app, "/api/layouts/L3", &json!({"id": "L3", "name": "폐지", "arrangement": "1", "sync": {}, "revision": 1, "cells": [
            {"slot": 0, "symbol": "999990", "venue": "nxt", "period": "D", "symbolLink": false, "chartSettings": {}}]})).await.0, StatusCode::OK, "목록에 없는 종목은 막지 않는다");

        let with = |f: &dyn Fn(&mut Value)| {
            let mut v = two_cells("005930");
            v["revision"] = json!(2);
            f(&mut v);
            v
        };
        for (uri, body, status, want) in [
            ("/api/layouts/OTHER", two_cells("005930"), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/layouts/L2", with(&|v| v["arrangement"] = json!("3")), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/layouts/L2", with(&|v| v["cells"][0]["slot"] = json!(0)), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/layouts/L2", with(&|v| v["cells"][1]["venue"] = json!("krx")), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/layouts/L2", with(&|v| v["cells"][0]["venue"] = json!(null)), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/layouts/L2", with(&|v| v["cells"][0]["symbol"] = json!("bad")), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/layouts/L2", with(&|v| v["name"] = json!(" ")), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/layouts/L2", with(&|v| v["cells"][0]["period"] = json!("2m")), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/layouts/L2", two_cells("005935"), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/layouts/L2", with(&|v| v["name"] = json!("기본")), StatusCode::CONFLICT, "conflict"),
            ("/api/layouts/L2", with(&|v| v["cells"][0]["chartSettings"] = json!({"pad": "x".repeat(65_536)})), StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"),
            ("/api/layouts/L2", with(&|v| v["pad"] = json!("x".repeat(LAYOUT_LIMIT))), StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"),
            ("/api/layouts/L2", with(&|v| v["revision"] = json!(null)), StatusCode::BAD_REQUEST, "bad_request"),
            ("/api/layouts/L2", with(&|v| v["revision"] = json!(1)), StatusCode::CONFLICT, "stale_revision"),
            ("/api/layouts/L2", with(&|v| v["revision"] = json!(0)), StatusCode::CONFLICT, "stale_revision"),
        ] {
            let (s, v) = put(&f.app, uri, &body).await;
            assert_eq!((s, code(&v)), (status, want), "{uri} {v}");
        }
        let (_, v) = put(&f.app, "/api/layouts/L2", &two_cells("005935")).await;
        assert!(v["error"]["message"].as_str().unwrap().contains("NXT에서 거래되지 않는 종목입니다"), "{v}");
        assert_eq!(json(&f.app, "/api/layouts/L2").await.1["revision"], 1, "거절한 PUT은 저장하지 않는다");
        let mut four_big = json!({"id": "L4", "name": "넷", "arrangement": "4", "sync": {}, "revision": 1, "cells": []});
        for slot in 0..4 {
            four_big["cells"].as_array_mut().unwrap().push(json!({"slot": slot, "symbol": "IDX:001", "venue": null, "period": "D", "symbolLink": false,
                "chartSettings": {"pad": "x".repeat(60_000)}}));
        }
        assert_eq!(put(&f.app, "/api/layouts/L4", &four_big).await.0, StatusCode::OK, "칸마다 64KB 아래면 합이 64KB를 넘어도 된다");

        let (s, v) = json(&f.app, "/api/layouts/nope").await;
        assert_eq!((s, code(&v)), (StatusCode::NOT_FOUND, "not_found"));
        assert_eq!(send(&f.app, "DELETE", "/api/layouts/nope", Body::empty()).await.0, StatusCode::NOT_FOUND);
        for id in ["L2", "L3", "L4"] {
            assert_eq!(send(&f.app, "DELETE", &format!("/api/layouts/{id}"), Body::empty()).await, (StatusCode::NO_CONTENT, Value::Null));
        }
        let (s, v) = send(&f.app, "DELETE", &format!("/api/layouts/{DEFAULT_ID}"), Body::empty()).await;
        assert_eq!((s, code(&v)), (StatusCode::CONFLICT, "conflict"), "마지막 레이아웃");
    }

    #[tokio::test]
    async fn layout_without_nxt_saves_before_the_symbol_list_arrives() {
        let f = live_fixture(false).await;
        let mut body = two_cells("005930");
        body["cells"][0]["venue"] = json!("combined");
        assert_eq!(put(&f.app, "/api/layouts/L2", &body).await.0, StatusCode::OK);
    }

    #[tokio::test(start_paused = true)]
    async fn layout_with_nxt_waits_for_the_symbol_list() {
        let f = fixture(false, false).await;
        let (s, v) = put(&f.app, "/api/layouts/L2", &two_cells("005930")).await;
        assert_eq!((s, code(&v)), (StatusCode::SERVICE_UNAVAILABLE, "kiwoom_unavailable"));
    }

    #[tokio::test]
    async fn ui_state_round_trips_unknown_keys_and_rejects_non_objects() {
        let f = live_fixture(true).await;
        assert_eq!(json(&f.app, "/api/ui-state").await, (StatusCode::OK, json!({"lastLayoutId": DEFAULT_ID, "theme": "dark", "revision": 0})));
        let state = json!({"lastLayoutId": null, "theme": "light", "watchCollapsed": true, "nested": {"a": [1, 2]}, "revision": 5});
        assert_eq!(put(&f.app, "/api/ui-state", &state).await, (StatusCode::OK, state.clone()));
        assert_eq!(json(&f.app, "/api/ui-state").await, (StatusCode::OK, state));
        for (body, status, want) in [
            (json!([1, 2]), StatusCode::BAD_REQUEST, "bad_request"),
            (json!("x"), StatusCode::BAD_REQUEST, "bad_request"),
            (json!({"theme": "dark", "pad": "x".repeat(65_536)}), StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"),
            (json!({"theme": "dark"}), StatusCode::BAD_REQUEST, "bad_request"),
            (json!({"theme": "dark", "revision": "6"}), StatusCode::BAD_REQUEST, "bad_request"),
            (json!({"theme": "dark", "revision": 5}), StatusCode::CONFLICT, "stale_revision"),
        ] {
            let (s, v) = put(&f.app, "/api/ui-state", &body).await;
            assert_eq!((s, code(&v)), (status, want), "{v}");
        }
        let (s, v) = send(&f.app, "PUT", "/api/ui-state", "{not json").await;
        assert_eq!((s, code(&v)), (StatusCode::BAD_REQUEST, "bad_request"));
    }

    #[tokio::test(start_paused = true)]
    async fn symbols_endpoints() {
        let f = fixture(false, true).await;
        let (s, v) = json(&f.app, "/api/symbols?q=%EC%82%BC%EC%84%B1").await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v[0], json!({"code": "005930", "name": "삼성전자", "kind": "common", "market": "kospi", "nxtEnabled": true}));
        assert_eq!(v[1]["nxtEnabled"], false);
        assert_eq!(json(&f.app, "/api/symbols?q=").await, (StatusCode::OK, json!([])));
        assert_eq!(json(&f.app, "/api/symbols").await, (StatusCode::OK, json!([])));
        assert_eq!(json(&f.app, "/api/symbols/IDX:101").await.1["name"], "코스닥");
        let (s, v) = json(&f.app, "/api/symbols/000660").await;
        assert_eq!((s, v["error"]["code"].as_str()), (StatusCode::NOT_FOUND, Some("unknown_symbol")));
        assert_eq!(json(&f.app, "/api/symbols/bad").await.0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test(start_paused = true)]
    async fn bars_endpoint_shape_and_errors() {
        let f = fixture(false, true).await;
        let (s, v) = json(&f.app, "/api/bars?symbol=005930&period=D").await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v["symbol"], "005930");
        assert_eq!(v["period"], "D");
        assert_eq!(v["seq"], Value::Null);
        assert_eq!(v["current"], Value::Null);
        assert_eq!(v["nextBefore"], Value::Null);
        assert_eq!(v["bars"][1], json!({"t": 1_793_890_800, "o": 185000.0, "h": 196500.0, "l": 175300.0, "c": 193400.0, "v": 56147847}));
        assert_eq!(v["venue"], "combined", "거래소를 주지 않으면 통합");
        let (s, v) = json(&f.app, "/api/bars?symbol=005930&period=5m&venue=nxt").await;
        assert_eq!((s, v["period"].as_str(), v["venue"].as_str()), (StatusCode::OK, Some("5m"), Some("nxt")), "{v}");
        let ts: Vec<_> = v["bars"].as_array().unwrap().iter().map(|b| (b["t"].as_i64().unwrap(), b["c"].as_f64().unwrap())).collect();
        assert_eq!(ts, [(1_793_962_200, 193_700.0), (1_793_962_500, 193_400.0)], "2026-11-06 19:50·19:55 봉, 오름차순");
        let (s, v) = json(&f.app, "/api/bars?symbol=005930&period=D&venue=krx").await;
        assert_eq!((s, v["venue"].as_str()), (StatusCode::OK, Some("krx")));
        let (s, v) = json(&f.app, "/api/bars?symbol=005935&period=D&venue=nxt").await;
        assert!(v["error"]["message"].as_str().unwrap().contains("NXT에서 거래되지 않는 종목입니다"), "{s} {v}");
        for (uri, code, status) in [
            ("/api/bars?symbol=005930", "bad_request", StatusCode::BAD_REQUEST),
            ("/api/bars?symbol=005930&period=X", "bad_request", StatusCode::BAD_REQUEST),
            ("/api/bars?symbol=005930&period=D&limit=0", "bad_request", StatusCode::BAD_REQUEST),
            ("/api/bars?symbol=005930&period=D&limit=1001", "bad_request", StatusCode::BAD_REQUEST),
            ("/api/bars?symbol=005930&period=D&before=abc", "bad_request", StatusCode::BAD_REQUEST),
            ("/api/bars?symbol=005930&period=D&venue=tokyo", "bad_request", StatusCode::BAD_REQUEST),
            ("/api/bars?symbol=IDX:001&period=D&venue=krx", "bad_request", StatusCode::BAD_REQUEST),
            ("/api/bars?symbol=005935&period=D&venue=nxt", "bad_request", StatusCode::BAD_REQUEST),
            ("/api/bars?symbol=000660&period=D", "unknown_symbol", StatusCode::NOT_FOUND),
        ] {
            let (s, v) = json(&f.app, uri).await;
            assert_eq!((s, v["error"]["code"].as_str().unwrap()), (status, code), "{uri}");
            assert!(!v["error"]["message"].as_str().unwrap().is_empty());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn kiwoom_down_and_list_missing_are_503() {
        let f = fixture(true, true).await;
        let (s, v) = json(&f.app, "/api/bars?symbol=005930&period=D").await;
        assert_eq!((s, v["error"]["code"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("kiwoom_unavailable")));
        let f = fixture(false, false).await;
        let (s, v) = json(&f.app, "/api/symbols?q=x").await;
        assert_eq!((s, v["error"]["code"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("kiwoom_unavailable")));
    }

    #[tokio::test]
    async fn wrong_method_is_405_with_api_error() {
        let f = live_fixture(true).await;
        for (method, uri) in [("POST", "/api/ui-state"), ("DELETE", "/api/watchlists"), ("POST", "/api/layouts/x"), ("PUT", "/api/bars"), ("POST", "/api/symbols")] {
            let (s, v) = send(&f.app, method, uri, "{}").await;
            assert_eq!((s, code(&v)), (StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed"), "{method} {uri}: {v}");
            assert!(v["error"]["message"].as_str().unwrap().contains(method), "{v}");
        }
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
            (StaleRevision, 409),
            (ScreenerNotReady, 409),
            (PayloadTooLarge, 413),
            (MethodNotAllowed, 405),
            (Internal, 500),
        ];
        for (code, want) in table {
            assert_eq!(status_of(code).as_u16(), want, "{code:?}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn static_files_follow_the_table() {
        let f = fixture(false, true).await;
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
        let f = fixture(false, true).await;
        let (_, h, _) = get_with(&f.app, "/assets/app-1234.js", Some("br")).await;
        assert_eq!(header(&h, "content-encoding"), "br");
        let (_, h, _) = get_with(&f.app, "/assets/app-1234.js", Some("gzip")).await;
        assert_eq!(header(&h, "content-encoding"), "gzip");
    }

    fn m1(h: u32, m: u32) -> domain::Bucket {
        Period::M1.bucket(kst(KstDate::new(2026, 11, 9).unwrap(), h, m, 0))
    }

    fn ohlcv(c: u64) -> domain::Ohlcv {
        let p = domain::Price::from_centi(c).unwrap();
        domain::Ohlcv::try_new(p, p, p, p, domain::Volume(1)).unwrap()
    }

    fn realtime(b: domain::Bucket, c: u64) -> domain::ConfirmedBar {
        domain::ConfirmedBar { bucket: b, ohlcv: ohlcv(c), source: domain::BarSource::Realtime, needs_verify: false }
    }

    #[test]
    fn the_latest_page_takes_seq_current_and_unwritten_bars_from_the_hub() {
        let page = vec![domain::ConfirmedBar::from_kiwoom(m1(8, 58), ohlcv(100)), domain::ConfirmedBar::from_kiwoom(m1(8, 59), ohlcv(200))];
        let kiwoom_current = Some(crate::kiwoom::wire::KiwoomBar { bucket: m1(9, 0), ohlcv: ohlcv(300) });
        let t = |b: &[domain::ConfirmedBar]| b.iter().map(|b| (b.bucket.start(), b.source)).collect::<Vec<_>>();

        let (bars, current, seq) = with_snapshot(page.clone(), kiwoom_current, None);
        assert_eq!((bars.len(), current.map(|c| c.c), seq), (2, Some(3.0), None), "허브가 모르는 키는 키움 값");

        let snap = HubSnapshot { seq: 7, current: Some(domain::CurrentBar::seed(m1(9, 1), ohlcv(500))), recent_confirmed: vec![realtime(m1(8, 59), 1), realtime(m1(9, 0), 400)] };
        let (bars, current, seq) = with_snapshot(page.clone(), kiwoom_current, Some(snap));
        assert_eq!(
            t(&bars),
            [(m1(8, 58).start(), domain::BarSource::Kiwoom), (m1(8, 59).start(), domain::BarSource::Kiwoom), (m1(9, 0).start(), domain::BarSource::Realtime)],
            "캐시에 있는 봉은 그대로, 더 새 확정 봉만 잇는다"
        );
        assert_eq!((current.map(|c| (c.t.0, c.c)), seq), (Some((m1(9, 1).start().unix(), 5.0)), Some(7)));

        let seeding = HubSnapshot { seq: 3, current: None, recent_confirmed: vec![] };
        let (_, current, seq) = with_snapshot(page.clone(), kiwoom_current, Some(seeding));
        assert_eq!((current.map(|c| c.c), seq), (Some(3.0), Some(3)), "시드 중이면 키움의 현재 봉");

        let closed = HubSnapshot { seq: 4, current: None, recent_confirmed: vec![realtime(m1(9, 0), 400)] };
        let (bars, current, _) = with_snapshot(page, kiwoom_current, Some(closed));
        assert_eq!((bars.len(), current), (3, None), "허브가 이미 확정한 구간의 키움 현재 봉은 버린다");
    }

    #[test]
    fn a_page_that_crossed_a_minute_after_the_snapshot_keeps_its_own_current() {
        let page = vec![domain::ConfirmedBar::from_kiwoom(m1(8, 59), ohlcv(200)), domain::ConfirmedBar::from_kiwoom(m1(9, 0), ohlcv(300))];
        let kiwoom_current = Some(crate::kiwoom::wire::KiwoomBar { bucket: m1(9, 1), ohlcv: ohlcv(400) });
        let snap = HubSnapshot { seq: 7, current: Some(domain::CurrentBar::seed(m1(9, 0), ohlcv(250))), recent_confirmed: vec![] };
        let (bars, current, seq) = with_snapshot(page, kiwoom_current, Some(snap));
        let newest = bars.last().unwrap().bucket.start().unix();
        assert!(current.is_some_and(|c| c.t.0 > newest), "현재 봉은 모든 확정 봉보다 늦다: {current:?}");
        assert_eq!((current.map(|c| (c.t.0, c.c)), seq), (Some((m1(9, 1).start().unix(), 4.0)), Some(7)), "페이지의 09:01 현재 봉, seq는 스냅숏의 것");
    }

    #[tokio::test(start_paused = true)]
    async fn only_the_latest_page_of_a_subscribed_key_has_a_seq() {
        let f = fixture(false, true).await;
        let (_, v) = json(&f.app, "/api/bars?symbol=005930&period=D").await;
        assert_eq!(v["seq"], Value::Null, "구독이 없으면 null");
        let out = crate::market::outbox::Outbox::new();
        let conn = f.hub.connect(out.clone());
        let key = SeriesKey { feed: Feed::new(Symbol::parse("005930").unwrap(), None).unwrap(), period: Period::Day };
        f.hub.subscribe(conn, crate::market::SubId("c0".into()), key);
        tokio::time::sleep(Duration::from_secs(1)).await;
        let (_, v) = json(&f.app, "/api/bars?symbol=005930&period=D").await;
        assert_eq!(v["seq"], json!(0));
        let (_, v) = json(&f.app, "/api/bars?symbol=005930&period=D&before=1793890800").await;
        assert_eq!(v["seq"], Value::Null, "과거 페이지는 null");
    }

    type Client = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

    async fn recv_json(ws: &mut Client) -> Value {
        use futures::StreamExt;
        loop {
            if let tokio_tungstenite::tungstenite::Message::Text(t) = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("5초 안에 온다").unwrap().unwrap() {
                return serde_json::from_str(t.as_str()).unwrap();
            }
        }
    }

    #[tokio::test]
    async fn websocket_says_hello_and_answers_subscribe() {
        use futures::SinkExt;
        use tokio_tungstenite::tungstenite::Message;
        let f = live_fixture(true).await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(axum::serve(listener, f.app.clone()).into_future());
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/api/ws")).await.unwrap();
        let hello = recv_json(&mut ws).await;
        assert_eq!((hello["type"].as_str(), hello["protocol"].as_i64()), (Some("hello"), Some(1)), "{hello}");
        for text in [
            "not json",
            r#"{"type":"subscribe","sub":"bad","symbol":"IDX:001","venue":"krx","period":"D"}"#,
            r#"{"type":"subscribe","sub":"c0","symbol":"005930","venue":null,"period":"D"}"#,
        ] {
            ws.send(Message::Text(text.into())).await.unwrap();
        }
        assert_eq!(recv_json(&mut ws).await, json!({"type": "sub_error", "sub": "bad", "code": "bad_request"}), "읽을 수 없는 메시지는 버리고, 지수에 거래소는 bad_request");
        assert_eq!(recv_json(&mut ws).await, json!({"type": "subscribed", "sub": "c0", "seq": 0, "current": null}));
    }

    #[tokio::test(start_paused = true)]
    async fn requests_already_waiting_for_the_symbol_list_end_when_kiwoom_rejects_auth() {
        let dir = tempfile::tempdir().unwrap();
        tokio::time::resume();
        let db = AppDb::open(&dir.path().join("vally.db")).await.unwrap();
        tokio::time::pause();
        let fake = Arc::new(FakeTransport::new(Duration::from_millis(300), |s| {
            if s.api_id == ApiId::Au10001 {
                return token(1);
            }
            status(403, json!({"return_code": 3, "return_msg": "지정단말기 인증에 실패했습니다[8050:지정단말기 인증 실패]"}))
        }));
        let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 9, 0, 0));
        let rest = KiwoomRest::new(Arc::new(fake.clone()), KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None), clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        let bars = Arc::new(BarService::new(rest.clone(), symbols.clone(), clock.clone()));
        let (hub, _events) = crate::market::hub::MarketHub::detached(bars.clone(), clock.clone());
        let screener = Arc::new(Screener::new(crate::screener::store::Store::open(&dir.path().join("screener.duckdb")).unwrap(), rest.clone(), bars.clone(), symbols.clone(), clock.clone()));
        let app = router(Arc::new(AppState { symbols: symbols.clone(), bars, rest: rest.clone(), db, clock, static_dir: dir.path().to_owned(), hub, screener }));

        let nxt_layout = two_cells("005930");
        let started = tokio::time::Instant::now();
        let (symbol, bar, layout, list) = tokio::join!(
            json(&app, "/api/symbols/005930"),
            json(&app, "/api/bars?symbol=005930&period=D&before=1794182400"),
            put(&app, "/api/layouts/L2", &nxt_layout),
            symbols.refresh(&rest, crate::kiwoom::rest::Priority::Screen),
        );
        let list = list.unwrap_err();
        let failure = list.failure().expect("키움 판정");
        assert_eq!((failure.category(), failure.detail()), (crate::kiwoom::error::Category::AuthBlocked, Some(crate::kiwoom::error::CodeKey::Rest(8050))));
        for (what, (s, v)) in [("종목", symbol), ("봉", bar), ("NXT 레이아웃", layout)] {
            assert_eq!((s, code(&v)), (StatusCode::BAD_GATEWAY, "kiwoom_auth_failed"), "{what}: {v}");
        }
        assert!(started.elapsed() < Duration::from_secs(2), "8050을 받자마자 끝난다: {:?}", started.elapsed());
    }
}
