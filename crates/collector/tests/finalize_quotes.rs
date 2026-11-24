use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use collector::calendar::Day;
use collector::finalize::{self, store_dir};
use collector::keys::KeyRole;
use collector::plan::{InputSummary, KeyShare, MARKET_TYPES, PlanFile, write_plan};
use collector::protocol::KeyName;
use collector::raw_write::{RawLine, RawWriter};
use serde_json::{Map, json};
use server::shared_data::{BookLevel, BookRow, ClosedQuotes, LiveQuoteWriter, QuoteDay, QuoteMinuteBuilder, closed_day_dir, live_day_dir, read_quote_day, write_closed_quotes};
use tempfile::{TempDir, tempdir};

const DATE: u32 = 20_261_124;
const EARLIER: u32 = 20_261_120;
const UNFINISHED: u32 = 20_261_119;
const ALREADY: u32 = 20_261_118;
const BUSY: &str = "000010";
const KRX_ONLY: &str = "000020";
const SILENT: &str = "000030";
const EXCLUDED: &str = "300001";

type Level = (i64, i64, i64);

#[derive(Clone)]
struct Quote {
    time: &'static str,
    asks: Vec<Level>,
    bids: Vec<Level>,
}

impl Quote {
    fn frame(&self, code: &str) -> String {
        let mut values = Map::new();
        values.insert("21".to_owned(), json!(self.time));
        for (price_fid, qty_fid, krx_fid, nxt_fid, levels, sign) in [(41, 61, 6044, 6066, &self.asks, "+"), (51, 71, 6054, 6076, &self.bids, "-")] {
            for (index, (price, krx, nxt)) in levels.iter().enumerate() {
                let mut put = |fid: usize, text: String| values.insert((fid + index).to_string(), json!(text));
                put(price_fid, format!("{sign}{price}"));
                put(qty_fid, (krx + nxt).to_string());
                put(krx_fid, krx.to_string());
                put(nxt_fid, nxt.to_string());
            }
        }
        json!({"trnm": "REAL", "data": [{"type": "0D", "item": format!("{code}_AL"), "values": values}]}).to_string()
    }

    fn row(&self) -> BookRow {
        let side = |levels: &[Level]| {
            let mut filled = [BookLevel::default(); 10];
            for (slot, (price, krx, nxt)) in filled.iter_mut().zip(levels) {
                *slot = BookLevel { price: *price, combined: krx + nxt, krx: *krx, nxt: *nxt };
            }
            filled
        };
        let part = |range: std::ops::Range<usize>| self.time[range].parse::<u32>().unwrap();
        BookRow { sec: part(0..2) * 3600 + part(2..4) * 60 + part(4..6), asks: side(&self.asks), bids: side(&self.bids) }
    }
}

fn wide(time: &'static str, best_ask: Level, best_bid: Level) -> Quote {
    Quote {
        time,
        asks: vec![best_ask, (10_200, 3, 1), (10_300, 4, 0), (10_400, 0, 6)],
        bids: vec![best_bid, (9_800, 2, 2), (9_700, 5, 0), (9_600, 0, 7)],
    }
}

fn busy_quotes() -> Vec<Quote> {
    vec![
        wide("090005", (10_100, 100, 40), (9_900, 10, 10)),
        wide("090031", (10_100, 20, 300), (9_900, 80, 10)),
        wide("090059", (10_110, 7, 8), (9_950, 9, 1)),
        wide("090101", (10_110, 70, 80), (9_950, 90, 10)),
        Quote { time: "090158", asks: vec![(10_100, 9_000, 0)], bids: vec![(9_900, 8_000, 0)] },
    ]
}

fn krx_only_quotes() -> Vec<Quote> {
    let levels = |base: i64, step: i64| (0..10).map(|index| (base + step * index, 11 + index, 0)).collect::<Vec<Level>>();
    vec![Quote { time: "091500", asks: levels(5_010, 10), bids: levels(5_000, -10) }]
}

fn folded(quotes: &[Quote]) -> Vec<server::shared_data::QuoteMinute> {
    let mut builders: std::collections::BTreeMap<u16, QuoteMinuteBuilder> = Default::default();
    for row in quotes.iter().map(Quote::row) {
        builders.entry(row.minute()).or_insert_with(|| QuoteMinuteBuilder::new(row.minute())).take(&row);
    }
    builders.into_values().map(|builder| builder.finish().unwrap()).collect()
}

fn day_text(date: u32) -> String {
    date.to_string()
}

fn at_ms(date: u32, hour: u32, minute: u32, second: i64) -> i64 {
    Day::from_yyyymmdd(date).unwrap().unix_ms_at_kst(hour, minute) + second * 1000
}

