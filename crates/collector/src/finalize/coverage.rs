use std::collections::BTreeMap;
use std::io;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::calendar::Day;
use crate::plan::PlanFile;
use crate::protocol::{REGISTER_BATCH_SIZE, STOCK_ITEM_SUFFIX};
use crate::raw_read::{RawContent, RawItem, read_day_by_key};
use crate::supervise::journal_path;

const STOCKS_BATCH_SUFFIX: &str = "-stocks";
const HANDOFF_BATCH_PREFIX: &str = "handoff-";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Gap {
    pub from_ms: i64,
    pub to_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Handoff {
    pub at: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StockCoverage {
    pub code: String,
    pub planned: bool,
    pub key: Option<String>,
    pub excluded: bool,
    pub suspended: bool,
    pub registered: bool,
    pub received: bool,
    pub messages: u64,
    pub gaps: Vec<Gap>,
    pub handoff: Option<Handoff>,
}

impl StockCoverage {
    fn unplanned(code: &str) -> StockCoverage {
        StockCoverage {
            code: code.to_owned(),
            planned: false,
            key: None,
            excluded: false,
            suspended: false,
            registered: false,
            received: false,
            messages: 0,
            gaps: Vec::new(),
            handoff: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JournalFact {
    Handoff { at: String, at_ms: i64, from: String, to: String, stocks: Vec<String> },
    RegisterFailed { id: String, part: u32 },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeyTimeline {
    pub last_ms: i64,
    pub lives: Vec<i64>,
    pub gaps: Vec<Gap>,
}

pub type KeyTimelines = BTreeMap<Option<String>, KeyTimeline>;

pub struct CoverageInput<'a> {
    pub plan: Option<&'a PlanFile>,
    pub journal: &'a [JournalFact],
    pub timelines: &'a KeyTimelines,
    pub symbol_messages: &'a BTreeMap<String, u64>,
}

pub fn read_journal(data_dir: &Path, date: u32) -> io::Result<Vec<JournalFact>> {
    let text = match std::fs::read_to_string(journal_path(data_dir, date)) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    Ok(text.lines().filter_map(journal_fact).collect())
}

fn journal_fact(line: &str) -> Option<JournalFact> {
    let value: Value = serde_json::from_str(line).ok()?;
    let text = |name: &str| value.get(name).and_then(Value::as_str).map(str::to_owned);
    match value.get("event")?.as_str()? {
        "handoff" => {
            let at = text("at")?;
            let stocks = value.get("stocks")?.as_array()?.iter().filter_map(|stock| stock.as_str().map(str::to_owned)).collect();
            Some(JournalFact::Handoff { at_ms: stamp_unix_ms(&at)?, at, from: text("from")?, to: text("to")?, stocks })
        }
        "register_failed" => Some(JournalFact::RegisterFailed { id: text("id")?, part: u32::try_from(value.get("part")?.as_u64()?).ok()? }),
        _ => None,
    }
}

fn stamp_unix_ms(stamp: &str) -> Option<i64> {
    let number = |range: std::ops::Range<usize>| stamp.get(range)?.parse::<u32>().ok();
    let day = Day::from_ymd(u16::try_from(number(0..4)?).ok()?, u8::try_from(number(5..7)?).ok()?, u8::try_from(number(8..10)?).ok()?)?;
    Some(day.unix_ms_at_kst(number(11..13)?, number(14..16)?) + i64::from(number(17..19)?) * 1000)
}

pub fn read_timelines(data_dir: &Path, date: u32) -> io::Result<KeyTimelines> {
    let mut timelines = KeyTimelines::new();
    for (key, reader) in read_day_by_key(data_dir, date)? {
        timelines.insert(key, timeline_of(reader));
    }
    Ok(timelines)
}

fn timeline_of(items: impl Iterator<Item = RawItem>) -> KeyTimeline {
    let mut timeline = KeyTimeline::default();
    let mut down_since: Option<i64> = None;
    let mut saw_real = false;
    let mut seen_any = false;
    for item in items {
        let RawItem::Record(record) = item else { continue };
        match record.content {
            RawContent::Down { .. } => {
                down_since.get_or_insert(record.recv_ms);
            }
            RawContent::Live => {
                timeline.lives.push(record.recv_ms);
                match down_since.take() {
                    Some(start) => timeline.gaps.push(Gap { from_ms: start, to_ms: record.recv_ms }),
                    None if saw_real => timeline.gaps.push(Gap { from_ms: timeline.last_ms, to_ms: record.recv_ms }),
                    None => {}
                }
            }
            RawContent::Frame(text) => saw_real |= is_real_frame(&text),
            RawContent::Text(_) => {}
        }
        timeline.last_ms = if seen_any { timeline.last_ms.max(record.recv_ms) } else { record.recv_ms };
        seen_any = true;
    }
    if let Some(start) = down_since {
        timeline.gaps.push(Gap { from_ms: start, to_ms: timeline.last_ms });
    }
    timeline
}

fn is_real_frame(text: &str) -> bool {
    #[derive(serde::Deserialize)]
    struct Head<'a> {
        #[serde(borrow)]
        trnm: Option<std::borrow::Cow<'a, str>>,
    }
    serde_json::from_str::<Head<'_>>(text).is_ok_and(|head| head.trnm.as_deref() == Some("REAL"))
}

pub fn build_coverage(input: &CoverageInput<'_>) -> Vec<StockCoverage> {
    let mut stocks: BTreeMap<String, StockCoverage> = BTreeMap::new();
    if let Some(plan) = input.plan {
        for share in &plan.keys {
            for code in &share.stocks {
                let stock = stocks.entry(code.clone()).or_insert_with(|| StockCoverage::unplanned(code));
                stock.planned = true;
                stock.registered = true;
                stock.key = Some(share.name.as_str().to_owned());
            }
        }
        for code in &plan.excluded {
            let stock = stocks.entry(code.clone()).or_insert_with(|| StockCoverage::unplanned(code));
            stock.planned = true;
            stock.excluded = true;
        }
        for code in &plan.unregistered {
            let stock = stocks.entry(code.clone()).or_insert_with(|| StockCoverage::unplanned(code));
            stock.planned = true;
            stock.suspended = true;
        }
    }
    for code in failed_registrations(input) {
        if let Some(stock) = stocks.get_mut(&code) {
            stock.registered = false;
        }
    }
    let mut handoffs: BTreeMap<String, (String, String, i64)> = BTreeMap::new();
    for fact in input.journal {
        if let JournalFact::Handoff { at, at_ms, from, to, stocks: moved } = fact {
            for code in moved {
                stocks.entry(code.clone()).or_insert_with(|| StockCoverage::unplanned(code)).handoff =
                    Some(Handoff { at: at.clone(), from: from.clone(), to: to.clone() });
                handoffs.insert(code.clone(), (from.clone(), to.clone(), *at_ms));
            }
        }
    }
    for (symbol, messages) in input.symbol_messages {
        let Some(code) = symbol.strip_suffix(STOCK_ITEM_SUFFIX) else { continue };
        let stock = stocks.entry(code.to_owned()).or_insert_with(|| StockCoverage::unplanned(code));
        stock.messages = *messages;
        stock.received = *messages > 0;
    }
    for (code, stock) in &mut stocks {
        stock.gaps = gaps_of(stock, handoffs.get(code), input.timelines);
    }
    stocks.into_values().collect()
}

fn failed_registrations(input: &CoverageInput<'_>) -> Vec<String> {
    let mut failed = Vec::new();
    for fact in input.journal {
        let JournalFact::RegisterFailed { id, part } = fact else { continue };
        let Some(owner) = id.strip_suffix(STOCKS_BATCH_SUFFIX) else { continue };
        let registered: Vec<&String> = match owner.strip_prefix(HANDOFF_BATCH_PREFIX) {
            Some(from) => input
                .journal
                .iter()
                .filter_map(|fact| match fact {
                    JournalFact::Handoff { from: handed_from, stocks, .. } if handed_from == from => Some(stocks),
                    _ => None,
                })
                .flatten()
                .collect(),
            None => input
                .plan
                .iter()
                .flat_map(|plan| &plan.keys)
                .filter(|share| share.name.as_str() == owner)
                .flat_map(|share| &share.stocks)
                .collect(),
        };
        let start = *part as usize * REGISTER_BATCH_SIZE;
        failed.extend(registered.into_iter().skip(start).take(REGISTER_BATCH_SIZE).cloned());
    }
    failed
}

fn gaps_of(stock: &StockCoverage, handoff: Option<&(String, String, i64)>, timelines: &KeyTimelines) -> Vec<Gap> {
    if let Some((from, to, at_ms)) = handoff {
        let at_ms = *at_ms;
        let from_timeline = timelines.get(&Some(from.clone()));
        let to_timeline = timelines.get(&Some(to.clone()));
        let mut gaps = from_timeline.map(|timeline| timeline.gaps.clone()).unwrap_or_default();
        let from_last = from_timeline.map_or(at_ms, |timeline| timeline.last_ms);
        if let Some(to_timeline) = to_timeline {
            let resumed = to_timeline.lives.iter().copied().find(|live| *live >= at_ms).unwrap_or(to_timeline.last_ms);
            if resumed > from_last {
                gaps.push(Gap { from_ms: from_last, to_ms: resumed });
            }
            gaps.extend(to_timeline.gaps.iter().filter(|gap| gap.from_ms >= resumed).copied());
        }
        return coalesce(gaps);
    }
    let key = match (&stock.key, stock.planned) {
        (Some(key), _) => Some(key.clone()),
        (None, false) => None,
        (None, true) => return Vec::new(),
    };
    timelines.get(&key).map(|timeline| coalesce(timeline.gaps.clone())).unwrap_or_default()
}

fn coalesce(mut gaps: Vec<Gap>) -> Vec<Gap> {
    gaps.sort_by_key(|gap| (gap.from_ms, gap.to_ms));
    let mut merged: Vec<Gap> = Vec::new();
    for gap in gaps {
        match merged.last_mut() {
            Some(last) if gap.from_ms <= last.to_ms => last.to_ms = last.to_ms.max(gap.to_ms),
            _ => merged.push(gap),
        }
    }
    merged
}
