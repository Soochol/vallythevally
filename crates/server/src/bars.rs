//! 봉 메모리 캐시(backend.md §6.2~6.5, ADR 0003, D4, D14). (종목, 거래소, 봉 주기)마다 시리즈 하나다.
//!
//! 시리즈 하나 = 캐시 구간 하나. 오름차순 확정 봉이 빠짐없이 들어 있고, 양 끝으로만 늘어난다.
//! #2에는 실시간으로 만든 봉을 붙이는 쓰기가 없다. 그래서 키별 잠금을 키움 조회 동안에도 쥔다.
//! 같은 키의 요청은 이 잠금에서 줄을 서고, 앞 요청이 받은 결과를 메모리에서 바로 쓴다.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use domain::{ConfirmedBar, Feed, KstDate, KstTime, Period, SeriesKey, Venue};

use crate::clock::Clock;
use crate::kiwoom::api::{
    DailyChart, IndexDailyChart, IndexMinuteChart, IndexMonthlyChart, IndexWeeklyChart, MarketRequest, MinuteChart, MonthlyChart, WeeklyChart,
};
use crate::kiwoom::rest::{ContKey, KiwoomError, KiwoomRest, MergeScope, Priority};
use crate::kiwoom::wire::{ChartBody, ChartRows, KiwoomBar, parse_chart};
use crate::symbols::{NotReady, SymbolDirectory};

pub const DEFAULT_LIMIT: usize = 500;
pub const MAX_LIMIT: usize = 1000;
/// `next-key`는 15분 묵혀도 통했다(kiwoom.md §10.3). 그보다 오래되면 오늘부터 다시 따라간다.
/// 지수 분봉만 가진 가장 이른 봉의 날짜로 건너뛴다.
const CONT_FRESH_SECS: i64 = 15 * 60;
pub const IDLE_EVICT_SECS: i64 = 10 * 60;

/// 시리즈를 새로 만들 때마다 받는 번호. 내렸다가 다시 만들면 바뀐다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeriesId(u64);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BarError {
    BadRequest(String),
    UnknownSymbol,
    /// 종목 목록을 아직 못 받았거나 키움이 응답하지 않는다.
    Unavailable(String),
    AuthFailed { detail: Option<u16> },
    TokenWait(String),
    TokenFile(String),
    Internal(String),
}

impl fmt::Display for BarError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BarError::BadRequest(m) | BarError::Unavailable(m) | BarError::TokenWait(m) | BarError::TokenFile(m) | BarError::Internal(m) => f.write_str(m),
            BarError::UnknownSymbol => f.write_str("없는 종목입니다"),
            BarError::AuthFailed { detail } => f.write_str(&crate::kiwoom::auth::auth_failed_message(*detail)),
        }
    }
}

