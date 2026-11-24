use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use domain::{KstDate, KstTime};

use super::QuoteDayState;
use crate::clock::Clock;
use crate::shared_data::{QuoteDay, quote_days, read_quote_day};

pub const CLOSED_CAPACITY: usize = 64;
pub const LIVE_TTL_SECS: i64 = 2;
pub const DAYS_TTL_SECS: i64 = 2;

pub struct LoadedDay {
    pub date: KstDate,
    pub state: QuoteDayState,
    pub day: Option<Arc<QuoteDay>>,
}

struct CachedDays {
    dir: PathBuf,
    fetched_at: KstTime,
    days: Arc<HashSet<KstDate>>,
}

struct ClosedEntry {
    day: Arc<QuoteDay>,
    used: u64,
}

#[derive(Default)]
struct LruClosed {
    tick: u64,
    entries: HashMap<(KstDate, String), ClosedEntry>,
}

impl LruClosed {
    fn get(&mut self, date: KstDate, code: &str) -> Option<Arc<QuoteDay>> {
        let entry = self.entries.get_mut(&(date, code.to_owned()))?;
        self.tick += 1;
        entry.used = self.tick;
        Some(entry.day.clone())
    }

    fn insert(&mut self, date: KstDate, code: String, day: Arc<QuoteDay>) {
        self.tick += 1;
        self.entries.insert((date, code), ClosedEntry { day, used: self.tick });
        if self.entries.len() > CLOSED_CAPACITY
            && let Some(oldest) = self.entries.iter().min_by_key(|(_, entry)| entry.used).map(|(key, _)| key.clone())
        {
            self.entries.remove(&oldest);
        }
    }
}

struct LiveEntry {
    fetched_at: KstTime,
    day: Option<Arc<QuoteDay>>,
}

#[derive(Default)]
struct CacheState {
    days: Option<CachedDays>,
    closed: LruClosed,
    live: HashMap<(KstDate, String), LiveEntry>,
}

impl CacheState {
    fn fresh_days(&self, dir: &Path, now: KstTime) -> Option<Arc<HashSet<KstDate>>> {
        let cached = self.days.as_ref()?;
        (cached.dir == dir && is_fresh(cached.fetched_at, now, DAYS_TTL_SECS)).then(|| cached.days.clone())
    }

    fn fresh_live(&self, date: KstDate, code: &str, now: KstTime) -> Option<Option<Arc<QuoteDay>>> {
        let entry = self.live.get(&(date, code.to_owned()))?;
        is_fresh(entry.fetched_at, now, LIVE_TTL_SECS).then(|| entry.day.clone())
    }

    fn store_live(&mut self, date: KstDate, code: String, now: KstTime, day: Option<Arc<QuoteDay>>) {
        self.live.retain(|_, entry| is_fresh(entry.fetched_at, now, LIVE_TTL_SECS));
        self.live.insert((date, code), LiveEntry { fetched_at: now, day });
    }
}

fn is_fresh(fetched_at: KstTime, now: KstTime, ttl_secs: i64) -> bool {
    let elapsed = now.unix() - fetched_at.unix();
    elapsed >= 0 && elapsed < ttl_secs
}

#[derive(Default)]
pub struct QuoteCache {
    state: Mutex<CacheState>,
    fallback_dir: OnceLock<PathBuf>,
}

