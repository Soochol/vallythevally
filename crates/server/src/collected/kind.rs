use std::borrow::Cow;

use domain::TimeOfDay;

use crate::api;
use crate::market_source::stream::{BrokerEntry, Exchange, TradeSide};
use crate::market_source::vi::{ViDirection, ViMarket};

pub struct FidValues<'a> {
    fids: &'a [u32],
    values: &'a [Option<String>],
}

impl<'a> FidValues<'a> {
    pub fn new(fids: &'a [u32], values: &'a [Option<String>]) -> Self {
        Self { fids, values }
    }

    pub fn get(&self, fid: u32) -> Option<&'a str> {
        let index = self.fids.iter().position(|&candidate| candidate == fid)?;
        self.values.get(index)?.as_deref()
    }
}

pub trait CollectedKind: 'static {
    const TYPE_CODE: &'static str;
    type View: Clone + Send + Sync + 'static;

    fn fids() -> &'static [u32];
    fn plus_sign_fids() -> &'static [u32] {
        &[]
    }
    fn store_symbols(stock_code: &str) -> Vec<String> {
        vec![format!("{stock_code}_AL")]
    }
    fn decode(recv_ms: i64, values: &FidValues<'_>) -> Option<Self::View>;
    fn decode_store(symbol: &str, recv_ms: i64, values: &FidValues<'_>) -> Option<Self::View> {
        let _ = symbol;
        Self::decode(recv_ms, values)
    }
}

pub struct Brokers;

const BROKER_FIDS: [u32; 46] = [
    141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160,
    161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180,
    261, 262, 263, 264, 267, 268,
];

impl CollectedKind for Brokers {
    const TYPE_CODE: &'static str = "0F";
    type View = api::FeedBrokers;

    fn fids() -> &'static [u32] {
        &BROKER_FIDS
    }

    fn decode(recv_ms: i64, values: &FidValues<'_>) -> Option<Self::View> {
        let (sells, buys) = crate::kiwoom::wire::parse_broker_sides(|fid| values.get(fid).map(Cow::Borrowed)).ok()?;
        let map_side = |entries: Vec<BrokerEntry>| {
            entries
                .into_iter()
                .map(|entry| api::FeedBroker {
                    code: entry.member_code,
                    name: entry.member_name,
                    qty: entry.cumulative_qty.0,
                    qty_change: entry.change_qty,
                })
                .collect()
        };
        let foreign_est_net_qty = values.get(267).and_then(|s| parse_optional_signed(Some(s)));
        let foreign_est_net_change = values.get(268).and_then(|s| parse_optional_signed(Some(s)));
        Some(api::FeedBrokers {
            t: api::UnixSeconds(recv_ms.div_euclid(1000)),
            sells: map_side(sells),
            buys: map_side(buys),
            foreign_est_net_qty,
            foreign_est_net_change,
        })
    }
}

pub struct ProgramFlow;

const PROGRAM_FIDS: [u32; 10] = [20, 10, 202, 204, 206, 208, 210, 211, 212, 213];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CollectedProgramRow {
    pub recv_ms: i64,
    pub hhmmss: TimeOfDay,
    pub price_won: Option<u64>,
    pub sell_qty: u64,
    pub sell_amount_million_won: u64,
    pub buy_qty: u64,
    pub buy_amount_million_won: u64,
    pub net_buy_qty: i64,
    pub net_buy_qty_change: i64,
    pub net_buy_amount_million_won: i64,
    pub net_buy_amount_change_million_won: i64,
}

impl CollectedKind for ProgramFlow {
    const TYPE_CODE: &'static str = "0w";
    type View = CollectedProgramRow;

