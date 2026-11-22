//! 임시 장치: 공개 요청이 운영자 키움 키의 대기열을 밀어내는 크기를 묶는다(ADR D10·D11).
//! `collector-shared-data`가 공용 자료를 수집 데몬으로 옮기면 이 모듈과 `public/mod.rs`에서 부르는 줄을 지운다.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use tokio::sync::OwnedSemaphorePermit;

use super::limits::{AccountSlots, MinuteWindow, PerAccount, Slots, locked};
use super::settings::Limits;
use super::usage::Bundle;
use super::{Principal, Runtime, errors};

const CACHED_BODY_LIMIT: usize = 8 * 1024 * 1024;
const REQUEST_BODY_LIMIT: usize = 64 * 1024;
const CACHE_ENTRIES: usize = 256;
const BUSY_RETRY_SECS: i64 = 2;

pub(crate) enum Refusal {
    Busy,
    Limited { retry_at: i64 },
}

impl Refusal {
    fn into_response(self, now: i64) -> Response {
        match self {
            Refusal::Busy => errors::busy(now, BUSY_RETRY_SECS),
            Refusal::Limited { retry_at } => errors::too_many(now, retry_at),
        }
    }
}

pub(crate) struct Held {
    _account: OwnedSemaphorePermit,
    _bundle: Option<OwnedSemaphorePermit>,
}

struct Cached {
    at: i64,
    content_type: Option<HeaderValue>,
    body: Bytes,
}

impl Cached {
    fn response(&self) -> Response {
        let mut response = (StatusCode::OK, Body::from(self.body.clone())).into_response();
        if let Some(content_type) = &self.content_type {
            response.headers_mut().insert(header::CONTENT_TYPE, content_type.clone());
        }
        response
    }
}

pub(crate) struct KiwoomGuard {
    ranking_max_pages: u8,
    market_cache_secs: i64,
    status_cache_secs: i64,
    account: AccountSlots,
    rankings: Slots,
    market: Slots,
    board: Slots,
    flow: Slots,
    screener: Option<Slots>,
    screener_account_per_minute: u32,
    screener_total_per_minute: u32,
    screener_account: PerAccount<MinuteWindow>,
    screener_total: Mutex<MinuteWindow>,
    market_cache: Mutex<HashMap<String, Cached>>,
    status_cache: Mutex<Option<Cached>>,
}

impl KiwoomGuard {
    pub fn new(limits: &Limits) -> Self {
        KiwoomGuard {
            ranking_max_pages: limits.ranking_max_pages,
            market_cache_secs: limits.market_cache.as_secs() as i64,
            status_cache_secs: limits.screener_status_cache.as_secs() as i64,
            account: AccountSlots::new(limits.kiwoom_account_in_flight),
            rankings: Slots::new(limits.rankings_concurrency),
            market: Slots::new(limits.market_concurrency),
            board: Slots::new(limits.board_concurrency),
            flow: Slots::new(limits.flow_concurrency),
            screener: (limits.screener_concurrency > 0).then(|| Slots::new(limits.screener_concurrency)),
            screener_account_per_minute: limits.screener_account_per_minute,
            screener_total_per_minute: limits.screener_total_per_minute,
            screener_account: PerAccount::default(),
            screener_total: Mutex::new(MinuteWindow::default()),
            market_cache: Mutex::new(HashMap::new()),
            status_cache: Mutex::new(None),
        }
    }

    /// 묶음 자리와 계정당 키움 경로 자리를 함께 잡는다. 자리가 없으면 기다리지 않는다. `public-user-data`의 보드·흐름도 이 함수를 쓴다.
    pub fn hold(&self, bundle: Bundle, account: &str) -> Result<Held, Refusal> {
        let pool = match bundle {
            Bundle::Rankings => Some(&self.rankings),
            Bundle::MarketOverview => Some(&self.market),
            Bundle::ScreenerRun => self.screener.as_ref(),
            Bundle::Board => Some(&self.board),
            Bundle::Flow => Some(&self.flow),
            Bundle::Shared | Bundle::UserData | Bundle::Login => None,
        };
        let account_slot = self.account.take(account).map_err(|_| Refusal::Busy)?;
        let bundle_slot = match pool {
            Some(pool) => Some(pool.take().map_err(|_| Refusal::Busy)?),
            None => None,
        };
        Ok(Held { _account: account_slot, _bundle: bundle_slot })
    }

    fn screener_runs(&self, account: &str, now: i64) -> Result<(), Refusal> {
        self.screener_account
            .with(account, MinuteWindow::default, |window| window.admit(self.screener_account_per_minute, now))
            .map_err(|retry_at| Refusal::Limited { retry_at })?;
        if self.screener_total_per_minute > 0 {
            locked(&self.screener_total).admit(self.screener_total_per_minute, now).map_err(|retry_at| Refusal::Limited { retry_at })?;
        }
        Ok(())
    }

    fn fresh_market(&self, key: &str, now: i64) -> Option<Response> {
        locked(&self.market_cache).get(key).filter(|c| now - c.at < self.market_cache_secs).map(Cached::response)
    }

    fn keep_market(&self, key: String, cached: Cached, now: i64) {
        let mut cache = locked(&self.market_cache);
        if cache.len() >= CACHE_ENTRIES {
            let ttl = self.market_cache_secs;
            cache.retain(|_, c| now - c.at < ttl);
        }
        if cache.len() < CACHE_ENTRIES {
            cache.insert(key, cached);
        }
    }

    fn fresh_status(&self, now: i64) -> Option<Response> {
        locked(&self.status_cache).as_ref().filter(|c| now - c.at < self.status_cache_secs).map(Cached::response)
    }
}

