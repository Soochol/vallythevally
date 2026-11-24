use std::fs::OpenOptions;
use std::io::Write;

use domain::KstDate;
use server::shared_data::{
    BookLevel, BookRow, ClosedQuotes, CurrentQuotes, Ladder, LevelQty, LiveQuoteWriter, MinuteVenue, QuoteMinute, QuoteMinuteBuilder, VenueQuote, closed_day_dir, live_day_dir, quote_days,
    read_quote_day, write_closed_quotes,
};

const DATE: &str = "20261124";
const MINUTE: u16 = 541;
const START: u32 = 541 * 60;

type Level = (i64, i64, i64);

fn side(levels: &[Level]) -> [BookLevel; 10] {
    let mut filled = [BookLevel::default(); 10];
    for (slot, (price, krx, nxt)) in filled.iter_mut().zip(levels) {
        *slot = BookLevel { price: *price, combined: krx + nxt, krx: *krx, nxt: *nxt };
    }
    filled
}

fn row(sec: u32, asks: &[Level], bids: &[Level]) -> BookRow {
    BookRow { sec: START + sec, asks: side(asks), bids: side(bids) }
}

fn wide(sec: u32, ask: Level, bid: Level) -> BookRow {
    let asks = [ask, (10_200, 1, 1), (10_300, 1, 1), (10_400, 1, 1)];
    let bids = [bid, (9_800, 1, 1), (9_700, 1, 1), (9_600, 1, 1)];
    row(sec, &asks, &bids)
}

fn built(rows: &[BookRow]) -> QuoteMinute {
    let mut builder = QuoteMinuteBuilder::new(MINUTE);
    rows.iter().for_each(|row| builder.take(row));
    builder.finish().unwrap()
}

fn levels(pairs: &[(i64, i64)]) -> Vec<LevelQty> {
    pairs.iter().map(|(price, qty)| LevelQty(*price, *qty)).collect()
}

fn ladder(asks: &[(i64, i64)], bids: &[(i64, i64)]) -> Ladder {
    Ladder { asks: levels(asks), bids: levels(bids) }
}

fn plain(minute: u16, sec: u32, ask: i64) -> QuoteMinute {
    let close = ladder(&[(10_100, ask)], &[(9_900, 5)]);
    let quote = VenueQuote { close: close.clone(), peak: close.clone(), price_max: close };
    QuoteMinute { minute, close_sec: sec, single_price: false, combined: quote.clone(), krx: quote, nxt: VenueQuote::default() }
}

#[test]
fn the_last_book_of_the_minute_is_its_close() {
    let first = wide(5, (10_100, 900, 900), (9_900, 900, 900));
    let last = row(58, &[(10_100, 30, 12), (10_200, 4, 0), (10_300, 0, 7), (10_400, 1, 1)], &[(10_000, 20, 5), (9_900, 0, 3), (9_800, 6, 0), (9_700, 1, 1)]);
    assert_eq!(QuoteMinuteBuilder::new(MINUTE).finish(), None);
    assert_eq!(last.minute(), MINUTE);
    let minute = built(&[first, last]);
    assert_eq!((minute.minute, minute.close_sec, minute.single_price), (MINUTE, START + 58, false));
    assert_eq!(minute.combined.close, ladder(&[(10_100, 42), (10_200, 4), (10_300, 7), (10_400, 2)], &[(10_000, 25), (9_900, 3), (9_800, 6), (9_700, 2)]));
    assert_eq!(minute.venue(MinuteVenue::Krx).close, ladder(&[(10_100, 30), (10_200, 4), (10_400, 1)], &[(10_000, 20), (9_800, 6), (9_700, 1)]));
    assert_eq!(minute.venue(MinuteVenue::Nxt).close, ladder(&[(10_100, 12), (10_300, 7), (10_400, 1)], &[(10_000, 5), (9_900, 3), (9_700, 1)]));
    assert_eq!((minute.combined.close.ask_total(), minute.combined.close.bid_total()), (55, 36));
    let krx_only = built(&[row(1, &[(1, 5, 0), (2, 5, 0), (3, 5, 0), (4, 5, 0)], &[])]);
    assert!(krx_only.nxt.close.is_empty() && krx_only.nxt.peak.is_empty() && krx_only.nxt.price_max.is_empty());
    assert_eq!(krx_only.combined, krx_only.krx);
}

