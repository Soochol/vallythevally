use std::sync::Arc;

use domain::{Feed, IndexCode, KstDate, Venue};

use super::cache::DayError;
use super::series::{BUCKET_MINUTES, CollectedCell, SymbolDay, Weighting};
use crate::bars::BarError;
use crate::clock::kst;
use crate::http::AppState;
use crate::shared_data::{CELL_MINUTES, MinuteInstrument, MinuteSeries, MinuteVenue, Loaded, SharedData, SnapshotBody};

const _: () = assert!(CELL_MINUTES as u32 == BUCKET_MINUTES);

fn minute_venue(venue: Venue) -> MinuteVenue {
    match venue {
        Venue::Krx => MinuteVenue::Krx,
        Venue::Nxt => MinuteVenue::Nxt,
        Venue::Combined => MinuteVenue::Combined,
    }
}

fn series_of(feed: Feed) -> MinuteSeries {
    match feed {
        Feed::Stock(code, venue) => MinuteSeries { symbol: code.as_str().to_owned(), instrument: MinuteInstrument::Stock, venue: Some(minute_venue(venue)) },
        Feed::Index(code) => MinuteSeries { symbol: code.as_str().to_owned(), instrument: MinuteInstrument::Index, venue: None },
    }
}

fn centi(value: f64) -> Option<u64> {
    let centi = (value * 100.0).round();
    (centi.is_finite() && centi >= 0.0).then_some(centi as u64)
}

fn index_base_centi(data: &SharedData, code: IndexCode, today: KstDate) -> Option<u64> {
    let row = Venue::ALL.iter().find_map(|venue| todays(data, *venue, today)?.body.indices.iter().find(|row| row.code == code.as_str()).cloned())?;
    let base = row.level / (1.0 + row.change_rate / 100.0);
    (row.change_rate > -100.0).then(|| centi(base)).flatten()
}

fn todays(data: &SharedData, venue: Venue, today: KstDate) -> Option<Arc<Loaded<SnapshotBody>>> {
    data.snapshot(venue).current().filter(|loaded| loaded.header.observation_date == today.yyyymmdd())
}

fn stock_base_centi(data: &SharedData, code: domain::StockCode, venue: Venue, today: KstDate) -> Option<u64> {
    let loaded = todays(data, venue, today)?;
    loaded.body.stocks.iter().find(|row| row.code == code.as_str()).and_then(|row| row.base_won.checked_mul(100))
}

fn base_of(data: &SharedData, feed: Feed, today: KstDate) -> Option<(u64, Weighting)> {
    match feed {
        Feed::Stock(code, venue) => Some((stock_base_centi(data, code, venue, today)?, Weighting::TradedValue)),
        Feed::Index(code) => Some((index_base_centi(data, code, today)?, Weighting::Excluded)),
    }
}

fn unix_of(day: KstDate, minute: u32, second: u32) -> i64 {
    kst(day, 0, 0, 0).unix() + i64::from(minute) * 60 + i64::from(second)
}

pub(super) fn day(st: &AppState, feed: Feed) -> Result<Arc<SymbolDay>, DayError> {
    let today = st.clock.now().kst_date();
    let data = &st.shared_data;
    let collected = data.minutes.cells(today, &series_of(feed)).ok_or(DayError::NotCollected)?;
    let (base_centi, weighting) = base_of(data, feed, today).ok_or_else(|| DayError::Bars(BarError::Internal("오늘 날짜의 공용 스냅샷에 전일 종가가 없습니다".into())))?;
    let cells = collected.cells.iter().filter_map(|cell| Some(CollectedCell { start: unix_of(today, u32::from(cell.start_minute), 0), close_centi: centi(cell.close)?, traded_won: cell.traded_won }));
    let as_of = Some(unix_of(today, 0, collected.last_sec));
    SymbolDay::from_collected_cells(base_centi, weighting, as_of, cells).map(Arc::new).ok_or_else(|| DayError::Bars(BarError::Internal("전일 종가를 알 수 없습니다".into())))
}

