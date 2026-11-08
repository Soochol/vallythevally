//! 일·주·월봉 메모리 캐시(backend.md §6.2~6.5, ADR 0003, D4, D14).
//!
//! 시리즈 하나 = 캐시 구간 하나. 오름차순 확정 봉이 빠짐없이 들어 있고, 양 끝으로만 늘어난다.
//! #2에는 실시간으로 만든 봉을 붙이는 쓰기가 없다. 그래서 키별 잠금을 키움 조회 동안에도 쥔다.
//! 같은 키의 요청은 이 잠금에서 줄을 서고, 앞 요청이 받은 결과를 메모리에서 바로 쓴다.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use domain::{ConfirmedBar, KstDate, KstTime, Period, SeriesKey, Symbol};

use crate::clock::Clock;
use crate::kiwoom::api::{DailyChart, IndexDailyChart, IndexMonthlyChart, IndexWeeklyChart, MarketRequest, MonthlyChart, WeeklyChart};
use crate::kiwoom::rest::{ContKey, KiwoomError, KiwoomRest, Priority};
use crate::kiwoom::wire::{ChartBody, ChartRows, KiwoomBar, parse_chart};
use crate::symbols::SymbolDirectory;

pub const DEFAULT_LIMIT: usize = 500;
pub const MAX_LIMIT: usize = 1000;
/// `next-key`는 15분 묵혀도 통했다(kiwoom.md §10.3). 그보다 오래되면 오늘부터 다시 따라간다.
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
    AuthFailed,
    Internal(String),
}

impl fmt::Display for BarError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BarError::BadRequest(m) | BarError::Unavailable(m) | BarError::Internal(m) => f.write_str(m),
            BarError::UnknownSymbol => f.write_str("없는 종목입니다"),
            BarError::AuthFailed => f.write_str("키움 인증에 실패했습니다"),
        }
    }
}

