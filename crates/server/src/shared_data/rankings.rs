use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use domain::{KstDate, KstTime};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::board::Signature;
use super::format::{Broker, DataKind, Envelope, FORMAT_VERSION, Header, HeaderOnly};
use crate::api::{self, BalanceSort, ExpectedSort, Excludes, Market, NetDirection, Percent, Ranking, RankingFigures, RankingInvestor, RankingMarket, SymbolCode, TradeUnit, TradingSession, Venue, ViewSpan, Won};
use crate::market_source::rankings::condition_key;

pub const DEFAULT_PAGES: u8 = 5;
pub const DEFAULT_PERIOD_SECS: u64 = 10;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedRankingRow {
    pub code: SymbolCode,
    pub name: String,
    pub price: Option<Won>,
    pub change_rate: Option<Percent>,
    pub figures: RankingFigures,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivedRanking {
    pub rows: Vec<SharedRankingRow>,
    pub pages: u8,
    pub end: bool,
    pub limited: bool,
    pub received_at: i64,
    pub broker: Broker,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ConditionState {
    Ready,
    Failed { at: i64, message: String },
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionEntry {
    pub key: String,
    pub state: ConditionState,
    pub last: Option<ReceivedRanking>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankingsPartBody {
    pub period_secs: u64,
    pub pages: u8,
    pub conditions: Vec<ConditionEntry>,
}

pub fn part_path(dir: &Path, observation_date: &str, key_name: &str) -> PathBuf {
    dir.join(DataKind::Rankings.folder()).join(observation_date).join(format!("{key_name}.json"))
}

pub fn default_rankings() -> Vec<Ranking> {
    let excludes = Excludes { etf_etn: false, preferred: false };
    let venue = Venue::Combined;
    let all_markets = [RankingMarket::All, RankingMarket::Kospi, RankingMarket::Kosdaq];
    let listed_markets = [Market::Kospi, Market::Kosdaq];
    let mut rankings = Vec::new();
    for market in all_markets {
        rankings.extend([
            Ranking::TradeAmount { market, venue, excludes, exclude_managed: false },
            Ranking::TradeVolume { market, venue, session: TradingSession::All, excludes, exclude_managed: false },
            Ranking::Turnover { market, venue, excludes, exclude_managed: false },
            Ranking::VolumeSurge { market, venue, baseline: api::SurgeBaseline::PreviousDay, sort: api::SurgeSort::SurgeRate, excludes, exclude_managed: false },
            Ranking::Gainers { market, venue, include_limit: true, min_trade_amount: api::MinTradeAmount::Any, excludes, exclude_managed: false },
            Ranking::Losers { market, venue, include_limit: true, min_trade_amount: api::MinTradeAmount::Any, excludes, exclude_managed: false },
            Ranking::Expected { market, venue, sort: ExpectedSort::Gainers, excludes, exclude_managed: false },
            Ranking::InvestorNetBuy { market, investor: RankingInvestor::Foreign, direction: NetDirection::NetBuy, unit: TradeUnit::Amount, excludes },
            Ranking::ForeignStreak { market, venue, direction: NetDirection::NetBuy, excludes },
            Ranking::CreditRatio { market, venue, excludes, exclude_managed: false },
        ]);
    }
    for market in listed_markets {
        rankings.push(Ranking::Program { market, venue, direction: NetDirection::NetBuy, excludes });
        rankings.push(Ranking::BidAskBalance { market, venue, sort: BalanceSort::NetBuyRemaining, excludes, exclude_managed: false });
    }
    rankings.push(Ranking::MostViewed { span: ViewSpan::Minute1, excludes });
    rankings
}

#[derive(Debug, Clone, PartialEq)]
pub struct MergedCondition {
    pub state: ConditionState,
    pub last: Option<ReceivedRanking>,
    pub part_key: String,
    pub part_as_of: i64,
    pub period_secs: u64,
    pub pages: u8,
}

impl MergedCondition {
    pub fn is_stale(&self, now: KstTime) -> bool {
        now.unix() - self.part_as_of > i64::try_from(self.period_secs.saturating_mul(2)).unwrap_or(i64::MAX)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MergedRankings {
    pub observation_date: String,
    pub parts: Vec<Header>,
    by_condition: HashMap<String, MergedCondition>,
}

impl MergedRankings {
    pub fn find(&self, ranking: &Ranking, pages: u8) -> Option<&MergedCondition> {
        self.by_condition.get(&condition_key(ranking)).filter(|found| found.pages >= pages)
    }

    pub fn len(&self) -> usize {
        self.by_condition.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_condition.is_empty()
    }
}

impl ReceivedRanking {
    pub fn covers(&self, pages: u8) -> bool {
        self.end || self.pages >= pages
    }
}

fn merge(observation_date: String, parts: &[Arc<Loaded>]) -> MergedRankings {
    let mut candidates: HashMap<String, Vec<MergedCondition>> = HashMap::new();
    for part in parts {
        for entry in &part.body.conditions {
            candidates.entry(entry.key.clone()).or_default().push(MergedCondition {
                state: entry.state.clone(),
                last: entry.last.clone(),
                part_key: part.key_name.clone(),
                part_as_of: part.header.as_of,
                period_secs: part.body.period_secs,
                pages: part.body.pages,
            });
        }
    }
    let by_condition = candidates
        .into_iter()
        .filter_map(|(key, held)| {
            let mut newest = held.iter().reduce(|best, next| if next.part_as_of > best.part_as_of { next } else { best })?.clone();
            let pages = newest.pages;
            newest.last = held.iter().filter_map(|condition| condition.last.as_ref()).filter(|last| last.covers(pages)).max_by_key(|last| last.received_at).cloned();
            Some((key, newest))
        })
        .collect();
    MergedRankings { observation_date, parts: parts.iter().map(|part| part.header.clone()).collect(), by_condition }
}

struct Loaded {
    key_name: String,
    header: Header,
    body: RankingsPartBody,
}

struct CachedPart {
    signature: Signature,
    loaded: Option<Arc<Loaded>>,
}

#[derive(Default)]
struct Seen {
    date: Option<String>,
    parts: HashMap<PathBuf, CachedPart>,
}

pub struct RankingsBoard {
    current: RwLock<Option<Arc<MergedRankings>>>,
    seen: Mutex<Seen>,
    errors: AtomicU64,
}

impl Default for RankingsBoard {
    fn default() -> Self {
        RankingsBoard::new()
    }
}

impl RankingsBoard {
    pub fn new() -> Self {
        RankingsBoard { current: RwLock::new(None), seen: Mutex::new(Seen::default()), errors: AtomicU64::new(0) }
    }

    pub fn current(&self) -> Option<Arc<MergedRankings>> {
        self.current.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn errors(&self) -> u64 {
        self.errors.load(Ordering::Relaxed)
    }

    pub fn age_secs(&self, now: KstTime) -> Option<i64> {
        let merged = self.current()?;
        merged.parts.iter().map(|header| now.unix() - header.as_of).min()
    }

    pub fn poll(&self, dir: &Path) {
        let Some((date, folder)) = newest_date_folder(dir) else { return };
        let files = fragment_files(&folder);
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        let same_date = seen.date.as_deref() == Some(date.as_str());
        let mut changed = !same_date;
        if !same_date {
            seen.parts.clear();
            seen.date = Some(date.clone());
        }
        let before = seen.parts.len();
        seen.parts.retain(|path, _| files.iter().any(|(candidate, _)| candidate == path));
        changed |= seen.parts.len() != before;
        for (path, key_name) in &files {
            let Ok(meta) = std::fs::metadata(path) else { continue };
            let signature = Signature::of(path.clone(), &meta);
            if seen.parts.get(path).is_some_and(|cached| cached.signature == signature) {
                continue;
            }
            changed = true;
            let previous = seen.parts.get(path).and_then(|cached| cached.loaded.clone());
            let loaded = match read_part(path, key_name) {
                Ok(loaded) => Some(Arc::new(loaded)),
                Err(reason) => {
                    self.errors.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(path = %path.display(), %reason, "순위 조각을 읽지 못해 이전 조각을 둡니다");
                    previous
                }
            };
            seen.parts.insert(path.clone(), CachedPart { signature, loaded });
        }
        if !changed {
            return;
        }
        let mut parts: Vec<Arc<Loaded>> = seen.parts.values().filter_map(|cached| cached.loaded.clone()).collect();
        parts.sort_by(|a, b| a.key_name.cmp(&b.key_name));
        drop(seen);
        let merged = (!parts.is_empty()).then(|| Arc::new(merge(date, &parts)));
        *self.current.write().unwrap_or_else(|e| e.into_inner()) = merged;
    }
}

fn newest_date_folder(dir: &Path) -> Option<(String, PathBuf)> {
    let entries = std::fs::read_dir(dir.join(DataKind::Rankings.folder())).ok()?;
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            KstDate::parse_yyyymmdd(&name)?;
            entry.file_type().ok()?.is_dir().then(|| (name, entry.path()))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
}

fn fragment_files(folder: &Path) -> Vec<(PathBuf, String)> {
    let Ok(entries) = std::fs::read_dir(folder) else { return Vec::new() };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let key_name = name.strip_suffix(".json")?;
            (!key_name.is_empty() && !key_name.starts_with('.')).then(|| (entry.path(), key_name.to_owned()))
        })
        .collect()
}

pub fn read_own_part(dir: &Path, observation_date: &str, key_name: &str) -> Option<RankingsPartBody> {
    read_part(&part_path(dir, observation_date, key_name), key_name).ok().map(|loaded| loaded.body)
}

fn read_part(path: &Path, key_name: &str) -> Result<Loaded, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let peek: HeaderOnly = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if peek.header.format_version != FORMAT_VERSION {
        return Err(format!("모르는 형식 버전 {}", peek.header.format_version));
    }
    if peek.header.kind != DataKind::Rankings {
        return Err("폴더와 자료 종류가 다릅니다".to_owned());
    }
    let Envelope { header, body } = parse::<RankingsPartBody>(&bytes)?;
    Ok(Loaded { key_name: key_name.to_owned(), header, body })
}

fn parse<B: DeserializeOwned>(bytes: &[u8]) -> Result<Envelope<B>, String> {
    serde_json::from_slice(bytes).map_err(|e| e.to_string())
}

pub fn broker_of_part(header: &Header) -> Option<Broker> {
    header.sources.first().map(|source| source.broker)
}
