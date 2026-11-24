use std::collections::{BTreeMap, HashMap};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use domain::{KstDate, KstTime};
use serde::Deserialize;

use crate::clock::kst;
use crate::shared_data::{FlowCursor, flow_folder, flow_links_path};

use super::kind::{CollectedKind, FidValues};

const READ_INTERVAL_SECS: i64 = 1;
const IDLE_EVICT_SECS: i64 = 60;
const STALE_LINK_MS: i64 = 90_000;
const FLOW_SUFFIX: &str = ".flow";

pub(super) struct FlowSnapshot<V> {
    pub generation: u64,
    pub snapshots: Vec<V>,
    pub gaps: Vec<[i64; 2]>,
    pub live: bool,
}

struct KeyTail {
    cursor: FlowCursor,
    first_row_ms: Option<i64>,
}

impl KeyTail {
    fn new(path: PathBuf) -> Self {
        Self { cursor: FlowCursor::new(path), first_row_ms: None }
    }
}

struct FlowTail<V> {
    generation: u64,
    keys: BTreeMap<String, KeyTail>,
    last_read: KstTime,
    last_used: KstTime,
    rows: Vec<(i64, V)>,
    gaps: Vec<[i64; 2]>,
    live: bool,
}

impl<V: Clone> FlowTail<V> {
    fn snapshot(&self) -> FlowSnapshot<V> {
        FlowSnapshot {
            generation: self.generation,
            snapshots: self.rows.iter().map(|(_, view)| view.clone()).collect(),
            gaps: self.gaps.clone(),
            live: self.live,
        }
    }
}

struct FlowState<V> {
    next_generation: u64,
    tails: HashMap<(String, String), FlowTail<V>>,
}

impl<V> FlowState<V> {
    fn new() -> Self {
        Self { next_generation: 1, tails: HashMap::new() }
    }

    fn alloc_generation(&mut self) -> u64 {
        let generation = self.next_generation;
        self.next_generation = self.next_generation.saturating_add(1);
        generation
    }
}

pub(super) struct FlowCache<K: CollectedKind> {
    state: Mutex<FlowState<K::View>>,
}

impl<K: CollectedKind> FlowCache<K> {
    pub(super) fn new() -> Self {
        Self { state: Mutex::new(FlowState::new()) }
    }

    pub(super) fn read(
        &self,
        shared_dir: &Path,
        date: KstDate,
        date_str: &str,
        symbol: &str,
        now: KstTime,
    ) -> Result<Option<FlowSnapshot<K::View>>, String> {
        let mut state = self.state.lock().expect("collected flow cache");
        state.tails.retain(|_, tail| now.unix() - tail.last_used.unix() < IDLE_EVICT_SECS);
        let cache_key = (date_str.to_owned(), symbol.to_owned());
        if let Some(tail) = state.tails.get_mut(&cache_key)
            && now.unix() - tail.last_read.unix() < READ_INTERVAL_SECS
        {
            tail.last_used = now;
            return Ok(Some(tail.snapshot()));
        }
        let discovered = list_key_files(shared_dir, date_str, K::TYPE_CODE, symbol)?;
        if discovered.is_empty() {
            state.tails.remove(&cache_key);
            return Ok(None);
        }
        let needs_reset = state.tails.get(&cache_key).is_none_or(|tail| {
            tail.keys.keys().any(|existing| !discovered.contains_key(existing))
        });
        if needs_reset {
            let generation = state.alloc_generation();
            let mut keys = BTreeMap::new();
            for (key, path) in discovered {
                keys.insert(key, KeyTail::new(path));
            }
            let mut tail = FlowTail {
                generation,
                keys,
                last_read: now,
                last_used: now,
                rows: Vec::new(),
                gaps: Vec::new(),
                live: false,
            };
            let new_rows = read_all_keys::<K>(&mut tail.keys, symbol)?;
            merge_into_rows(&mut tail.rows, new_rows);
            let (gaps, live) = compute_links_status(shared_dir, date, date_str, &tail.keys, now);
            tail.gaps = gaps;
            tail.live = live;
            let snapshot = tail.snapshot();
            state.tails.insert(cache_key, tail);
            return Ok(Some(snapshot));
        }
        let next_gen = state.next_generation;
        let tail = state.tails.get_mut(&cache_key).expect("tail exists");
        for (key, path) in discovered {
            tail.keys.entry(key).or_insert_with(|| KeyTail::new(path));
        }
        let new_rows = read_all_keys::<K>(&mut tail.keys, symbol)?;
        let reordered = merge_into_rows(&mut tail.rows, new_rows);
        let (gaps, live) = compute_links_status(shared_dir, date, date_str, &tail.keys, now);
        tail.gaps = gaps;
        tail.live = live;
        tail.last_read = now;
        tail.last_used = now;
        if reordered {
            tail.generation = next_gen;
        }
        let snapshot = tail.snapshot();
        if reordered {
            state.next_generation = next_gen.saturating_add(1);
        }
        Ok(Some(snapshot))
    }
}

