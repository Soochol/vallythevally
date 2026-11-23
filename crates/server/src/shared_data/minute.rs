use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use domain::KstDate;
use serde::{Deserialize, Serialize};

use super::format::{DataKind, FEED_EXTENSION, FORMAT_VERSION, Header};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MinuteVenue {
    Krx,
    Nxt,
    Combined,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MinuteInstrument {
    Stock,
    Index,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinuteBar {
    pub symbol: String,
    pub instrument: MinuteInstrument,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue: Option<MinuteVenue>,
    pub minute: u16,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: i64,
    pub value: i64,
    pub trades: u32,
    pub first_sec: u32,
    pub last_sec: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MinuteBarKey {
    pub symbol: String,
    pub instrument: MinuteInstrument,
    pub venue: Option<MinuteVenue>,
    pub minute: u16,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MinuteTrade {
    pub price: f64,
    pub volume: i64,
    pub value: i64,
    pub sec: u32,
}

impl MinuteBar {
    pub fn started_by(symbol: &str, instrument: MinuteInstrument, venue: Option<MinuteVenue>, minute: u16, trade: MinuteTrade) -> MinuteBar {
        MinuteBar {
            symbol: symbol.to_owned(),
            instrument,
            venue,
            minute,
            open: trade.price,
            high: trade.price,
            low: trade.price,
            close: trade.price,
            volume: trade.volume,
            value: trade.value,
            trades: 1,
            first_sec: trade.sec,
            last_sec: trade.sec,
        }
    }

    pub fn key(&self) -> MinuteBarKey {
        MinuteBarKey { symbol: self.symbol.clone(), instrument: self.instrument, venue: self.venue, minute: self.minute }
    }

    pub fn has_key(&self, symbol: &str, instrument: MinuteInstrument, venue: Option<MinuteVenue>, minute: u16) -> bool {
        self.symbol == symbol && self.instrument == instrument && self.venue == venue && self.minute == minute
    }

    pub fn absorb(&mut self, trade: MinuteTrade) {
        self.high = self.high.max(trade.price);
        self.low = self.low.min(trade.price);
        if trade.sec < self.first_sec {
            self.open = trade.price;
            self.first_sec = trade.sec;
        }
        if trade.sec >= self.last_sec {
            self.close = trade.price;
            self.last_sec = trade.sec;
        }
        self.volume += trade.volume;
        self.value += trade.value;
        self.trades += 1;
    }

    pub fn merged_with(&self, later: &MinuteBar) -> Option<MinuteBar> {
        if self.key() != later.key() {
            return None;
        }
        let open_from = if later.first_sec < self.first_sec { later } else { self };
        let close_from = if later.last_sec >= self.last_sec { later } else { self };
        Some(MinuteBar {
            open: open_from.open,
            high: self.high.max(later.high),
            low: self.low.min(later.low),
            close: close_from.close,
            volume: self.volume + later.volume,
            value: self.value + later.value,
            trades: self.trades + later.trades,
            first_sec: self.first_sec.min(later.first_sec),
            last_sec: self.last_sec.max(later.last_sec),
            ..self.clone()
        })
    }
}

pub fn minute_path(dir: &Path, observation_date: &str, key_name: &str) -> PathBuf {
    dir.join(DataKind::Minute.folder()).join(observation_date).join(format!("{key_name}.{FEED_EXTENSION}"))
}

pub const CELL_MINUTES: u16 = 5;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MinuteSeries {
    pub symbol: String,
    pub instrument: MinuteInstrument,
    pub venue: Option<MinuteVenue>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MinuteCell {
    pub start_minute: u16,
    pub close: f64,
    pub traded_won: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MinuteCells {
    pub cells: Vec<MinuteCell>,
    pub last_sec: u32,
}

impl MinuteCells {
    fn of_minutes(minutes: &BTreeMap<u16, MinuteBar>) -> MinuteCells {
        let mut cells: Vec<MinuteCell> = Vec::new();
        for (minute, bar) in minutes {
            let start_minute = minute - minute % CELL_MINUTES;
            let traded_won = u64::try_from(bar.value).unwrap_or(0);
            match cells.last_mut() {
                Some(cell) if cell.start_minute == start_minute => {
                    cell.close = bar.close;
                    cell.traded_won += traded_won;
                }
                _ => cells.push(MinuteCell { start_minute, close: bar.close, traded_won }),
            }
        }
        MinuteCells { cells, last_sec: minutes.values().map(|bar| bar.last_sec).max().unwrap_or(0) }
    }
}

struct Tail {
    identity: u64,
    offset: u64,
    head: Vec<u8>,
    rejected: bool,
}

impl Tail {
    fn fresh() -> Tail {
        Tail { identity: 0, offset: 0, head: Vec::new(), rejected: false }
    }
}

#[derive(Default)]
struct FileMinutes {
    tail: Option<Tail>,
    series: HashMap<MinuteSeries, BTreeMap<u16, MinuteBar>>,
}

#[derive(Default)]
struct Reading {
    day: Option<KstDate>,
    files: BTreeMap<String, FileMinutes>,
}

#[derive(Default)]
struct Published {
    day: Option<KstDate>,
    cells: HashMap<MinuteSeries, Arc<MinuteCells>>,
}

pub struct MinuteBook {
    reading: Mutex<Reading>,
    published: RwLock<Published>,
    errors: AtomicU64,
}

impl Default for MinuteBook {
    fn default() -> Self {
        MinuteBook::new()
    }
}

impl MinuteBook {
    pub fn new() -> MinuteBook {
        MinuteBook { reading: Mutex::new(Reading::default()), published: RwLock::new(Published::default()), errors: AtomicU64::new(0) }
    }

    pub fn errors(&self) -> u64 {
        self.errors.load(Ordering::Relaxed)
    }

    pub fn day(&self) -> Option<KstDate> {
        self.published.read().unwrap_or_else(|e| e.into_inner()).day
    }

    pub fn cells(&self, today: KstDate, series: &MinuteSeries) -> Option<Arc<MinuteCells>> {
        let published = self.published.read().unwrap_or_else(|e| e.into_inner());
        if published.day != Some(today) {
            return None;
        }
        published.cells.get(series).cloned()
    }

    pub fn poll(&self, dir: &Path) {
        let Some((day, folder)) = newest_day_folder(dir) else { return };
        let mut reading = self.reading.lock().unwrap_or_else(|e| e.into_inner());
        let mut changed: HashSet<MinuteSeries> = HashSet::new();
        let day_changed = reading.day != Some(day);
        if day_changed {
            *reading = Reading { day: Some(day), files: BTreeMap::new() };
        }
        let names = jsonl_names(&folder);
        let vanished: Vec<String> = reading.files.keys().filter(|name| !names.contains(name)).cloned().collect();
        for name in vanished {
            if let Some(gone) = reading.files.remove(&name) {
                changed.extend(gone.series.into_keys());
            }
        }
        for name in names {
            let file = reading.files.entry(name.clone()).or_default();
            let tail = file.tail.get_or_insert_with(Tail::fresh);
            let Some((reset, bars)) = read_tail(&folder.join(&name), tail, &self.errors) else { continue };
            if reset {
                changed.extend(file.series.drain().map(|(series, _)| series));
            }
            for mut bar in bars {
                let series = MinuteSeries { symbol: std::mem::take(&mut bar.symbol), instrument: bar.instrument, venue: bar.venue };
                file.series.entry(series.clone()).or_default().insert(bar.minute, bar);
                changed.insert(series);
            }
        }
        if changed.is_empty() && !day_changed {
            return;
        }
        let rebuilt: Vec<(MinuteSeries, Option<Arc<MinuteCells>>)> = changed.into_iter().map(|series| {
            let merged = merged_minutes(&reading.files, &series);
            let cells = (!merged.is_empty()).then(|| Arc::new(MinuteCells::of_minutes(&merged)));
            (series, cells)
        }).collect();
        let mut published = self.published.write().unwrap_or_else(|e| e.into_inner());
        if day_changed {
            *published = Published { day: Some(day), cells: HashMap::new() };
        }
        for (series, cells) in rebuilt {
            match cells {
                Some(cells) => published.cells.insert(series, cells),
                None => published.cells.remove(&series),
            };
        }
    }
}

fn merged_minutes(files: &BTreeMap<String, FileMinutes>, series: &MinuteSeries) -> BTreeMap<u16, MinuteBar> {
    let mut merged: BTreeMap<u16, MinuteBar> = BTreeMap::new();
    for bars in files.values().filter_map(|file| file.series.get(series)) {
        for (minute, bar) in bars {
            match merged.get_mut(minute) {
                Some(earlier) => {
                    if let Some(both) = earlier.merged_with(bar) {
                        *earlier = both;
                    }
                }
                None => {
                    merged.insert(*minute, bar.clone());
                }
            }
        }
    }
    merged
}

fn newest_day_folder(dir: &Path) -> Option<(KstDate, PathBuf)> {
    let entries = std::fs::read_dir(dir.join(DataKind::Minute.folder())).ok()?;
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let day = KstDate::parse_yyyymmdd(entry.file_name().to_str()?)?;
            Some((day, entry.path()))
        })
        .max_by_key(|(day, _)| *day)
}

fn jsonl_names(folder: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(folder) else { return Vec::new() };
    let mut names: Vec<String> = entries.filter_map(Result::ok).filter_map(|entry| entry.file_name().into_string().ok()).filter(|name| name.ends_with(&format!(".{FEED_EXTENSION}")) && !name.starts_with('.')).collect();
    names.sort();
    names
}

fn head_matches(file: &mut File, head: &[u8]) -> bool {
    let mut seen = vec![0; head.len()];
    file.seek(SeekFrom::Start(0)).and_then(|_| file.read_exact(&mut seen)).is_ok() && seen == head
}

fn header_problem(line: &[u8]) -> Option<String> {
    let header: Header = match serde_json::from_slice(line) {
        Ok(header) => header,
        Err(e) => return Some(e.to_string()),
    };
    if header.format_version != FORMAT_VERSION {
        return Some(format!("모르는 형식 버전 {}", header.format_version));
    }
    (header.kind != DataKind::Minute).then(|| "폴더와 자료 종류가 다릅니다".to_owned())
}

fn read_tail(path: &Path, tail: &mut Tail, errors: &AtomicU64) -> Option<(bool, Vec<MinuteBar>)> {
    let mut file = File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    let (len, identity) = (meta.len(), super::format::file_identity(&meta));
    let reset = tail.identity != identity || len < tail.offset || !head_matches(&mut file, &tail.head);
    if reset {
        *tail = Tail { identity, ..Tail::fresh() };
    }
    if tail.rejected || len == tail.offset {
        return reset.then(|| (true, Vec::new()));
    }
    let mut chunk = Vec::new();
    file.seek(SeekFrom::Start(tail.offset)).and_then(|_| file.read_to_end(&mut chunk)).ok()?;
    let complete = chunk.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    let mut bars = Vec::new();
    let mut header_pending = tail.offset == 0;
    let mut line_end = 0;
    for line in chunk[..complete].split(|b| *b == b'\n') {
        line_end += line.len() + 1;
        if line.is_empty() {
            continue;
        }
        if header_pending {
            header_pending = false;
            tail.head = chunk[..line_end].to_vec();
            if let Some(reason) = header_problem(line) {
                errors.fetch_add(1, Ordering::Relaxed);
                tracing::warn!(path = %path.display(), %reason, "분봉 파일의 머리를 읽지 못했습니다");
                tail.rejected = true;
                return Some((reset, Vec::new()));
            }
            continue;
        }
        match serde_json::from_slice::<MinuteBar>(line) {
            Ok(bar) => bars.push(bar),
            Err(e) => {
                errors.fetch_add(1, Ordering::Relaxed);
                tracing::warn!(path = %path.display(), error = %e, "분봉 파일의 줄을 건너뜁니다");
            }
        }
    }
    tail.offset += complete as u64;
    Some((reset, bars))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trade(price: f64, volume: i64, sec: u32) -> MinuteTrade {
        MinuteTrade { price, volume, value: price as i64 * volume, sec }
    }

    fn bar(first: MinuteTrade, rest: &[MinuteTrade]) -> MinuteBar {
        let mut bar = MinuteBar::started_by("005930", MinuteInstrument::Stock, Some(MinuteVenue::Krx), 540, first);
        for trade in rest {
            bar.absorb(*trade);
        }
        bar
    }

    #[test]
    fn a_bar_absorbs_trades_by_time_not_arrival() {
        let bar = bar(trade(100.0, 2, 30), &[trade(105.0, 1, 40), trade(98.0, 3, 10), trade(101.0, 4, 40)]);
        assert_eq!((bar.open, bar.high, bar.low, bar.close), (98.0, 105.0, 98.0, 101.0));
        assert_eq!((bar.volume, bar.value, bar.trades, bar.first_sec, bar.last_sec), (10, 200 + 105 + 294 + 404, 4, 10, 40));
    }

    #[test]
    fn merging_two_files_takes_the_open_of_the_earlier_and_the_close_of_the_later() {
        let first_key = bar(trade(100.0, 2, 5), &[trade(110.0, 1, 20)]);
        let second_key = bar(trade(90.0, 4, 30), &[trade(95.0, 1, 50)]);
        for merged in [first_key.merged_with(&second_key).unwrap(), second_key.merged_with(&first_key).unwrap()] {
            assert_eq!((merged.open, merged.high, merged.low, merged.close), (100.0, 110.0, 90.0, 95.0));
            assert_eq!((merged.volume, merged.value, merged.trades, merged.first_sec, merged.last_sec), (8, 200 + 110 + 360 + 95, 4, 5, 50));
        }
    }

    #[test]
    fn bars_of_different_keys_do_not_merge() {
        let stock = bar(trade(100.0, 1, 5), &[]);
        let mut other_minute = stock.clone();
        other_minute.minute += 1;
        let mut other_venue = stock.clone();
        other_venue.venue = Some(MinuteVenue::Nxt);
        assert_eq!(stock.merged_with(&other_minute), None);
        assert_eq!(stock.merged_with(&other_venue), None);
    }

    #[test]
    fn a_line_round_trips_and_leaves_out_the_venue_of_an_index() {
        let index = MinuteBar::started_by("001", MinuteInstrument::Index, None, 541, trade(2650.35, 10, 7));
        let text = serde_json::to_string(&index).unwrap();
        assert!(!text.contains("venue"));
        assert_eq!(serde_json::from_str::<MinuteBar>(&text).unwrap(), index);
    }

    fn write_file(dir: &Path, key: &str, bars: &[MinuteBar]) {
        let header = Header::new(DataKind::Minute, KstDate::new(2026, 11, 23).unwrap(), 1, 1, Vec::new());
        let mut writer = crate::shared_data::FeedWriter::open_at(&minute_path(dir, "20261123", key), header).unwrap();
        for bar in bars {
            writer.append(bar).unwrap();
        }
    }

    fn series() -> MinuteSeries {
        MinuteSeries { symbol: "005930".into(), instrument: MinuteInstrument::Stock, venue: Some(MinuteVenue::Krx) }
    }

    #[test]
    fn a_later_line_for_the_same_minute_replaces_the_earlier_one_inside_a_file_and_a_replaced_file_is_read_again() {
        let tmp = tempfile::tempdir().unwrap();
        let today = KstDate::new(2026, 11, 23).unwrap();
        let book = MinuteBook::new();
        write_file(tmp.path(), "k1", &[trade_bar(540, 100.0, 10, 5), trade_bar(540, 110.0, 25, 9)]);
        book.poll(tmp.path());
        let cells = book.cells(today, &series()).unwrap();
        assert_eq!(cells.cells, vec![MinuteCell { start_minute: 540, close: 110.0, traded_won: 25 }]);
        assert_eq!(cells.last_sec, 9);

        let path = minute_path(tmp.path(), "20261123", "k1");
        std::fs::remove_file(&path).unwrap();
        write_file(tmp.path(), "k1", &[trade_bar(541, 90.0, 7, 3)]);
        book.poll(tmp.path());
        assert_eq!(book.cells(today, &series()).unwrap().cells, vec![MinuteCell { start_minute: 540, close: 90.0, traded_won: 7 }]);
        assert_eq!(book.cells(KstDate::new(2026, 11, 24).unwrap(), &series()), None);
    }

    fn trade_bar(minute: u16, close: f64, value: i64, last_sec: u32) -> MinuteBar {
        MinuteBar { symbol: "005930".into(), instrument: MinuteInstrument::Stock, venue: Some(MinuteVenue::Krx), minute, open: close, high: close, low: close, close, volume: 1, value, trades: 1, first_sec: 0, last_sec }
    }

    #[test]
    fn a_cell_takes_the_close_of_its_latest_minute_and_sums_the_values_of_its_minutes() {
        let minutes: BTreeMap<u16, MinuteBar> = [trade_bar(541, 101.0, 4, 1), trade_bar(544, 104.0, 6, 2), trade_bar(545, 105.0, 8, 3)].into_iter().map(|bar| (bar.minute, bar)).collect();
        let cells = MinuteCells::of_minutes(&minutes);
        assert_eq!(cells.cells, vec![MinuteCell { start_minute: 540, close: 104.0, traded_won: 10 }, MinuteCell { start_minute: 545, close: 105.0, traded_won: 8 }]);
    }

    #[test]
    fn the_path_is_a_day_folder_with_one_file_per_key() {
        assert_eq!(minute_path(Path::new("/shared"), "20261123", "collect-01"), Path::new("/shared/minute/20261123/collect-01.jsonl"));
    }
}