    fn fids() -> &'static [u32] {
        &PROGRAM_FIDS
    }

    fn decode(recv_ms: i64, values: &FidValues<'_>) -> Option<Self::View> {
        Some(CollectedProgramRow {
            recv_ms,
            hhmmss: parse_hhmmss(values.get(20))?,
            price_won: parse_optional_nonzero_won(values.get(10))?,
            sell_qty: parse_magnitude_or_zero(values.get(202))?,
            sell_amount_million_won: parse_magnitude_or_zero(values.get(204))?,
            buy_qty: parse_magnitude_or_zero(values.get(206))?,
            buy_amount_million_won: parse_magnitude_or_zero(values.get(208))?,
            net_buy_qty: parse_signed_or_zero(values.get(210))?,
            net_buy_qty_change: parse_signed_or_zero(values.get(211))?,
            net_buy_amount_million_won: parse_signed_or_zero(values.get(212))?,
            net_buy_amount_change_million_won: parse_signed_or_zero(values.get(213))?,
        })
    }
}

pub struct ViEvents;

const VI_FIDS: [u32; 13] = [9001, 9068, 9069, 1221, 1223, 1224, 1225, 1236, 1237, 1238, 1239, 1489, 1490];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViKind {
    Static,
    Dynamic,
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViAction {
    Trigger,
    Release,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CollectedViEvent {
    pub recv_ms: i64,
    pub market: ViMarket,
    pub kind: ViKind,
    pub direction: ViDirection,
    pub trigger_price_won: Option<u64>,
    pub triggered: TimeOfDay,
    pub released: Option<TimeOfDay>,
    pub action: Option<ViAction>,
    pub static_base_won: Option<u64>,
    pub dynamic_base_won: Option<u64>,
    pub static_deviation_pct: Option<f64>,
    pub dynamic_deviation_pct: Option<f64>,
    pub trigger_change_pct: Option<f64>,
    pub trigger_count: Option<u32>,
}

impl CollectedKind for ViEvents {
    const TYPE_CODE: &'static str = "1h";
    type View = CollectedViEvent;

    fn fids() -> &'static [u32] {
        &VI_FIDS
    }

    fn store_symbols(stock_code: &str) -> Vec<String> {
        vec![stock_code.to_owned(), format!("{stock_code}_NX")]
    }

    fn decode_store(symbol: &str, recv_ms: i64, values: &FidValues<'_>) -> Option<Self::View> {
        let mut event = Self::decode(recv_ms, values)?;
        if symbol.trim().ends_with("_NX") {
            event.market = ViMarket::Nxt;
        }
        Some(event)
    }

    fn decode(recv_ms: i64, values: &FidValues<'_>) -> Option<Self::View> {
        let kind = match trimmed_or_empty(values.get(9068)) {
            "1" => ViKind::Static,
            "2" => ViKind::Dynamic,
            "3" => ViKind::Both,
            _ => return None,
        };
        let direction = match trimmed_or_empty(values.get(9069)) {
            "1" => ViDirection::Up,
            "2" => ViDirection::Down,
            _ => return None,
        };
        let market = if trimmed_or_empty(values.get(9001)).ends_with("_NX") {
            ViMarket::Nxt
        } else {
            ViMarket::Krx
        };
        let action = match trimmed_or_empty(values.get(1225)) {
            "1" => Some(ViAction::Trigger),
            "2" => Some(ViAction::Release),
            _ => None,
        };
        Some(CollectedViEvent {
            recv_ms,
            market,
            kind,
            direction,
            trigger_price_won: parse_optional_nonzero_won(values.get(1221))?,
            triggered: parse_hhmmss(values.get(1223))?,
            released: parse_optional_release_time(values.get(1224))?,
            action,
            static_base_won: parse_optional_nonzero_won(values.get(1236))?,
            dynamic_base_won: parse_optional_nonzero_won(values.get(1237))?,
            static_deviation_pct: parse_optional_f64(values.get(1238)),
            dynamic_deviation_pct: parse_optional_f64(values.get(1239)),
            trigger_change_pct: parse_optional_f64(values.get(1489)),
            trigger_count: parse_optional_u32(values.get(1490)),
        })
    }
}

pub struct ExpectedTrades;

const EXPECTED_FIDS: [u32; 7] = [20, 10, 11, 12, 15, 13, 25];

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CollectedExpectedTrade {
    pub recv_ms: i64,
    pub hhmmss: TimeOfDay,
    pub price_won: u64,
    pub change_won: Option<i64>,
    pub change_pct: Option<f64>,
    pub expected_qty: u64,
    pub delta_qty: i64,
    pub change_sign: Option<i8>,
}

impl CollectedKind for ExpectedTrades {
    const TYPE_CODE: &'static str = "0H";
    type View = CollectedExpectedTrade;

    fn fids() -> &'static [u32] {
        &EXPECTED_FIDS
    }

    fn decode(recv_ms: i64, values: &FidValues<'_>) -> Option<Self::View> {
        let price_won = parse_optional_nonzero_won(values.get(10))??;
        Some(CollectedExpectedTrade {
            recv_ms,
            hhmmss: parse_hhmmss(values.get(20))?,
            price_won,
            change_won: parse_optional_signed(values.get(11)),
            change_pct: parse_optional_f64(values.get(12)),
            expected_qty: parse_magnitude_or_zero(values.get(13))?,
            delta_qty: parse_signed_or_zero(values.get(15))?,
            change_sign: parse_optional_i8(values.get(25)),
        })
    }
}