fn principal_key(request: &Request) -> Option<String> {
    request.extensions().get::<Principal>().map(|p| p.key.clone())
}

fn total_trs_sent(runtime: &Runtime) -> u64 {
    runtime.sends.load(std::sync::atomic::Ordering::Relaxed)
}

async fn cache_if_ok(response: Response) -> (Response, Option<Cached>) {
    let (parts, body) = response.into_parts();
    if parts.status != StatusCode::OK {
        return (Response::from_parts(parts, body), None);
    }
    match axum::body::to_bytes(body, CACHED_BODY_LIMIT).await {
        Ok(bytes) => {
            let cached = Cached { at: 0, content_type: parts.headers.get(header::CONTENT_TYPE).cloned(), body: bytes.clone() };
            (Response::from_parts(parts, Body::from(bytes)), Some(cached))
        }
        Err(_) => (errors::internal(), None),
    }
}

pub(super) async fn rankings(State(runtime): State<Arc<Runtime>>, request: Request, next: Next) -> Response {
    let now = runtime.clock.now().unix();
    let Some(account) = principal_key(&request) else { return errors::signed_out() };
    let held = match runtime.kiwoom.hold(Bundle::Rankings, &account) {
        Ok(held) => held,
        Err(refusal) => return refusal.into_response(now),
    };
    let (mut parts, body) = request.into_parts();
    let bytes = match axum::body::to_bytes(body, REQUEST_BODY_LIMIT).await {
        Ok(bytes) => bytes,
        Err(_) => return errors::too_large(),
    };
    let capped = cap_pages(&bytes, runtime.kiwoom.ranking_max_pages);
    parts.headers.remove(header::CONTENT_LENGTH);
    let before = total_trs_sent(&runtime);
    let response = next.run(Request::from_parts(parts, Body::from(capped))).await;
    runtime.usage.tr_calls(Bundle::Rankings, total_trs_sent(&runtime).saturating_sub(before));
    drop(held);
    response
}

fn cap_pages(body: &Bytes, max: u8) -> Bytes {
    let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(body) else { return body.clone() };
    let Some(pages) = value.get_mut("pages") else { return body.clone() };
    if pages.as_u64().is_some_and(|n| n > u64::from(max)) {
        *pages = serde_json::Value::from(max);
        return serde_json::to_vec(&value).map_or_else(|_| body.clone(), Bytes::from);
    }
    body.clone()
}

pub(super) async fn market_overview(State(runtime): State<Arc<Runtime>>, request: Request, next: Next) -> Response {
    if request.method() != Method::GET {
        return next.run(request).await;
    }
    let now = runtime.clock.now().unix();
    let key = request.uri().path_and_query().map_or_else(|| request.uri().path().to_owned(), |pq| pq.as_str().to_owned());
    if let Some(hit) = runtime.kiwoom.fresh_market(&key, now) {
        runtime.usage.market_cache_hit();
        return hit;
    }
    let Some(account) = principal_key(&request) else { return errors::signed_out() };
    let held = match runtime.kiwoom.hold(Bundle::MarketOverview, &account) {
        Ok(held) => held,
        Err(refusal) => return refusal.into_response(now),
    };
    let before = total_trs_sent(&runtime);
    let response = next.run(request).await;
    runtime.usage.tr_calls(Bundle::MarketOverview, total_trs_sent(&runtime).saturating_sub(before));
    drop(held);
    let (response, cached) = cache_if_ok(response).await;
    if let Some(cached) = cached {
        runtime.kiwoom.keep_market(key, Cached { at: runtime.clock.now().unix(), ..cached }, now);
    }
    response
}

pub(super) async fn screener_run(State(runtime): State<Arc<Runtime>>, request: Request, next: Next) -> Response {
    let now = runtime.clock.now().unix();
    let Some(account) = principal_key(&request) else { return errors::signed_out() };
    let held = match runtime.kiwoom.hold(Bundle::ScreenerRun, &account) {
        Ok(held) => held,
        Err(refusal) => return refusal.into_response(now),
    };
    if let Err(refusal) = runtime.kiwoom.screener_runs(&account, now) {
        return refusal.into_response(now);
    }
    let before = total_trs_sent(&runtime);
    let response = next.run(request).await;
    runtime.usage.tr_calls(Bundle::ScreenerRun, total_trs_sent(&runtime).saturating_sub(before));
    drop(held);
    response
}

pub(super) async fn screener_status(State(runtime): State<Arc<Runtime>>, request: Request, next: Next) -> Response {
    if request.method() != Method::GET {
        return next.run(request).await;
    }
    let now = runtime.clock.now().unix();
    if let Some(hit) = runtime.kiwoom.fresh_status(now) {
        runtime.usage.screener_status_cache_hit();
        return hit;
    }
    let response = next.run(request).await;
    let (response, cached) = cache_if_ok(response).await;
    if let Some(cached) = cached {
        *locked(&runtime.kiwoom.status_cache) = Some(Cached { at: now, ..cached });
    }
    response
}

pub(super) async fn screener(State(runtime): State<Arc<Runtime>>, request: Request, next: Next) -> Response {
    match (request.method().clone(), request.uri().path()) {
        (Method::POST, "/api/screener/run") => screener_run(State(runtime), request, next).await,
        (Method::GET, "/api/screener/status") => screener_status(State(runtime), request, next).await,
        _ => errors::not_found(),
    }
}

pub(super) async fn financial_reads(request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let listed = *request.method() == Method::GET && (path == "/api/financial-update" || (path.starts_with("/api/symbols/") && (path.ends_with("/financial-source") || path.ends_with("/financials"))));
    if listed { next.run(request).await } else { errors::not_found() }
}
