use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

use domain::{KstDate, KstTime, StockCode};

use crate::api;
use crate::clock::kst;
use crate::collected_store::{CollectedStore, DayIndexState, FileStamp, StampLru, read_stamp};
use crate::hoga_archive::{ArchiveDayLookup, brokers::read_brokers_day, query::read_trade_ticks};
use crate::market_source::stream::{Exchange, TradeSide};
use crate::shared_data::{CollectorPaths, SYMBOL_FLOW_FOLDER, live_day_dir, live_quote_stock_keys};

use super::flow::{FlowCache, has_symbol_flow};
use super::kind::{
    Brokers, CollectedExpectedTrade, CollectedKind, CollectedProgramRow, CollectedTradeTick, CollectedViEvent, ExpectedTrades, MicroEvents, ProgramFlow,
    TradeTicks, ViEvents,
};
use super::store::{StoreDay, read_day};

const MAX_FALLBACK_DAYS: usize = 5;
const MAX_TRADE_STRENGTH: f64 = 500.0;
const TRADE_CUTOFF_LOOKAHEAD_MS: i64 = 60_000;

pub struct TradeWindowQuery {
    pub stock: StockCode,
    pub date: KstDate,
    pub date_str: String,
    pub until_sec: u32,
    pub venue: domain::Venue,
    pub min_won: u64,
    pub limit: usize,
    pub now: KstTime,
}

pub struct BrokerDaysResult {
    pub days: Vec<String>,
    pub archive_days: Vec<String>,
}

pub struct TradeWindowSlice {
    pub coverage: api::BookReplayCoverage,
    pub venue_override: Option<api::Venue>,
    pub venue_scope: Option<api::ReplayVenueScope>,
    pub gaps: Vec<[i64; 2]>,
    pub cum_volume: u64,
    pub cum_buy_qty: u64,
    pub cum_sell_qty: u64,
    pub strength: Option<f64>,
    pub trades: Vec<api::BookReplayTradeRow>,
}

impl TradeWindowSlice {
    fn empty(coverage: api::BookReplayCoverage) -> Self {
        Self {
            coverage,
            venue_override: None,
            venue_scope: None,
            gaps: Vec::new(),
            cum_volume: 0,
            cum_buy_qty: 0,
            cum_sell_qty: 0,
            strength: None,
            trades: Vec::new(),
        }
    }
}

pub struct ProgramDaySlice {
    pub coverage: api::BookReplayCoverage,
    pub venue_scope: Option<api::ReplayVenueScope>,
    pub gaps: Vec<[i64; 2]>,
    pub rows: Vec<api::BookReplayProgramRow>,
}

impl ProgramDaySlice {
    fn empty(coverage: api::BookReplayCoverage) -> Self {
        Self {
            coverage,
            venue_scope: None,
            gaps: Vec::new(),
            rows: Vec::new(),
        }
    }
}

struct LoadedStoreDay<V> {
    stamp: FileStamp,
    day: Arc<StoreDay<V>>,
}

pub(super) struct KindSource<K: CollectedKind> {
    store_cache: Mutex<StampLru<Arc<StoreDay<K::View>>>>,
    flow: FlowCache<K>,
}

impl<K: CollectedKind> KindSource<K> {
    fn new() -> Self {
        Self {
            store_cache: Mutex::new(StampLru::new()),
            flow: FlowCache::new(),
        }
    }
}

pub struct DaySlice<V> {
    pub source: api::BrokerDaySource,
    pub coverage: Option<api::BookReplayCoverage>,
    pub venue_scope: Option<api::ReplayVenueScope>,
    pub snapshots: Vec<V>,
    pub gaps: Vec<[i64; 2]>,
    pub live: bool,
    pub cursor: String,
    pub reset: bool,
}

impl<V> DaySlice<V> {
    fn none(coverage: api::BookReplayCoverage) -> Self {
        Self {
            source: api::BrokerDaySource::None,
            coverage: Some(coverage),
            venue_scope: None,
            snapshots: Vec::new(),
            gaps: Vec::new(),
            live: false,
            cursor: String::new(),
            reset: true,
        }
    }
}

enum StoreLookup<V> {
    Hit(FileStamp, Arc<StoreDay<V>>),
    Miss,
    SymbolNotCollected,
    DayNotCollected,
    NoClosedDay,
}

enum StoreLoad<V> {
    Loaded(LoadedStoreDay<V>),
    SymbolNotCollected,
    DayNotCollected,
    NoClosedDay,
}

struct DayQuery<'a> {
    stock: StockCode,
    date: KstDate,
    date_str: &'a str,
    after: Option<&'a str>,
    now: KstTime,
}

pub struct Collected {
    store: Arc<CollectedStore>,
    brokers: KindSource<Brokers>,
    program: KindSource<ProgramFlow>,
    vi: KindSource<ViEvents>,
    expected: KindSource<ExpectedTrades>,
    ticks: KindSource<TradeTicks>,
    micro: KindSource<MicroEvents>,
    archive_brokers: Mutex<StampLru<Arc<Vec<api::FeedBrokers>>>>,
    archive_ticks: Mutex<StampLru<Arc<Vec<CollectedTradeTick>>>>,
}

