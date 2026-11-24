use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use domain::{KstDate, KstTime, StockCode};
use tokio::sync::Semaphore;

use crate::api;
use crate::book_replay::day_index::{DayIndexCache, DayIndexState, FileStamp, read_stamp};

use super::flow::{FlowCache, has_symbol_flow};
use super::kind::{Brokers, CollectedKind};
use super::store::{StoreDay, read_day};

const STORE_CACHE_CAPACITY: usize = 16;
const MAX_CONCURRENT_QUERIES: usize = 2;
const SHARED_FOLDER: &str = "shared";

struct CachedStoreDay<V> {
    stamp: FileStamp,
    day: Arc<StoreDay<V>>,
}

struct StoreCache<V> {
    order: VecDeque<(String, String)>,
    entries: HashMap<(String, String), CachedStoreDay<V>>,
}

impl<V> StoreCache<V> {
    fn new() -> Self {
        Self {
            order: VecDeque::with_capacity(STORE_CACHE_CAPACITY),
            entries: HashMap::with_capacity(STORE_CACHE_CAPACITY),
        }
    }

    fn get(&mut self, key: &(String, String), stamp: &FileStamp) -> Option<Arc<StoreDay<V>>> {
        let entry = self.entries.get(key)?;
        if &entry.stamp != stamp {
            return None;
        }
        let day = Arc::clone(&entry.day);
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            self.order.remove(pos);
        }
        self.order.push_back(key.clone());
        Some(day)
    }

    fn insert(&mut self, key: (String, String), stamp: FileStamp, day: Arc<StoreDay<V>>) {
        if let Some(pos) = self.order.iter().position(|k| k == &key) {
            self.order.remove(pos);
        } else if self.order.len() >= STORE_CACHE_CAPACITY
            && let Some(oldest) = self.order.pop_front()
        {
            self.entries.remove(&oldest);
        }
        self.order.push_back(key.clone());
        self.entries.insert(key, CachedStoreDay { stamp, day });
    }
}

struct LoadedStoreDay<V> {
    stamp: FileStamp,
    day: Arc<StoreDay<V>>,
}

pub(super) struct KindSource<K: CollectedKind> {
    store_cache: Mutex<StoreCache<K::View>>,
    flow: FlowCache<K>,
}

impl<K: CollectedKind> KindSource<K> {
    fn new() -> Self {
        Self {
            store_cache: Mutex::new(StoreCache::new()),
            flow: FlowCache::new(),
        }
    }
}

pub(super) struct DaySlice<V> {
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

pub struct Collected {
    dir: OnceLock<PathBuf>,
    day_index: DayIndexCache,
    permits: Arc<Semaphore>,
    brokers: KindSource<Brokers>,
}

impl Collected {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            dir: OnceLock::new(),
            day_index: DayIndexCache::new(),
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_QUERIES)),
            brokers: KindSource::new(),
        })
    }

    pub fn enable(&self, data_dir: PathBuf) {
        let _ = self.dir.set(data_dir);
    }

    pub(super) async fn broker_day(
        self: &Arc<Self>,
        stock: StockCode,
        date: KstDate,
        date_str: &str,
        after: Option<&str>,
        now: KstTime,
    ) -> Result<DaySlice<api::FeedBrokers>, String> {
        self.read_day::<Brokers>(|c| &c.brokers, stock, date, date_str, after, now).await
    }

    pub(super) async fn broker_days(self: &Arc<Self>, stock: StockCode, now: KstTime) -> Result<Vec<String>, String> {
        self.days_for::<Brokers>(stock, now).await
    }

    async fn days_for<K: CollectedKind>(self: &Arc<Self>, stock: StockCode, now: KstTime) -> Result<Vec<String>, String> {
        let Some(dir) = self.dir.get().cloned() else {
            return Ok(Vec::new());
        };
        let collected = Arc::clone(self);
        let stock_str = stock.as_str().to_owned();
        let today_str = format_yyyymmdd(now.kst_date());
        tokio::task::spawn_blocking(move || {
            let mut days = collected.day_index.collected_days(&dir, &stock_str)?;
            let shared_dir = dir.join(SHARED_FOLDER);
            if !days.iter().any(|d| d == &today_str) && has_symbol_flow(&shared_dir, &today_str, K::TYPE_CODE, &stock_str)? {
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
        stock: StockCode,
        date: KstDate,
        date_str: &str,
        after: Option<&str>,
        now: KstTime,
    ) -> Result<DaySlice<K::View>, String> {
        let Some(dir) = self.dir.get().cloned() else {
            return Ok(DaySlice::none());
        };
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
                let permit = self.permits.clone().acquire_owned().await.map_err(|e| format!("수집 저장소 조회 허가를 얻지 못했습니다: {e}"))?;
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
        if date != now.kst_date() {
            return Ok(DaySlice::none());
        }
        let flow_after = parse_flow_cursor(after);
        let collected = Arc::clone(self);
        let shared_dir = dir.join(SHARED_FOLDER);
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
    let (_, state) = collected.day_index.load(dir, date_str)?;
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
    let (Some(stamp), state) = collected.day_index.load(dir, date_str)? else {
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

fn stamp_token(stamp: &FileStamp) -> String {
    let nanos = stamp
        .modified
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0u128, |d| d.as_nanos());
    format!("{}-{nanos}", stamp.len)
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
    let token = stamp_token(stamp);
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