impl From<KiwoomError> for BarError {
    fn from(e: KiwoomError) -> Self {
        match e {
            KiwoomError::RateLimited | KiwoomError::Transport(_) => BarError::Unavailable(e.to_string()),
            KiwoomError::AuthFailed { .. } => BarError::AuthFailed,
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
    /// 이 시리즈의 모든 조회가 쓰는 `base_dt`. 07:45에 시리즈를 모두 비우므로 하루 안에서 바뀌지 않는다.
    base_date: KstDate,
    bars: Vec<ConfirmedBar>,
    reached_origin: bool,
    /// 지금 가진 가장 이른 봉 바로 앞을 가리키는 연속조회 키와 받은 시각.
    cont: Option<(ContKey, KstTime)>,
    /// 마지막 최신 페이지 조회가 준 진행 중 구간 봉. 캐시 구간에는 넣지 않는다.
    current: Option<KiwoomBar>,
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
}

struct Fetched {
    rows: Vec<KiwoomBar>,
    next: Option<ContKey>,
}

impl BarService {
    pub fn new(rest: KiwoomRest, symbols: Arc<SymbolDirectory>, clock: Clock) -> Self {
        BarService { rest, symbols, clock, slots: Mutex::new(HashMap::new()), next_id: AtomicU64::new(1) }
    }

    /// `before`가 None이면 최신 페이지다.
    pub async fn page(&self, key: SeriesKey, before: Option<KstTime>, limit: usize) -> Result<BarPage, BarError> {
        if key.period.is_intraday() {
            return Err(BarError::BadRequest("분봉은 아직 열리지 않았습니다(#4에서 열립니다)".into()));
        }
        let dir = self.symbols.ready().await.map_err(|_| BarError::Unavailable("종목 목록을 아직 받지 못했습니다".into()))?;
        if dir.get(key.symbol).is_none() {
            return Err(BarError::UnknownSymbol);
        }
        let slot = self.slot(key);
        let seen_latest = slot.latest_fetches.load(Ordering::SeqCst);
        let mut s = slot.series.lock().await;
        match before {
            None if slot.latest_fetches.load(Ordering::SeqCst) != seen_latest => {}
            None => {
                self.refresh_latest(key, &mut s).await?;
                slot.latest_fetches.fetch_add(1, Ordering::SeqCst);
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
            tracing::info!(symbol = %key.symbol.as_wire(), period = key.period.as_wire(), "시리즈가 그사이 내려가 받은 봉을 메모리에 남기지 않습니다");
        }
        slot.last_access.store(self.clock.now().unix(), Ordering::SeqCst);
        Ok(build_page(&s, before, limit))
    }

    /// 07:45에 부른다. 진행 중인 조회의 응답은 내려간 시리즈에만 쓰이고 버려진다.
    pub fn clear_all(&self) {
        let n = {
            let mut slots = self.slots.lock().expect("slots 잠금");
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
                    base_date: now.kst_date(),
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
        let page = self.fetch(key, s.base_date, None).await?;
        let (confirmed, current) = split_current(&page.rows, self.clock.now());
        s.current = current;
        let connects = match (confirmed.first(), s.bars.last()) {
            (Some(oldest_new), Some(newest_old)) => oldest_new.bucket.start() <= newest_old.bucket.start(),
            _ => false,
        };
        if !connects && !s.bars.is_empty() {
            tracing::info!(symbol = %key.symbol.as_wire(), period = key.period.as_wire(), "최신 페이지가 메모리 구간과 이어지지 않아 시리즈를 새로 만듭니다");
            s.bars.clear();
            s.cont = None;
            s.reached_origin = false;
        }
        self.ingest(s, confirmed, page.next);
        Ok(())
    }

    /// 가장 이른 봉보다 과거를 적어도 한 페이지 더 받는다(§6.3 과거로 늘리기).
    async fn extend_older(&self, key: SeriesKey, s: &mut Series) -> Result<(), BarError> {
        let now = self.clock.now();
        if let Some((cont, at)) = s.cont.clone().filter(|(_, at)| now.unix() - at.unix() < CONT_FRESH_SECS) {
            let page = self.fetch(key, s.base_date, Some(&cont)).await?;
            let below = match (page.rows.last(), s.bars.first()) {
                (Some(newest_new), Some(oldest_old)) => newest_new.bucket.start() < oldest_old.bucket.start(),
                (None, _) => true,
                (_, None) => false,
            };
            if below {
                let (confirmed, _) = split_current(&page.rows, now);
                self.ingest(s, confirmed, page.next);
                return Ok(());
            }
            tracing::info!(symbol = %key.symbol.as_wire(), cont_age_secs = now.unix() - at.unix(), "연속조회 키가 기대한 위치를 주지 않아 오늘부터 다시 따라갑니다");
        }
        self.follow_from_today(key, s).await
    }

    /// 오늘부터 연속조회 체인을 따라 내려가며 받은 봉을 모두 덮어쓴다. 가진 구간 아래로 한 페이지 넘어가면 멈춘다.
    async fn follow_from_today(&self, key: SeriesKey, s: &mut Series) -> Result<(), BarError> {
        let target = s.bars.first().map(|b| b.bucket.start());
        let mut cont: Option<ContKey> = None;
        loop {
            let page = self.fetch(key, s.base_date, cont.as_ref()).await?;
            let (confirmed, _) = split_current(&page.rows, self.clock.now());
            let reached = match (confirmed.first(), target) {
                (Some(oldest_new), Some(t)) => oldest_new.bucket.start() < t,
                _ => true,
            };
            cont = page.next.clone();
            self.ingest(s, confirmed, page.next);
            if reached || cont.is_none() {
                return Ok(());
            }
        }
    }

    /// 받은 확정 봉을 합친다. 같은 `t`는 키움 값이 덮는다.
    /// 이 페이지가 가진 구간의 가장 이른 봉까지 내려왔을 때만 연속조회 키와 끝 여부를 바꾼다.
    fn ingest(&self, s: &mut Series, confirmed: Vec<ConfirmedBar>, next: Option<ContKey>) {
        let reaches_oldest = match (confirmed.first(), s.bars.first()) {
            (Some(new), Some(old)) => new.bucket.start() <= old.bucket.start(),
            (None, _) => next.is_none(),
            (Some(_), None) => true,
        };
        s.bars = merge(std::mem::take(&mut s.bars), confirmed);
        if reaches_oldest {
            s.reached_origin = next.is_none();
            s.cont = next.map(|k| (k, self.clock.now()));
        }
    }

    async fn fetch(&self, key: SeriesKey, base: KstDate, cont: Option<&ContKey>) -> Result<Fetched, BarError> {
        let p = key.period;
        match key.symbol {
            Symbol::Stock(c) => match p {
                Period::Day => self.fetch_tr(&DailyChart::new(c, base), cont, p).await,
                Period::Week => self.fetch_tr(&WeeklyChart::new(c, base), cont, p).await,
                Period::Month => self.fetch_tr(&MonthlyChart::new(c, base), cont, p).await,
                _ => Err(BarError::BadRequest("분봉은 아직 열리지 않았습니다(#4에서 열립니다)".into())),
            },
            Symbol::Index(c) => match p {
                Period::Day => self.fetch_tr(&IndexDailyChart::new(c, base), cont, p).await,
                Period::Week => self.fetch_tr(&IndexWeeklyChart::new(c, base), cont, p).await,
                Period::Month => self.fetch_tr(&IndexMonthlyChart::new(c, base), cont, p).await,
                _ => Err(BarError::BadRequest("분봉은 아직 열리지 않았습니다(#4에서 열립니다)".into())),
            },
        }
    }

    async fn fetch_tr<R>(&self, req: &R, cont: Option<&ContKey>, period: Period) -> Result<Fetched, BarError>
    where
        R: MarketRequest,
        R::Response: ChartBody,
    {
        let page = self.rest.call(req, cont, Priority::Screen).await?;
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

    use domain::{Market, SymbolInfo, SymbolKind, TimeOfDay, Weekday};
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

    /// 가짜 키움 차트 하나: 최신순 dt 목록과 페이지 크기.
    struct FakeChart {
        dts: Vec<KstDate>,
        page: usize,
    }

    impl FakeChart {
        fn daily(n: usize) -> Self {
            let mut d = date(2026, 11, 6);
            let mut dts = Vec::new();
            while dts.len() < n {
                if !matches!(d.weekday(), Weekday::Sat | Weekday::Sun) {
                    dts.push(d);
                }
                d = d.add_days(-1);
            }
            FakeChart { dts, page: 600 }
        }

        /// 주봉 dt는 그 주의 첫 관측일이다. 몇 주는 화요일로 둔다(kiwoom.md §10.8).
        fn weekly(n: usize) -> Self {
            let dts = (0..n).map(|i| date(2026, 11, 2).add_days(-7 * i as i64 + if i % 5 == 3 { 1 } else { 0 })).collect();
            FakeChart { dts, page: 300 }
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
            FakeChart { dts, page: 240 }
        }

        fn respond(&self, s: &Sent, array: &str) -> Result<crate::kiwoom::transport::HttpResponse, crate::kiwoom::transport::TransportError> {
            let offset: usize = s.cont.as_deref().map_or(0, |k| k.trim_start_matches('P').parse().unwrap());
            let end = (offset + self.page).min(self.dts.len());
            let rows: Vec<_> = self.dts[offset..end]
                .iter()
                .enumerate()
                .map(|(i, d)| {
                    let p = 1000 + (offset + i) as u64;
                    json!({"dt": d.yyyymmdd(), "open_pric": p.to_string(), "high_pric": (p + 5).to_string(),
                           "low_pric": (p - 5).to_string(), "cur_prc": format!("-{p}"), "trde_qty": "10", "upd_rt": ""})
                })
                .collect();
            let next = (end < self.dts.len()).then(|| format!("P{end}"));
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
    const EMPTY_ROW: &str = "999990";

    fn harness(now: KstTime, latency: Duration, day: FakeChart, week: FakeChart, month: FakeChart) -> Harness {
        let tokens = AtomicUsize::new(0);
        let fake = Arc::new(FakeTransport::new(latency, move |s| {
            if s.api_id == ApiId::Au10001 {
                return token(tokens.fetch_add(1, Ordering::SeqCst) + 1);
            }
            if s.body.contains(EMPTY_ROW) {
                return ok(json!({"stk_dt_pole_chart_qry": [{"dt": "", "cur_prc": ""}], "return_code": 0}), None);
            }
            let chart = match s.api_id {
                ApiId::Ka10081 | ApiId::Ka20006 => &day,
                ApiId::Ka10082 | ApiId::Ka20007 => &week,
                _ => &month,
            };
            chart.respond(s, array_of(s.api_id))
        }));
        let clock = Clock::fake(now);
        let rest = KiwoomRest::new(Arc::new(fake.clone()), KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into())), clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        let stock = |code: &str| SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: code.into(), kind: SymbolKind::Common, market: Market::Kospi };
        symbols.replace(Directory::build(vec![stock(SAMSUNG), stock(EMPTY_ROW)]));
        Harness { fake, bars: Arc::new(BarService::new(rest, symbols, clock.clone())), clock }
    }

    fn std_harness(latency: Duration) -> Harness {
        harness(monday_night(), latency, FakeChart::daily(2000), FakeChart::weekly(1000), FakeChart::monthly(800))
    }

    fn key(symbol: &str, period: Period) -> SeriesKey {
        SeriesKey { symbol: Symbol::parse(symbol).unwrap(), period }
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
        let h = harness(monday_night(), Duration::ZERO, FakeChart::daily(700), FakeChart::weekly(10), FakeChart::monthly(10));
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
    async fn unknown_symbols_and_intraday_are_rejected() {
        let h = std_harness(Duration::ZERO);
        assert_eq!(h.bars.page(key("000660", Period::Day), None, 10).await, Err(BarError::UnknownSymbol));
        assert!(h.chart_calls().is_empty(), "목록에 없으면 키움을 부르지 않는다");
        assert_eq!(h.bars.page(key(EMPTY_ROW, Period::Day), None, 10).await, Err(BarError::UnknownSymbol));
        assert!(matches!(h.bars.page(key(SAMSUNG, Period::M5), None, 10).await, Err(BarError::BadRequest(_))));
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
