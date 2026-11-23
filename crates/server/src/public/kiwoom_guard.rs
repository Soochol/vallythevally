
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::{Body, Bytes};
use axum::extract::{Extension, Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Json, Response};
use tokio::sync::OwnedSemaphorePermit;

use std::collections::HashSet;

use axum::extract::Query;
use futures::future::BoxFuture;
use domain::{KstTime, Symbol};

use super::limits::{AccountSlots, MinuteWindow, PerAccount, SendPacer, Slots, locked};
use super::settings::Limits;
use super::usage::Bundle;
use super::{Principal, Runtime, errors, user_data};
use crate::heatmap_board::{Busy, QuoteGate, Refused as BoardRefused};
use crate::heatmap_flow::{FlowGate, Freshness, same_kst_minute};
use crate::market_source::{GenerationScoped, GenerationTicket, SourceGeneration};

const CACHED_BODY_LIMIT: usize = 8 * 1024 * 1024;
const REQUEST_BODY_LIMIT: usize = 64 * 1024;
const CACHE_ENTRIES: usize = 256;
const BUSY_RETRY_SECS: i64 = 2;
const BOARD_WINDOW_SECS: i64 = 45;
const FLOW_WINDOW_SECS: i64 = 60;
const KIWOOM_SEND_WINDOW: std::time::Duration = std::time::Duration::from_millis(1050);

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
    board_tr_per_window: u32,
    board_trs: Mutex<MinuteWindow>,
    flow_tr_per_minute: u32,
    flow_account_tr_per_minute: u32,
    flow_fetch_concurrency: usize,
    flow_trs: Mutex<MinuteWindow>,
    flow_account_trs: PerAccount<MinuteWindow>,
    board_pacer: SendPacer,
    flow_pacer: SendPacer,
    market_cache: GenerationScoped<HashMap<String, Cached>>,
    status_cache: Mutex<Option<Cached>>,
}

impl KiwoomGuard {
    pub fn new(limits: &Limits, generation: SourceGeneration) -> Self {
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
            board_tr_per_window: limits.board_tr_per_window,
            board_trs: Mutex::new(MinuteWindow::default()),
            flow_tr_per_minute: limits.flow_tr_per_minute,
            flow_account_tr_per_minute: limits.flow_account_tr_per_minute,
            flow_fetch_concurrency: limits.flow_fetch_concurrency,
            flow_trs: Mutex::new(MinuteWindow::default()),
            flow_account_trs: PerAccount::default(),
            board_pacer: SendPacer::new(KIWOOM_SEND_WINDOW, limits.kiwoom_sends_per_window),
            flow_pacer: SendPacer::new(KIWOOM_SEND_WINDOW, limits.kiwoom_sends_per_window),
            market_cache: GenerationScoped::new(generation),
            status_cache: Mutex::new(None),
        }
    }

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

    async fn take_board_tr(&self, now: i64) -> bool {
        if locked(&self.board_trs).admit_within(BOARD_WINDOW_SECS, self.board_tr_per_window, now).is_err() {
            return false;
        }
        self.board_pacer.pass().await;
        true
    }

    async fn take_flow_tr(&self, account: &str, now: i64) -> bool {
        let granted = {
            let mut total = locked(&self.flow_trs);
            self.flow_account_trs.with(account, MinuteWindow::default, |mine| {
                if total.has_room(FLOW_WINDOW_SECS, self.flow_tr_per_minute, now).is_err() || mine.has_room(FLOW_WINDOW_SECS, self.flow_account_tr_per_minute, now).is_err() {
                    return false;
                }
                total.record(now);
                mine.record(now);
                true
            })
        };
        if !granted {
            return false;
        }
        self.flow_pacer.pass().await;
        true
    }

    fn market_ticket(&self) -> GenerationTicket {
        self.market_cache.ticket()
    }

    fn fresh_market(&self, key: &str, now: i64) -> Option<Response> {
        self.market_cache.read(|cache| cache.get(key).filter(|c| now - c.at < self.market_cache_secs).map(Cached::response))
    }

    fn keep_market(&self, started: GenerationTicket, key: String, cached: Cached, now: i64) {
        self.market_cache.keep(started, |cache| {
            if cache.len() >= CACHE_ENTRIES {
                let ttl = self.market_cache_secs;
                cache.retain(|_, c| now - c.at < ttl);
            }
            if cache.len() < CACHE_ENTRIES {
                cache.insert(key, cached);
            }
        });
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

fn cache_key(uri: &axum::http::Uri) -> String {
    let mut pairs: Vec<&str> = uri.query().map(|q| q.split('&').collect()).unwrap_or_default();
    pairs.sort_unstable();
    format!("{}?{}", uri.path(), pairs.join("&"))
}

fn scrub_failed_cards(value: &mut serde_json::Value, retry_at: i64) -> bool {
    match value {
        serde_json::Value::Object(object) => {
            let mut scrubbed = false;
            if object.get("status").and_then(|s| s.as_str()) == Some("failed")
                && let Some(serde_json::Value::Object(error)) = object.get_mut("error")
            {
                error.insert("message".into(), errors::KIWOOM_FIXED.into());
                error.insert("manualActionRequired".into(), false.into());
                error.insert("reason".into(), serde_json::Value::Null);
                error.insert("retryAt".into(), retry_at.into());
                scrubbed = true;
            }
            let mut deeper = false;
            for child in object.values_mut() {
                deeper |= scrub_failed_cards(child, retry_at);
            }
            scrubbed || deeper
        }
        serde_json::Value::Array(items) => {
            let mut scrubbed = false;
            for child in items {
                scrubbed |= scrub_failed_cards(child, retry_at);
            }
            scrubbed
        }
        _ => false,
    }
}

async fn cache_if_ok(response: Response, scrub_at: Option<i64>) -> (Response, Option<Cached>) {
    let (mut parts, body) = response.into_parts();
    if parts.status != StatusCode::OK {
        return (Response::from_parts(parts, body), None);
    }
    match axum::body::to_bytes(body, CACHED_BODY_LIMIT).await {
        Ok(bytes) => {
            if let Some(now) = scrub_at
                && let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&bytes)
                && scrub_failed_cards(&mut value, now + errors::KIWOOM_RETRY_SECS)
                && let Ok(scrubbed) = serde_json::to_vec(&value)
            {
                parts.headers.remove(header::CONTENT_LENGTH);
                return (Response::from_parts(parts, Body::from(scrubbed)), None);
            }
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
    let key = cache_key(request.uri());
    let started = runtime.kiwoom.market_ticket();
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
    let (response, cached) = cache_if_ok(response, Some(now)).await;
    if let Some(cached) = cached {
        runtime.kiwoom.keep_market(started, key, Cached { at: runtime.clock.now().unix(), ..cached }, now);
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
    let (response, cached) = cache_if_ok(response, None).await;
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

struct BoardGate<'a> {
    runtime: &'a Runtime,
    account: &'a str,
}

impl QuoteGate for BoardGate<'_> {
    fn begin(&self) -> Result<Box<dyn Send>, Busy> {
        self.runtime.kiwoom.hold(Bundle::Board, self.account).map(|held| Box::new(held) as Box<dyn Send>).map_err(|_| Busy)
    }

    fn grant_tr(&self) -> BoxFuture<'_, bool> {
        Box::pin(self.runtime.kiwoom.take_board_tr(self.runtime.clock.now().unix()))
    }
}

struct FlowAdmission<'a> {
    runtime: &'a Runtime,
    account: &'a str,
}