impl From<KiwoomError> for BarError {
    fn from(e: KiwoomError) -> Self {
        match e {
            KiwoomError::RateLimited | KiwoomError::Transport(_) => BarError::Unavailable(e.to_string()),
            KiwoomError::AuthFailed { detail } => BarError::AuthFailed { detail },
            KiwoomError::IssueTooSoon { .. } => BarError::TokenWait(e.to_string()),
            KiwoomError::TokenFile(_) => BarError::TokenFile(e.to_string()),
            KiwoomError::BadRequest { .. } | KiwoomError::Parse { .. } => BarError::Internal(e.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BarPage {
    /// 오름차순. `before`가 있으면 그보다 이른 것만.
    pub bars: Vec<ConfirmedBar>,
    /// 최신 페이지일 때만. 키움 최신 페이지의 진행 중 구간 봉(D3, D12).
    pub current: Option<KiwoomBar>,
    /// None이면 더 과거가 없다.
    pub next_before: Option<KstTime>,
}

struct Series {
    /// 최신 페이지와 일·주·월봉 조회가 쓰는 `base_dt`(오늘). 07:45에 시리즈를 모두 비우므로 하루 안에서 바뀌지 않는다.
    today: KstDate,
    bars: Vec<ConfirmedBar>,
    /// 키움이 연속조회를 끝냈다(`cont-yn: N`). 분봉은 여기가 1년 끝이다(kiwoom.md §2, U1).
    reached_origin: bool,
    /// 지금 가진 가장 이른 봉 바로 앞을 가리키는 연속조회.
    cont: Option<Cont>,
    /// 마지막 최신 페이지 조회가 준 진행 중 구간 봉. 캐시 구간에는 넣지 않는다.
    current: Option<KiwoomBar>,
}

#[derive(Clone)]
struct Cont {
    key: ContKey,
    /// 이 키를 낸 조회의 `base_dt`. 이어 받을 때도 같은 본문을 보낸다.
    base: KstDate,
    received_at: KstTime,
}

struct Slot {
    id: SeriesId,
    last_access: AtomicI64,
    /// 최신 페이지를 키움에서 받은 횟수. 잠금을 기다린 요청이 그사이 받은 결과를 다시 쓰는 데 쓴다.
    latest_fetches: AtomicU64,
    series: tokio::sync::Mutex<Series>,
}

pub struct BarService {
    rest: KiwoomRest,
    symbols: Arc<SymbolDirectory>,
    clock: Clock,
    slots: Mutex<HashMap<SeriesKey, Arc<Slot>>>,
    next_id: AtomicU64,
    /// 07:45 비우기마다 오른다. 키움 조회의 합치기 범위다.
    resets: AtomicU64,
}

struct Fetched {
    rows: Vec<KiwoomBar>,
    next: Option<ContKey>,
}

impl BarService {
    pub fn new(rest: KiwoomRest, symbols: Arc<SymbolDirectory>, clock: Clock) -> Self {
        BarService { rest, symbols, clock, slots: Mutex::new(HashMap::new()), next_id: AtomicU64::new(1), resets: AtomicU64::new(0) }
    }

    /// `before`가 None이면 최신 페이지다.
    pub async fn page(&self, key: SeriesKey, before: Option<KstTime>, limit: usize) -> Result<BarPage, BarError> {
        let dir = self.symbols.ready(&self.rest).await.map_err(|e| match e {
            NotReady::Kiwoom(e) => e.into(),
            NotReady::Timeout => BarError::Unavailable("종목 목록을 아직 받지 못했습니다".into()),
        })?;
        let Some(info) = dir.get(key.feed.symbol()) else {
            return Err(BarError::UnknownSymbol);
        };
        // 키움은 NXT 불가 종목의 `_NX`에 없는 코드와 같은 빈 행을 준다(kiwoom.md §12.4, §13). 보내기 전에 거른다.
        if key.feed.venue() == Some(Venue::Nxt) && !info.nxt_enabled {
            return Err(BarError::BadRequest(format!("NXT에서 거래되지 않는 종목입니다: {}({})", info.name, key.feed.symbol().as_wire())));
        }
        let slot = self.slot(key);
        let seen_latest = slot.latest_fetches.load(Ordering::SeqCst);
        let mut s = slot.series.lock().await;
        match before {
            None => {
                // 잠금을 기다리는 동안 다른 요청이 최신 페이지를 받았으면 그 결과를 같이 쓴다.
                if slot.latest_fetches.load(Ordering::SeqCst) == seen_latest {
                    self.refresh_latest(key, &mut s).await?;
                    slot.latest_fetches.fetch_add(1, Ordering::SeqCst);
                }
                while s.bars.len() < limit && !s.reached_origin {
                    self.extend_older(key, &mut s).await?;
                }
            }
            Some(before) => {
                while s.bars.partition_point(|b| b.bucket.start() < before) < limit && !s.reached_origin {
                    self.extend_older(key, &mut s).await?;
                }
            }
        }
        if !self.is_live(key, slot.id) {
            tracing::info!(symbol = %key.feed.symbol().as_wire(), venue = ?key.feed.venue(), period = key.period.as_wire(), "시리즈가 그사이 내려가 받은 봉을 메모리에 남기지 않습니다");
        }
        slot.last_access.store(self.clock.now().unix(), Ordering::SeqCst);
        Ok(build_page(&s, before, limit))
    }

    /// 07:45에 부른다. 진행 중인 조회의 응답은 내려간 시리즈에만 쓰이고 버려진다.
    /// 비운 뒤의 조회는 비우기 전 조회와 합쳐지지 않는다.
    pub fn clear_all(&self) {
        let n = {
            let mut slots = self.slots.lock().expect("slots 잠금");
            self.resets.fetch_add(1, Ordering::SeqCst);
            let n = slots.len();
            slots.clear();
            n
        };
        tracing::info!(count = n, "시세 캐시를 모두 비웠습니다");
    }

    /// 1분 타이머가 부른다. 10분 동안 요청이 없던 시리즈를 내린다. 조회 중인 시리즈는 남긴다.
    pub fn evict_idle(&self) {
        let now = self.clock.now().unix();
        self.slots.lock().expect("slots 잠금").retain(|_, slot| {
            now - slot.last_access.load(Ordering::SeqCst) < IDLE_EVICT_SECS || slot.series.try_lock().is_err()
        });
    }

    pub fn series_count(&self) -> usize {
        self.slots.lock().expect("slots 잠금").len()
    }

    /// 시리즈를 만드는 것은 요청뿐이다.
    fn slot(&self, key: SeriesKey) -> Arc<Slot> {
        let now = self.clock.now();
        let mut slots = self.slots.lock().expect("slots 잠금");
        let slot = slots.entry(key).or_insert_with(|| {
            Arc::new(Slot {
                id: SeriesId(self.next_id.fetch_add(1, Ordering::SeqCst)),
                last_access: AtomicI64::new(now.unix()),
                latest_fetches: AtomicU64::new(0),
                series: tokio::sync::Mutex::new(Series {
                    today: now.kst_date(),
                    bars: Vec::new(),
                    reached_origin: false,
                    cont: None,
                    current: None,
                }),
            })
        });
        slot.last_access.store(now.unix(), Ordering::SeqCst);
        slot.clone()
    }

    fn is_live(&self, key: SeriesKey, id: SeriesId) -> bool {
        self.slots.lock().expect("slots 잠금").get(&key).is_some_and(|s| s.id == id)
    }

    /// 키움 최신 페이지를 받아 앞으로 늘린다(D4). 이어지지 않으면 시리즈를 버리고 새로 만든다.
    async fn refresh_latest(&self, key: SeriesKey, s: &mut Series) -> Result<(), BarError> {
        let today = s.today;
        let page = self.fetch(key, today, None).await?;
        let (confirmed, current) = split_current(&page.rows, self.clock.now());
        s.current = current;
        let connects = match (confirmed.first(), s.bars.last()) {
            (Some(oldest_new), Some(newest_old)) => oldest_new.bucket.start() <= newest_old.bucket.start(),
            _ => false,
        };
        if !connects && !s.bars.is_empty() {
            tracing::info!(symbol = %key.feed.symbol().as_wire(), venue = ?key.feed.venue(), period = key.period.as_wire(), "최신 페이지가 메모리 구간과 이어지지 않아 시리즈를 새로 만듭니다");
            s.bars.clear();
            s.cont = None;
            s.reached_origin = false;
        }
        self.ingest(s, confirmed, page.next, today);
        Ok(())
    }

    /// 가장 이른 봉보다 과거를 적어도 한 페이지 더 받는다(§6.3 과거로 늘리기).
    async fn extend_older(&self, key: SeriesKey, s: &mut Series) -> Result<(), BarError> {
        let now = self.clock.now();
        if let Some(c) = s.cont.clone().filter(|c| now.unix() - c.received_at.unix() < CONT_FRESH_SECS) {
            let page = self.fetch(key, c.base, Some(&c.key)).await?;
            let below = match (page.rows.last(), s.bars.first()) {
                (Some(newest_new), Some(oldest_old)) => newest_new.bucket.start() < oldest_old.bucket.start(),
                (None, _) => true,
                (_, None) => false,
            };
            if below {
                let (confirmed, _) = split_current(&page.rows, now);
                self.ingest(s, confirmed, page.next, c.base);
                return Ok(());
            }
            tracing::info!(symbol = %key.feed.symbol().as_wire(), venue = ?key.feed.venue(), cont_age_secs = now.unix() - c.received_at.unix(), "연속조회 키가 기대한 위치를 주지 않아 다시 따라갑니다");
        }
        // 주식은 과거 base_dt로 가면 그날 뒤의 권리발생이 빠진 가격이 온다(kiwoom.md §4.1). 그래서 언제나 오늘부터
        // 따라간다(1분봉 1년이 191페이지, kiwoom.md §2). 지수에는 수정주가가 없어 그 봉의 날짜로 바로 간다.
        let start = match (key.feed, s.bars.first()) {
            (Feed::Index(_), Some(oldest)) if key.period.is_intraday() => oldest.bucket.start().kst_date(),
            _ => s.today,
        };
        self.follow_from(key, s, start).await
    }

    /// `base`부터 연속조회 체인을 따라 내려가며 받은 봉을 모두 덮어쓴다. 가진 구간 아래로 한 페이지 넘어가면 멈춘다.
    async fn follow_from(&self, key: SeriesKey, s: &mut Series, base: KstDate) -> Result<(), BarError> {
        let target = s.bars.first().map(|b| b.bucket.start());
        let mut cont: Option<ContKey> = None;
        loop {
            let page = self.fetch(key, base, cont.as_ref()).await?;
            let (confirmed, _) = split_current(&page.rows, self.clock.now());
            let reached = match (confirmed.first(), target) {
                (Some(oldest_new), Some(t)) => oldest_new.bucket.start() < t,
                _ => true,
            };
            cont = page.next.clone();
            self.ingest(s, confirmed, page.next, base);
            if reached || cont.is_none() {
                return Ok(());
            }
        }
    }

    /// 받은 확정 봉을 합친다. 같은 `t`는 키움 값이 덮는다.
    /// 이 페이지가 가진 구간의 가장 이른 봉까지 내려왔거나 키움이 연속조회를 끝냈을 때만 연속조회 키와 끝 여부를 바꾼다.
    /// `base`는 이 페이지를 받은 조회의 `base_dt`다.
    fn ingest(&self, s: &mut Series, confirmed: Vec<ConfirmedBar>, next: Option<ContKey>, base: KstDate) {
        let reaches_oldest = match (confirmed.first(), s.bars.first()) {
            (Some(new), Some(old)) => new.bucket.start() <= old.bucket.start(),
            (Some(_), None) => true,
            (None, _) => false,
        };
        s.bars = merge(std::mem::take(&mut s.bars), confirmed);
        if reaches_oldest || next.is_none() {
            s.reached_origin = next.is_none();
            s.cont = next.map(|key| Cont { key, base, received_at: self.clock.now() });
        }
    }

    async fn fetch(&self, key: SeriesKey, base: KstDate, cont: Option<&ContKey>) -> Result<Fetched, BarError> {
        const MINUTE: &str = "일·주·월봉이 아니면 분봉이다";
        let p = key.period;
        match key.feed {
            Feed::Stock(c, v) => match p {
                Period::Day => self.fetch_tr(&DailyChart::new(c, v, base), cont, p).await,
                Period::Week => self.fetch_tr(&WeeklyChart::new(c, v, base), cont, p).await,
                Period::Month => self.fetch_tr(&MonthlyChart::new(c, v, base), cont, p).await,
                _ => self.fetch_tr(&MinuteChart::new(c, v, p, base).expect(MINUTE), cont, p).await,
            },
            Feed::Index(c) => match p {
                Period::Day => self.fetch_tr(&IndexDailyChart::new(c, base), cont, p).await,
                Period::Week => self.fetch_tr(&IndexWeeklyChart::new(c, base), cont, p).await,
                Period::Month => self.fetch_tr(&IndexMonthlyChart::new(c, base), cont, p).await,
                _ => self.fetch_tr(&IndexMinuteChart::new(c, p, base).expect(MINUTE), cont, p).await,
            },
        }
    }

    async fn fetch_tr<R>(&self, req: &R, cont: Option<&ContKey>, period: Period) -> Result<Fetched, BarError>
    where
        R: MarketRequest,
        R::Response: ChartBody,
    {
        let scope = MergeScope(self.resets.load(Ordering::SeqCst));
        let page = self.rest.call(req, cont, Priority::Screen, scope).await?;
        match parse_chart(page.body, period) {
            Ok(ChartRows::Rows(rows)) => Ok(Fetched { rows, next: page.next }),
            Ok(ChartRows::UnknownSymbol) => Err(BarError::UnknownSymbol),
            Err(e) => {
                tracing::error!(api_id = R::API_ID.as_str(), error = %e, "키움 봉 응답을 읽지 못했습니다");
                Err(BarError::Internal(format!("키움 응답을 읽지 못했습니다: {e}")))
            }
        }
    }
}

/// 아직 확정되지 않은 구간(가장 늦은 행)은 현재 봉으로 떼어 낸다. 캐시에는 확정 봉만 들어간다.
fn split_current(rows: &[KiwoomBar], now: KstTime) -> (Vec<ConfirmedBar>, Option<KiwoomBar>) {
    let mut current = None;
    let mut confirmed = Vec::with_capacity(rows.len());
    for r in rows {
        if r.bucket.is_confirmed_at(now) {
            confirmed.push(ConfirmedBar::from_kiwoom(r.bucket, r.ohlcv));
        } else {
            current = Some(*r);
        }
    }
    (confirmed, current)
}

/// 두 오름차순 목록을 합친다. 같은 시작 시각이면 `new`가 이긴다.
fn merge(old: Vec<ConfirmedBar>, new: Vec<ConfirmedBar>) -> Vec<ConfirmedBar> {
    let mut all = new;
    all.extend(old);
    all.sort_by_key(|b| b.bucket.start());
    all.dedup_by_key(|b| b.bucket.start());
    all
}

fn build_page(s: &Series, before: Option<KstTime>, limit: usize) -> BarPage {
    let end = before.map_or(s.bars.len(), |b| s.bars.partition_point(|x| x.bucket.start() < b));
    let start = end.saturating_sub(limit);
    let bars = s.bars[start..end].to_vec();
    let more = start > 0 || !s.reached_origin;
    BarPage {
        next_before: bars.first().filter(|_| more).map(|b| b.bucket.start()),
        current: if before.is_none() { s.current } else { None },
        bars,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    use domain::{Market, Symbol, SymbolInfo, SymbolKind, TimeOfDay, Weekday};
    use serde_json::json;

    use super::*;
    use crate::clock::kst;
    use crate::config::Secret;
    use crate::kiwoom::api::ApiId;
    use crate::kiwoom::auth::KiwoomAuth;
    use crate::kiwoom::rest::testing::{FakeTransport, Sent, ok, token};
    use crate::symbols::Directory;

    fn date(y: i32, m: u8, d: u8) -> KstDate {
        KstDate::new(y, m, d).unwrap()
    }

    fn midnight(d: KstDate) -> KstTime {
        KstTime::from_kst_civil(d, TimeOfDay::MIDNIGHT)
    }

    /// 2026-11-09(월) 00:34 KST. 마지막 관측일은 11-06(금).
    fn monday_night() -> KstTime {
        kst(date(2026, 11, 9), 0, 34, 0)
    }

    /// 가짜 키움 차트 하나: 최신순 봉 시작 시각과 페이지 크기.
    struct FakeChart {
        ts: Vec<KstTime>,
        page: usize,
        intraday: bool,
        /// 이날 1:2 권리발생(주식만). 그 전 봉은 `base_dt`가 이날보다 이르면 수정 전 가격(2배)으로 온다(kiwoom.md §4).
        rights_on: Option<KstDate>,
    }

    impl FakeChart {
        fn dated(dts: Vec<KstDate>, page: usize) -> Self {
            FakeChart { ts: dts.into_iter().map(midnight).collect(), page, intraday: false, rights_on: None }
        }

        /// 1분봉. 평일 08:00~19:59(하루 720봉)를 11-06 19:59부터 거꾸로 n개. 페이지는 900봉(kiwoom.md §1).
        fn minutes(n: usize) -> Self {
            let mut ts = Vec::with_capacity(n);
            let mut d = date(2026, 11, 6);
            while ts.len() < n {
                if !matches!(d.weekday(), Weekday::Sat | Weekday::Sun) {
                    let close = kst(d, 19, 59, 0);
                    ts.extend((0..720).map(|i| close.plus_secs(-60 * i)).take(n - ts.len()));
                }
                d = d.add_days(-1);
            }
            FakeChart { ts, page: 900, intraday: true, rights_on: None }
        }

        fn daily(n: usize) -> Self {
            let mut d = date(2026, 11, 6);
            let mut dts = Vec::new();
            while dts.len() < n {
                if !matches!(d.weekday(), Weekday::Sat | Weekday::Sun) {
                    dts.push(d);
                }
                d = d.add_days(-1);
            }
            FakeChart::dated(dts, 600)
        }

        /// 주봉 dt는 그 주의 첫 관측일이다. 몇 주는 화요일로 둔다(kiwoom.md §10.8).
        fn weekly(n: usize) -> Self {
            let dts = (0..n).map(|i| date(2026, 11, 2).add_days(-7 * i as i64 + if i % 5 == 3 { 1 } else { 0 })).collect();
            FakeChart::dated(dts, 300)
        }

        /// 월봉 dt는 그 달의 첫 관측일이다. 2026-11은 02일.
        fn monthly(n: usize) -> Self {
            let mut d = date(2026, 11, 1);
            let mut dts = Vec::new();
            for _ in 0..n {
                let mut obs = d;
                while matches!(obs.weekday(), Weekday::Sat | Weekday::Sun) {
                    obs = obs.add_days(1);
                }
                dts.push(obs);
                d = d.first_of_prev_month();
            }
            FakeChart::dated(dts, 240)
        }

        /// 연속조회 키는 `P<행 번호>`다. 키가 없으면 `base_dt` 날짜의 마지막 봉부터 준다(kiwoom.md §1).
        fn respond(&self, s: &Sent, array: &str) -> Result<crate::kiwoom::transport::HttpResponse, crate::kiwoom::transport::TransportError> {
            let body: serde_json::Value = serde_json::from_str(&s.body).unwrap();
            let base = KstDate::parse_yyyymmdd(body["base_dt"].as_str().unwrap()).unwrap();
            let offset: usize = match s.cont.as_deref() {
                Some(k) => k.trim_start_matches('P').parse().unwrap(),
                None => self.ts.partition_point(|t| t.kst_date() > base),
            };
            let end = (offset + self.page).min(self.ts.len());
            let unadjusted_before = self.rights_on.filter(|&r| body.get("upd_stkpc_tp").is_some() && base < r);
            let rows: Vec<_> = self.ts[offset..end]
                .iter()
                .enumerate()
                .map(|(i, t)| {
                    let p = (1000 + (offset + i) as u64) * if unadjusted_before.is_some_and(|r| t.kst_date() < r) { 2 } else { 1 };
                    let mut row = json!({"open_pric": p.to_string(), "high_pric": (p + 5).to_string(),
                           "low_pric": (p - 5).to_string(), "cur_prc": format!("-{p}"), "trde_qty": "10", "upd_rt": ""});
                    if self.intraday {
                        let tod = t.kst_time_of_day().secs();
                        row["cntr_tm"] = format!("{}{:02}{:02}00", t.kst_date().yyyymmdd(), tod / 3600, tod / 60 % 60).into();
                    } else {
                        row["dt"] = t.kst_date().yyyymmdd().into();
                    }
                    row
                })
                .collect();
            let next = (end < self.ts.len()).then(|| format!("P{end}"));
            ok(json!({array: rows, "return_code": 0, "return_msg": "정상적으로 처리되었습니다"}), next.as_deref())
        }
    }

    fn array_of(api: ApiId) -> &'static str {
        match api {
            ApiId::Ka10081 => "stk_dt_pole_chart_qry",
            ApiId::Ka10082 => "stk_stk_pole_chart_qry",
            ApiId::Ka10083 => "stk_mth_pole_chart_qry",
            ApiId::Ka20006 => "inds_dt_pole_qry",
            ApiId::Ka20007 => "inds_stk_pole_qry",
            ApiId::Ka20008 => "inds_mth_pole_qry",
            ApiId::Ka10080 => "stk_min_pole_chart_qry",
            ApiId::Ka20005 => "inds_min_pole_qry",
            other => panic!("{other:?}"),
        }
    }

    struct Harness {
        fake: Arc<FakeTransport>,
        bars: Arc<BarService>,
        clock: Clock,
    }

    impl Harness {
        fn chart_calls(&self) -> Vec<Sent> {
            self.fake.market_sent()
        }
    }

    const SAMSUNG: &str = "005930";
    /// 삼성전자우. NXT에서 거래되지 않는다.
    const NOT_ON_NXT: &str = "005935";
    const EMPTY_ROW: &str = "999990";

    struct Charts {
        minute: FakeChart,
        day: FakeChart,
        week: FakeChart,
        month: FakeChart,
    }

    impl Default for Charts {
        fn default() -> Self {
            Charts { minute: FakeChart::minutes(3000), day: FakeChart::daily(2000), week: FakeChart::weekly(1000), month: FakeChart::monthly(800) }
        }
    }

    fn harness(now: KstTime, latency: Duration, charts: Charts) -> Harness {
        let tokens = AtomicUsize::new(0);
        let fake = Arc::new(FakeTransport::new(latency, move |s| {
            if s.api_id == ApiId::Au10001 {
                return token(tokens.fetch_add(1, Ordering::SeqCst) + 1);
            }
            if s.body.contains(EMPTY_ROW) {
                return ok(json!({array_of(s.api_id): [{"dt": "", "cntr_tm": "", "cur_prc": ""}], "return_code": 0}), None);
            }
            let chart = match s.api_id {
                ApiId::Ka10080 | ApiId::Ka20005 => &charts.minute,
                ApiId::Ka10081 | ApiId::Ka20006 => &charts.day,
                ApiId::Ka10082 | ApiId::Ka20007 => &charts.week,
                _ => &charts.month,
            };
            chart.respond(s, array_of(s.api_id))
        }));
        let clock = Clock::fake(now);
        let rest = KiwoomRest::new(Arc::new(fake.clone()), KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None), clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        let stock = |code: &str, nxt_enabled| SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: code.into(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled };
        symbols.replace(Directory::build(vec![stock(SAMSUNG, true), stock(NOT_ON_NXT, false), stock(EMPTY_ROW, true)]));
        Harness { fake, bars: Arc::new(BarService::new(rest, symbols, clock.clone())), clock }
    }

    fn std_harness(latency: Duration) -> Harness {
        harness(monday_night(), latency, Charts::default())
    }

    fn key(symbol: &str, period: Period) -> SeriesKey {
        SeriesKey { feed: Feed::new(Symbol::parse(symbol).unwrap(), None).unwrap(), period }
    }

    fn venue_key(symbol: &str, venue: Venue, period: Period) -> SeriesKey {
        SeriesKey { feed: Feed::new(Symbol::parse(symbol).unwrap(), Some(venue)).unwrap(), period }
    }

    fn assert_contiguous_asc(bars: &[ConfirmedBar]) {
        assert!(bars.windows(2).all(|w| w[0].bucket.start() < w[1].bucket.start()));
    }

    #[tokio::test(start_paused = true)]
    async fn latest_page_splits_current_from_confirmed_and_fills_to_limit() {
        let h = std_harness(Duration::from_millis(50));
        let d = h.bars.page(key(SAMSUNG, Period::Day), None, 500).await.unwrap();
        assert_eq!(d.bars.len(), 500);
        assert_eq!(d.bars.last().unwrap().bucket.start(), midnight(date(2026, 11, 6)), "11-06 일봉은 확정");
        assert_eq!(d.current, None);
        assert_eq!(h.chart_calls().len(), 1, "일봉은 1회");

        let w = h.bars.page(key(SAMSUNG, Period::Week), None, 500).await.unwrap();
        assert_eq!(w.bars.len(), 500);
        assert_eq!(w.bars.last().unwrap().bucket.start(), midnight(date(2026, 11, 2)), "11-02 주봉은 금요일 20:00 뒤라 확정");
        assert_eq!(w.current, None);
        assert!(w.bars.iter().all(|b| b.bucket.start().kst_date().weekday() == Weekday::Mon));
        assert_contiguous_asc(&w.bars);
        assert_eq!(h.chart_calls().len(), 1 + 2, "주봉은 2회");

        let m = h.bars.page(key(SAMSUNG, Period::Month), None, 500).await.unwrap();
        assert_eq!(m.bars.len(), 500);
        assert_eq!(m.current.unwrap().bucket.start(), midnight(date(2026, 11, 1)), "11월 월봉은 현재 봉");
        assert_eq!(m.bars.last().unwrap().bucket.start(), midnight(date(2026, 10, 1)));
        assert!(m.bars.iter().all(|b| b.bucket.start().kst_date().day() == 1));
        assert_eq!(h.chart_calls().len(), 1 + 2 + 3, "월봉은 3회");
        assert_eq!(m.next_before, Some(m.bars[0].bucket.start()));

        let body: serde_json::Value = serde_json::from_str(&h.chart_calls()[0].body).unwrap();
        assert_eq!(body, json!({"stk_cd": "005930_AL", "base_dt": "20261109", "upd_stkpc_tp": "1"}));
    }

    #[tokio::test(start_paused = true)]
    async fn index_uses_index_tr_and_keeps_centi() {
        let h = std_harness(Duration::ZERO);
        let w = h.bars.page(key("IDX:001", Period::Week), None, 100).await.unwrap();
        assert_eq!(w.bars.len(), 100);
        let sent = h.chart_calls();
        assert_eq!(sent[0].api_id, ApiId::Ka20007);
        assert_eq!(serde_json::from_str::<serde_json::Value>(&sent[0].body).unwrap(), json!({"inds_cd": "001", "base_dt": "20261109"}));
        assert_eq!(w.bars.last().unwrap().ohlcv.close().centi(), 1000, "지수는 100배 정수 그대로");
    }

    #[tokio::test(start_paused = true)]
    async fn older_pages_come_from_memory_then_from_the_continuation() {
        let h = std_harness(Duration::ZERO);
        let k = key(SAMSUNG, Period::Day);
        let latest = h.bars.page(k, None, 500).await.unwrap();
        let before = latest.next_before.unwrap();
        let older = h.bars.page(k, Some(before), 50).await.unwrap();
        assert_eq!(older.bars.len(), 50);
        assert!(older.bars.last().unwrap().bucket.start() < before);
        assert_eq!(older.current, None);
        assert_eq!(h.chart_calls().len(), 1, "메모리에 있으면 키움을 부르지 않는다");

        let older = h.bars.page(k, Some(before), 500).await.unwrap();
        assert_eq!(older.bars.len(), 500);
        let calls = h.chart_calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].cont.as_deref(), Some("P600"), "기억한 연속조회 키로 이어 받는다");
        let all = [older.bars.clone(), latest.bars.clone()].concat();
        assert_contiguous_asc(&all);
    }

    #[tokio::test(start_paused = true)]
    async fn stale_continuation_refollows_from_today() {
        let h = std_harness(Duration::ZERO);
        let k = key(SAMSUNG, Period::Day);
        let latest = h.bars.page(k, None, 600).await.unwrap();
        h.clock.jump(16 * 60);
        let older = h.bars.page(k, latest.next_before, 100).await.unwrap();
        assert_eq!(older.bars.len(), 100);
        let conts: Vec<_> = h.chart_calls().iter().map(|s| s.cont.clone()).collect();
        assert_eq!(conts, [None, None, Some("P600".to_string())]);
    }

    #[tokio::test(start_paused = true)]
    async fn next_before_is_null_at_the_origin() {
        let h = harness(monday_night(), Duration::ZERO, Charts { day: FakeChart::daily(700), week: FakeChart::weekly(10), ..Charts::default() });
        let k = key(SAMSUNG, Period::Day);
        let latest = h.bars.page(k, None, 500).await.unwrap();
        assert!(latest.next_before.is_some());
        let older = h.bars.page(k, latest.next_before, 500).await.unwrap();
        assert_eq!(older.bars.len(), 200);
        assert_eq!(older.next_before, None);
        assert_eq!(h.chart_calls().len(), 2);
        let again = h.bars.page(k, Some(older.bars[0].bucket.start()), 500).await.unwrap();
        assert!(again.bars.is_empty() && again.next_before.is_none());
        assert_eq!(h.chart_calls().len(), 2);

        let w = h.bars.page(key(SAMSUNG, Period::Week), None, 500).await.unwrap();
        assert_eq!((w.bars.len(), w.next_before), (10, None), "짧은 시리즈는 최신 페이지에서 끝난다");
    }

    #[tokio::test(start_paused = true)]
    async fn same_day_reopen_fetches_page_one_only() {
        let h = std_harness(Duration::ZERO);
        let k = key(SAMSUNG, Period::Week);
        h.bars.page(k, None, 500).await.unwrap();
        let again = h.bars.page(k, None, 500).await.unwrap();
        assert_eq!(again.bars.len(), 500);
        let calls = h.chart_calls();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[2].cont, None);
    }

    #[tokio::test(start_paused = true)]
    async fn concurrent_requests_for_one_key_share_one_kiwoom_call() {
        let h = std_harness(Duration::from_millis(400));
        let k = key(SAMSUNG, Period::Day);
        let (a, b, c) = tokio::join!(h.bars.page(k, None, 500), h.bars.page(k, None, 500), h.bars.page(k, None, 100));
        assert_eq!(a.as_ref().unwrap(), b.as_ref().unwrap());
        assert_eq!(c.unwrap().bars.len(), 100);
        assert_eq!(h.chart_calls().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_joined_request_with_a_bigger_limit_still_fills_its_limit() {
        let h = std_harness(Duration::from_millis(400));
        let k = key(SAMSUNG, Period::Week);
        let (small, big) = tokio::join!(h.bars.page(k, None, 100), h.bars.page(k, None, 500));
        assert_eq!((small.unwrap().bars.len(), big.unwrap().bars.len()), (100, 500));
        let conts: Vec<_> = h.chart_calls().into_iter().map(|s| s.cont).collect();
        assert_eq!(conts, [None, Some("P300".to_string())], "최신 페이지는 한 번만, 모자란 만큼만 이어 받는다");
    }

    #[tokio::test(start_paused = true)]
    async fn late_response_after_clear_all_does_not_revive_the_series() {
        let h = std_harness(Duration::from_secs(2));
        let k = key(SAMSUNG, Period::Day);
        let bars = h.bars.clone();
        let pending = tokio::spawn(async move { bars.page(k, None, 500).await });
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(h.bars.series_count(), 1);
        h.bars.clear_all();
        let page = pending.await.unwrap().unwrap();
        assert_eq!(page.bars.len(), 500, "요청한 브라우저에는 답한다");
        assert_eq!(h.bars.series_count(), 0, "응답이 시리즈를 새로 만들지 않는다");
        h.bars.page(k, None, 500).await.unwrap();
        assert_eq!(h.chart_calls().len(), 2, "비운 뒤에는 키움에서 다시 받는다");
    }

    #[tokio::test(start_paused = true)]
    async fn idle_series_are_evicted_after_ten_minutes() {
        let h = std_harness(Duration::ZERO);
        h.bars.page(key(SAMSUNG, Period::Day), None, 10).await.unwrap();
        h.clock.jump(9 * 60);
        h.bars.page(key(SAMSUNG, Period::Week), None, 10).await.unwrap();
        h.clock.jump(2 * 60);
        h.bars.evict_idle();
        assert_eq!(h.bars.series_count(), 1);
        h.clock.jump(9 * 60);
        h.bars.evict_idle();
        assert_eq!(h.bars.series_count(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn unknown_symbols_are_rejected() {
        let h = std_harness(Duration::ZERO);
        assert_eq!(h.bars.page(key("000660", Period::Day), None, 10).await, Err(BarError::UnknownSymbol));
        assert!(h.chart_calls().is_empty(), "목록에 없으면 키움을 부르지 않는다");
        assert_eq!(h.bars.page(key(EMPTY_ROW, Period::Day), None, 10).await, Err(BarError::UnknownSymbol));
        assert_eq!(h.bars.page(key(EMPTY_ROW, Period::M5), None, 10).await, Err(BarError::UnknownSymbol));
    }

    fn body(s: &Sent) -> serde_json::Value {
        serde_json::from_str(&s.body).unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn each_venue_is_its_own_series_with_its_own_code() {
        let h = std_harness(Duration::ZERO);
        for v in [Venue::Krx, Venue::Combined, Venue::Nxt] {
            h.bars.page(venue_key(SAMSUNG, v, Period::Day), None, 10).await.unwrap();
        }
        h.bars.page(venue_key(SAMSUNG, Venue::Krx, Period::Day), None, 10).await.unwrap();
        h.bars.page(venue_key(SAMSUNG, Venue::Krx, Period::M1), None, 10).await.unwrap();
        let sent: Vec<_> = h.chart_calls().iter().map(|s| (s.api_id, body(s)["stk_cd"].as_str().unwrap().to_owned())).collect();
        let want = [(ApiId::Ka10081, "005930"), (ApiId::Ka10081, "005930_AL"), (ApiId::Ka10081, "005930_NX"), (ApiId::Ka10081, "005930"), (ApiId::Ka10080, "005930")];
        assert_eq!(sent, want.map(|(a, c)| (a, c.to_owned())), "KRX를 받아도 통합은 따로 받는다");
        assert_eq!(h.bars.series_count(), 4);
    }

    #[tokio::test(start_paused = true)]
    async fn minute_latest_page_is_one_call_with_today_and_tic_scope() {
        let h = std_harness(Duration::ZERO);
        let p = h.bars.page(venue_key(SAMSUNG, Venue::Nxt, Period::M1), None, 500).await.unwrap();
        assert_eq!(p.bars.len(), 500);
        assert_eq!(p.bars.last().unwrap().bucket.start(), kst(date(2026, 11, 6), 19, 59, 0));
        assert_eq!(p.current, None, "금요일 봉은 모두 확정");
        assert_contiguous_asc(&p.bars);
        let calls = h.chart_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].api_id, ApiId::Ka10080);
        assert_eq!(body(&calls[0]), json!({"stk_cd": "005930_NX", "tic_scope": "1", "upd_stkpc_tp": "1", "base_dt": "20261109"}));
    }

    #[tokio::test(start_paused = true)]
    async fn index_minutes_use_ka20005() {
        let h = std_harness(Duration::ZERO);
        let p = h.bars.page(key("IDX:001", Period::M30), None, 100).await.unwrap();
        assert_eq!(p.bars.len(), 100);
        let calls = h.chart_calls();
        assert_eq!(calls[0].api_id, ApiId::Ka20005);
        assert_eq!(body(&calls[0]), json!({"inds_cd": "001", "tic_scope": "30", "base_dt": "20261109"}));
    }

    #[tokio::test(start_paused = true)]
    async fn minutes_end_where_kiwoom_ends_the_chain() {
        let h = harness(monday_night(), Duration::ZERO, Charts { minute: FakeChart::minutes(1500), ..Charts::default() });
        let k = venue_key(SAMSUNG, Venue::Combined, Period::M1);
        let latest = h.bars.page(k, None, 500).await.unwrap();
        assert!(latest.next_before.is_some());
        let older = h.bars.page(k, latest.next_before, 1000).await.unwrap();
        assert_eq!(older.bars.len(), 1000);
        assert_eq!(older.next_before, None, "cont-yn: N이 1년 끝이다");
        assert_eq!(h.chart_calls().len(), 2);
        let again = h.bars.page(k, Some(older.bars[0].bucket.start()), 500).await.unwrap();
        assert!(again.bars.is_empty() && again.next_before.is_none());
        assert_eq!(h.chart_calls().len(), 2);
    }

    /// 오래된 봉일수록 1원씩 비싸다(`FakeChart::respond`). 기준이 하나면 이웃한 두 봉의 종가 차이는 언제나 1원이다.
    fn assert_one_basis(bars: &[ConfirmedBar]) {
        let bad: Vec<_> = bars.windows(2).filter(|w| w[0].ohlcv.close().centi() != w[1].ohlcv.close().centi() + 100).map(|w| (w[1].bucket.start(), w[0].ohlcv.close().centi(), w[1].ohlcv.close().centi())).collect();
        assert!(bad.is_empty(), "수정주가 기준이 섞였다: {:?}", &bad[..bad.len().min(3)]);
    }

    #[tokio::test(start_paused = true)]
    async fn stale_stock_minute_continuation_keeps_todays_adjustment_basis() {
        let minute = FakeChart { rights_on: Some(date(2026, 11, 6)), ..FakeChart::minutes(3000) };
        let h = harness(monday_night(), Duration::ZERO, Charts { minute, ..Charts::default() });
        let k = venue_key(SAMSUNG, Venue::Nxt, Period::M1);
        // 첫 페이지 900봉에는 권리발생 전날(11-05) 봉이 들어 있다.
        let latest = h.bars.page(k, None, 900).await.unwrap();
        h.clock.jump(16 * 60);
        let older = h.bars.page(k, latest.next_before, 1000).await.unwrap();
        assert_eq!(older.bars.len(), 1000);
        let cached = h.bars.page(k, Some(latest.bars.last().unwrap().bucket.start().plus_secs(1)), 900).await.unwrap();
        assert_eq!(cached.bars.len(), latest.bars.len());
        let changed = cached.bars.iter().zip(&latest.bars).filter(|(a, b)| a != b).count();
        assert_eq!(changed, 0, "이미 보낸 봉의 가격이 바뀌지 않는다");
        let all = [older.bars.clone(), latest.bars.clone()].concat();
        assert_contiguous_asc(&all);
        assert_one_basis(&all);
        let calls = h.chart_calls();
        assert!(calls.iter().all(|c| body(c)["base_dt"] == "20261109"), "주식 분봉은 오늘 기준만 쓴다: {:?}", calls.iter().map(|c| body(c)["base_dt"].clone()).collect::<Vec<_>>());
        let conts: Vec<_> = calls.iter().map(|c| c.cont.clone()).collect();
        assert_eq!(conts, [None, None, Some("P900".to_string()), Some("P1800".to_string())], "묵은 키는 오늘부터 다시 따라간다");
    }

    #[tokio::test(start_paused = true)]
    async fn stale_index_minute_continuation_jumps_to_the_oldest_date() {
        let h = std_harness(Duration::ZERO);
        let k = key("IDX:001", Period::M1);
        let latest = h.bars.page(k, None, 500).await.unwrap();
        h.clock.jump(16 * 60);
        // 첫 페이지 900봉의 가장 이른 봉은 11-05 17:00이다(11-06 720봉 + 11-05 180봉).
        let older = h.bars.page(k, latest.next_before, 1000).await.unwrap();
        assert_eq!(older.bars.len(), 1000);
        let calls = h.chart_calls();
        assert_eq!(calls.len(), 2, "지수는 묵은 키에서 한 번 건너뛰어 받는다");
        assert_eq!((calls[1].cont.as_deref(), body(&calls[1])["base_dt"].as_str()), (None, Some("20261105")));
        let all = [older.bars.clone(), latest.bars.clone()].concat();
        assert_contiguous_asc(&all);
        assert!(all.windows(2).all(|w| w[1].bucket.start().unix() - w[0].bucket.start().unix() == 60 || w[1].bucket.start().kst_date() != w[0].bucket.start().kst_date()), "겹친 날에 구멍이 없다");
        assert_eq!(older.next_before, Some(older.bars[0].bucket.start()));

        // 건너뛴 조회가 준 키로 이어 받는다. 본문도 그 조회와 같다.
        h.bars.page(k, older.next_before, 1000).await.unwrap();
        let calls = h.chart_calls();
        assert_eq!(calls.len(), 3);
        assert_eq!((calls[2].cont.as_deref(), body(&calls[2])["base_dt"].as_str()), (Some("P1620"), Some("20261105")));
    }

    #[tokio::test(start_paused = true)]
    async fn nxt_is_rejected_before_kiwoom_for_symbols_not_on_nxt() {
        let h = std_harness(Duration::ZERO);
        let r = h.bars.page(venue_key(NOT_ON_NXT, Venue::Nxt, Period::Day), None, 10).await;
        assert!(matches!(&r, Err(BarError::BadRequest(m)) if m.contains("NXT에서 거래되지 않는 종목입니다")), "{r:?}");
        assert!(h.chart_calls().is_empty(), "키움을 부르지 않는다");
        assert_eq!(h.bars.series_count(), 0, "시리즈도 만들지 않는다");
        h.bars.page(venue_key(NOT_ON_NXT, Venue::Krx, Period::Day), None, 10).await.unwrap();
        assert_eq!(h.chart_calls().len(), 1, "KRX는 받는다");
    }

    #[tokio::test(start_paused = true)]
    async fn kiwoom_overwrites_same_t_and_merge_keeps_order() {
        let b = |d: u8, close: u64| {
            let p = |v| domain::Price::from_centi(v).unwrap();
            ConfirmedBar::from_kiwoom(
                Period::Day.bucket(midnight(date(2026, 11, d))),
                domain::Ohlcv::try_new(p(close), p(close), p(close), p(close), domain::Volume(1)).unwrap(),
            )
        };
        let merged = merge(vec![b(3, 1), b(4, 1), b(5, 1)], vec![b(5, 9), b(6, 9)]);
        let closes: Vec<_> = merged.iter().map(|x| x.ohlcv.close().centi()).collect();
        assert_eq!(closes, [1, 1, 9, 9]);
        assert_contiguous_asc(&merged);
    }
}