pub(super) fn has_symbol_flow(shared_dir: &Path, date_str: &str, type_code: &str, symbol: &str) -> Result<bool, String> {
    Ok(!list_key_files(shared_dir, date_str, type_code, symbol)?.is_empty())
}

fn list_key_files(shared_dir: &Path, date_str: &str, type_code: &str, symbol: &str) -> Result<BTreeMap<String, PathBuf>, String> {
    let folder = flow_folder(shared_dir, date_str, type_code, symbol);
    let entries = match std::fs::read_dir(&folder) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => return Err(format!("{}를 읽을 수 없습니다: {e}", folder.display())),
    };
    let mut keys = BTreeMap::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("{} 항목을 읽을 수 없습니다: {e}", folder.display()))?;
        let Ok(name) = entry.file_name().into_string() else { continue };
        let Some(key) = name.strip_suffix(FLOW_SUFFIX) else { continue };
        if key.is_empty() {
            continue;
        }
        if entry.file_type().is_ok_and(|ft| ft.is_file()) {
            keys.insert(key.to_owned(), entry.path());
        }
    }
    Ok(keys)
}

fn read_all_keys<K: CollectedKind>(keys: &mut BTreeMap<String, KeyTail>, symbol: &str) -> Result<Vec<(i64, K::View)>, String> {
    let mut decoded: Vec<(i64, K::View)> = Vec::new();
    let mut skipped: u64 = 0;
    for (key, tail) in keys.iter_mut() {
        let blocks = match tail.cursor.read_new() {
            Ok(blocks) => blocks,
            Err(e) => {
                tracing::warn!(type_code = K::TYPE_CODE, symbol = %symbol, key = %key, reason = %e, "흐름 파일을 읽지 못해 건너뜁니다");
                continue;
            }
        };
        for block in blocks {
            for row in block.rows {
                tail.first_row_ms = Some(tail.first_row_ms.map_or(row.recv_ms, |prev| prev.min(row.recv_ms)));
                let values = FidValues::new(&block.description.fids, &row.values);
                match K::decode(row.recv_ms, &values) {
                    Some(view) => decoded.push((row.recv_ms, view)),
                    None => skipped += 1,
                }
            }
        }
    }
    if skipped > 0 {
        tracing::warn!(type_code = K::TYPE_CODE, symbol = %symbol, skipped, "흐름 행을 읽지 못해 건너뛰었습니다");
    }
    Ok(decoded)
}

fn merge_into_rows<V>(rows: &mut Vec<(i64, V)>, mut new_rows: Vec<(i64, V)>) -> bool {
    if new_rows.is_empty() {
        return false;
    }
    new_rows.sort_by_key(|(recv_ms, _)| *recv_ms);
    let mut deduped: Vec<(i64, V)> = Vec::with_capacity(new_rows.len());
    for (recv_ms, view) in new_rows {
        let sec = recv_ms.div_euclid(1000);
        if let Some(last) = deduped.last_mut()
            && last.0 == sec
        {
            last.1 = view;
        } else {
            deduped.push((sec, view));
        }
    }
    if rows.last().is_none_or(|(last_sec, _)| deduped[0].0 > *last_sec) {
        rows.extend(deduped);
        return false;
    }
    let mut by_sec: BTreeMap<i64, V> = rows.drain(..).collect();
    for (sec, view) in deduped {
        by_sec.insert(sec, view);
    }
    rows.extend(by_sec);
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum LinkEvent {
    Start,
    Live,
    Down,
    Alive,
    End,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct LinkLine {
    t: i64,
    event: LinkEvent,
}

fn read_links(path: &Path) -> Vec<LinkLine> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut events: Vec<LinkLine> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<LinkLine>(line).ok())
        .collect();
    events.sort_by_key(|line| line.t);
    events
}