impl Collected {
    pub fn new(store: Arc<CollectedStore>) -> Arc<Self> {
        Arc::new(Self {
            store,
            brokers: KindSource::new(),
            program: KindSource::new(),
            vi: KindSource::new(),
            expected: KindSource::new(),
            ticks: KindSource::new(),
            micro: KindSource::new(),
            archive_brokers: Mutex::new(StampLru::new()),
            archive_ticks: Mutex::new(StampLru::new()),
        })
    }

    pub(crate) fn store(&self) -> &Arc<CollectedStore> {
        &self.store
    }

    pub(super) async fn broker_day(
        self: &Arc<Self>,
        paths: CollectorPaths,
        stock: StockCode,
        date: KstDate,
        date_str: &str,
        after: Option<&str>,
        now: KstTime,
    ) -> Result<DaySlice<api::FeedBrokers>, String> {
        let primary = self.read_day::<Brokers>(|c| &c.brokers, paths.clone(), DayQuery { stock, date, date_str, after, now }).await?;
        if primary.source != api::BrokerDaySource::None {
            return Ok(primary);
        }
        let Some(archive_dir) = paths.archive_dir().map(Path::to_path_buf) else {
            return Ok(primary);
        };
        self.read_archive_broker_day(&archive_dir, stock, date, date_str, after, primary.coverage).await
    }

    pub(super) async fn broker_day_or_latest(
        self: &Arc<Self>,
        paths: CollectorPaths,
        stock: StockCode,
        date: KstDate,
        date_str: &str,
        after: Option<&str>,
        now: KstTime,
    ) -> Result<(String, DaySlice<api::FeedBrokers>), String> {
        let primary = self.broker_day(paths.clone(), stock, date, date_str, after, now).await?;
        if after.is_some() || (primary.source != api::BrokerDaySource::None && !primary.snapshots.is_empty()) {
            return Ok((date_str.to_owned(), primary));
        }
        let days = self.broker_days(paths.clone(), stock, now).await?.days;
        for candidate in days.iter().rev().filter(|day| day.as_str() < date_str).take(MAX_FALLBACK_DAYS) {
            let Some(candidate_date) = KstDate::parse_yyyymmdd(candidate) else {
                continue;
            };
            let fallback = self.broker_day(paths.clone(), stock, candidate_date, candidate, None, now).await?;
            if fallback.source != api::BrokerDaySource::None && !fallback.snapshots.is_empty() {
                return Ok((candidate.clone(), fallback));
            }
        }
        Ok((date_str.to_owned(), primary))
    }

    pub(super) async fn broker_days(self: &Arc<Self>, paths: CollectorPaths, stock: StockCode, now: KstTime) -> Result<BrokerDaysResult, String> {
        let native_days = self.days_for::<Brokers>(paths.clone(), stock, now).await?;
        let Some(archive_dir) = paths.archive_dir().map(Path::to_path_buf) else {
            return Ok(BrokerDaysResult { days: native_days, archive_days: Vec::new() });
        };
        let collected = Arc::clone(self);
        let stock_str = stock.as_str().to_owned();
        let archive_raw = tokio::task::spawn_blocking(move || collected.store.archive().days_for_stock(&archive_dir, &stock_str))
            .await
            .map_err(|e| format!("아카이브 거래원 날짜 목록 작업이 멈췄습니다: {e}"))??;
        let native_set: BTreeSet<String> = native_days.iter().cloned().collect();
        let archive_days: Vec<String> = archive_raw.into_iter().filter(|d| !native_set.contains(d)).collect();
        let mut merged = native_set;
        merged.extend(archive_days.iter().cloned());
        Ok(BrokerDaysResult {
            days: merged.into_iter().collect(),
            archive_days,
        })
    }

    pub async fn program_day(
        self: &Arc<Self>,
        paths: CollectorPaths,
        stock: StockCode,
        date: KstDate,
        date_str: &str,
        after: Option<&str>,
        now: KstTime,
    ) -> Result<DaySlice<CollectedProgramRow>, String> {
        self.read_day::<ProgramFlow>(|c| &c.program, paths, DayQuery { stock, date, date_str, after, now }).await
    }

    pub async fn program_day_or_latest(
        self: &Arc<Self>,
        paths: CollectorPaths,
        stock: StockCode,
        date: KstDate,
        date_str: &str,
        now: KstTime,
    ) -> Result<(String, DaySlice<CollectedProgramRow>), String> {
        self.read_day_or_latest::<ProgramFlow>(|c| &c.program, paths, DayQuery { stock, date, date_str, after: None, now }).await
    }

    pub async fn program_days(self: &Arc<Self>, paths: CollectorPaths, stock: StockCode, now: KstTime) -> Result<Vec<String>, String> {
        self.days_for::<ProgramFlow>(paths, stock, now).await
    }

    pub async fn vi_day(
        self: &Arc<Self>,
        paths: CollectorPaths,
        stock: StockCode,
        date: KstDate,
        date_str: &str,
        after: Option<&str>,
        now: KstTime,
    ) -> Result<DaySlice<CollectedViEvent>, String> {
        self.read_day::<ViEvents>(|c| &c.vi, paths, DayQuery { stock, date, date_str, after, now }).await
    }

    pub async fn vi_days(self: &Arc<Self>, paths: CollectorPaths, stock: StockCode, now: KstTime) -> Result<Vec<String>, String> {
        self.days_for::<ViEvents>(paths, stock, now).await
    }

