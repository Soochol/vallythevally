use std::collections::{BTreeSet, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use domain::{KstDate, KstTime, MicroEvent, MicroEventKind, MicroSide, StockCode, Symbol, SymbolKind, TimeOfDay};
use sqlx::Row;

use crate::api::{self, DiagnosisTag, ExecutionForensic, ExecutionForensics, OrderSide, SymbolCode, TradingExecution, UnixSeconds};
use crate::clock::kst;
use crate::collected::Collected;
use crate::collected::kind::{CollectedProgramRow, CollectedTradeTick};
use crate::collected_store::read_stamp;
use crate::db::AppDb;
use crate::micro_events::MicroEventService;
use crate::shared_data::CollectorPaths;
use crate::symbols::SymbolDirectory;
use crate::trading::tick;

const FORENSICS_CACHE_CAPACITY: usize = 32;
const PRE_ENTRY_WINDOW_SECS: u32 = 10;
const POST_ENTRY_WINDOW_SECS: u32 = 300;
const WHALE_LOOKBACK_SECS: u32 = 60;
const WHALE_TICK_THRESHOLD_WON: u64 = 100_000_000;
const WHALE_DIAGNOSIS_THRESHOLD_MILLION: f64 = 100.0;
const PROGRAM_DIAGNOSIS_THRESHOLD_MILLION: f64 = 100.0;
const SPOOF_CANCEL_RATE_THRESHOLD_PCT: f64 = 70.0;
const FAVORABLE_MFE_THRESHOLD_PCT: f64 = 0.3;
const ADVERSE_MAE_THRESHOLD_PCT: f64 = -0.3;
const UNCOLLECTED_SUMMARY: &str = "수집 데이터가 없어 체결 해부를 표시할 수 없습니다";
const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0100_0000_01b3;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    account: String,
    date: String,
    fingerprint: u64,
    store_stamp: String,
}

struct ForensicsLru {
    capacity: usize,
    order: VecDeque<CacheKey>,
    entries: HashMap<CacheKey, ExecutionForensics>,
}

impl ForensicsLru {
    fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity,
            order: VecDeque::with_capacity(capacity),
            entries: HashMap::with_capacity(capacity),
        }
    }

    fn get(&mut self, key: &CacheKey) -> Option<ExecutionForensics> {
        let value = self.entries.get(key)?.clone();
        if let Some(pos) = self.order.iter().position(|candidate| candidate == key) {
            self.order.remove(pos);
        }
        self.order.push_back(key.clone());
        Some(value)
    }

    fn insert(&mut self, key: CacheKey, value: ExecutionForensics) {
        if let Some(pos) = self.order.iter().position(|candidate| candidate == &key) {
            self.order.remove(pos);
        } else if self.order.len() >= self.capacity
            && let Some(oldest) = self.order.pop_front()
        {
            self.entries.remove(&oldest);
        }
        self.order.push_back(key.clone());
        self.entries.insert(key, value);
    }
}

pub struct ForensicsCache {
    lru: Mutex<ForensicsLru>,
}

impl ForensicsCache {
    pub fn new() -> Arc<Self> {
        Self::with_capacity(FORENSICS_CACHE_CAPACITY)
    }

    pub fn with_capacity(capacity: usize) -> Arc<Self> {
        Arc::new(Self {
            lru: Mutex::new(ForensicsLru::with_capacity(capacity)),
        })
    }

    fn get(&self, key: &CacheKey) -> Option<ExecutionForensics> {
        self.lru.lock().expect("forensics cache").get(key)
    }

    fn insert(&self, key: CacheKey, value: ExecutionForensics) {
        self.lru.lock().expect("forensics cache").insert(key, value);
    }
}

struct SymbolCollectedData {
    ticks: Vec<CollectedTradeTick>,
    program: Vec<CollectedProgramRow>,
    micro_events: Vec<MicroEvent>,
}

pub struct ForensicsInputs<'a> {
    pub collected: &'a Arc<Collected>,
    pub micro_events: &'a Arc<MicroEventService>,
    pub db: &'a AppDb,
    pub symbols: &'a SymbolDirectory,
    pub cache: &'a ForensicsCache,
    pub paths: CollectorPaths,
    pub date: KstDate,
    pub date_str: &'a str,
    pub account_query: Option<&'a str>,
    pub executions: &'a api::TradingExecutions,
    pub now: KstTime,
}