fn key(name: &str) -> KeyName {
    KeyName::parse(name).unwrap()
}

fn write_day_plan(data: &Path, date: u32) {
    let share = |name: &str, role: KeyRole, stocks: &[&str], market: bool| KeyShare {
        name: key(name),
        role,
        app_key_hash: format!("hash-{name}"),
        stocks: stocks.iter().map(|code| (*code).to_owned()).collect(),
        market_types: if market { MARKET_TYPES.to_vec() } else { Vec::new() },
        rest_jobs: Vec::new(),
        load: 0,
    };
    let plan = PlanFile {
        format_version: 1,
        date,
        created_at: "2026-11-24T07:35:00+09:00".to_owned(),
        input: InputSummary { active_keys: 2, universe_replaced: None },
        keys: vec![share("collect-01", KeyRole::Collecting, &[BUSY, KRX_ONLY, SILENT], true), share("spare-01", KeyRole::Spare, &[], false)],
        excluded: vec![EXCLUDED.to_owned()],
        unregistered: Vec::new(),
        alerts: Vec::new(),
    };
    write_plan(data, &plan).unwrap();
}

fn write_raw(data: &Path, date: u32) {
    let mut writer = RawWriter::for_key(data, key("collect-01"));
    let base = at_ms(date, 9, 0, 0);
    let mut frame = |offset: i64, text: &str| writer.write(&RawLine::Frame { recv_ms: base + offset, text }).unwrap();
    frame(0, &json!({"trnm": "LOGIN", "return_code": 0}).to_string());
    frame(100, &json!({"trnm": "REG", "return_code": 0}).to_string());
    for (index, quote) in busy_quotes().iter().enumerate() {
        frame(1_000 + index as i64 * 100, &quote.frame(BUSY));
    }
    frame(1_900, &json!({"trnm": "REAL", "data": [{"type": "0D", "item": format!("{BUSY}_AL"), "values": {"21": "", "41": "+1", "61": "999999"}}]}).to_string());
    for quote in krx_only_quotes() {
        frame(2_000, &quote.frame(KRX_ONLY));
    }
    writer.write(&RawLine::Live { recv_ms: base + 2_100 }).unwrap();
    writer.write(&RawLine::Down { recv_ms: base + 60_000, reason: "연결 끊김" }).unwrap();
    writer.write(&RawLine::Live { recv_ms: base + 95_000 }).unwrap();
    writer.close().unwrap();
}

fn prepared_day(data: &Path, date: u32) {
    write_day_plan(data, date);
    write_raw(data, date);
}

struct Place {
    _folder: TempDir,
    data: PathBuf,
    shared: PathBuf,
}

fn place() -> Place {
    let folder = tempdir().unwrap();
    let (data, shared) = (folder.path().join("data"), folder.path().join("shared"));
    fs::create_dir_all(&data).unwrap();
    Place { data, shared, _folder: folder }
}

fn finalize_with(place: &Place, date: u32, extra: &[&str]) -> String {
    let mut arguments: Vec<String> = ["--data", &place.data.to_string_lossy(), "--date", &date.to_string(), "--buckets", "16", "--threads", "2", "--shared", &place.shared.to_string_lossy()].map(str::to_owned).to_vec();
    arguments.extend(extra.iter().map(|argument| (*argument).to_owned()));
    exit_text(finalize::run(&arguments))
}

fn exit_text(code: ExitCode) -> String {
    format!("{code:?}")
}

fn success() -> String {
    exit_text(ExitCode::SUCCESS)
}

fn read(place: &Place, date: u32, code: &str) -> Option<QuoteDay> {
    read_quote_day(&place.shared, &day_text(date), code).unwrap()
}

#[test]
fn a_closed_day_holds_the_fold_of_its_books() {
    let place = place();
    prepared_day(&place.data, DATE);
    assert_eq!(finalize_with(&place, DATE, &[]), success());
    let busy = read(&place, DATE, BUSY).unwrap();
    assert!(busy.closed);
    assert_eq!(busy.minutes, folded(&busy_quotes()));
    assert!(busy.minutes[1].single_price);
    assert_eq!(busy.minutes[0].combined.close.ask_total(), 15 + 4 + 4 + 6);
    assert_eq!(busy.minutes[0].nxt.price_max.asks[0], server::shared_data::LevelQty(10_100, 300));
    let krx_only = read(&place, DATE, KRX_ONLY).unwrap();
    assert_eq!(krx_only.minutes, folded(&krx_only_quotes()));
    assert_eq!(krx_only.minutes[0].combined.close.asks.len(), 10);
}