fn key_coverage(events: &[LinkLine], now_ms: i64) -> (Vec<(i64, i64)>, bool) {
    let mut covered = Vec::new();
    let mut live_since: Option<i64> = None;
    let mut last_t: Option<i64> = None;
    for ev in events {
        match ev.event {
            LinkEvent::Start => {
                if let Some(start) = live_since.take() {
                    let end = last_t.unwrap_or(start);
                    if end > start {
                        covered.push((start, end));
                    }
                }
            }
            LinkEvent::Live => {
                if live_since.is_none() {
                    live_since = Some(ev.t);
                }
            }
            LinkEvent::Alive => {}
            LinkEvent::Down | LinkEvent::End => {
                if let Some(start) = live_since.take()
                    && ev.t > start
                {
                    covered.push((start, ev.t));
                }
            }
        }
        last_t = Some(ev.t);
    }
    let is_live = if let Some(start) = live_since {
        let last = last_t.unwrap_or(start);
        if now_ms - last > STALE_LINK_MS {
            if last > start {
                covered.push((start, last));
            }
            false
        } else {
            if now_ms > start {
                covered.push((start, now_ms));
            }
            true
        }
    } else {
        false
    };
    (covered, is_live)
}

fn compute_links_status(
    shared_dir: &Path,
    date: KstDate,
    date_str: &str,
    keys: &BTreeMap<String, KeyTail>,
    now: KstTime,
) -> (Vec<[i64; 2]>, bool) {
    let day_start_ms = kst(date, 8, 0, 0).unix() * 1000;
    let now_ms = now.unix() * 1000;
    let primary_key = keys
        .iter()
        .min_by_key(|(name, tail)| (tail.first_row_ms.unwrap_or(i64::MAX), name.as_str()))
        .map(|(name, _)| name.as_str());
    let mut all_covered: Vec<(i64, i64)> = Vec::new();
    let mut any_live = false;
    for (key, tail) in keys {
        let events = read_links(&flow_links_path(shared_dir, date_str, key));
        let (intervals, is_live) = key_coverage(&events, now_ms);
        let is_primary = primary_key == Some(key.as_str());
        if is_primary {
            all_covered.extend(intervals);
            if is_live {
                any_live = true;
            }
        } else if let Some(handoff_ms) = tail.first_row_ms {
            for (from, to) in intervals {
                if to > handoff_ms {
                    all_covered.push((from.max(handoff_ms), to));
                }
            }
            if is_live {
                any_live = true;
            }
        }
    }
    if now_ms <= day_start_ms {
        return (Vec::new(), any_live);
    }
    let gaps = complement_gaps(day_start_ms, now_ms, all_covered);
    (gaps, any_live)
}

