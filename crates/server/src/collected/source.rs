use std::path::Path;
use std::sync::{Arc, Mutex};

use domain::{KstDate, KstTime, StockCode};

use crate::api;
use crate::collected_store::{CollectedStore, DayIndexState, FileStamp, StampLru, read_stamp};
use crate::shared_data::CollectorPaths;

use super::flow::{FlowCache, has_symbol_flow};
use super::kind::{
    Brokers, CollectedExpectedTrade, CollectedKind, CollectedProgramRow, CollectedTradeTick, CollectedViEvent, ExpectedTrades, ProgramFlow, TradeTicks,
    ViEvents,
};
use super::store::{StoreDay, read_day};

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
    pub snapshots: Vec<V>,
    pub gaps: Vec<[i64; 2]>,
    pub live: bool,
    pub cursor: String,
    pub reset: bool,
}

impl<V> DaySlice<V> {
    fn none() -> Self {
        Self {
            source: api::BrokerDaySource::None,
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
    NotCollected,
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
        })
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
        self.read_day::<Brokers>(|c| &c.brokers, paths, DayQuery { stock, date, date_str, after, now }).await
    }

    pub(super) async fn broker_days(self: &Arc<Self>, paths: CollectorPaths, stock: StockCode, now: KstTime) -> Result<Vec<String>, String> {
        self.days_for::<Brokers>(paths, stock, now).await
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
                    if let Some(loaded) = loaded {
                        return Ok(slice_store(&loaded.stamp, &loaded.day, after));
                    }
                }
                StoreLookup::NotCollected => {}
            }
        }
        if date != now.kst_date() {
            return Ok(DaySlice::none());
        }
        let Some(shared_dir) = paths.shared_dir().map(Path::to_path_buf) else {
            return Ok(DaySlice::none());
        };
        let flow_after = parse_flow_cursor(after);
        let collected = Arc::clone(self);
        let date_owned = date_str.to_owned();
        let stock_str = stock.as_str().to_owned();
        let flow = tokio::task::spawn_blocking(move || {
            select(&collected).flow.read(&shared_dir, date, &date_owned, &stock_str, now, flow_after)
        })
        .await
        .map_err(|e| format!("수집 흐름 읽기 작업이 멈췄습니다: {e}"))??;
        let Some(flow) = flow else {
            return Ok(DaySlice::none());
        };
        Ok(DaySlice {
            source: api::BrokerDaySource::Flow,
            snapshots: flow.snapshots,
            gaps: flow.gaps,
            live: flow.live,
            cursor: format!("f:{}:{}", flow.generation, flow.total),
            reset: flow.reset,
        })
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
        return Ok(StoreLookup::NotCollected);
    };
    if let Some(day) = kind.store_cache.lock().expect("collected store cache").get(cache_key, &stamp) {
        return Ok(StoreLookup::Hit(stamp, day));
    }
    let (_, state) = collected.store.load_day_index(dir, date_str)?;
    match state {
        DayIndexState::Ready(index) if index.stocks.contains_key(&cache_key.0) => Ok(StoreLookup::Miss),
        _ => Ok(StoreLookup::NotCollected),
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
) -> Result<Option<LoadedStoreDay<K::View>>, String> {
    let (Some(stamp), state) = collected.store.load_day_index(dir, date_str)? else {
        return Ok(None);
    };
    if let Some(day) = kind.store_cache.lock().expect("collected store cache").get(cache_key, &stamp) {
        return Ok(Some(LoadedStoreDay { stamp, day }));
    }
    let DayIndexState::Ready(index) = state else {
        return Ok(None);
    };
    let Some(coverage) = index.stocks.get(stock_str) else {
        return Ok(None);
    };
    let day_dir = dir.join("store").join(date_str);
    let day = Arc::new(read_day::<K>(&day_dir, date, stock_str, index.buckets, &coverage.gaps)?);
    kind.store_cache.lock().expect("collected store cache").insert(cache_key.clone(), stamp.clone(), Arc::clone(&day));
    Ok(Some(LoadedStoreDay { stamp, day }))
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
            snapshots: day.snapshots[index..].to_vec(),
            gaps: day.gaps.clone(),
            live: false,
            cursor,
            reset: false,
        };
    }
    DaySlice {
        source: api::BrokerDaySource::Store,
        snapshots: day.snapshots.clone(),
        gaps: day.gaps.clone(),
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