    pub async fn expected_day(
        self: &Arc<Self>,
        paths: CollectorPaths,
        stock: StockCode,
        date: KstDate,
        date_str: &str,
        after: Option<&str>,
        now: KstTime,
    ) -> Result<DaySlice<CollectedExpectedTrade>, String> {
        self.read_day::<ExpectedTrades>(|c| &c.expected, paths, DayQuery { stock, date, date_str, after, now }).await
    }

    pub async fn expected_days(self: &Arc<Self>, paths: CollectorPaths, stock: StockCode, now: KstTime) -> Result<Vec<String>, String> {
        self.days_for::<ExpectedTrades>(paths, stock, now).await
    }

    pub async fn ticks_day(
        self: &Arc<Self>,
        paths: CollectorPaths,
        stock: StockCode,
        date: KstDate,
        date_str: &str,
        after: Option<&str>,
        now: KstTime,
    ) -> Result<DaySlice<CollectedTradeTick>, String> {
        self.read_day::<TradeTicks>(|c| &c.ticks, paths, DayQuery { stock, date, date_str, after, now }).await
    }

    pub async fn ticks_days(self: &Arc<Self>, paths: CollectorPaths, stock: StockCode, now: KstTime) -> Result<Vec<String>, String> {
        self.days_for::<TradeTicks>(paths, stock, now).await
    }

    pub async fn ticks_window_at(self: &Arc<Self>, paths: CollectorPaths, query: TradeWindowQuery) -> Result<TradeWindowSlice, String> {
        let params = TradeWindowParams {
            cutoff_ms: kst(query.date, 0, 0, 0).unix() * 1000 + (i64::from(query.until_sec) + 1) * 1000,
            until_sec: query.until_sec,
            venue: query.venue,
            min_won: query.min_won,
            limit: query.limit,
        };
        let key = ReplayDayKey {
            stock: query.stock,
            date: query.date,
            date_str: query.date_str.clone(),
            now: query.now,
        };
        let primary = self
            .read_replay_day::<TradeTicks, _, _, _, _>(
                |c| &c.ticks,
                paths.clone(),
                key,
                move |day| aggregate_trade_window(&day.snapshots, &day.gaps, params, |tick| tick),
                move |rows, gaps| aggregate_trade_window(rows, gaps, params, |(_, tick)| tick),
                TradeWindowSlice::empty,
            )
            .await?;
        if primary.coverage == api::BookReplayCoverage::Collected {
            return Ok(primary);
        }
        let Some(archive_dir) = paths.archive_dir().map(Path::to_path_buf) else {
            return Ok(primary);
        };
        self.read_archive_trade_window(&archive_dir, query.stock, query.date, &query.date_str, params, primary.coverage).await
    }

    pub async fn program_replay_day(
        self: &Arc<Self>,
        paths: CollectorPaths,
        stock: StockCode,
        date: KstDate,
        date_str: &str,
        now: KstTime,
    ) -> Result<ProgramDaySlice, String> {
        let key = ReplayDayKey {
            stock,
            date,
            date_str: date_str.to_owned(),
            now,
        };
        let primary = self
            .read_replay_day::<ProgramFlow, _, _, _, _>(
                |c| &c.program,
                paths.clone(),
                key,
                |day| map_program_day_slice(&day.gaps, day.snapshots.iter()),
                |rows, gaps| map_program_day_slice(gaps, rows.iter().map(|(_, row)| row)),
                ProgramDaySlice::empty,
            )
            .await?;
        if primary.coverage == api::BookReplayCoverage::Collected {
            return Ok(primary);
        }
        let Some(archive_dir) = paths.archive_dir().map(Path::to_path_buf) else {
            return Ok(primary);
        };
        let collected = Arc::clone(self);
        let date_owned = date_str.to_owned();
        let stock_str = stock.as_str().to_owned();
        let lookup = tokio::task::spawn_blocking(move || collected.store.archive().lookup_day(&archive_dir, &date_owned, &stock_str))
            .await
            .map_err(|e| format!("아카이브 프로그램 조회 작업이 멈췄습니다: {e}"))??;
        Ok(match lookup {
            ArchiveDayLookup::Found { .. } => ProgramDaySlice {
                coverage: api::BookReplayCoverage::Collected,
                venue_scope: Some(api::ReplayVenueScope::KrxArchive),
                gaps: Vec::new(),
                rows: Vec::new(),
            },
            ArchiveDayLookup::MissingStock if primary.coverage == api::BookReplayCoverage::DayNotCollected => {
                ProgramDaySlice::empty(api::BookReplayCoverage::SymbolNotCollected)
            }
            ArchiveDayLookup::MissingDay | ArchiveDayLookup::MissingStock => primary,
        })
    }