fn complement_gaps(window_start_ms: i64, window_end_ms: i64, mut covered: Vec<(i64, i64)>) -> Vec<[i64; 2]> {
    covered.retain(|&(from, to)| to > window_start_ms && from < window_end_ms && to > from);
    covered.sort_unstable();
    let mut merged: Vec<(i64, i64)> = Vec::with_capacity(covered.len());
    for (from, to) in covered {
        let clamped_from = from.max(window_start_ms);
        let clamped_to = to.min(window_end_ms);
        if let Some(last) = merged.last_mut()
            && clamped_from <= last.1
        {
            last.1 = last.1.max(clamped_to);
        } else {
            merged.push((clamped_from, clamped_to));
        }
    }
    let mut gaps_ms: Vec<(i64, i64)> = Vec::new();
    let mut cursor = window_start_ms;
    for (from, to) in merged {
        if from > cursor {
            gaps_ms.push((cursor, from));
        }
        cursor = cursor.max(to);
    }
    if cursor < window_end_ms {
        gaps_ms.push((cursor, window_end_ms));
    }
    let mut gaps_sec: Vec<[i64; 2]> = Vec::with_capacity(gaps_ms.len());
    for (from_ms, to_ms) in gaps_ms {
        let from_s = from_ms.div_euclid(1000);
        let to_s = to_ms.div_euclid(1000);
        if to_s <= from_s {
            continue;
        }
        if let Some(last) = gaps_sec.last_mut()
            && from_s <= last[1]
        {
            last[1] = last[1].max(to_s);
        } else {
            gaps_sec.push([from_s, to_s]);
        }
    }
    gaps_sec
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collected::kind::Brokers;
    use crate::shared_data::{FlowDescription, FlowRow, FlowWriter, flow_path};

    fn ts(hour: u32, minute: u32, second: u32) -> KstTime {
        kst(KstDate::new(2026, 11, 24).unwrap(), hour, minute, second)
    }

    fn write_links_file(shared: &Path, key: &str, lines: &[(KstTime, &str)]) {
        let path = flow_links_path(shared, "20261124", key);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text: String = lines.iter().map(|(t, event)| format!("{{\"t\":{},\"event\":\"{event}\"}}\n", t.unix() * 1000)).collect();
        std::fs::write(path, text).unwrap();
    }

    fn sample_row(at: KstTime, qty: &str) -> FlowRow {
        let values = (141..=180)
            .map(|fid| match fid {
                151 => Some("키움증권".to_owned()),
                156 => Some("050".to_owned()),
                171 => Some(qty.to_owned()),
                _ => None,
            })
            .collect();
        FlowRow { recv_ms: at.unix() * 1000, values }
    }

    #[test]
    fn throttle_skips_reread_within_one_second_and_evicts_after_sixty_seconds() {
        let tmp = tempfile::tempdir().unwrap();
        let date = KstDate::new(2026, 11, 24).unwrap();
        let fids: Vec<u32> = (141..=180).collect();
        let path = flow_path(tmp.path(), "20261124", Brokers::TYPE_CODE, "005930", "k1");
        FlowWriter::open(&path, FlowDescription::new(Brokers::TYPE_CODE, "005930", "20261124", "k1", &fids))
            .unwrap()
            .append(&[sample_row(ts(9, 0, 1), "10")])
            .unwrap();
        write_links_file(tmp.path(), "k1", &[(ts(8, 0, 0), "live"), (ts(9, 59, 50), "alive")]);
        let cache: FlowCache<Brokers> = FlowCache::new();
        let first = cache.read(tmp.path(), date, "20261124", "005930", ts(10, 0, 0)).unwrap().unwrap();
        assert_eq!(first.snapshots.len(), 1);
        FlowWriter::open(&path, FlowDescription::new(Brokers::TYPE_CODE, "005930", "20261124", "k1", &fids))
            .unwrap()
            .append(&[sample_row(ts(9, 0, 2), "20")])
            .unwrap();
        let within_second = cache.read(tmp.path(), date, "20261124", "005930", ts(10, 0, 0)).unwrap().unwrap();
        assert_eq!(within_second.snapshots.len(), 1);
        let after_second = cache.read(tmp.path(), date, "20261124", "005930", ts(10, 0, 1)).unwrap().unwrap();
        assert_eq!(after_second.snapshots.len(), 2);
        assert_eq!(after_second.generation, first.generation);
        let after_evict = cache.read(tmp.path(), date, "20261124", "005930", ts(10, 1, 2)).unwrap().unwrap();
        assert_ne!(after_evict.generation, after_second.generation);
    }

    #[test]
    fn links_handle_crash_late_start_and_handoff() {
        let tmp = tempfile::tempdir().unwrap();
        let date = KstDate::new(2026, 11, 24).unwrap();
        write_links_file(
            tmp.path(),
            "k1",
            &[
                (ts(8, 5, 0), "live"),
                (ts(9, 0, 0), "alive"),
                (ts(9, 5, 0), "start"),
                (ts(9, 6, 0), "live"),
                (ts(9, 15, 0), "down"),
            ],
        );
        write_links_file(tmp.path(), "k2", &[(ts(8, 0, 0), "live"), (ts(9, 59, 50), "alive")]);
        let mut keys = BTreeMap::new();
        keys.insert("k1".to_owned(), KeyTail { cursor: FlowCursor::new(PathBuf::new()), first_row_ms: Some(ts(8, 10, 0).unix() * 1000) });
        keys.insert("k2".to_owned(), KeyTail { cursor: FlowCursor::new(PathBuf::new()), first_row_ms: Some(ts(9, 20, 0).unix() * 1000) });
        let (gaps, live) = compute_links_status(tmp.path(), date, "20261124", &keys, ts(10, 0, 0));
        assert!(live);
        assert_eq!(
            gaps,
            vec![
                [ts(8, 0, 0).unix(), ts(8, 5, 0).unix()],
                [ts(9, 0, 0).unix(), ts(9, 6, 0).unix()],
                [ts(9, 15, 0).unix(), ts(9, 20, 0).unix()],
            ]
        );
    }
}
