use std::collections::{BTreeMap, HashMap, HashSet};

use domain::{KstDate, StockCode};
use futures::future::join_all;
use serde::{Deserialize, Serialize};
use server::clock::Clock;
use server::kiwoom::api::{AllIndices, ListedMarket, StockQuotes};
use server::kiwoom::rest::{KiwoomRest, MergeScope, Priority};
use server::kiwoom::wire::{QuoteRow, parse_kst_datetime};
use server::shared_data::{IndexRow, SnapshotRow};

use super::{Tick, VenueName};
use crate::protocol::KeyName;
use crate::shared::job::Slice;
use crate::universe::ListedStock;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct VenuePart {
    pub venue: VenueName,
    pub requested: u32,
    pub rows: Vec<SnapshotRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Part {
    pub tick: i64,
    pub closing: bool,
    pub slice_index: u32,
    pub slice_count: u32,
    pub key: String,
    pub finished_at: i64,
    pub venues: Vec<VenuePart>,
    pub indices: Vec<IndexRow>,
}

pub(super) enum Unit {
    Quotes { venue: VenueName, codes: Vec<StockCode> },
    Index(ListedMarket),
}

enum Fetched {
    Quotes { venue: VenueName, requested: u32, rows: Vec<SnapshotRow> },
    Index(Vec<IndexRow>),
}

pub(super) fn units_of(listed: &[ListedStock], venues: &[VenueName]) -> Vec<Unit> {
    let mut units = Vec::new();
    for venue in venues {
        let codes: Vec<StockCode> = listed.iter().filter(|stock| venue.takes(stock)).filter_map(|stock| StockCode::parse(&stock.code).ok()).collect();
        units.extend(codes.chunks(StockQuotes::MAX).map(|chunk| Unit::Quotes { venue: *venue, codes: chunk.to_vec() }));
    }
    units.push(Unit::Index(ListedMarket::Kospi));
    units.push(Unit::Index(ListedMarket::Kosdaq));
    units
}

pub(super) async fn fetch_slice(rest: &KiwoomRest, units: &[Unit], venues: &[VenueName], slice: Slice, tick: Tick, key: &KeyName, clock: &Clock) -> Result<Part, String> {
    let mine = units.iter().enumerate().filter(|(position, _)| slice.owns(*position as u32)).map(|(_, unit)| unit);
    let outcomes = join_all(mine.map(|unit| fetch_unit(rest, unit))).await;
    let mut by_venue: BTreeMap<VenueName, VenuePart> = venues.iter().map(|venue| (*venue, VenuePart { venue: *venue, requested: 0, rows: Vec::new() })).collect();
    let mut indices = Vec::new();
    let mut failures = Vec::new();
    for outcome in outcomes {
        match outcome {
            Ok(Fetched::Quotes { venue, requested, rows }) => {
                let part = by_venue.get_mut(&venue).expect("묶음의 거래소는 선택값에 있다");
                part.requested += requested;
                part.rows.extend(rows);
            }
            Ok(Fetched::Index(rows)) => indices.extend(rows),
            Err(error) => failures.push(error),
        }
    }
    for part in by_venue.values().filter(|part| part.requested > 0 && part.rows.is_empty()) {
        failures.push(format!("{:?} 응답에서 읽히는 행이 하나도 없습니다({}종목 요청)", part.venue, part.requested));
    }
    if let Some(first) = failures.first() {
        return Err(format!("묶음 {}개가 실패해 이 판을 쓰지 않습니다(첫 실패: {first})", failures.len()));
    }
    Ok(Part {
        tick: tick.at.unix(),
        closing: tick.closing,
        slice_index: slice.index,
        slice_count: slice.count,
        key: key.as_str().to_owned(),
        finished_at: clock.now().unix(),
        venues: by_venue.into_values().collect(),
        indices,
    })
}

async fn fetch_unit(rest: &KiwoomRest, unit: &Unit) -> Result<Fetched, String> {
    match unit {
        Unit::Quotes { venue, codes } => {
            let request = StockQuotes::new(codes, venue.venue()).expect("묶음은 1~MAX개다");
            let page = rest.call(&request, None, Priority::Background, MergeScope::default()).await.map_err(|error| error.to_string())?;
            Ok(Fetched::Quotes { venue: *venue, requested: codes.len() as u32, rows: rows_of(page.body.atn_stk_infr, *venue, codes) })
        }
        Unit::Index(market) => {
            let page = rest.call(&AllIndices::new(*market), None, Priority::Background, MergeScope::default()).await.map_err(|error| error.to_string())?;
            let whole = market.index_code();
            let row = page.body.rows().rows.into_iter().find(|row| row.code == whole.as_str()).ok_or_else(|| format!("ka20003 응답에 종합지수 {} 행이 없습니다", whole.as_str()))?;
            Ok(Fetched::Index(vec![IndexRow { code: row.code, name: row.name, level: row.level, change_rate: row.change_rate, trade_million_won: row.trade_million_won }]))
        }
    }
}

fn suffix_of(venue: VenueName) -> &'static str {
    match venue {
        VenueName::Krx => "",
        VenueName::Combined => "_AL",
        VenueName::Nxt => "_NX",
    }
}

fn rows_of(rows: Vec<QuoteRow>, venue: VenueName, wanted: &[StockCode]) -> Vec<SnapshotRow> {
    let wanted: HashSet<&str> = wanted.iter().map(|code| code.as_str()).collect();
    let mut by_code: HashMap<&str, Vec<&QuoteRow>> = HashMap::new();
    for row in &rows {
        if let Some(code) = row.stk_cd.strip_suffix(suffix_of(venue)).filter(|code| wanted.contains(code)) {
            by_code.entry(code).or_default().push(row);
        }
    }
    let mut read: Vec<SnapshotRow> = by_code.into_iter().filter_map(|(code, rows)| (rows.len() == 1).then(|| read_row(code, rows[0])).flatten()).collect();
    read.sort_by(|a, b| a.code.cmp(&b.code));
    read
}

fn number(text: &str) -> Option<u64> {
    text.trim().trim_start_matches(['+', '-']).parse().ok()
}

fn read_row(code: &str, row: &QuoteRow) -> Option<SnapshotRow> {
    KstDate::parse_yyyymmdd(&row.dt)?;
    let traded_at = match row.cntr_tm.is_empty() {
        true => None,
        false => Some(parse_kst_datetime(&format!("{}{}", row.dt, row.cntr_tm))?.unix()),
    };
    Some(SnapshotRow {
        code: code.to_owned(),
        day: row.dt.clone(),
        current_won: number(&row.cur_prc)?,
        base_won: number(&row.base_pric)?,
        open_won: number(&row.open_pric)?,
        high_won: number(&row.high_pric)?,
        low_won: number(&row.low_pric)?,
        volume: number(&row.trde_qty)?,
        traded_million_won: number(&row.trde_prica)?,
        traded_at,
    })
}