    async fn read_archive_broker_day(
        self: &Arc<Self>,
        archive_dir: &Path,
        stock: StockCode,
        date: KstDate,
        date_str: &str,
        after: Option<&str>,
        fallback_coverage: Option<api::BookReplayCoverage>,
    ) -> Result<DaySlice<api::FeedBrokers>, String> {
        let collected = Arc::clone(self);
        let dir = archive_dir.to_path_buf();
        let date_owned = date_str.to_owned();
        let stock_str = stock.as_str().to_owned();
        let lookup = tokio::task::spawn_blocking(move || collected.store.archive().lookup_day(&dir, &date_owned, &stock_str))
            .await
            .map_err(|e| format!("아카이브 거래원 확인 작업이 멈췄습니다: {e}"))??;
        let (hogaplay_dir, stamp) = match lookup {
            ArchiveDayLookup::Found { hogaplay_dir, stamp } => (hogaplay_dir, stamp),
            ArchiveDayLookup::MissingStock if fallback_coverage == Some(api::BookReplayCoverage::DayNotCollected) => {
                return Ok(DaySlice::none(api::BookReplayCoverage::SymbolNotCollected));
            }
            ArchiveDayLookup::MissingDay | ArchiveDayLookup::MissingStock => {
                return Ok(DaySlice::none(fallback_coverage.unwrap_or(api::BookReplayCoverage::DayNotCollected)));
            }
        };
        let cache_key = (stock.as_str().to_owned(), date_str.to_owned());
        if let Some(cached) = self.archive_brokers.lock().expect("archive broker cache").get(&cache_key, &stamp) {
            return Ok(slice_archive_brokers(&stamp, &cached, after));
        }
        let permit = self.store.acquire_permit().await.map_err(|e| format!("아카이브 거래원 조회 허가를 얻지 못했습니다: {e}"))?;
        let loaded = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            read_brokers_day(&hogaplay_dir, date)
        })
        .await
        .map_err(|e| format!("아카이브 거래원 조회 작업이 멈췄습니다: {e}"))??;
        let shared = Arc::new(loaded);
        self.archive_brokers
            .lock()
            .expect("archive broker cache")
            .insert(cache_key, stamp.clone(), Arc::clone(&shared));
        Ok(slice_archive_brokers(&stamp, &shared, after))
    }

    async fn read_archive_trade_window(
        self: &Arc<Self>,
        archive_dir: &Path,
        stock: StockCode,
        date: KstDate,
        date_str: &str,
        params: TradeWindowParams,
        fallback_coverage: api::BookReplayCoverage,
    ) -> Result<TradeWindowSlice, String> {
        let collected = Arc::clone(self);
        let dir = archive_dir.to_path_buf();
        let date_owned = date_str.to_owned();
        let stock_str = stock.as_str().to_owned();
        let lookup = tokio::task::spawn_blocking(move || collected.store.archive().lookup_day(&dir, &date_owned, &stock_str))
            .await
            .map_err(|e| format!("아카이브 체결 확인 작업이 멈췄습니다: {e}"))??;
        let (hogaplay_dir, stamp) = match lookup {
            ArchiveDayLookup::Found { hogaplay_dir, stamp } => (hogaplay_dir, stamp),
            ArchiveDayLookup::MissingStock if fallback_coverage == api::BookReplayCoverage::DayNotCollected => {
                return Ok(TradeWindowSlice::empty(api::BookReplayCoverage::SymbolNotCollected));
            }
            ArchiveDayLookup::MissingDay | ArchiveDayLookup::MissingStock => {
                return Ok(TradeWindowSlice::empty(fallback_coverage));
            }
        };
        let cache_key = (stock.as_str().to_owned(), date_str.to_owned());
        let ticks = if let Some(cached) = self.archive_ticks.lock().expect("archive ticks cache").get(&cache_key, &stamp) {
            cached
        } else {
            let permit = self.store.acquire_permit().await.map_err(|e| format!("아카이브 체결 조회 허가를 얻지 못했습니다: {e}"))?;
            let loaded = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                read_trade_ticks(&hogaplay_dir, date)
            })
            .await
            .map_err(|e| format!("아카이브 체결 조회 작업이 멈췄습니다: {e}"))??;
            let shared = Arc::new(loaded);
            self.archive_ticks
                .lock()
                .expect("archive ticks cache")
                .insert(cache_key, stamp, Arc::clone(&shared));
            shared
        };
        let archive_params = TradeWindowParams { venue: domain::Venue::Krx, ..params };
        let mut slice = tokio::task::spawn_blocking(move || aggregate_trade_window(&ticks, &[], archive_params, |tick| tick))
            .await
            .map_err(|e| format!("아카이브 체결 집계 작업이 멈췄습니다: {e}"))?;
        slice.venue_override = Some(api::Venue::Krx);
        slice.venue_scope = Some(api::ReplayVenueScope::KrxArchive);
        Ok(slice)
    }

    pub async fn micro_day(
        self: &Arc<Self>,
        paths: CollectorPaths,
        stock: StockCode,
        date: KstDate,
        date_str: &str,
        after: Option<&str>,
        now: KstTime,
    ) -> Result<DaySlice<domain::MicroEvent>, String> {
        self.read_day::<MicroEvents>(|c| &c.micro, paths, DayQuery { stock, date, date_str, after, now }).await
    }

    pub async fn micro_days(self: &Arc<Self>, paths: CollectorPaths, stock: StockCode, now: KstTime) -> Result<Vec<String>, String> {
        self.days_for::<MicroEvents>(paths, stock, now).await
    }

    async fn days_for<K: CollectedKind>(self: &Arc<Self>, paths: CollectorPaths, stock: StockCode, now: KstTime) -> Result<Vec<String>, String> {
        let dir = paths.hoga_dir().map(Path::to_path_buf);
        let shared_dir = paths.shared_dir().map(Path::to_path_buf);
        if dir.is_none() && shared_dir.is_none() {
            return Ok(Vec::new());
        }
        let collected = Arc::clone(self);
        let stock_str = stock.as_str().to_owned();
        let today_str = format_yyyymmdd(now.kst_date());
        tokio::task::spawn_blocking(move || {
            let mut days = match &dir {
                Some(dir) => collected.store.collected_days(dir, &stock_str)?,
                None => Vec::new(),
            };
            if let Some(shared_dir) = &shared_dir
                && !days.iter().any(|d| d == &today_str)
                && has_symbol_flow(shared_dir, &today_str, K::TYPE_CODE, &stock_str)?
            {
                days.push(today_str);
                days.sort_unstable();
            }
            Ok(days)
        })
        .await
        .map_err(|e| format!("수집 날짜 목록 작업이 멈췄습니다: {e}"))?
    }

    async fn read_day<K: CollectedKind>(
        self: &Arc<Self>,
        select: fn(&Self) -> &KindSource<K>,
        paths: CollectorPaths,
        query: DayQuery<'_>,
    ) -> Result<DaySlice<K::View>, String> {
        let DayQuery { stock, date, date_str, after, now } = query;
        if let Some(dir) = paths.hoga_dir().map(Path::to_path_buf) {
            let cache_key = (stock.as_str().to_owned(), date_str.to_owned());
            let lookup = {
                let collected = Arc::clone(self);
                let dir_check = dir.clone();
                let date_check = date_str.to_owned();
                let key_check = cache_key.clone();
                tokio::task::spawn_blocking(move || check_store_cache(&collected, select(&collected), &dir_check, &date_check, &key_check))
                    .await
                    .map_err(|e| format!("수집 저장소 확인 작업이 멈췄습니다: {e}"))??
            };
            match lookup {
                StoreLookup::Hit(stamp, day) => {
                    return Ok(slice_store(&stamp, &day, after));
                }
                StoreLookup::Miss => {
                    let permit = self.store.acquire_permit().await.map_err(|e| format!("수집 저장소 조회 허가를 얻지 못했습니다: {e}"))?;
                    let collected = Arc::clone(self);
                    let dir_load = dir.clone();
                    let date_owned = date_str.to_owned();
                    let stock_str = stock.as_str().to_owned();
                    let loaded = tokio::task::spawn_blocking(move || {
                        let _permit = permit;
                        load_store_day(&collected, select(&collected), &dir_load, date, &date_owned, &stock_str, &cache_key)
                    })
                    .await
                    .map_err(|e| format!("수집 저장소 조회 작업이 멈췄습니다: {e}"))??;
                    match loaded {
                        StoreLoad::Loaded(loaded) => return Ok(slice_store(&loaded.stamp, &loaded.day, after)),
                        StoreLoad::SymbolNotCollected => return Ok(DaySlice::none(api::BookReplayCoverage::SymbolNotCollected)),
                        StoreLoad::DayNotCollected => return Ok(DaySlice::none(api::BookReplayCoverage::DayNotCollected)),
                        StoreLoad::NoClosedDay => {}
                    }
                }
                StoreLookup::SymbolNotCollected => return Ok(DaySlice::none(api::BookReplayCoverage::SymbolNotCollected)),
                StoreLookup::DayNotCollected => return Ok(DaySlice::none(api::BookReplayCoverage::DayNotCollected)),
                StoreLookup::NoClosedDay => {}
            }
        }
        if date != now.kst_date() {
            return Ok(DaySlice::none(api::BookReplayCoverage::DayNotCollected));
        }
        let Some(shared_dir) = paths.shared_dir().map(Path::to_path_buf) else {
            return Ok(DaySlice::none(api::BookReplayCoverage::DayNotCollected));
        };
        let flow_after = parse_flow_cursor(after);
        let collected = Arc::clone(self);
        let date_owned = date_str.to_owned();
        let stock_str = stock.as_str().to_owned();
        let (flow, missing_coverage) = tokio::task::spawn_blocking(move || {
            let flow = select(&collected).flow.read(&shared_dir, date, &date_owned, &stock_str, now, flow_after)?;
            let missing = flow.is_none().then(|| missing_live_coverage::<K>(&shared_dir, &date_owned, &stock_str));
            Ok::<_, String>((flow, missing))
        })
        .await
        .map_err(|e| format!("수집 흐름 읽기 작업이 멈췄습니다: {e}"))??;
        let Some(flow) = flow else {
            return Ok(DaySlice::none(missing_coverage.unwrap_or(api::BookReplayCoverage::DayNotCollected)));
        };
        Ok(DaySlice {
            source: api::BrokerDaySource::Flow,
            coverage: Some(api::BookReplayCoverage::Collected),
            venue_scope: None,
            snapshots: flow.snapshots,
            gaps: flow.gaps,
            live: flow.live,
            cursor: format!("f:{}:{}", flow.generation, flow.total),
            reset: flow.reset,
        })
    }

    async fn read_replay_day<K, R, FStore, FFlow, FEmpty>(
        self: &Arc<Self>,
        select: fn(&Self) -> &KindSource<K>,
        paths: CollectorPaths,
        key: ReplayDayKey,
        on_store: FStore,
        on_flow: FFlow,
        on_empty: FEmpty,
    ) -> Result<R, String>
    where
        K: CollectedKind,
        R: Send + 'static,
        FStore: FnOnce(&StoreDay<K::View>) -> R + Send + 'static,
        FFlow: FnOnce(&[(i64, K::View)], &[[i64; 2]]) -> R + Send + 'static,
        FEmpty: FnOnce(api::BookReplayCoverage) -> R + Send + 'static,
    {
        let ReplayDayKey { stock, date, date_str, now } = key;
        if let Some(dir) = paths.hoga_dir().map(Path::to_path_buf) {
            let cache_key = (stock.as_str().to_owned(), date_str.clone());
            let lookup = {
                let collected = Arc::clone(self);
                let dir_check = dir.clone();
                let date_check = date_str.clone();
                let key_check = cache_key.clone();
                tokio::task::spawn_blocking(move || check_store_cache(&collected, select(&collected), &dir_check, &date_check, &key_check))
                    .await
                    .map_err(|e| format!("수집 저장소 확인 작업이 멈췄습니다: {e}"))??
            };
            match lookup {
                StoreLookup::Hit(_, day) => {
                    return tokio::task::spawn_blocking(move || on_store(&day))
                        .await
                        .map_err(|e| format!("수집 저장소 집계 작업이 멈췄습니다: {e}"));
                }
                StoreLookup::Miss => {
                    let permit = self.store.acquire_permit().await.map_err(|e| format!("수집 저장소 조회 허가를 얻지 못했습니다: {e}"))?;
                    let collected = Arc::clone(self);
                    let dir_load = dir.clone();
                    let date_owned = date_str.clone();
                    let stock_str = stock.as_str().to_owned();
                    let loaded = tokio::task::spawn_blocking(move || {
                        let _permit = permit;
                        load_store_day(&collected, select(&collected), &dir_load, date, &date_owned, &stock_str, &cache_key)
                    })
                    .await
                    .map_err(|e| format!("수집 저장소 조회 작업이 멈췄습니다: {e}"))??;
                    match loaded {
                        StoreLoad::Loaded(loaded) => {
                            return tokio::task::spawn_blocking(move || on_store(&loaded.day))
                                .await
                                .map_err(|e| format!("수집 저장소 집계 작업이 멈췄습니다: {e}"));
                        }
                        StoreLoad::SymbolNotCollected => return Ok(on_empty(api::BookReplayCoverage::SymbolNotCollected)),
                        StoreLoad::DayNotCollected => return Ok(on_empty(api::BookReplayCoverage::DayNotCollected)),
                        StoreLoad::NoClosedDay => {}
                    }
                }
                StoreLookup::SymbolNotCollected => return Ok(on_empty(api::BookReplayCoverage::SymbolNotCollected)),
                StoreLookup::DayNotCollected => return Ok(on_empty(api::BookReplayCoverage::DayNotCollected)),
                StoreLookup::NoClosedDay => {}
            }
        }
        if date != now.kst_date() {
            return Ok(on_empty(api::BookReplayCoverage::DayNotCollected));
        }
        let Some(shared_dir) = paths.shared_dir().map(Path::to_path_buf) else {
            return Ok(on_empty(api::BookReplayCoverage::DayNotCollected));
        };
        let collected = Arc::clone(self);
        let stock_str = stock.as_str().to_owned();
        tokio::task::spawn_blocking(move || {
            match select(&collected).flow.read_with(&shared_dir, date, &date_str, &stock_str, now, on_flow)? {
                Some(value) => Ok(value),
                None => Ok(on_empty(missing_live_coverage::<K>(&shared_dir, &date_str, &stock_str))),
            }
        })
        .await
        .map_err(|e| format!("수집 흐름 읽기 작업이 멈췄습니다: {e}"))?
    }

    async fn read_day_or_latest<K: CollectedKind>(
        self: &Arc<Self>,
        select: fn(&Self) -> &KindSource<K>,
        paths: CollectorPaths,
        query: DayQuery<'_>,
    ) -> Result<(String, DaySlice<K::View>), String> {
        let DayQuery { stock, date, date_str, after, now } = query;
        let primary = self.read_day::<K>(select, paths.clone(), DayQuery { stock, date, date_str, after, now }).await?;
        if after.is_some() || (primary.source != api::BrokerDaySource::None && !primary.snapshots.is_empty()) {
            return Ok((date_str.to_owned(), primary));
        }
        let days = self.days_for::<K>(paths.clone(), stock, now).await?;
        for candidate in days.iter().rev().filter(|day| day.as_str() < date_str).take(MAX_FALLBACK_DAYS) {
            let Some(candidate_date) = KstDate::parse_yyyymmdd(candidate) else {
                continue;
            };
            let fallback = self
                .read_day::<K>(
                    select,
                    paths.clone(),
                    DayQuery { stock, date: candidate_date, date_str: candidate, after: None, now },
                )
                .await?;
            if fallback.source != api::BrokerDaySource::None && !fallback.snapshots.is_empty() {
                return Ok((candidate.clone(), fallback));
            }
        }
        Ok((date_str.to_owned(), primary))
    }
}

