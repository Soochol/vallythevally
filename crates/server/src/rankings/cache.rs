use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use domain::KstTime;
use tokio::sync::watch;

use crate::api::{MAX_RANKING_PAGES, Ranking};
use crate::clock::Clock;
use crate::market_source::rankings::{Demand, QueryKey, RankedRow, RankingError, RankingFetch, RankingSource, Unsupported};
use crate::market_source::{Cursor, Priority, SourceError};

const FRESH_SECS: i64 = 8;
const IDLE_SECS: i64 = 60;
const MAX_PAGES: usize = MAX_RANKING_PAGES as usize;

#[derive(Debug, Clone)]
pub enum WalkError {
    Source(SourceError),
    CursorRefused(SourceError),
    Unsupported(Unsupported),
    KeyRepeated,
    KeyMissing,
    PageUnreadable,
    WalkLost,
}

impl From<RankingError> for WalkError {
    fn from(e: RankingError) -> Self {
        match e {
            RankingError::Source(e) => WalkError::Source(e),
            RankingError::CursorRefused(e) => WalkError::CursorRefused(e),
            RankingError::Unreadable => WalkError::PageUnreadable,
            RankingError::Unsupported(unsupported) => WalkError::Unsupported(unsupported),
        }
    }
}

impl WalkError {
    fn settled(self) -> WalkError {
        match self {
            WalkError::CursorRefused(e) => WalkError::Source(e),
            other => other,
        }
    }
}

#[derive(Debug, Clone)]
enum Next {
    Start,
    Key(Cursor),
    End,
}

#[derive(Debug, Clone)]
struct Walk {
    pages: Vec<Arc<Vec<RankedRow>>>,
    used_keys: Vec<Cursor>,
    next: Next,
}

impl Walk {
    fn start() -> Walk {
        Walk { pages: Vec::new(), used_keys: Vec::new(), next: Next::Start }
    }

    fn covers(&self, wanted: usize) -> bool {
        self.pages.len() >= wanted || matches!(self.next, Next::End)
    }

    async fn advance_to(&mut self, wanted: usize, source: &dyn RankingSource, ranking: &Ranking, demand: &mut Demand) -> Result<(), WalkError> {
        while self.pages.len() < wanted {
            let cont = match &self.next {
                Next::End => break,
                Next::Start => None,
                Next::Key(key) => Some(key.clone()),
            };
            let RankingFetch { rows, next, continues_without_cursor } = source.page(ranking, cont.as_ref(), demand).await?;
            self.used_keys.extend(cont);
            self.pages.push(Arc::new(rows));
            self.next = match next {
                Some(key) if self.used_keys.contains(&key) => return Err(WalkError::KeyRepeated),
                Some(key) => Next::Key(key),
                None if continues_without_cursor => return Err(WalkError::KeyMissing),
                None => Next::End,
            };
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct Snapshot {
    walk: Walk,
    fetched_at: KstTime,
}

impl Snapshot {
    fn is_fresh(&self, now: KstTime) -> bool {
        (0..FRESH_SECS).contains(&(now.unix() - self.fetched_at.unix()))
    }

    fn served(&self, wanted: usize) -> Served {
        let pages: Vec<_> = self.walk.pages.iter().take(wanted).cloned().collect();
        let end = matches!(self.walk.next, Next::End) && pages.len() == self.walk.pages.len();
        let limited = !end && pages.len() == MAX_PAGES;
        Served { pages, end, limited, fetched_at: self.fetched_at }
    }
}

pub struct Served {
    pub pages: Vec<Arc<Vec<RankedRow>>>,
    pub end: bool,
    pub limited: bool,
    pub fetched_at: KstTime,
}

struct Wants {
    tally: Mutex<BTreeMap<Priority, usize>>,
    best: watch::Sender<Priority>,
}

impl Wants {
    fn new() -> Wants {
        Wants { tally: Mutex::default(), best: watch::channel(Priority::Background).0 }
    }

    fn add(&self, priority: Priority) -> Want<'_> {
        let mut tally = self.tally.lock().expect("우선순위 집계 잠금");
        *tally.entry(priority).or_default() += 1;
        self.best.send_replace(*tally.keys().next().expect("방금 더했다"));
        Want { wants: self, priority }
    }

    fn remove(&self, priority: Priority) {
        let mut tally = self.tally.lock().expect("우선순위 집계 잠금");
        if let Some(count) = tally.get_mut(&priority) {
            *count -= 1;
            if *count == 0 {
                tally.remove(&priority);
            }
        }
        if let Some(best) = tally.keys().next() {
            self.best.send_replace(*best);
        }
    }
}

struct Want<'a> {
    wants: &'a Wants,
    priority: Priority,
}

impl Drop for Want<'_> {
    fn drop(&mut self) {
        self.wants.remove(self.priority);
    }
}