#[test]
fn gaps_and_silent_stocks_come_from_the_complete_file() {
    let place = place();
    prepared_day(&place.data, DATE);
    assert_eq!(finalize_with(&place, DATE, &[]), success());
    let outage = vec![(9 * 3600 + 60, 9 * 3600 + 95)];
    assert_eq!(read(&place, DATE, BUSY).unwrap().gaps, outage);
    let silent = read(&place, DATE, SILENT).unwrap();
    assert!(silent.closed && silent.minutes.is_empty());
    assert_eq!(silent.gaps, outage);
    assert_eq!(read(&place, DATE, EXCLUDED), None);
    assert_eq!(read(&place, DATE, "999999"), None);
}

#[test]
fn complete_days_without_closed_quotes_are_filled_and_live_files_go_away() {
    let place = place();
    prepared_day(&place.data, EARLIER);
    assert_eq!(finalize_with(&place, EARLIER, &[]), success());
    fs::remove_dir_all(closed_day_dir(&place.shared, &day_text(EARLIER))).unwrap();

    let copied = store_dir(&place.data, ALREADY);
    fs::create_dir_all(copied.parent().unwrap()).unwrap();
    copy_folder(&store_dir(&place.data, EARLIER), &copied);
    let kept = ClosedQuotes { minutes: Vec::new(), gaps: vec![(1, 2)] };
    write_closed_quotes(&closed_day_dir(&place.shared, &day_text(ALREADY)), &day_text(ALREADY), BUSY, &kept).unwrap();
    let kept_file = closed_day_dir(&place.shared, &day_text(ALREADY)).join(format!("{BUSY}.json.gz"));
    let kept_bytes = fs::read(&kept_file).unwrap();

    let unfinished = store_dir(&place.data, UNFINISHED);
    copy_folder(&store_dir(&place.data, EARLIER), &unfinished);
    fs::remove_file(unfinished.join("complete.json")).unwrap();

    prepared_day(&place.data, DATE);
    let mut live = LiveQuoteWriter::open(&place.shared, &day_text(DATE), "collect-01", 1).unwrap();
    live.append_minute(BUSY, &folded(&busy_quotes())[0]).unwrap();
    let half = closed_day_dir(&place.shared, &format!("{DATE}.tmp"));
    write_closed_quotes(&half, &day_text(DATE), "777777", &ClosedQuotes::default()).unwrap();

    assert_eq!(finalize_with(&place, DATE, &[]), success());
    for date in [EARLIER, DATE] {
        assert_eq!(read(&place, date, BUSY).unwrap().minutes, folded(&busy_quotes()), "{date}");
    }
    assert_eq!(read(&place, UNFINISHED, BUSY), None);
    assert_eq!(fs::read(&kept_file).unwrap(), kept_bytes);
    assert!(!live_day_dir(&place.shared, &day_text(DATE)).exists());
    assert!(!half.exists());
    assert_eq!(read(&place, DATE, "777777"), None);

    write_closed_quotes(&closed_day_dir(&place.shared, &day_text(DATE)), &day_text(DATE), "888888", &ClosedQuotes::default()).unwrap();
    assert_eq!(finalize_with(&place, DATE, &[]), success());
    assert_eq!(read(&place, DATE, "888888"), None);
    assert_eq!(read(&place, DATE, BUSY).unwrap().minutes, folded(&busy_quotes()));
    let mut names: Vec<String> = fs::read_dir(place.shared.join("quote-minutes")).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
    names.sort();
    assert_eq!(names, [ALREADY, EARLIER, DATE].map(day_text), "비켜 둔 폴더가 남지 않는다");
}

fn copy_folder(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_folder(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

#[test]
fn a_failure_to_write_quotes_exits_with_3_after_the_day_is_complete() {
    let place = place();
    prepared_day(&place.data, DATE);
    fs::write(&place.shared, "폴더가 아니다").unwrap();
    assert_eq!(finalize_with(&place, DATE, &[]), exit_text(ExitCode::from(3)));
    assert!(store_dir(&place.data, DATE).join("complete.json").is_file());

    fs::remove_file(&place.shared).unwrap();
    assert_eq!(finalize_with(&place, DATE, &["--verify-only"]), success());
    assert!(!closed_day_dir(&place.shared, &day_text(DATE)).exists());
    assert_eq!(finalize_with(&place, DATE, &[]), success());
    assert!(read(&place, DATE, BUSY).is_some());

    let without_option: Vec<String> = ["--data", &place.data.to_string_lossy(), "--date", &DATE.to_string(), "--buckets", "16"].map(str::to_owned).to_vec();
    assert_eq!(exit_text(finalize::run(&without_option)), success());
    assert!(closed_day_dir(&place.data.join("shared"), &day_text(DATE)).is_dir());
}
