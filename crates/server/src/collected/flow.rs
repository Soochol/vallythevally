use std::collections::{BTreeMap, HashMap};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use domain::{KstDate, KstTime};

use crate::clock::kst;
use crate::collected_store::{FileStamp, read_path_stamp};
use crate::shared_data::{FlowCursor, FlowLinkEvent, FlowLinkLine, flow_folder, flow_links_path, read_flow_links};

use super::kind::{CollectedKind, FidValues};

const READ_INTERVAL_SECS: i64 = 1;
const IDLE_EVICT_SECS: i64 = 60;
const STALE_LINK_MS: i64 = 90_000;
const FLOW_SUFFIX: &str = ".flow";

pub(super) struct FlowSlice<V> {
    pub generation: u64,
    pub total: usize,
    pub snapshots: Vec<V>,
    pub gaps: Vec<[i64; 2]>,
    pub live: bool,
    pub reset: bool,
}

struct KeyTail {
    cursor: FlowCursor,
    first_row_ms: Option<i64>,
    links_stamp: Option<FileStamp>,
    link_events: Vec<FlowLinkLine>,
    last_error: Option<String>,
}

impl KeyTail {
    fn new(path: PathBuf) -> Self {
        Self {
            cursor: FlowCursor::new(path),
            first_row_ms: None,
            links_stamp: None,
            link_events: Vec::new(),
            last_error: None,
        }
    }

    fn refresh_links(&mut self, path: &Path) {
        let stamp = match read_path_stamp(path) {
            Ok(Some(stamp)) => stamp,
            Ok(None) => {
                self.links_stamp = None;
                self.link_events.clear();
                return;
            }
            Err(_) => return,
        };
        if self.links_stamp.as_ref() == Some(&stamp) {
            return;
        }
        if let Ok(mut events) = read_flow_links(path) {
            events.sort_by_key(|line| line.t);
            self.link_events = events;
            self.links_stamp = Some(stamp);
        }
    }
}

struct FlowTail<V> {
    initialized: bool,
    generation: u64,
    keys: BTreeMap<String, KeyTail>,
    last_read: KstTime,
    rows: Vec<(i64, V)>,
    gaps: Vec<[i64; 2]>,
    live: bool,
}

impl<V: Clone> FlowTail<V> {
    fn empty(now: KstTime) -> Self {
        Self {
            initialized: false,
            generation: 0,
            keys: BTreeMap::new(),
            last_read: now,
            rows: Vec::new(),
            gaps: Vec::new(),
            live: false,
        }
    }

    fn slice(&self, after: Option<(u64, usize)>) -> FlowSlice<V> {
        let total = self.rows.len();
        let (start, reset) = match after {
            Some((generation, index)) if generation == self.generation && index <= total => (index, false),
            _ => (0, true),
        };
        let snapshots = if start == total {
            Vec::new()
        } else {
            self.rows[start..].iter().map(|(_, view)| view.clone()).collect()
        };
        FlowSlice {
            generation: self.generation,
            total,
            snapshots,
            gaps: self.gaps.clone(),
            live: self.live,
            reset,
        }
    }
}

struct FlowEntry<V> {
    last_used: KstTime,
    tail: Arc<Mutex<FlowTail<V>>>,
}

type FlowEntries<V> = HashMap<(String, String), FlowEntry<V>>;

pub(super) struct FlowCache<K: CollectedKind> {
    next_generation: AtomicU64,
    entries: Mutex<FlowEntries<K::View>>,
}

struct FlowTarget<'a> {
    shared_dir: &'a Path,
    date: KstDate,
    date_str: &'a str,
    symbol: &'a str,
    now: KstTime,
}