type Outcome = Result<Snapshot, WalkError>;

#[derive(Default)]
struct SlotState {
    snapshot: Option<Snapshot>,
    flight: Option<watch::Receiver<Option<Outcome>>>,
}

struct Slot {
    state: Mutex<SlotState>,
    wants: Wants,
    last_read: AtomicI64,
}

struct Landing {
    slot: Arc<Slot>,
    outcome: watch::Sender<Option<Outcome>>,
    result: Option<Outcome>,
}

impl Drop for Landing {
    fn drop(&mut self) {
        let result = self.result.take().unwrap_or(Err(WalkError::WalkLost));
        {
            let mut state = self.slot.state.lock().expect("순위 캐시 잠금");
            state.flight = None;
            if let Ok(snapshot) = &result {
                state.snapshot = Some(snapshot.clone());
            }
        }
        self.outcome.send_replace(Some(result));
    }
}

#[derive(Default)]
pub struct RankingCache {
    slots: Mutex<HashMap<QueryKey, Arc<Slot>>>,
}

async fn walk_snapshot(base: Option<Snapshot>, wanted: usize, source: &dyn RankingSource, ranking: &Ranking, clock: &Clock, demand: &mut Demand) -> Outcome {
    if let Some(base) = base {
        let mut walk = base.walk.clone();
        match walk.advance_to(wanted, source, ranking, demand).await {
            Ok(()) => return Ok(Snapshot { walk, fetched_at: base.fetched_at }),
            Err(WalkError::CursorRefused(e)) => tracing::info!(reason = %e, source = source.name(), "공급원이 남긴 연속조회 키를 받지 않아 1페이지부터 다시 받습니다"),
            Err(e) => return Err(e),
        }
    }
    let mut walk = Walk::start();
    walk.advance_to(wanted, source, ranking, demand).await.map_err(WalkError::settled)?;
    Ok(Snapshot { walk, fetched_at: clock.now() })
}

impl RankingCache {
    pub fn slots(&self) -> usize {
        self.slots.lock().expect("순위 캐시 잠금").len()
    }

    fn slot(&self, key: QueryKey, now: KstTime) -> Arc<Slot> {
        let mut slots = self.slots.lock().expect("순위 캐시 잠금");
        slots.retain(|_, slot| Arc::strong_count(slot) > 1 || now.unix() - slot.last_read.load(Ordering::SeqCst) < IDLE_SECS);
        let slot = slots.entry(key).or_insert_with(|| Arc::new(Slot { state: Mutex::default(), wants: Wants::new(), last_read: AtomicI64::new(now.unix()) }));
        slot.last_read.store(now.unix(), Ordering::SeqCst);
        slot.clone()
    }

    pub async fn serve(&self, source: Arc<dyn RankingSource>, ranking: Ranking, wanted: usize, priority: Priority, clock: &Clock) -> Result<Served, WalkError> {
        source.check(&ranking).map_err(WalkError::Unsupported)?;
        let slot = self.slot(source.query_key(&ranking), clock.now());
        let _want = slot.wants.add(priority);
        loop {
            let now = clock.now();
            slot.last_read.store(now.unix(), Ordering::SeqCst);
            let (mut flight, started) = {
                let mut state = slot.state.lock().expect("순위 캐시 잠금");
                let fresh = state.snapshot.clone().filter(|snapshot| snapshot.is_fresh(now));
                if let Some(snapshot) = fresh.as_ref().filter(|snapshot| snapshot.walk.covers(wanted)) {
                    return Ok(snapshot.served(wanted));
                }
                match &state.flight {
                    Some(flight) => (flight.clone(), false),
                    None => {
                        let (outcome, flight) = watch::channel(None);
                        state.flight = Some(flight.clone());
                        let landing = Landing { slot: slot.clone(), outcome, result: None };
                        let (source, clock) = (source.clone(), clock.clone());
                        let mut demand = Demand::new(slot.wants.best.subscribe());
                        tokio::spawn(async move {
                            let mut landing = landing;
                            landing.result = Some(walk_snapshot(fresh, wanted, source.as_ref(), &ranking, &clock, &mut demand).await);
                        });
                        (flight, true)
                    }
                }
            };
            let landed = flight.wait_for(Option::is_some).await.map_err(|_| WalkError::WalkLost)?.clone().expect("착지한 걷기에는 결과가 있다")?;
            if landed.walk.covers(wanted) && (started || landed.is_fresh(clock.now())) {
                return Ok(landed.served(wanted));
            }
        }
    }
}