impl QuoteCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_fallback_dir(&self, dir: PathBuf) {
        let _ = self.fallback_dir.set(dir);
    }

    pub fn fallback_dir(&self) -> Option<&Path> {
        self.fallback_dir.get().map(PathBuf::as_path)
    }

    pub async fn load_range(&self, dir: &Path, code: &str, dates: &[KstDate], clock: &Clock) -> io::Result<Vec<LoadedDay>> {
        let now = clock.now();
        let available = self.available_days(dir, now).await?;
        let mut results: Vec<Option<LoadedDay>> = (0..dates.len()).map(|_| None).collect();
        let mut misses: Vec<(usize, KstDate)> = Vec::new();
        {
            let mut state = self.state.lock().unwrap();
            for (index, &date) in dates.iter().enumerate() {
                if !available.contains(&date) {
                    results[index] = Some(LoadedDay { date, state: QuoteDayState::None, day: None });
                    continue;
                }
                if let Some(day) = state.closed.get(date, code) {
                    results[index] = Some(LoadedDay { date, state: QuoteDayState::Closed, day: Some(day) });
                    continue;
                }
                if let Some(live) = state.fresh_live(date, code, now) {
                    let day_state = if live.is_some() { QuoteDayState::Live } else { QuoteDayState::NotCollected };
                    results[index] = Some(LoadedDay { date, state: day_state, day: live });
                    continue;
                }
                misses.push((index, date));
            }
        }
        if !misses.is_empty() {
            let tasks = misses.iter().map(|&(_, date)| {
                let dir = dir.to_path_buf();
                let date_str = date.yyyymmdd();
                let code = code.to_owned();
                tokio::task::spawn_blocking(move || read_quote_day(&dir, &date_str, &code))
            });
            let joined = futures::future::join_all(tasks).await;
            let mut fetched = Vec::with_capacity(joined.len());
            for ((index, date), outcome) in misses.into_iter().zip(joined) {
                let day = outcome.map_err(|e| io::Error::other(e.to_string()))??;
                fetched.push((index, date, day));
            }
            let mut state = self.state.lock().unwrap();
            for (index, date, day) in fetched {
                let loaded = match day {
                    Some(day) if day.closed => {
                        let day = Arc::new(day);
                        state.live.remove(&(date, code.to_owned()));
                        state.closed.insert(date, code.to_owned(), day.clone());
                        LoadedDay { date, state: QuoteDayState::Closed, day: Some(day) }
                    }
                    Some(day) => {
                        let day = Arc::new(day);
                        state.store_live(date, code.to_owned(), now, Some(day.clone()));
                        LoadedDay { date, state: QuoteDayState::Live, day: Some(day) }
                    }
                    None => {
                        state.store_live(date, code.to_owned(), now, None);
                        LoadedDay { date, state: QuoteDayState::NotCollected, day: None }
                    }
                };
                results[index] = Some(loaded);
            }
        }
        Ok(results.into_iter().map(Option::unwrap).collect())
    }

    async fn available_days(&self, dir: &Path, now: KstTime) -> io::Result<Arc<HashSet<KstDate>>> {
        if let Some(days) = self.state.lock().unwrap().fresh_days(dir, now) {
            return Ok(days);
        }
        let dir_owned = dir.to_path_buf();
        let listed = tokio::task::spawn_blocking(move || quote_days(&dir_owned))
            .await
            .map_err(|e| io::Error::other(e.to_string()))??;
        let days: Arc<HashSet<KstDate>> = Arc::new(listed.into_iter().collect());
        self.state.lock().unwrap().days = Some(CachedDays { dir: dir.to_path_buf(), fetched_at: now, days: days.clone() });
        Ok(days)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::kst;
    use crate::shared_data::{ClosedQuotes, Ladder, LevelQty, QuoteMinute, VenueQuote, closed_day_dir, write_closed_quotes};

    fn sample_day(date: KstDate) -> QuoteDay {
        let ladder = Ladder { asks: vec![LevelQty(100, 10)], bids: vec![LevelQty(90, 20)] };
        let venue = VenueQuote { close: ladder.clone(), peak: ladder.clone(), price_max: ladder };
        let minute = QuoteMinute { minute: 540, close_sec: 32_450, single_price: false, combined: venue, krx: VenueQuote::default(), nxt: VenueQuote::default() };
        let _ = date;
        QuoteDay { closed: true, minutes: vec![minute], gaps: Vec::new() }
    }

    #[test]
    fn closed_lru_evicts_least_recently_used_entry() {
        let mut lru = LruClosed::default();
        let base = KstDate::new(2026, 1, 1).unwrap();
        for i in 0..CLOSED_CAPACITY {
            let date = base.add_days(i as i64);
            lru.insert(date, "005930".into(), Arc::new(sample_day(date)));
        }
        assert!(lru.get(base, "005930").is_some());
        let extra = base.add_days(CLOSED_CAPACITY as i64);
        lru.insert(extra, "005930".into(), Arc::new(sample_day(extra)));
        assert_eq!(lru.entries.len(), CLOSED_CAPACITY);
        assert!(lru.get(base, "005930").is_some());
        assert!(lru.get(base.add_days(1), "005930").is_none());
    }

    #[tokio::test]
    async fn closed_day_is_not_reread_from_disk_after_caching() {
        let tmp = tempfile::tempdir().unwrap();
        let date = KstDate::new(2026, 11, 23).unwrap();
        let day = sample_day(date);
        let day_dir = closed_day_dir(tmp.path(), &date.yyyymmdd());
        write_closed_quotes(&day_dir, &date.yyyymmdd(), "005930", &ClosedQuotes { minutes: day.minutes.clone(), gaps: Vec::new() }).unwrap();
        let clock = Clock::frozen(kst(KstDate::new(2026, 11, 24).unwrap(), 10, 0, 0));
        let cache = QuoteCache::new();
        let first = cache.load_range(tmp.path(), "005930", &[date], &clock).await.unwrap();
        assert_eq!(first[0].state, QuoteDayState::Closed);
        std::fs::remove_file(day_dir.join("005930.json.gz")).unwrap();
        clock.jump(10);
        let second = cache.load_range(tmp.path(), "005930", &[date], &clock).await.unwrap();
        assert_eq!(second[0].state, QuoteDayState::Closed);
        assert!(second[0].day.is_some());
    }
}