struct ReplayDayKey {
    stock: StockCode,
    date: KstDate,
    date_str: String,
    now: KstTime,
}

#[derive(Clone, Copy)]
struct TradeWindowParams {
    cutoff_ms: i64,
    until_sec: u32,
    venue: domain::Venue,
    min_won: u64,
    limit: usize,
}

fn missing_live_coverage<K: CollectedKind>(shared_dir: &Path, date_str: &str, stock_str: &str) -> api::BookReplayCoverage {
    if live_quote_stock_keys(shared_dir, date_str, stock_str).is_ok_and(|keys| !keys.is_empty()) {
        return api::BookReplayCoverage::Collected;
    }
    let flow_type_dir = shared_dir.join(SYMBOL_FLOW_FOLDER).join(date_str).join(K::TYPE_CODE);
    if flow_type_dir.is_dir() || live_day_dir(shared_dir, date_str).is_dir() {
        api::BookReplayCoverage::SymbolNotCollected
    } else {
        api::BookReplayCoverage::DayNotCollected
    }
}

fn matches_venue(exchange: Option<Exchange>, venue: domain::Venue) -> bool {
    match venue {
        domain::Venue::Combined => true,
        domain::Venue::Krx => matches!(exchange, Some(Exchange::Krx) | None),
        domain::Venue::Nxt => exchange == Some(Exchange::Nxt),
    }
}