#[test]
fn single_price_books_mark_the_close_and_stay_out_of_the_maxima() {
    let normal = wide(10, (10_100, 10, 0), (9_900, 10, 0));
    let auction = row(20, &[(10_100, 5_000, 0), (10_200, 1, 0), (10_300, 1, 0)], &[(9_900, 7_000, 0), (9_800, 1, 0), (9_700, 1, 0)]);
    let empty = row(59, &[], &[]);
    assert!(!normal.is_single_price() && auction.is_single_price() && empty.is_single_price());
    let one_sided = row(1, &[(10_100, 1, 0)], &[(9_900, 1, 0), (9_800, 1, 0), (9_700, 1, 0), (9_600, 1, 0)]);
    assert!(!one_sided.is_single_price());

    let with_auction = built(&[normal, auction]);
    assert!(with_auction.single_price);
    assert_eq!(with_auction.combined.close.ask_total(), 5_002);
    assert_eq!(with_auction.krx.peak, built(&[normal]).krx.peak);
    assert_eq!(with_auction.combined.price_max, built(&[normal]).combined.price_max);

    let emptied = built(&[normal, auction, empty]);
    assert!(emptied.single_price && emptied.combined.close.is_empty());
    assert_eq!(emptied.close_sec, START + 59);

    let only_auction = built(&[auction]);
    assert!(only_auction.single_price && only_auction.combined.peak.is_empty() && only_auction.combined.price_max.is_empty());

    let reopened = built(&[auction, normal]);
    assert!(!reopened.single_price);
    assert_eq!(reopened.combined.close, built(&[normal]).combined.close);
}

#[test]
fn price_max_keeps_the_largest_size_of_each_price_per_venue() {
    let krx_heavy = wide(1, (10_100, 100, 10), (9_900, 40, 0));
    let nxt_heavy = wide(2, (10_100, 30, 90), (9_900, 0, 70));
    let moved = row(3, &[(10_050, 8, 0), (10_200, 1, 1), (10_300, 1, 1), (10_400, 50, 1)], &[(9_950, 6, 6), (9_800, 1, 1), (9_700, 1, 1), (9_600, 1, 1)]);
    let minute = built(&[krx_heavy, nxt_heavy, moved]);
    assert_eq!(
        minute.combined.price_max,
        ladder(&[(10_050, 8), (10_100, 120), (10_200, 2), (10_300, 2), (10_400, 51)], &[(9_950, 12), (9_900, 70), (9_800, 2), (9_700, 2), (9_600, 2)])
    );
    assert_eq!(minute.krx.price_max.asks, levels(&[(10_050, 8), (10_100, 100), (10_200, 1), (10_300, 1), (10_400, 50)]));
    assert_eq!(minute.nxt.price_max.bids, levels(&[(9_950, 6), (9_900, 70), (9_800, 1), (9_700, 1), (9_600, 1)]));
}

#[test]
fn peak_book_is_the_moment_with_the_largest_total_per_venue() {
    let krx_peak = wide(1, (10_100, 300, 0), (9_900, 0, 0));
    let combined_peak = wide(2, (10_100, 200, 250), (9_900, 0, 0));
    let tie = wide(3, (10_100, 0, 0), (9_900, 200, 250));
    let last = wide(4, (10_100, 1, 1), (9_900, 1, 1));
    let minute = built(&[krx_peak, combined_peak, tie, last]);
    assert_eq!(minute.krx.peak, built(&[krx_peak]).krx.close);
    assert_eq!(minute.combined.peak, built(&[combined_peak]).combined.close);
    assert_eq!(minute.nxt.peak, built(&[combined_peak]).nxt.close);
}

#[test]
fn two_halves_of_a_minute_merge_into_the_whole() {
    let rows = [
        wide(1, (10_100, 300, 5), (9_900, 1, 1)),
        wide(2, (10_100, 10, 400), (9_900, 2, 2)),
        wide(31, (10_100, 50, 50), (9_900, 90, 900)),
        wide(59, (10_100, 7, 8), (9_900, 3, 4)),
    ];
    let whole = built(&rows);
    let (early, late) = (built(&rows[..2]), built(&rows[2..]));
    assert_eq!(early.merged_with(&late).as_ref(), Some(&whole));

    let mut resumed = QuoteMinuteBuilder::resumed(early.clone());
    assert_eq!(resumed.finish().as_ref(), Some(&early));
    rows[2..].iter().for_each(|row| resumed.take(row));
    assert_eq!(resumed.finish().unwrap(), whole);

    let elsewhere = QuoteMinute { minute: MINUTE + 1, ..late.clone() };
    assert_eq!(early.merged_with(&elsewhere), None);

    let same_second = QuoteMinute { close_sec: early.close_sec, ..late.clone() };
    assert_eq!(early.merged_with(&same_second).unwrap().combined.close, late.combined.close);
}