pub struct TradeTicks;

const TRADE_TICK_FIDS: [u32; 5] = [20, 10, 15, 1313, 9081];
const TRADE_TICK_PLUS_FIDS: [u32; 1] = [15];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CollectedTradeTick {
    pub recv_ms: i64,
    pub hhmmss: TimeOfDay,
    pub price_won: u64,
    pub signed_qty: i64,
    pub side: Option<TradeSide>,
    pub instant_value_thousand_won: Option<i64>,
    pub exchange: Option<Exchange>,
}

impl CollectedTradeTick {
    pub fn qty(&self) -> u64 {
        self.signed_qty.unsigned_abs()
    }

    pub fn side(&self) -> Option<TradeSide> {
        self.side
    }

    pub fn value_won(&self) -> u64 {
        self.price_won.saturating_mul(self.qty())
    }
}

impl CollectedKind for TradeTicks {
    const TYPE_CODE: &'static str = "0B";
    type View = CollectedTradeTick;

    fn fids() -> &'static [u32] {
        &TRADE_TICK_FIDS
    }

    fn plus_sign_fids() -> &'static [u32] {
        &TRADE_TICK_PLUS_FIDS
    }

    fn decode(recv_ms: i64, values: &FidValues<'_>) -> Option<Self::View> {
        let price_won = parse_optional_nonzero_won(values.get(10))??;
        let qty_text = values.get(15)?.trim();
        let signed_qty = parse_signed(qty_text)?;
        if signed_qty == 0 {
            return None;
        }
        let side = match qty_text.as_bytes().first() {
            Some(b'+') => Some(TradeSide::Buy),
            Some(b'-') => Some(TradeSide::Sell),
            _ => None,
        };
        let exchange = match trimmed_or_empty(values.get(9081)) {
            "KRX" => Some(Exchange::Krx),
            "NXT" => Some(Exchange::Nxt),
            _ => None,
        };
        Some(CollectedTradeTick {
            recv_ms,
            hhmmss: parse_hhmmss(values.get(20))?,
            price_won,
            signed_qty,
            side,
            instant_value_thousand_won: parse_optional_signed(values.get(1313)),
            exchange,
        })
    }
}

pub struct MicroEvents;

const MICRO_FIDS: [u32; 7] = [1, 2, 3, 4, 5, 6, 7];

impl CollectedKind for MicroEvents {
    const TYPE_CODE: &'static str = "ME";
    type View = domain::MicroEvent;