pub async fn compute_forensics(inputs: ForensicsInputs<'_>) -> Result<ExecutionForensics, String> {
    let account = inputs.account_query.map(str::to_owned).or_else(|| Some(inputs.executions.account_ref.clone()));
    if inputs.executions.day.0 != inputs.date {
        return Ok(ExecutionForensics {
            date: inputs.date_str.to_owned(),
            account,
            items: Vec::new(),
        });
    }
    let intended_prices = load_intended_prices(inputs.db, &inputs.executions.account_ref, inputs.date)
        .await
        .map_err(|e| format!("주문 명령 이력을 읽지 못했습니다: {e}"))?;
    let unique_stocks = deduplicate_stocks(&inputs.executions.executions);
    let stamp_paths = inputs.paths.clone();
    let stamp_date = inputs.date_str.to_owned();
    let finalized_stamp = tokio::task::spawn_blocking(move || finalized_store_stamp(&stamp_paths, &stamp_date))
        .await
        .map_err(|e| format!("수집 저장소 상태 확인 작업이 멈췄습니다: {e}"))??;
    let cache_key = finalized_stamp.map(|store_stamp| CacheKey {
        account: inputs.executions.account_ref.clone(),
        date: inputs.date_str.to_owned(),
        fingerprint: execution_fingerprint(&inputs.executions.executions, &intended_prices),
        store_stamp,
    });
    if let Some(ref key) = cache_key
        && let Some(cached) = inputs.cache.get(key)
    {
        return Ok(cached);
    }

    let loads = unique_stocks.into_iter().map(|stock| {
        let collected = Arc::clone(inputs.collected);
        let micro_events = Arc::clone(inputs.micro_events);
        let paths = inputs.paths.clone();
        let date = inputs.date;
        let date_str = inputs.date_str.to_owned();
        let now = inputs.now;
        async move {
            let (ticks_slice, program_slice, (_, micro)) = tokio::try_join!(
                collected.ticks_day(paths.clone(), stock, date, &date_str, None, now),
                collected.program_day(paths.clone(), stock, date, &date_str, None, now),
                micro_events.day_events(&collected, paths, stock, date, now),
            )?;
            Ok::<_, String>((
                stock,
                SymbolCollectedData {
                    ticks: ticks_slice.snapshots,
                    program: program_slice.snapshots,
                    micro_events: micro,
                },
            ))
        }
    });
    let per_symbol: HashMap<StockCode, SymbolCollectedData> = futures::future::try_join_all(loads).await?.into_iter().collect();

    let directory = inputs.symbols.updates().borrow().clone();
    let items = inputs.executions.executions
        .iter()
        .map(|fill| {
            let stock = StockCode::parse(&fill.code).ok();
            let kind = stock
                .and_then(|s| directory.as_ref().and_then(|dir| dir.get(Symbol::Stock(s))).map(|info| info.kind))
                .unwrap_or(SymbolKind::Common);
            let data = stock.and_then(|s| per_symbol.get(&s));
            let intended_price = intended_prices.get(&(fill.order_no.clone(), fill.code.clone())).copied();
            analyze_execution(fill, inputs.date, kind, intended_price, data)
        })
        .collect();

    let result = ExecutionForensics {
        date: inputs.date_str.to_owned(),
        account,
        items,
    };
    if let Some(key) = cache_key {
        inputs.cache.insert(key, result.clone());
    }
    Ok(result)
}

async fn load_intended_prices(db: &AppDb, account_ref: &str, date: KstDate) -> Result<HashMap<(String, String), u64>, sqlx::Error> {
    let day_start = kst(date, 0, 0, 0).unix();
    let day_end = day_start + 86_400;
    let rows = sqlx::query(
        "SELECT order_no, code, price FROM order_commands \
         WHERE account_ref = ? AND order_no IS NOT NULL AND price IS NOT NULL \
           AND created_at >= ? AND created_at < ? \
         ORDER BY updated_at DESC, rowid DESC",
    )
    .bind(account_ref)
    .bind(day_start)
    .bind(day_end)
    .fetch_all(db.read())
    .await?;
    let mut prices = HashMap::new();
    for row in rows {
        let order_no: String = row.try_get("order_no")?;
        let code: String = row.try_get("code")?;
        let price: i64 = row.try_get("price")?;
        if price > 0 {
            prices.entry((order_no, code)).or_insert(price as u64);
        }
    }
    Ok(prices)
}

fn deduplicate_stocks(executions: &[TradingExecution]) -> Vec<StockCode> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for fill in executions {
        if let Ok(stock) = StockCode::parse(&fill.code)
            && seen.insert(stock)
        {
            out.push(stock);
        }
    }
    out
}

fn finalized_store_stamp(paths: &CollectorPaths, date_str: &str) -> Result<Option<String>, String> {
    let Some(hoga_dir) = paths.hoga_dir().map(PathBuf::from) else {
        return Ok(None);
    };
    Ok(read_stamp(&hoga_dir, date_str)?.map(|stamp| format!("store:{}", stamp.token())))
}