impl<K: CollectedKind> FlowCache<K> {
    pub(super) fn new() -> Self {
        Self {
            next_generation: AtomicU64::new(1),
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn alloc_generation(&self) -> u64 {
        self.next_generation.fetch_add(1, Ordering::Relaxed)
    }

    pub(super) fn read(
        &self,
        shared_dir: &Path,
        date: KstDate,
        date_str: &str,
        symbol: &str,
        now: KstTime,
        after: Option<(u64, usize)>,
    ) -> Result<Option<FlowSlice<K::View>>, String> {
        self.with_tail(shared_dir, date, date_str, symbol, now, |tail| tail.slice(after))
    }

    pub(super) fn read_with<R>(
        &self,
        shared_dir: &Path,
        date: KstDate,
        date_str: &str,
        symbol: &str,
        now: KstTime,
        f: impl FnOnce(&[(i64, K::View)], &[[i64; 2]]) -> R,
    ) -> Result<Option<R>, String> {
        self.with_tail(shared_dir, date, date_str, symbol, now, |tail| f(&tail.rows, &tail.gaps))
    }

    fn with_tail<R>(
        &self,
        shared_dir: &Path,
        date: KstDate,
        date_str: &str,
        symbol: &str,
        now: KstTime,
        f: impl FnOnce(&FlowTail<K::View>) -> R,
    ) -> Result<Option<R>, String> {
        let cache_key = (date_str.to_owned(), symbol.to_owned());
        let tail_arc = {
            let mut entries = self.entries.lock().expect("collected flow cache");
            entries.retain(|_, entry| now.unix() - entry.last_used.unix() < IDLE_EVICT_SECS);
            match entries.get_mut(&cache_key) {
                Some(entry) => {
                    entry.last_used = now;
                    Arc::clone(&entry.tail)
                }
                None => {
                    let tail = Arc::new(Mutex::new(FlowTail::empty(now)));
                    entries.insert(cache_key.clone(), FlowEntry { last_used: now, tail: Arc::clone(&tail) });
                    tail
                }
            }
        };
        let mut tail = tail_arc.lock().expect("collected flow tail");
        if tail.initialized && now.unix() - tail.last_read.unix() < READ_INTERVAL_SECS {
            return Ok(Some(f(&tail)));
        }
        let discovered = list_key_files(shared_dir, date_str, K::TYPE_CODE, symbol)?;
        if discovered.is_empty() {
            drop(tail);
            let mut entries = self.entries.lock().expect("collected flow cache");
            if entries.get(&cache_key).is_some_and(|entry| Arc::ptr_eq(&entry.tail, &tail_arc)) {
                entries.remove(&cache_key);
            }
            return Ok(None);
        }
        let target = FlowTarget { shared_dir, date, date_str, symbol, now };
        let needs_reset = !tail.initialized || tail.keys.keys().any(|existing| !discovered.contains_key(existing));
        if needs_reset {
            self.rebuild_tail(&mut tail, discovered, target);
            return Ok(Some(f(&tail)));
        }
        for (key, path) in &discovered {
            tail.keys.entry(key.clone()).or_insert_with(|| KeyTail::new(path.clone()));
        }
        let (new_rows, restarted) = read_all_keys::<K>(&mut tail.keys, symbol);
        if restarted {
            self.rebuild_tail(&mut tail, discovered, target);
            return Ok(Some(f(&tail)));
        }
        let reordered = merge_into_rows(&mut tail.rows, new_rows);
        if reordered {
            tail.generation = self.alloc_generation();
        }
        let (gaps, live) = compute_links_status(shared_dir, date, date_str, &mut tail.keys, now);
        tail.gaps = gaps;
        tail.live = live;
        tail.last_read = now;
        Ok(Some(f(&tail)))
    }

    fn rebuild_tail(&self, tail: &mut FlowTail<K::View>, discovered: BTreeMap<String, PathBuf>, target: FlowTarget<'_>) {
        let generation = self.alloc_generation();
        let mut keys = BTreeMap::new();
        for (key, path) in discovered {
            keys.insert(key, KeyTail::new(path));
        }
        tail.initialized = true;
        tail.generation = generation;
        tail.keys = keys;
        tail.rows.clear();
        let (new_rows, _) = read_all_keys::<K>(&mut tail.keys, target.symbol);
        merge_into_rows(&mut tail.rows, new_rows);
        let (gaps, live) = compute_links_status(target.shared_dir, target.date, target.date_str, &mut tail.keys, target.now);
        tail.gaps = gaps;
        tail.live = live;
        tail.last_read = target.now;
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

fn read_all_keys<K: CollectedKind>(keys: &mut BTreeMap<String, KeyTail>, symbol: &str) -> (Vec<(i64, K::View)>, bool) {
    let mut decoded: Vec<(i64, K::View)> = Vec::new();
    let mut skipped: u64 = 0;
    let mut restarted = false;
    for (key, tail) in keys.iter_mut() {
        let prev_restarts = tail.cursor.restarts();
        let blocks = match tail.cursor.read_new() {
            Ok(blocks) => {
                tail.last_error = None;
                blocks
            }
            Err(e) => {
                let reason = e.to_string();
                if tail.last_error.as_deref() != Some(reason.as_str()) {
                    tracing::warn!(type_code = K::TYPE_CODE, symbol = %symbol, key = %key, reason = %reason, "흐름 파일을 읽지 못해 건너뜁니다");
                    tail.last_error = Some(reason);
                }
                continue;
            }
        };
        if tail.cursor.restarts() != prev_restarts {
            restarted = true;
        }
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
    (decoded, restarted)
}

fn merge_into_rows<V>(rows: &mut Vec<(i64, V)>, mut new_rows: Vec<(i64, V)>) -> bool {
    if new_rows.is_empty() {
        return false;
    }
    new_rows.sort_by_key(|(recv_ms, _)| *recv_ms);
    if rows.last().is_none_or(|(last_ms, _)| new_rows[0].0 >= *last_ms) {
        rows.extend(new_rows);
        return false;
    }
    rows.extend(new_rows);
    rows.sort_by_key(|(recv_ms, _)| *recv_ms);
    true
}

fn key_coverage(events: &[FlowLinkLine], now_ms: i64) -> (Vec<(i64, i64)>, bool) {
    let mut covered = Vec::new();
    let mut live_since: Option<i64> = None;
    let mut last_t: Option<i64> = None;
    for ev in events {
        match ev.event {
            FlowLinkEvent::Start => {
                if let Some(start) = live_since.take() {
                    let end = last_t.unwrap_or(start);
                    if end > start {
                        covered.push((start, end));
                    }
                }
            }
            FlowLinkEvent::Live => {
                if live_since.is_none() {
                    live_since = Some(ev.t);
                }
            }
            FlowLinkEvent::Alive => {}
            FlowLinkEvent::Down | FlowLinkEvent::End => {
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
    keys: &mut BTreeMap<String, KeyTail>,
    now: KstTime,
) -> (Vec<[i64; 2]>, bool) {
    let day_start_ms = kst(date, 8, 0, 0).unix() * 1000;
    let now_ms = now.unix() * 1000;
    let primary_key = keys
        .iter()
        .min_by_key(|(name, tail)| (tail.first_row_ms.unwrap_or(i64::MAX), name.as_str()))
        .map(|(name, _)| name.clone());
    let mut all_covered: Vec<(i64, i64)> = Vec::new();
    let mut any_live = false;
    for (key, tail) in keys.iter_mut() {
        tail.refresh_links(&flow_links_path(shared_dir, date_str, key));
        let (intervals, is_live) = key_coverage(&tail.link_events, now_ms);
        let is_primary = primary_key.as_deref() == Some(key.as_str());
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
        let first = cache.read(tmp.path(), date, "20261124", "005930", ts(10, 0, 0), None).unwrap().unwrap();
        assert_eq!((first.snapshots.len(), first.total, first.reset), (1, 1, true));
        FlowWriter::open(&path, FlowDescription::new(Brokers::TYPE_CODE, "005930", "20261124", "k1", &fids))
            .unwrap()
            .append(&[sample_row(ts(9, 0, 2), "20")])
            .unwrap();
        let within_second = cache
            .read(tmp.path(), date, "20261124", "005930", ts(10, 0, 0), Some((first.generation, first.total)))
            .unwrap()
            .unwrap();
        assert_eq!((within_second.snapshots.len(), within_second.total, within_second.reset), (0, 1, false));
        let after_second = cache
            .read(tmp.path(), date, "20261124", "005930", ts(10, 0, 1), Some((first.generation, first.total)))
            .unwrap()
            .unwrap();
        assert_eq!((after_second.snapshots.len(), after_second.total, after_second.reset), (1, 2, false));
        assert_eq!(after_second.generation, first.generation);
        let after_evict = cache
            .read(tmp.path(), date, "20261124", "005930", ts(10, 1, 2), Some((after_second.generation, after_second.total)))
            .unwrap()
            .unwrap();
        assert_ne!(after_evict.generation, after_second.generation);
        assert_eq!((after_evict.snapshots.len(), after_evict.total, after_evict.reset), (2, 2, true));
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
        let mut k1 = KeyTail::new(PathBuf::new());
        k1.first_row_ms = Some(ts(8, 10, 0).unix() * 1000);
        let mut k2 = KeyTail::new(PathBuf::new());
        k2.first_row_ms = Some(ts(9, 20, 0).unix() * 1000);
        keys.insert("k1".to_owned(), k1);
        keys.insert("k2".to_owned(), k2);
        let (gaps, live) = compute_links_status(tmp.path(), date, "20261124", &mut keys, ts(10, 0, 0));
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

    #[test]
    fn merge_keeps_same_second_rows_and_only_reorders_earlier_timestamps() {
        let mut rows = vec![(10_200, "a"), (10_500, "b")];
        assert!(!merge_into_rows(&mut rows, vec![(10_500, "c"), (10_900, "d")]));
        assert_eq!(rows, vec![(10_200, "a"), (10_500, "b"), (10_500, "c"), (10_900, "d")]);
        assert!(merge_into_rows(&mut rows, vec![(10_400, "x")]));
        assert_eq!(rows, vec![(10_200, "a"), (10_400, "x"), (10_500, "b"), (10_500, "c"), (10_900, "d")]);
    }

    #[test]
    fn refresh_links_preserves_complete_lines_before_torn_utf8_tail() {
        let tmp = tempfile::tempdir().unwrap();
        let path = flow_links_path(tmp.path(), "20261124", "k1");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut raw = format!("{{\"t\":{},\"event\":\"live\"}}\n{{\"t\":{},\"event\":\"alive\"}}\n", ts(8, 0, 0).unix() * 1000, ts(9, 0, 0).unix() * 1000).into_bytes();
        raw.extend_from_slice(b"{\"t\":9999999999999,\"event\":\"\xec\x95");
        std::fs::write(&path, raw).unwrap();
        let mut tail = KeyTail::new(PathBuf::new());
        tail.refresh_links(&path);
        assert_eq!(tail.link_events.len(), 2);
        assert_eq!(tail.link_events[0].event, FlowLinkEvent::Live);
        assert_eq!(tail.link_events[1].event, FlowLinkEvent::Alive);
    }

    #[test]
    fn read_with_borrows_cached_rows_and_gaps() {
        let tmp = tempfile::tempdir().unwrap();
        let date = KstDate::new(2026, 11, 24).unwrap();
        let fids: Vec<u32> = (141..=180).collect();
        let path = flow_path(tmp.path(), "20261124", Brokers::TYPE_CODE, "005930", "k1");
        FlowWriter::open(&path, FlowDescription::new(Brokers::TYPE_CODE, "005930", "20261124", "k1", &fids))
            .unwrap()
            .append(&[sample_row(ts(9, 0, 1), "10"), sample_row(ts(9, 0, 2), "25")])
            .unwrap();
        write_links_file(tmp.path(), "k1", &[(ts(8, 0, 0), "live"), (ts(9, 59, 50), "alive")]);
        let cache: FlowCache<Brokers> = FlowCache::new();
        let summary = cache
            .read_with(tmp.path(), date, "20261124", "005930", ts(10, 0, 0), |rows, gaps| (rows.len(), gaps.len()))
            .unwrap();
        assert_eq!(summary, Some((2, 0)));
        assert_eq!(cache.read_with(tmp.path(), date, "20261124", "000660", ts(10, 0, 0), |rows, _| rows.len()).unwrap(), None);
    }
}