#[test]
fn a_closed_day_replaces_the_live_day_when_both_exist() {
    let tmp = tempfile::tempdir().unwrap();
    let mut live = LiveQuoteWriter::open(tmp.path(), DATE, "collect-01", 1).unwrap();
    live.append_minute("005930", &plain(541, START + 59, 10)).unwrap();
    live.append_minute("000660", &plain(541, START + 59, 10)).unwrap();
    assert!(!read_quote_day(tmp.path(), DATE, "005930").unwrap().unwrap().closed);

    let closed = ClosedQuotes { minutes: vec![plain(541, START + 59, 777), plain(542, START + 119, 8)], gaps: vec![(40_000, 40_100)] };
    write_closed_quotes(&closed_day_dir(tmp.path(), DATE), DATE, "005930", &closed).unwrap();
    let day = read_quote_day(tmp.path(), DATE, "005930").unwrap().unwrap();
    assert!(day.closed);
    assert_eq!((day.minutes, day.gaps), (closed.minutes, closed.gaps));
    assert_eq!(read_quote_day(tmp.path(), DATE, "000660").unwrap(), None);
}

#[test]
fn a_live_day_joins_finished_minutes_the_current_minute_and_gaps_across_keys() {
    let tmp = tempfile::tempdir().unwrap();
    let mut first = LiveQuoteWriter::open(tmp.path(), DATE, "collect-01", 1).unwrap();
    first.append_minute("005930", &plain(541, START + 59, 10)).unwrap();
    first.append_minute("005930", &plain(542, START + 70, 20)).unwrap();
    first.append_minute("000660", &plain(541, START + 59, 1)).unwrap();
    first.append_gap(50_000, 50_060).unwrap();

    let mut second = LiveQuoteWriter::open(tmp.path(), DATE, "spare-01", 1).unwrap();
    second.append_minute("005930", &plain(542, START + 110, 30)).unwrap();
    second.append_gap(30_000, 32_460).unwrap();
    let current = CurrentQuotes { minutes: [("005930".to_owned(), plain(543, START + 130, 40))].into() };
    second.write_current(&current, 5).unwrap();
    assert_eq!(second.load_current().unwrap(), current);
    assert_eq!(first.load_current().unwrap(), CurrentQuotes::default());

    let torn = live_day_dir(tmp.path(), DATE).join("collect-01").join("005930.jsonl");
    let mut file = OpenOptions::new().append(true).open(&torn).unwrap();
    file.write_all(b"{broken}\n{\"minute\":544").unwrap();

    let day = read_quote_day(tmp.path(), DATE, "005930").unwrap().unwrap();
    assert!(!day.closed);
    let merged = plain(542, START + 70, 20).merged_with(&plain(542, START + 110, 30)).unwrap();
    assert_eq!(day.minutes, [plain(541, START + 59, 10), merged, plain(543, START + 130, 40)]);
    assert_eq!(day.gaps, [(30_000, 32_460), (50_000, 50_060)]);

    let other = read_quote_day(tmp.path(), DATE, "000660").unwrap().unwrap();
    assert_eq!(other.gaps, [(50_000, 50_060)]);
    assert_eq!(read_quote_day(tmp.path(), DATE, "035420").unwrap(), None);
    assert_eq!(read_quote_day(tmp.path(), "20261125", "005930").unwrap(), None);

    let mut reopened = LiveQuoteWriter::open(tmp.path(), DATE, "collect-01", 9).unwrap();
    reopened.append_minute("005930", &plain(544, START + 190, 50)).unwrap();
    let minutes: Vec<u16> = read_quote_day(tmp.path(), DATE, "005930").unwrap().unwrap().minutes.iter().map(|minute| minute.minute).collect();
    assert_eq!(minutes, [541, 542, 543, 544]);
}

#[test]
fn quote_days_lists_every_day_with_live_or_closed_data() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(quote_days(tmp.path()).unwrap().is_empty());
    for date in ["20261120", "20261123"] {
        write_closed_quotes(&closed_day_dir(tmp.path(), date), date, "005930", &ClosedQuotes::default()).unwrap();
    }
    let mut live = LiveQuoteWriter::open(tmp.path(), DATE, "collect-01", 1).unwrap();
    live.append_minute("005930", &plain(541, START + 59, 10)).unwrap();
    let making = closed_day_dir(tmp.path(), DATE).with_extension("tmp");
    write_closed_quotes(&making, DATE, "005930", &ClosedQuotes::default()).unwrap();
    let days: Vec<KstDate> = ["20261120", "20261123", DATE].iter().map(|day| KstDate::parse_yyyymmdd(day).unwrap()).collect();
    assert_eq!(quote_days(tmp.path()).unwrap(), days);
    assert!(!read_quote_day(tmp.path(), DATE, "005930").unwrap().unwrap().closed);
}