impl Freshness for FlowAdmission<'_> {
    fn is_fresh(&self, fetched_at: KstTime, now: KstTime) -> bool {
        same_kst_minute(fetched_at, now)
    }

    fn grant_tr(&self) -> BoxFuture<'_, bool> {
        Box::pin(self.runtime.kiwoom.take_flow_tr(self.account, self.runtime.clock.now().unix()))
    }
}

impl FlowGate for FlowAdmission<'_> {
    fn begin(&self) -> Result<Box<dyn Send>, Busy> {
        self.runtime.kiwoom.hold(Bundle::Flow, self.account).map(|held| Box::new(held) as Box<dyn Send>).map_err(|_| Busy)
    }

    fn fetch_concurrency(&self) -> usize {
        self.runtime.kiwoom.flow_fetch_concurrency
    }
}

pub(super) async fn heatmap_board(State(runtime): State<Arc<Runtime>>, Extension(who): Extension<Principal>, Query(query): Query<HashMap<String, String>>) -> Response {
    let now = runtime.clock.now().unix();
    let themes = match user_data::heatmap_themes_of(&runtime, &who.account_id).await {
        Ok(themes) => themes,
        Err(failure) => return failure.into_response(),
    };
    let gate = BoardGate { runtime: &runtime, account: &who.key };
    match crate::heatmap_board::board_within(&runtime.state, &runtime.state.heatmap_quotes, &query, themes, &gate).await {
        Ok((board, tally)) => {
            runtime.usage.symbols(Bundle::Board, tally.cached, tally.fetched, tally.over_budget, 0);
            Json(board).into_response()
        }
        Err(BoardRefused::Busy) => errors::busy(now, BUSY_RETRY_SECS),
        Err(BoardRefused::Failed(failure)) => failure.into_response(),
    }
}

pub(super) async fn heatmap_flow(State(runtime): State<Arc<Runtime>>, Extension(who): Extension<Principal>, Query(query): Query<HashMap<String, String>>) -> Response {
    let now = runtime.clock.now().unix();
    let themes = match user_data::heatmap_themes_of(&runtime, &who.account_id).await {
        Ok(themes) => themes,
        Err(failure) => return failure.into_response(),
    };
    let allowed: HashSet<Symbol> = themes.themes.iter().flat_map(|theme| &theme.symbols).filter_map(|code| Symbol::parse(&code.0).ok()).collect();
    let gate = FlowAdmission { runtime: &runtime, account: &who.key };
    match crate::heatmap_flow::flow_within(&runtime.state, &runtime.state.heatmap_flow, &query, &allowed, &gate).await {
        Ok((series, tally)) => {
            runtime.usage.symbols(Bundle::Flow, tally.cached, tally.fetched, tally.over_budget, tally.rejected);
            Json(series).into_response()
        }
        Err(BoardRefused::Busy) => errors::busy(now, BUSY_RETRY_SECS),
        Err(BoardRefused::Failed(failure)) => failure.into_response(),
    }
}
