mod catalog;

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

use axum::extract::{Path, Query, State};
use axum::response::Json;
use axum::routing::get;
use axum::{Extension, Router};
use domain::{KstTime, Symbol, Venue};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api::{SymbolCode, UnixSeconds};
use crate::bars::BarError;
use crate::http::{ApiFailure, AppState, Lookup, venue_param};
use crate::kiwoom::api::{MarketRequest, THEME_PERIOD_DAYS, ThemeGroups, ThemeMembers};
use crate::kiwoom::rest::{ContKey, KiwoomRest, MergeScope, Priority};
use crate::kiwoom::wire::{LimitMove, ThemeGroupsResponse, ThemeMembersResponse};

pub use catalog::{CATALOG_AT, CatalogStore, StoredCatalog, StoredTheme, collect, members_of, start_collection};

pub const FRESH_SECS: i64 = 45;
pub const MAX_PAGES: usize = 20;
const DEFAULT_PERIOD_DAYS: u8 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KiwoomTheme {
    pub code: String,
    pub name: String,
    #[ts(type = "number")]
    pub stock_count: u64,
    pub change_rate: f64,
    pub period_return: f64,
    #[ts(type = "number")]
    pub rising: u64,
    #[ts(type = "number")]
    pub falling: u64,
    pub leaders: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KiwoomThemeList {
    pub period_days: u8,
    pub fetched_at: UnixSeconds,
    pub themes: Vec<KiwoomTheme>,
    pub pages: u32,
    pub complete: bool,
    pub skipped: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum KiwoomLimitMove {
    Upper,
    Lower,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KiwoomThemeMember {
    pub symbol: SymbolCode,
    pub name: String,
    #[ts(type = "number")]
    pub price: u64,
    pub change_rate: f64,
    #[ts(type = "number")]
    pub volume: u64,
    pub period_return: Option<f64>,
    pub limit: Option<KiwoomLimitMove>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KiwoomThemeMembers {
    pub code: String,
    pub period_days: u8,
    pub fetched_at: UnixSeconds,
    pub change_rate: Option<f64>,
    pub period_return: Option<f64>,
    pub members: Vec<KiwoomThemeMember>,
    pub pages: u32,
    pub complete: bool,
    pub skipped: u32,
}

pub(crate) struct Walked<T> {
    bodies: Vec<T>,
    complete: bool,
}

#[derive(Debug)]
pub enum WalkFailure {
    Kiwoom(crate::kiwoom::rest::KiwoomError),
    KeyRepeated,
    KeyMissing,
}

async fn walk<R: MarketRequest>(rest: &KiwoomRest, request: &R, priority: Priority) -> Result<Walked<R::Response>, WalkFailure> {
    let mut bodies = Vec::new();
    let mut used: Vec<ContKey> = Vec::new();
    let mut cont: Option<ContKey> = None;
    while bodies.len() < MAX_PAGES {
        let page = rest.call(request, cont.as_ref(), priority, MergeScope::default()).await.map_err(WalkFailure::Kiwoom)?;
        bodies.push(page.body);
        match page.next {
            Some(next) if used.contains(&next) => return Err(WalkFailure::KeyRepeated),
            Some(next) => {
                used.push(next.clone());
                cont = Some(next);
            }
            None if page.continues_without_key => return Err(WalkFailure::KeyMissing),
            None => return Ok(Walked { bodies, complete: true }),
        }
    }
    Ok(Walked { bodies, complete: false })
}

fn walk_failure(e: WalkFailure, st: &AppState) -> ApiFailure {
    match e {
        WalkFailure::Kiwoom(e) => Lookup::KiwoomThemes.failure(BarError::from(e), st.clock.now()),
        WalkFailure::KeyRepeated => ApiFailure::kiwoom_protocol("키움 테마의 연속조회 키가 되풀이돼 끝까지 받지 못했습니다"),
        WalkFailure::KeyMissing => ApiFailure::kiwoom_protocol("키움 테마가 다음 페이지가 있다고 하면서 연속조회 키를 주지 않았습니다"),
    }
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn period_param(q: &HashMap<String, String>) -> Result<u8, ApiFailure> {
    match q.get("days") {
        None => Ok(DEFAULT_PERIOD_DAYS),
        Some(raw) => raw.parse::<u8>().ok().filter(|d| THEME_PERIOD_DAYS.contains(d)).ok_or_else(|| ApiFailure::bad_request(format!("days는 {}~{}이어야 합니다: {raw}", THEME_PERIOD_DAYS.start(), THEME_PERIOD_DAYS.end()))),
    }
}

fn limit_of(limit: Option<LimitMove>) -> Option<KiwoomLimitMove> {
    limit.map(|l| match l {
        LimitMove::Upper => KiwoomLimitMove::Upper,
        LimitMove::Lower => KiwoomLimitMove::Lower,
    })
}

type Fresh<T> = Mutex<HashMap<(String, u8, Venue), (KstTime, Arc<T>)>>;

#[derive(Default)]
pub struct ThemeCache {
    lists: Fresh<KiwoomThemeList>,
    members: Fresh<KiwoomThemeMembers>,
}

fn fresh<T>(map: &Fresh<T>, key: &(String, u8, Venue), now: KstTime) -> Option<Arc<T>> {
    let map = map.lock().expect("키움 테마 캐시 잠금");
    map.get(key).filter(|(at, _)| at.kst_date() == now.kst_date() && now.unix() - at.unix() < FRESH_SECS).map(|(_, value)| value.clone())
}

fn keep<T>(map: &Fresh<T>, key: (String, u8, Venue), now: KstTime, value: Arc<T>) {
    let mut map = map.lock().expect("키움 테마 캐시 잠금");
    map.retain(|_, (at, _)| at.kst_date() == now.kst_date());
    map.insert(key, (now, value));
}

fn log_walk(api_id: &str, pages: usize, rows: usize, skipped: u32, complete: bool, unknown: &BTreeSet<String>) {
    tracing::info!(api_id, pages, rows, skipped, complete, unknown_fields = ?unknown, "키움 테마 응답을 받았습니다");
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/kiwoom-themes", get(list))
        .route("/api/kiwoom-themes/{code}", get(members))
        .layer(Extension(Arc::new(ThemeCache::default())))
}

async fn list(State(st): State<Arc<AppState>>, Extension(cache): Extension<Arc<ThemeCache>>, Query(q): Query<HashMap<String, String>>) -> Result<Json<KiwoomThemeList>, ApiFailure> {
    let days = period_param(&q)?;
    let venue = venue_param(&q)?.unwrap_or(Venue::Combined);
    let now = st.clock.now();
    let key = (String::new(), days, venue);
    if let Some(hit) = fresh(&cache.lists, &key, now) {
        return Ok(Json((*hit).clone()));
    }
    let request = ThemeGroups::by_change_rate(days, venue).expect("days는 범위 안이다");
    let walked = walk(&st.rest, &request, Priority::Screen).await.map_err(|e| walk_failure(e, &st))?;
    let unknown = walked.bodies.iter().flat_map(ThemeGroupsResponse::unknown_fields).collect();
    let mut seen = BTreeSet::new();
    let (mut themes, mut skipped) = (Vec::new(), 0);
    for body in &walked.bodies {
        let parsed = body.rows();
        skipped += parsed.skipped;
        for row in parsed.rows {
            if seen.insert(row.code.clone()) {
                themes.push(KiwoomTheme { code: row.code, name: row.name, stock_count: row.stock_count, change_rate: row.change_rate, period_return: row.period_return, rising: row.rising, falling: row.falling, leaders: row.leaders });
            }
        }
    }
    log_walk("ka90001", walked.bodies.len(), themes.len(), skipped, walked.complete, &unknown);
    let value = Arc::new(KiwoomThemeList { period_days: days, fetched_at: UnixSeconds(now.unix()), themes, pages: count(walked.bodies.len()), complete: walked.complete, skipped });
    keep(&cache.lists, key, now, value.clone());
    Ok(Json((*value).clone()))
}

async fn members(State(st): State<Arc<AppState>>, Extension(cache): Extension<Arc<ThemeCache>>, Path(code): Path<String>, Query(q): Query<HashMap<String, String>>) -> Result<Json<KiwoomThemeMembers>, ApiFailure> {
    let days = period_param(&q)?;
    let venue = venue_param(&q)?.unwrap_or(Venue::Combined);
    let request = ThemeMembers::new(&code, days, venue).ok_or_else(|| ApiFailure::bad_request(format!("테마코드는 영문·숫자 1~6자여야 합니다: {code}")))?;
    let code = code.trim().to_owned();
    let now = st.clock.now();
    let key = (code.clone(), days, venue);
    if let Some(hit) = fresh(&cache.members, &key, now) {
        return Ok(Json((*hit).clone()));
    }
    let walked = walk(&st.rest, &request, Priority::Screen).await.map_err(|e| walk_failure(e, &st))?;
    let unknown = walked.bodies.iter().flat_map(ThemeMembersResponse::unknown_fields).collect();
    let mut seen = BTreeSet::new();
    let (mut list, mut skipped) = (Vec::new(), 0);
    for body in &walked.bodies {
        let parsed = body.rows();
        skipped += parsed.skipped;
        for row in parsed.rows {
            if seen.insert(row.code) {
                list.push(KiwoomThemeMember {
                    symbol: SymbolCode(Symbol::Stock(row.code).as_wire()),
                    name: row.name,
                    price: row.price_won,
                    change_rate: row.change_rate,
                    volume: row.volume,
                    period_return: row.period_return,
                    limit: limit_of(row.limit),
                });
            }
        }
    }
    log_walk("ka90002", walked.bodies.len(), list.len(), skipped, walked.complete, &unknown);
    let first = walked.bodies.first();
    let value = Arc::new(KiwoomThemeMembers {
        code: code.clone(),
        period_days: days,
        fetched_at: UnixSeconds(now.unix()),
        change_rate: first.and_then(ThemeMembersResponse::theme_change_rate),
        period_return: first.and_then(ThemeMembersResponse::theme_period_return),
        members: list,
        pages: count(walked.bodies.len()),
        complete: walked.complete,
        skipped,
    });
    keep(&cache.members, key, now, value.clone());
    Ok(Json((*value).clone()))
}