fn execution_fingerprint(executions: &[TradingExecution], intended_prices: &HashMap<(String, String), u64>) -> u64 {
    let mut hash = FNV_OFFSET_BASIS;
    hash = fnv1a_bytes(hash, &(executions.len() as u64).to_le_bytes());
    for fill in executions {
        hash = fnv1a_bytes(hash, fill.order_no.as_bytes());
        hash = fnv1a_bytes(hash, b"|");
        hash = fnv1a_bytes(hash, fill.code.as_bytes());
        hash = fnv1a_bytes(hash, b"|");
        hash = fnv1a_bytes(hash, &[match fill.side { OrderSide::Buy => 1, OrderSide::Sell => 2 }]);
        hash = fnv1a_bytes(hash, fill.time.as_bytes());
        hash = fnv1a_bytes(hash, &fill.price.to_le_bytes());
        hash = fnv1a_bytes(hash, &fill.quantity.to_le_bytes());
        let intended = intended_prices.get(&(fill.order_no.clone(), fill.code.clone())).copied().unwrap_or(0);
        hash = fnv1a_bytes(hash, &intended.to_le_bytes());
    }
    hash
}

fn fnv1a_bytes(mut hash: u64, bytes: &[u8]) -> u64 {
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

fn parse_fill_time(raw: &str) -> Option<TimeOfDay> {
    let digits: String = raw.chars().filter(char::is_ascii_digit).collect();
    if digits.len() < 6 {
        return None;
    }
    let h: u32 = digits[0..2].parse().ok()?;
    let m: u32 = digits[2..4].parse().ok()?;
    let s: u32 = digits[4..6].parse().ok()?;
    TimeOfDay::hms(h, m, s)
}

fn uncollected_forensic(fill: &TradingExecution, fill_at: UnixSeconds) -> ExecutionForensic {
    ExecutionForensic {
        order_no: fill.order_no.clone(),
        code: SymbolCode(fill.code.clone()),
        name: fill.name.clone(),
        side: fill.side,
        time: fill.time.clone(),
        fill_at,
        price: fill.price,
        quantity: fill.quantity,
        collected: false,
        diagnosis: DiagnosisTag::Neutral,
        mfe_pct: None,
        mae_pct: None,
        slippage_ticks: None,
        pre_entry_cancel_rate_pct: None,
        program_delta_million_won: None,
        whale_net_delta_million_won: None,
        summary: UNCOLLECTED_SUMMARY.to_owned(),
    }
}

fn analyze_execution(
    fill: &TradingExecution,
    date: KstDate,
    kind: SymbolKind,
    intended_price: Option<u64>,
    data: Option<&SymbolCollectedData>,
) -> ExecutionForensic {
    let parsed_tod = parse_fill_time(&fill.time);
    let day_start = kst(date, 0, 0, 0).unix();
    let fill_at = match parsed_tod {
        Some(tod) => UnixSeconds(day_start + i64::from(tod.secs())),
        None => UnixSeconds(day_start),
    };
    let (Some(tod), Some(collected)) = (parsed_tod, data) else {
        return uncollected_forensic(fill, fill_at);
    };
    if collected.ticks.is_empty() {
        return uncollected_forensic(fill, fill_at);
    }

    let fill_secs = tod.secs();
    let fill_ms = fill_at.0 * 1000;
    let pre_start_ms = fill_ms - i64::from(PRE_ENTRY_WINDOW_SECS) * 1000;
    let pre_end_ms = fill_ms + 999;
    let post_end_secs = fill_secs.saturating_add(POST_ENTRY_WINDOW_SECS);
    let pre_window_start_secs = fill_secs.saturating_sub(PRE_ENTRY_WINDOW_SECS);
    let whale_start_secs = fill_secs.saturating_sub(WHALE_LOOKBACK_SECS);

    let (mfe_pct, mae_pct, end_return_pct) = compute_mfe_mae(&collected.ticks, fill.side, fill.price, fill_secs, post_end_secs);
    let (pre_entry_cancel_rate_pct, has_spoof, iceberg_supported) =
        analyze_micro_window(&collected.micro_events, fill.side, pre_start_ms, pre_end_ms);
    let program_delta_million_won = program_window_delta(&collected.program, pre_window_start_secs, post_end_secs);
    let post_program_delta_million_won = program_post_delta(&collected.program, fill_secs, post_end_secs);
    let whale_net_delta_million_won = compute_whale_net_delta(&collected.ticks, whale_start_secs, fill_secs);

    let ref_price = intended_price.or_else(|| nearest_reference_price(&collected.ticks, fill_secs, post_end_secs));
    let slippage_ticks = match ref_price {
        Some(reference) if reference > 0 && fill.price > 0 => Some(tick::slippage_ticks(fill.side, reference, fill.price, kind)),
        _ => None,
    };

    let diagnosis = classify_diagnosis(
        fill.side,
        pre_entry_cancel_rate_pct,
        has_spoof,
        iceberg_supported,
        mfe_pct,
        mae_pct,
        end_return_pct,
        whale_net_delta_million_won,
        post_program_delta_million_won,
    );
    let summary = format_summary(
        diagnosis,
        pre_entry_cancel_rate_pct,
        mfe_pct,
        mae_pct,
        whale_net_delta_million_won,
        post_program_delta_million_won.or(program_delta_million_won),
    );

    ExecutionForensic {
        order_no: fill.order_no.clone(),
        code: SymbolCode(fill.code.clone()),
        name: fill.name.clone(),
        side: fill.side,
        time: fill.time.clone(),
        fill_at,
        price: fill.price,
        quantity: fill.quantity,
        collected: true,
        diagnosis,
        mfe_pct,
        mae_pct,
        slippage_ticks,
        pre_entry_cancel_rate_pct: Some(pre_entry_cancel_rate_pct),
        program_delta_million_won,
        whale_net_delta_million_won: Some(whale_net_delta_million_won),
        summary,
    }
}

fn compute_mfe_mae(
    ticks: &[CollectedTradeTick],
    side: OrderSide,
    fill_price: u64,
    start_secs: u32,
    end_secs: u32,
) -> (Option<f64>, Option<f64>, Option<f64>) {
    if fill_price == 0 {
        return (None, None, None);
    }
    let entry = fill_price as f64;
    let mut found = false;
    let mut max_rel = 0.0f64;
    let mut min_rel = 0.0f64;
    let mut last_order: Option<(u32, i64)> = None;
    let mut last_rel = 0.0f64;
    for tick in ticks {
        let secs = tick.hhmmss.secs();
        if secs < start_secs || secs > end_secs || tick.price_won == 0 {
            continue;
        }
        let rel = match side {
            OrderSide::Buy => ((tick.price_won as f64 - entry) / entry) * 100.0,
            OrderSide::Sell => ((entry - tick.price_won as f64) / entry) * 100.0,
        };
        if !found {
            found = true;
            max_rel = rel.max(0.0);
            min_rel = rel.min(0.0);
        } else {
            max_rel = max_rel.max(rel);
            min_rel = min_rel.min(rel);
        }
        let order = (secs, tick.recv_ms);
        if last_order.is_none_or(|best| order >= best) {
            last_order = Some(order);
            last_rel = rel;
        }
    }
    if !found {
        return (None, None, None);
    }
    (Some(round2(max_rel)), Some(round2(min_rel)), Some(round2(last_rel)))
}

fn analyze_micro_window(events: &[MicroEvent], side: OrderSide, start_ms: i64, end_ms: i64) -> (f64, bool, bool) {
    let supporting_side = match side {
        OrderSide::Buy => MicroSide::Bid,
        OrderSide::Sell => MicroSide::Ask,
    };
    let mut max_cancel_rate = 0.0f64;
    let mut has_spoof = false;
    let mut iceberg_supported = false;
    for event in events {
        if event.recv_ms < start_ms || event.recv_ms > end_ms {
            continue;
        }
        match event.kind {
            MicroEventKind::SpoofCancel => {
                has_spoof = true;
                max_cancel_rate = max_cancel_rate.max(f64::from(event.ratio_bps) / 100.0);
            }
            MicroEventKind::IcebergAbsorb => {
                if event.side == supporting_side {
                    iceberg_supported = true;
                }
            }
        }
    }
    (round2(max_cancel_rate), has_spoof, iceberg_supported)
}

fn program_delta(rows: &[CollectedProgramRow], start_secs: u32, inclusive_start: bool, end_secs: u32) -> Option<f64> {
    if rows.is_empty() {
        return None;
    }
    let mut before_last: Option<((u32, i64), &CollectedProgramRow)> = None;
    let mut first_in: Option<((u32, i64), &CollectedProgramRow)> = None;
    let mut last_in: Option<((u32, i64), &CollectedProgramRow)> = None;
    for row in rows {
        let secs = row.hhmmss.secs();
        let order = (secs, row.recv_ms);
        let is_before = if inclusive_start { secs < start_secs } else { secs <= start_secs };
        if is_before {
            if before_last.is_none_or(|(best, _)| order >= best) {
                before_last = Some((order, row));
            }
        } else if secs <= end_secs {
            if first_in.is_none_or(|(best, _)| order < best) {
                first_in = Some((order, row));
            }
            if last_in.is_none_or(|(best, _)| order >= best) {
                last_in = Some((order, row));
            }
        }
    }
    let (Some((_, first)), Some((_, last))) = (first_in, last_in) else {
        return Some(0.0);
    };
    let baseline = match before_last {
        Some((_, prior)) => prior.net_buy_amount_million_won,
        None => first.net_buy_amount_million_won - first.net_buy_amount_change_million_won,
    };
    Some(round2((last.net_buy_amount_million_won - baseline) as f64))
}

fn program_window_delta(rows: &[CollectedProgramRow], start_secs: u32, end_secs: u32) -> Option<f64> {
    program_delta(rows, start_secs, true, end_secs)
}

fn program_post_delta(rows: &[CollectedProgramRow], fill_secs: u32, end_secs: u32) -> Option<f64> {
    program_delta(rows, fill_secs, false, end_secs)
}

fn compute_whale_net_delta(ticks: &[CollectedTradeTick], start_secs: u32, end_secs: u32) -> f64 {
    let mut net_won: i128 = 0;
    for tick in ticks {
        let secs = tick.hhmmss.secs();
        if secs < start_secs || secs > end_secs {
            continue;
        }
        let value = tick.value_won();
        if value >= WHALE_TICK_THRESHOLD_WON {
            let signed = i128::from(value);
            if tick.signed_qty > 0 {
                net_won += signed;
            } else {
                net_won -= signed;
            }
        }
    }
    round2(net_won as f64 / 1_000_000.0)
}

fn nearest_reference_price(ticks: &[CollectedTradeTick], fill_secs: u32, end_secs: u32) -> Option<u64> {
    let mut best_before: Option<((u32, i64), u64)> = None;
    let mut best_after: Option<((u32, i64), u64)> = None;
    for tick in ticks {
        if tick.price_won == 0 {
            continue;
        }
        let secs = tick.hhmmss.secs();
        let order = (secs, tick.recv_ms);
        if secs <= fill_secs {
            if best_before.is_none_or(|(best, _)| order >= best) {
                best_before = Some((order, tick.price_won));
            }
        } else if secs <= end_secs
            && best_after.is_none_or(|(best, _)| order < best)
        {
            best_after = Some((order, tick.price_won));
        }
    }
    best_before.or(best_after).map(|(_, price)| price)
}

#[allow(clippy::too_many_arguments)]
fn classify_diagnosis(
    side: OrderSide,
    pre_entry_cancel_rate_pct: f64,
    has_spoof: bool,
    iceberg_supported: bool,
    mfe_pct: Option<f64>,
    mae_pct: Option<f64>,
    end_return_pct: Option<f64>,
    whale_net_delta_million_won: f64,
    post_program_delta_million_won: Option<f64>,
) -> DiagnosisTag {
    let adverse_move = mae_pct.is_some_and(|mae| mae < ADVERSE_MAE_THRESHOLD_PCT)
        || end_return_pct.is_some_and(|ret| ret < 0.0);
    if pre_entry_cancel_rate_pct >= SPOOF_CANCEL_RATE_THRESHOLD_PCT || (has_spoof && adverse_move) {
        return DiagnosisTag::SpoofChaseTrap;
    }
    if iceberg_supported {
        return DiagnosisTag::IcebergSupport;
    }
    let favorable_mfe = mfe_pct.is_some_and(|mfe| mfe > FAVORABLE_MFE_THRESHOLD_PCT);
    let whale_aligned = match side {
        OrderSide::Buy => whale_net_delta_million_won >= WHALE_DIAGNOSIS_THRESHOLD_MILLION,
        OrderSide::Sell => whale_net_delta_million_won <= -WHALE_DIAGNOSIS_THRESHOLD_MILLION,
    };
    if whale_aligned && favorable_mfe {
        return DiagnosisTag::WhaleDivergence;
    }
    if side == OrderSide::Sell
        && post_program_delta_million_won.is_some_and(|delta| delta >= PROGRAM_DIAGNOSIS_THRESHOLD_MILLION)
        && mae_pct.is_some_and(|mae| mae < ADVERSE_MAE_THRESHOLD_PCT)
    {
        return DiagnosisTag::EarlyStopBeforeProgram;
    }
    DiagnosisTag::Neutral
}

fn format_million_krw(value: f64) -> String {
    let sign = if value > 0.0 { "+" } else if value < 0.0 { "-" } else { "" };
    let abs = value.abs();
    if abs >= 100.0 {
        format!("{sign}{:.1}억", abs / 100.0)
    } else {
        format!("{sign}{:.0}백만", abs)
    }
}

fn format_summary(
    diagnosis: DiagnosisTag,
    cancel_rate_pct: f64,
    mfe_pct: Option<f64>,
    mae_pct: Option<f64>,
    whale_net_delta_million_won: f64,
    program_delta_million_won: Option<f64>,
) -> String {
    let mfe = mfe_pct.unwrap_or(0.0);
    let mae = mae_pct.unwrap_or(0.0);
    match diagnosis {
        DiagnosisTag::SpoofChaseTrap => format!("진입 직전 허수 취소율 {cancel_rate_pct:.1}% 감지 · 5분 MAE {mae:.2}%"),
        DiagnosisTag::IcebergSupport => format!("진입 직전 아이스버그 지지 포착 · 5분 MFE +{mfe:.2}%"),
        DiagnosisTag::WhaleDivergence => format!(
            "진입 1분 고래 순체결 {} · 5분 MFE +{mfe:.2}%",
            format_million_krw(whale_net_delta_million_won),
        ),
        DiagnosisTag::EarlyStopBeforeProgram => format!(
            "매도 후 5분 프로그램 {} 유입 · 이후 역행 {mae:.2}%",
            format_million_krw(program_delta_million_won.unwrap_or(0.0)),
        ),
        DiagnosisTag::Neutral => format!("특이 미시 신호 없음 · 5분 MFE +{mfe:.2}% / MAE {mae:.2}%"),
    }
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hms(h: u32, m: u32, s: u32) -> TimeOfDay {
        TimeOfDay::hms(h, m, s).unwrap()
    }

    fn at_ms(date: KstDate, h: u32, m: u32, s: u32) -> i64 {
        kst(date, h, m, s).unix() * 1000
    }

    fn tick_row(date: KstDate, h: u32, m: u32, s: u32, price_won: u64, signed_qty: i64) -> CollectedTradeTick {
        CollectedTradeTick {
            recv_ms: at_ms(date, h, m, s),
            hhmmss: hms(h, m, s),
            price_won,
            signed_qty,
            side: None,
            instant_value_thousand_won: None,
            exchange: None,
        }
    }

    fn program_row(date: KstDate, h: u32, m: u32, s: u32, net_million: i64, change_million: i64) -> CollectedProgramRow {
        CollectedProgramRow {
            recv_ms: at_ms(date, h, m, s),
            hhmmss: hms(h, m, s),
            price_won: Some(70_000),
            sell_qty: 0,
            sell_amount_million_won: 0,
            buy_qty: 0,
            buy_amount_million_won: 0,
            net_buy_qty: 0,
            net_buy_qty_change: 0,
            net_buy_amount_million_won: net_million,
            net_buy_amount_change_million_won: change_million,
        }
    }

    fn make_fill(order_no: &str, side: OrderSide, price: u64, time: &str) -> TradingExecution {
        TradingExecution {
            order_no: order_no.to_owned(),
            code: "005930".to_owned(),
            name: "삼성전자".to_owned(),
            side,
            quantity: 10,
            price,
            time: time.to_owned(),
            venue: api::Venue::Krx,
        }
    }

    #[test]
    fn diagnoses_spoof_chase_trap_with_slippage_and_mae() {
        let date = KstDate::new(2026, 11, 25).unwrap();
        let data = SymbolCollectedData {
            ticks: vec![
                tick_row(date, 9, 30, 10, 70_000, 100),
                tick_row(date, 9, 30, 15, 70_200, 50),
                tick_row(date, 9, 31, 0, 69_600, -100),
                tick_row(date, 9, 34, 0, 69_700, -50),
            ],
            program: vec![
                program_row(date, 9, 30, 0, 20, 10),
                program_row(date, 9, 32, 0, -40, -60),
            ],
            micro_events: vec![MicroEvent {
                recv_ms: at_ms(date, 9, 30, 12),
                kind: MicroEventKind::SpoofCancel,
                side: MicroSide::Ask,
                price_won: 70_200,
                cancelled_or_absorbed_qty: 4_500,
                displayed_qty: 5_000,
                executed_qty: 500,
                ratio_bps: 9_000,
            }],
        };
        let fill = make_fill("0001", OrderSide::Buy, 70_200, "093015");
        let result = analyze_execution(&fill, date, SymbolKind::Common, Some(70_000), Some(&data));
        assert!(result.collected);
        assert_eq!(result.diagnosis, DiagnosisTag::SpoofChaseTrap);
        assert_eq!(result.slippage_ticks, Some(2));
        assert_eq!(result.pre_entry_cancel_rate_pct, Some(90.0));
        assert_eq!(result.program_delta_million_won, Some(-60.0));
        assert_eq!(result.mfe_pct, Some(0.0));
        assert_eq!(result.mae_pct, Some(-0.85));
        assert!(result.summary.contains("90.0%"));
    }

    #[test]
    fn diagnoses_iceberg_support_and_whale_divergence() {
        let date = KstDate::new(2026, 11, 25).unwrap();
        let iceberg_data = SymbolCollectedData {
            ticks: vec![
                tick_row(date, 9, 30, 15, 70_000, 100),
                tick_row(date, 9, 32, 0, 70_700, 100),
            ],
            program: vec![],
            micro_events: vec![MicroEvent {
                recv_ms: at_ms(date, 9, 30, 10),
                kind: MicroEventKind::IcebergAbsorb,
                side: MicroSide::Bid,
                price_won: 70_000,
                cancelled_or_absorbed_qty: 2_000,
                displayed_qty: 1_000,
                executed_qty: 2_000,
                ratio_bps: 20_000,
            }],
        };
        let fill = make_fill("0002", OrderSide::Buy, 70_000, "093015");
        let iceberg = analyze_execution(&fill, date, SymbolKind::Common, None, Some(&iceberg_data));
        assert_eq!(iceberg.diagnosis, DiagnosisTag::IcebergSupport);
        assert_eq!(iceberg.mfe_pct, Some(1.0));
        assert_eq!(iceberg.mae_pct, Some(0.0));
        assert_eq!(iceberg.slippage_ticks, Some(0));

        let whale_data = SymbolCollectedData {
            ticks: vec![
                tick_row(date, 9, 29, 30, 70_000, 2_000),
                tick_row(date, 9, 30, 15, 70_000, 50),
                tick_row(date, 9, 33, 0, 70_500, 100),
            ],
            program: vec![],
            micro_events: vec![],
        };
        let whale = analyze_execution(&fill, date, SymbolKind::Common, None, Some(&whale_data));
        assert_eq!(whale.diagnosis, DiagnosisTag::WhaleDivergence);
        assert_eq!(whale.whale_net_delta_million_won, Some(140.0));
        assert_eq!(whale.mfe_pct, Some(0.71));
    }

    #[test]
    fn diagnoses_early_stop_before_program_for_sell() {
        let date = KstDate::new(2026, 11, 25).unwrap();
        let data = SymbolCollectedData {
            ticks: vec![
                tick_row(date, 10, 0, 0, 70_000, -50),
                tick_row(date, 10, 2, 0, 70_600, 100),
                tick_row(date, 10, 4, 0, 70_500, 80),
            ],
            program: vec![
                program_row(date, 9, 59, 55, 50, 10),
                program_row(date, 10, 3, 0, 220, 170),
            ],
            micro_events: vec![],
        };
        let fill = make_fill("0003", OrderSide::Sell, 70_000, "100000");
        let res = analyze_execution(&fill, date, SymbolKind::Common, Some(70_100), Some(&data));
        assert_eq!(res.diagnosis, DiagnosisTag::EarlyStopBeforeProgram);
        assert_eq!(res.mae_pct, Some(-0.86));
        assert_eq!(res.mfe_pct, Some(0.0));
        assert_eq!(res.slippage_ticks, Some(1));
        assert_eq!(res.program_delta_million_won, Some(180.0));
    }

    #[test]
    fn uncollected_fallback_returns_neutral_and_null_metrics() {
        let date = KstDate::new(2026, 11, 25).unwrap();
        let fill = make_fill("0004", OrderSide::Buy, 70_000, "093015");
        let res = analyze_execution(&fill, date, SymbolKind::Common, None, None);
        assert!(!res.collected);
        assert_eq!(res.diagnosis, DiagnosisTag::Neutral);
        assert!(res.mfe_pct.is_none());
        assert!(res.mae_pct.is_none());
        assert!(res.slippage_ticks.is_none());
        assert_eq!(res.summary, UNCOLLECTED_SUMMARY);
    }

    #[test]
    fn cache_evicts_least_recently_used_entry() {
        let cache = ForensicsCache::with_capacity(2);
        let key = |date: &str| CacheKey {
            account: "acc".to_owned(),
            date: date.to_owned(),
            fingerprint: 1,
            store_stamp: "none".to_owned(),
        };
        let value = |date: &str| ExecutionForensics {
            date: date.to_owned(),
            account: Some("acc".to_owned()),
            items: vec![],
        };
        cache.insert(key("20261123"), value("20261123"));
        cache.insert(key("20261124"), value("20261124"));
        assert!(cache.get(&key("20261123")).is_some());
        cache.insert(key("20261125"), value("20261125"));
        assert!(cache.get(&key("20261123")).is_some());
        assert!(cache.get(&key("20261124")).is_none());
        assert!(cache.get(&key("20261125")).is_some());
    }

    #[test]
    fn program_window_delta_includes_first_row_inflow_without_prior_row() {
        let date = KstDate::new(2026, 11, 25).unwrap();
        let rows = vec![
            program_row(date, 10, 0, 5, 150, 150),
            program_row(date, 10, 2, 0, 200, 50),
        ];
        let delta = program_window_delta(&rows, hms(9, 59, 50).secs(), hms(10, 5, 0).secs());
        assert_eq!(delta, Some(200.0));
    }

    #[test]
    fn program_post_delta_zero_sum_flow_stays_zero_and_neutral() {
        let date = KstDate::new(2026, 11, 25).unwrap();
        let data = SymbolCollectedData {
            ticks: vec![
                tick_row(date, 10, 0, 0, 70_000, -50),
                tick_row(date, 10, 2, 0, 70_600, 100),
            ],
            program: vec![
                program_row(date, 10, 1, 0, -150, -150),
                program_row(date, 10, 3, 0, 0, 150),
            ],
            micro_events: vec![],
        };
        let fill = make_fill("0005", OrderSide::Sell, 70_000, "100000");
        assert_eq!(program_post_delta(&data.program, hms(10, 0, 0).secs(), hms(10, 5, 0).secs()), Some(0.0));
        let res = analyze_execution(&fill, date, SymbolKind::Common, Some(70_000), Some(&data));
        assert_eq!(res.diagnosis, DiagnosisTag::Neutral);
        assert_eq!(res.program_delta_million_won, Some(0.0));
    }

    #[test]
    fn out_of_order_hhmmss_ticks_and_program_rows_are_not_truncated() {
        let date = KstDate::new(2026, 11, 25).unwrap();
        let data = SymbolCollectedData {
            ticks: vec![
                CollectedTradeTick {
                    recv_ms: at_ms(date, 9, 30, 15),
                    hhmmss: hms(9, 30, 15),
                    price_won: 70_000,
                    signed_qty: 50,
                    side: None,
                    instant_value_thousand_won: None,
                    exchange: None,
                },
                CollectedTradeTick {
                    recv_ms: at_ms(date, 9, 30, 16),
                    hhmmss: hms(9, 36, 0),
                    price_won: 70_100,
                    signed_qty: 10,
                    side: None,
                    instant_value_thousand_won: None,
                    exchange: None,
                },
                CollectedTradeTick {
                    recv_ms: at_ms(date, 9, 30, 17),
                    hhmmss: hms(9, 32, 0),
                    price_won: 69_000,
                    signed_qty: -100,
                    side: None,
                    instant_value_thousand_won: None,
                    exchange: None,
                },
                CollectedTradeTick {
                    recv_ms: at_ms(date, 9, 30, 18),
                    hhmmss: hms(9, 29, 30),
                    price_won: 70_000,
                    signed_qty: 2_000,
                    side: None,
                    instant_value_thousand_won: None,
                    exchange: None,
                },
                CollectedTradeTick {
                    recv_ms: at_ms(date, 9, 30, 19),
                    hhmmss: hms(9, 33, 0),
                    price_won: 70_700,
                    signed_qty: 100,
                    side: None,
                    instant_value_thousand_won: None,
                    exchange: None,
                },
            ],
            program: vec![
                CollectedProgramRow {
                    recv_ms: at_ms(date, 9, 30, 16),
                    hhmmss: hms(9, 36, 0),
                    price_won: Some(70_000),
                    sell_qty: 0,
                    sell_amount_million_won: 0,
                    buy_qty: 0,
                    buy_amount_million_won: 0,
                    net_buy_qty: 0,
                    net_buy_qty_change: 0,
                    net_buy_amount_million_won: 300,
                    net_buy_amount_change_million_won: 100,
                },
                CollectedProgramRow {
                    recv_ms: at_ms(date, 9, 30, 17),
                    hhmmss: hms(9, 32, 0),
                    price_won: Some(70_000),
                    sell_qty: 0,
                    sell_amount_million_won: 0,
                    buy_qty: 0,
                    buy_amount_million_won: 0,
                    net_buy_qty: 0,
                    net_buy_qty_change: 0,
                    net_buy_amount_million_won: 200,
                    net_buy_amount_change_million_won: 150,
                },
                CollectedProgramRow {
                    recv_ms: at_ms(date, 9, 30, 18),
                    hhmmss: hms(9, 29, 50),
                    price_won: Some(70_000),
                    sell_qty: 0,
                    sell_amount_million_won: 0,
                    buy_qty: 0,
                    buy_amount_million_won: 0,
                    net_buy_qty: 0,
                    net_buy_qty_change: 0,
                    net_buy_amount_million_won: 50,
                    net_buy_amount_change_million_won: 50,
                },
            ],
            micro_events: vec![],
        };
        let fill = make_fill("0006", OrderSide::Buy, 70_000, "093015");
        let res = analyze_execution(&fill, date, SymbolKind::Common, None, Some(&data));
        assert_eq!(res.mae_pct, Some(-1.43));
        assert_eq!(res.mfe_pct, Some(1.0));
        assert_eq!(res.whale_net_delta_million_won, Some(140.0));
        assert_eq!(res.program_delta_million_won, Some(150.0));
        assert_eq!(res.diagnosis, DiagnosisTag::WhaleDivergence);
    }

    #[test]
    fn zero_price_fill_or_intended_price_returns_null_slippage_ticks() {
        let date = KstDate::new(2026, 11, 25).unwrap();
        let data = SymbolCollectedData {
            ticks: vec![tick_row(date, 9, 30, 15, 70_000, 50)],
            program: vec![],
            micro_events: vec![],
        };
        let zero_fill = make_fill("0007", OrderSide::Buy, 0, "093015");
        let res_zero_fill = analyze_execution(&zero_fill, date, SymbolKind::Common, Some(70_000), Some(&data));
        assert!(res_zero_fill.slippage_ticks.is_none());
        assert!(res_zero_fill.mfe_pct.is_none());
        assert!(res_zero_fill.mae_pct.is_none());

        let normal_fill = make_fill("0008", OrderSide::Buy, 70_200, "093015");
        let res_zero_intended = analyze_execution(&normal_fill, date, SymbolKind::Common, Some(0), Some(&data));
        assert!(res_zero_intended.slippage_ticks.is_none());
    }
}