fn map_trade_side(side: Option<TradeSide>) -> api::BookReplayTradeSide {
    match side {
        Some(TradeSide::Buy) => api::BookReplayTradeSide::Buy,
        Some(TradeSide::Sell) => api::BookReplayTradeSide::Sell,
        None => api::BookReplayTradeSide::None,
    }
}

fn map_exchange(exchange: Exchange) -> api::Venue {
    match exchange {
        Exchange::Krx => api::Venue::Krx,
        Exchange::Nxt => api::Venue::Nxt,
    }
}

fn aggregate_trade_window<T>(
    rows: &[T],
    gaps: &[[i64; 2]],
    params: TradeWindowParams,
    tick_of: impl Fn(&T) -> &CollectedTradeTick,
) -> TradeWindowSlice {
    let scan_cutoff_ms = params.cutoff_ms.saturating_add(TRADE_CUTOFF_LOOKAHEAD_MS);
    let end_idx = rows.partition_point(|row| tick_of(row).recv_ms < scan_cutoff_ms);
    let mut cum_volume: u64 = 0;
    let mut cum_buy_qty: u64 = 0;
    let mut cum_sell_qty: u64 = 0;
    for row in &rows[..end_idx] {
        let tick = tick_of(row);
        if tick.hhmmss.secs() > params.until_sec || !matches_venue(tick.exchange, params.venue) {
            continue;
        }
        let qty = tick.qty();
        cum_volume = cum_volume.saturating_add(qty);
        match tick.side() {
            Some(TradeSide::Buy) => cum_buy_qty = cum_buy_qty.saturating_add(qty),
            Some(TradeSide::Sell) => cum_sell_qty = cum_sell_qty.saturating_add(qty),
            None => {}
        }
    }
    let strength = if cum_sell_qty > 0 {
        Some(((cum_buy_qty as f64 / cum_sell_qty as f64) * 100.0).min(MAX_TRADE_STRENGTH))
    } else if cum_buy_qty > 0 {
        Some(MAX_TRADE_STRENGTH)
    } else {
        None
    };
    let mut trades = Vec::with_capacity(params.limit.min(end_idx));
    for row in rows[..end_idx].iter().rev() {
        if trades.len() >= params.limit {
            break;
        }
        let tick = tick_of(row);
        if tick.hhmmss.secs() > params.until_sec || !matches_venue(tick.exchange, params.venue) || tick.value_won() < params.min_won {
            continue;
        }
        trades.push(api::BookReplayTradeRow {
            second_of_day: tick.hhmmss.secs(),
            price: tick.price_won,
            quantity: tick.qty(),
            side: map_trade_side(tick.side()),
            venue: tick.exchange.map(map_exchange),
        });
    }
    TradeWindowSlice {
        coverage: api::BookReplayCoverage::Collected,
        venue_override: None,
        venue_scope: None,
        gaps: gaps.to_vec(),
        cum_volume,
        cum_buy_qty,
        cum_sell_qty,
        strength,
        trades,
    }
}