    fn fids() -> &'static [u32] {
        &MICRO_FIDS
    }

    fn decode(recv_ms: i64, values: &FidValues<'_>) -> Option<Self::View> {
        let kind = match trimmed_or_empty(values.get(1)) {
            "S" => domain::MicroEventKind::SpoofCancel,
            "I" => domain::MicroEventKind::IcebergAbsorb,
            _ => return None,
        };
        let side = match trimmed_or_empty(values.get(2)) {
            "A" => domain::MicroSide::Ask,
            "B" => domain::MicroSide::Bid,
            _ => return None,
        };
        let price_won = parse_optional_nonzero_won(values.get(3))??;
        let cancelled_or_absorbed_qty = parse_magnitude(values.get(4)?)?;
        let displayed_qty = parse_magnitude(values.get(5)?)?;
        let ratio_bps = parse_optional_u32(values.get(6))?;
        let executed_qty = match values.get(7).and_then(parse_magnitude) {
            Some(qty) => qty,
            None => match kind {
                domain::MicroEventKind::IcebergAbsorb => cancelled_or_absorbed_qty,
                domain::MicroEventKind::SpoofCancel => {
                    if ratio_bps >= 10_000 || ratio_bps == 0 {
                        0
                    } else {
                        let drop = (u128::from(cancelled_or_absorbed_qty) * 10_000 + u128::from(ratio_bps) / 2) / u128::from(ratio_bps);
                        let approx = (drop as u64).saturating_sub(cancelled_or_absorbed_qty);
                        approx.min(displayed_qty.saturating_sub(cancelled_or_absorbed_qty))
                    }
                }
            },
        };
        Some(domain::MicroEvent {
            recv_ms,
            kind,
            side,
            price_won,
            cancelled_or_absorbed_qty,
            displayed_qty,
            executed_qty,
            ratio_bps,
        })
    }
}

fn trimmed_or_empty(raw: Option<&str>) -> &str {
    raw.map(str::trim).unwrap_or_default()
}

fn parse_hhmmss(raw: Option<&str>) -> Option<TimeOfDay> {
    let text = raw?.trim();
    if text.len() != 6 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    TimeOfDay::hms(text[0..2].parse().ok()?, text[2..4].parse().ok()?, text[4..6].parse().ok()?)
}

fn parse_optional_release_time(raw: Option<&str>) -> Option<Option<TimeOfDay>> {
    match trimmed_or_empty(raw) {
        "" | "000000" => Some(None),
        text => parse_hhmmss(Some(text)).map(Some),
    }
}

fn parse_magnitude(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed).parse::<u64>().ok()
}

fn parse_magnitude_or_zero(raw: Option<&str>) -> Option<u64> {
    let text = trimmed_or_empty(raw);
    if text.is_empty() { Some(0) } else { parse_magnitude(text) }
}

fn parse_optional_nonzero_won(raw: Option<&str>) -> Option<Option<u64>> {
    let text = trimmed_or_empty(raw);
    if text.is_empty() {
        return Some(None);
    }
    let value = parse_magnitude(text)?;
    Some((value > 0).then_some(value))
}

fn parse_signed(raw: &str) -> Option<i64> {
    raw.trim().parse::<i64>().ok()
}

fn parse_signed_or_zero(raw: Option<&str>) -> Option<i64> {
    let text = trimmed_or_empty(raw);
    if text.is_empty() { Some(0) } else { parse_signed(text) }
}

fn parse_optional_signed(raw: Option<&str>) -> Option<i64> {
    let text = trimmed_or_empty(raw);
    if text.is_empty() { None } else { parse_signed(text) }
}

fn parse_optional_f64(raw: Option<&str>) -> Option<f64> {
    let text = trimmed_or_empty(raw);
    if text.is_empty() {
        return None;
    }
    text.parse::<f64>().ok().filter(|value| value.is_finite())
}

fn parse_optional_u32(raw: Option<&str>) -> Option<u32> {
    let text = trimmed_or_empty(raw);
    if text.is_empty() {
        return None;
    }
    let unsigned = match text.as_bytes().first() {
        Some(b'+') => &text[1..],
        Some(b'-') => {
            let digits = &text[1..];
            if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            return (digits.parse::<u32>().ok() == Some(0)).then_some(0);
        }
        _ => text,
    };
    if unsigned.is_empty() || !unsigned.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    unsigned.parse::<u32>().ok()
}

fn parse_optional_i8(raw: Option<&str>) -> Option<i8> {
    let text = trimmed_or_empty(raw);
    if text.is_empty() {
        return None;
    }
    text.parse::<i8>().ok()
}