fn map_program_day_slice<'a>(gaps: &[[i64; 2]], rows: impl Iterator<Item = &'a CollectedProgramRow>) -> ProgramDaySlice {
    let mut mapped: Vec<api::BookReplayProgramRow> = rows.map(map_program_row).collect();
    mapped.sort_by_key(|row| row.second_of_day);
    ProgramDaySlice {
        coverage: api::BookReplayCoverage::Collected,
        venue_scope: None,
        gaps: gaps.to_vec(),
        rows: mapped,
    }
}

fn map_program_row(row: &CollectedProgramRow) -> api::BookReplayProgramRow {
    api::BookReplayProgramRow {
        second_of_day: row.hhmmss.secs(),
        price: row.price_won,
        buy_qty: row.buy_qty,
        sell_qty: row.sell_qty,
        net_qty: row.net_buy_qty,
        net_qty_change: row.net_buy_qty_change,
        net_amount_million_won: row.net_buy_amount_million_won,
    }
}

fn check_store_cache<K: CollectedKind>(
    collected: &Collected,
    kind: &KindSource<K>,
    dir: &Path,
    date_str: &str,
    cache_key: &(String, String),
) -> Result<StoreLookup<K::View>, String> {
    let Some(stamp) = read_stamp(dir, date_str)? else {
        return Ok(StoreLookup::NoClosedDay);
    };
    if let Some(day) = kind.store_cache.lock().expect("collected store cache").get(cache_key, &stamp) {
        return Ok(StoreLookup::Hit(stamp, day));
    }
    let (_, state) = match collected.store.load_day_index(dir, date_str) {
        Ok(loaded) => loaded,
        Err(reason) => {
            tracing::warn!(type_code = K::TYPE_CODE, date = %date_str, reason = %reason, "complete.json을 읽지 못해 저장소 조회를 건너뜁니다");
            return Ok(StoreLookup::NoClosedDay);
        }
    };
    match state {
        DayIndexState::Missing => Ok(StoreLookup::NoClosedDay),
        DayIndexState::UnsupportedVersion => Ok(StoreLookup::DayNotCollected),
        DayIndexState::Ready(index) if index.stocks.contains_key(&cache_key.0) => Ok(StoreLookup::Miss),
        DayIndexState::Ready(_) => Ok(StoreLookup::SymbolNotCollected),
    }
}

fn load_store_day<K: CollectedKind>(
    collected: &Collected,
    kind: &KindSource<K>,
    dir: &Path,
    date: KstDate,
    date_str: &str,
    stock_str: &str,
    cache_key: &(String, String),
) -> Result<StoreLoad<K::View>, String> {
    let (stamp, state) = match collected.store.load_day_index(dir, date_str) {
        Ok(loaded) => loaded,
        Err(reason) => {
            tracing::warn!(type_code = K::TYPE_CODE, date = %date_str, reason = %reason, "complete.json을 읽지 못해 저장소 조회를 건너뜁니다");
            return Ok(StoreLoad::NoClosedDay);
        }
    };
    let Some(stamp) = stamp else {
        return Ok(StoreLoad::NoClosedDay);
    };
    if let Some(day) = kind.store_cache.lock().expect("collected store cache").get(cache_key, &stamp) {
        return Ok(StoreLoad::Loaded(LoadedStoreDay { stamp, day }));
    }
    let DayIndexState::Ready(index) = state else {
        return Ok(match state {
            DayIndexState::Missing => StoreLoad::NoClosedDay,
            DayIndexState::UnsupportedVersion => StoreLoad::DayNotCollected,
            DayIndexState::Ready(_) => unreachable!(),
        });
    };
    let Some(coverage) = index.stocks.get(stock_str) else {
        return Ok(StoreLoad::SymbolNotCollected);
    };
    let day_dir = dir.join("store").join(date_str);
    let day = Arc::new(read_day::<K>(&day_dir, date, stock_str, index.buckets, &coverage.gaps)?);
    kind.store_cache.lock().expect("collected store cache").insert(cache_key.clone(), stamp.clone(), Arc::clone(&day));
    Ok(StoreLoad::Loaded(LoadedStoreDay { stamp, day }))
}

fn parse_cursor(after: Option<&str>) -> Option<(&str, &str, usize)> {
    let raw = after?;
    let mut parts = raw.splitn(3, ':');
    let prefix = parts.next()?;
    let generation = parts.next()?;
    let index = parts.next()?.parse::<usize>().ok()?;
    Some((prefix, generation, index))
}

fn slice_store<V: Clone>(stamp: &FileStamp, day: &StoreDay<V>, after: Option<&str>) -> DaySlice<V> {
    let token = stamp.token();
    let total = day.snapshots.len();
    let cursor = format!("s:{token}:{total}");
    if let Some(("s", generation, index)) = parse_cursor(after)
        && generation == token
        && index <= total
    {
        return DaySlice {
            source: api::BrokerDaySource::Store,
            coverage: Some(api::BookReplayCoverage::Collected),
            venue_scope: None,
            snapshots: day.snapshots[index..].to_vec(),
            gaps: day.gaps.clone(),
            live: false,
            cursor,
            reset: false,
        };
    }
    DaySlice {
        source: api::BrokerDaySource::Store,
        coverage: Some(api::BookReplayCoverage::Collected),
        venue_scope: None,
        snapshots: day.snapshots.clone(),
        gaps: day.gaps.clone(),
        live: false,
        cursor,
        reset: true,
    }
}

fn slice_archive_brokers(stamp: &FileStamp, snapshots: &[api::FeedBrokers], after: Option<&str>) -> DaySlice<api::FeedBrokers> {
    let token = stamp.token();
    let total = snapshots.len();
    let cursor = format!("a:{token}:{total}");
    if let Some(("a", generation, index)) = parse_cursor(after)
        && generation == token
        && index <= total
    {
        return DaySlice {
            source: api::BrokerDaySource::Store,
            coverage: Some(api::BookReplayCoverage::Collected),
            venue_scope: Some(api::ReplayVenueScope::KrxArchive),
            snapshots: snapshots[index..].to_vec(),
            gaps: Vec::new(),
            live: false,
            cursor,
            reset: false,
        };
    }
    DaySlice {
        source: api::BrokerDaySource::Store,
        coverage: Some(api::BookReplayCoverage::Collected),
        venue_scope: Some(api::ReplayVenueScope::KrxArchive),
        snapshots: snapshots.to_vec(),
        gaps: Vec::new(),
        live: false,
        cursor,
        reset: true,
    }
}

fn parse_flow_cursor(after: Option<&str>) -> Option<(u64, usize)> {
    let ("f", generation, index) = parse_cursor(after)? else {
        return None;
    };
    Some((generation.parse::<u64>().ok()?, index))
}

fn format_yyyymmdd(date: KstDate) -> String {
    format!("{:04}{:02}{:02}", date.year(), date.month(), date.day())
}
