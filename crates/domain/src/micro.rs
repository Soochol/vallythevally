use std::collections::VecDeque;

const BPS_SCALE: u128 = 10_000;
const SINGLE_PRICE_MAX_LEVELS: usize = 3;
const MAX_TRACKED_EXEC_PRICES: usize = 256;
const MAX_WINDOW_SAMPLES: usize = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MicroSide {
    Ask,
    Bid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MicroEventKind {
    SpoofCancel,
    IcebergAbsorb,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MicroEvent {
    pub recv_ms: i64,
    pub kind: MicroEventKind,
    pub side: MicroSide,
    pub price_won: u64,
    pub cancelled_or_absorbed_qty: u64,
    pub displayed_qty: u64,
    pub executed_qty: u64,
    pub ratio_bps: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OfiSnapshot {
    pub recv_ms: i64,
    pub buy_pressure_pct: u8,
    pub ofi_qty: i64,
    pub tape_speed_ratio_bps: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BookSideLevel {
    pub price_won: u64,
    pub qty: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MicroConfig {
    pub spoof_min_drop_qty: u64,
    pub spoof_min_cancel_ratio_bps: u32,
    pub iceberg_min_exec_qty: u64,
    pub iceberg_min_ratio_bps: u32,
    pub ofi_window_ms: i64,
    pub tape_baseline_window_ms: i64,
}

impl Default for MicroConfig {
    fn default() -> Self {
        Self {
            spoof_min_drop_qty: 1_000,
            spoof_min_cancel_ratio_bps: 8_000,
            iceberg_min_exec_qty: 500,
            iceberg_min_ratio_bps: 15_000,
            ofi_window_ms: 10_000,
            tape_baseline_window_ms: 60_000,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct ExecAccum {
    price_won: u64,
    ask_qty: u64,
    bid_qty: u64,
}

#[derive(Debug, Clone)]
pub struct MicroEventDetector {
    config: MicroConfig,
    prev_asks: Vec<BookSideLevel>,
    prev_bids: Vec<BookSideLevel>,
    exec_since_book: Vec<ExecAccum>,
    ofi_samples: VecDeque<(i64, i64)>,
    ofi_sum: i64,
    ofi_abs_sum: u64,
    recent_trades: VecDeque<(i64, u32)>,
    recent_trade_total: u64,
    baseline_trades: VecDeque<(i64, u32)>,
    baseline_trade_total: u64,
    first_trade_ms: Option<i64>,
}

impl Default for MicroEventDetector {
    fn default() -> Self {
        Self::new(MicroConfig::default())
    }
}

impl MicroEventDetector {
    pub fn new(config: MicroConfig) -> Self {
        Self {
            config,
            prev_asks: Vec::with_capacity(10),
            prev_bids: Vec::with_capacity(10),
            exec_since_book: Vec::with_capacity(16),
            ofi_samples: VecDeque::with_capacity(64),
            ofi_sum: 0,
            ofi_abs_sum: 0,
            recent_trades: VecDeque::with_capacity(64),
            recent_trade_total: 0,
            baseline_trades: VecDeque::with_capacity(128),
            baseline_trade_total: 0,
            first_trade_ms: None,
        }
    }

    pub fn config(&self) -> MicroConfig {
        self.config
    }

    pub fn reset(&mut self) {
        self.prev_asks.clear();
        self.prev_bids.clear();
        self.exec_since_book.clear();
        self.ofi_samples.clear();
        self.ofi_sum = 0;
        self.ofi_abs_sum = 0;
        self.recent_trades.clear();
        self.recent_trade_total = 0;
        self.baseline_trades.clear();
        self.baseline_trade_total = 0;
        self.first_trade_ms = None;
    }

    pub fn on_trade(&mut self, recv_ms: i64, price_won: u64, signed_qty: i64) {
        if price_won == 0 || signed_qty == 0 {
            return;
        }
        let qty = signed_qty.unsigned_abs();
        let side = if signed_qty > 0 { MicroSide::Ask } else { MicroSide::Bid };
        self.record_exec(price_won, side, qty);
        self.record_trade_tick(recv_ms);
    }

    pub fn on_book(&mut self, recv_ms: i64, asks: &[BookSideLevel], bids: &[BookSideLevel]) -> (Vec<MicroEvent>, OfiSnapshot) {
        self.evict_ofi(recv_ms);
        self.evict_trades(recv_ms);

        let ask_count = asks.iter().filter(|level| level.price_won > 0 && level.qty > 0).count();
        let bid_count = bids.iter().filter(|level| level.price_won > 0 && level.qty > 0).count();
        if ask_count <= SINGLE_PRICE_MAX_LEVELS && bid_count <= SINGLE_PRICE_MAX_LEVELS {
            self.prev_asks.clear();
            self.prev_bids.clear();
            self.exec_since_book.clear();
            return (Vec::new(), self.snapshot_ofi(recv_ms));
        }

        let mut events = Vec::new();
        if !self.prev_asks.is_empty() || !self.prev_bids.is_empty() {
            if let Some(delta) = compute_ofi_delta(&self.prev_asks, &self.prev_bids, asks, bids) {
                self.push_ofi_delta(recv_ms, delta);
            }
            self.detect_side(recv_ms, MicroSide::Ask, asks, &mut events);
            self.detect_side(recv_ms, MicroSide::Bid, bids, &mut events);
        }

        self.prev_asks.clear();
        self.prev_asks.extend(asks.iter().copied().filter(|level| level.price_won > 0));
        self.prev_bids.clear();
        self.prev_bids.extend(bids.iter().copied().filter(|level| level.price_won > 0));
        self.exec_since_book.clear();

        (events, self.snapshot_ofi(recv_ms))
    }

    pub fn ofi(&mut self, recv_ms: i64) -> OfiSnapshot {
        self.evict_ofi(recv_ms);
        self.evict_trades(recv_ms);
        self.snapshot_ofi(recv_ms)
    }

    fn record_exec(&mut self, price_won: u64, side: MicroSide, qty: u64) {
        if let Some(entry) = self.exec_since_book.iter_mut().find(|item| item.price_won == price_won) {
            match side {
                MicroSide::Ask => entry.ask_qty = entry.ask_qty.saturating_add(qty),
                MicroSide::Bid => entry.bid_qty = entry.bid_qty.saturating_add(qty),
            }
            return;
        }
        if self.exec_since_book.len() >= MAX_TRACKED_EXEC_PRICES {
            return;
        }
        let mut entry = ExecAccum { price_won, ask_qty: 0, bid_qty: 0 };
        match side {
            MicroSide::Ask => entry.ask_qty = qty,
            MicroSide::Bid => entry.bid_qty = qty,
        }
        self.exec_since_book.push(entry);
    }

    fn exec_qty(&self, side: MicroSide, price_won: u64) -> u64 {
        self.exec_since_book
            .iter()
            .find(|item| item.price_won == price_won)
            .map_or(0, |item| match side {
                MicroSide::Ask => item.ask_qty,
                MicroSide::Bid => item.bid_qty,
            })
    }

    fn detect_side(&self, recv_ms: i64, side: MicroSide, curr_levels: &[BookSideLevel], out: &mut Vec<MicroEvent>) {
        let prev_levels = match side {
            MicroSide::Ask => &self.prev_asks,
            MicroSide::Bid => &self.prev_bids,
        };
        let boundary_price = match side {
            MicroSide::Ask => curr_levels.iter().filter(|level| level.price_won > 0 && level.qty > 0).map(|level| level.price_won).max(),
            MicroSide::Bid => curr_levels.iter().filter(|level| level.price_won > 0 && level.qty > 0).map(|level| level.price_won).min(),
        };

        for prev in prev_levels {
            if prev.price_won == 0 || prev.qty == 0 {
                continue;
            }
            let curr_qty = match curr_levels.iter().find(|level| level.price_won == prev.price_won) {
                Some(level) => Some(level.qty),
                None => match (side, boundary_price) {
                    (MicroSide::Ask, Some(max_ask)) if prev.price_won <= max_ask => Some(0),
                    (MicroSide::Bid, Some(min_bid)) if prev.price_won >= min_bid => Some(0),
                    _ => None,
                },
            };
            let Some(curr_qty) = curr_qty else {
                continue;
            };
            let matched_exec = self.exec_qty(side, prev.price_won);

            let drop = prev.qty.saturating_sub(curr_qty);
            if drop >= self.config.spoof_min_drop_qty {
                let cancelled = drop.saturating_sub(matched_exec);
                let cancel_ratio_bps = ((u128::from(cancelled) * BPS_SCALE) / u128::from(drop)) as u32;
                if cancel_ratio_bps >= self.config.spoof_min_cancel_ratio_bps {
                    out.push(MicroEvent {
                        recv_ms,
                        kind: MicroEventKind::SpoofCancel,
                        side,
                        price_won: prev.price_won,
                        cancelled_or_absorbed_qty: cancelled,
                        displayed_qty: prev.qty,
                        executed_qty: matched_exec,
                        ratio_bps: cancel_ratio_bps,
                    });
                }
            }

            if curr_qty > 0 && matched_exec >= self.config.iceberg_min_exec_qty {
                let lhs = u128::from(matched_exec) * BPS_SCALE;
                let rhs = u128::from(prev.qty) * u128::from(self.config.iceberg_min_ratio_bps);
                if lhs >= rhs {
                    let ratio_bps = (lhs / u128::from(prev.qty)).min(u128::from(u32::MAX)) as u32;
                    out.push(MicroEvent {
                        recv_ms,
                        kind: MicroEventKind::IcebergAbsorb,
                        side,
                        price_won: prev.price_won,
                        cancelled_or_absorbed_qty: matched_exec,
                        displayed_qty: prev.qty,
                        executed_qty: matched_exec,
                        ratio_bps,
                    });
                }
            }
        }
    }

    fn push_ofi_delta(&mut self, recv_ms: i64, delta: i64) {
        if delta == 0 {
            return;
        }
        while self.ofi_samples.len() >= MAX_WINDOW_SAMPLES {
            if let Some((_, old)) = self.ofi_samples.pop_front() {
                self.ofi_sum = self.ofi_sum.saturating_sub(old);
                self.ofi_abs_sum = self.ofi_abs_sum.saturating_sub(old.unsigned_abs());
            }
        }
        self.ofi_samples.push_back((recv_ms, delta));
        self.ofi_sum = self.ofi_sum.saturating_add(delta);
        self.ofi_abs_sum = self.ofi_abs_sum.saturating_add(delta.unsigned_abs());
    }

    fn evict_ofi(&mut self, recv_ms: i64) {
        let cutoff = recv_ms.saturating_sub(self.config.ofi_window_ms.max(1));
        while let Some(&(ts, old)) = self.ofi_samples.front() {
            if ts > cutoff {
                break;
            }
            self.ofi_samples.pop_front();
            self.ofi_sum = self.ofi_sum.saturating_sub(old);
            self.ofi_abs_sum = self.ofi_abs_sum.saturating_sub(old.unsigned_abs());
        }
    }

    fn record_trade_tick(&mut self, recv_ms: i64) {
        if self.first_trade_ms.is_none() {
            self.first_trade_ms = Some(recv_ms);
        }
        push_trade_bucket(&mut self.recent_trades, &mut self.recent_trade_total, recv_ms);
        push_trade_bucket(&mut self.baseline_trades, &mut self.baseline_trade_total, recv_ms);
        self.evict_trades(recv_ms);
    }

    fn evict_trades(&mut self, recv_ms: i64) {
        let recent_cutoff = recv_ms.saturating_sub(self.config.ofi_window_ms.max(1));
        evict_trade_buckets(&mut self.recent_trades, &mut self.recent_trade_total, recent_cutoff);
        let baseline_window = self.config.tape_baseline_window_ms.max(self.config.ofi_window_ms.max(1));
        let baseline_cutoff = recv_ms.saturating_sub(baseline_window);
        evict_trade_buckets(&mut self.baseline_trades, &mut self.baseline_trade_total, baseline_cutoff);
    }

    fn snapshot_ofi(&self, recv_ms: i64) -> OfiSnapshot {
        let buy_pressure_pct = if self.ofi_abs_sum == 0 {
            50
        } else {
            let abs = i128::from(self.ofi_abs_sum);
            let sum = i128::from(self.ofi_sum).clamp(-abs, abs);
            (((sum + abs) * 100) / (2 * abs)).clamp(0, 100) as u8
        };
        let tape_speed_ratio_bps = self.tape_speed_ratio_bps(recv_ms);
        OfiSnapshot {
            recv_ms,
            buy_pressure_pct,
            ofi_qty: self.ofi_sum,
            tape_speed_ratio_bps,
        }
    }

    fn tape_speed_ratio_bps(&self, recv_ms: i64) -> u32 {
        if self.baseline_trade_total == 0 {
            return BPS_SCALE as u32;
        }
        if self.recent_trade_total == 0 {
            return 0;
        }
        let recent_window = self.config.ofi_window_ms.max(1);
        let baseline_window = self.config.tape_baseline_window_ms.max(recent_window);
        let elapsed = self.first_trade_ms.map_or(recent_window, |first| recv_ms.saturating_sub(first));
        let baseline_span = elapsed.clamp(recent_window, baseline_window);
        let num = u128::from(self.recent_trade_total) * (baseline_span as u128) * BPS_SCALE;
        let den = u128::from(self.baseline_trade_total) * (recent_window as u128);
        (num / den).min(u128::from(u32::MAX)) as u32
    }
}

fn push_trade_bucket(queue: &mut VecDeque<(i64, u32)>, total: &mut u64, recv_ms: i64) {
    if let Some((last_ms, count)) = queue.back_mut()
        && *last_ms == recv_ms
    {
        *count = count.saturating_add(1);
        *total = total.saturating_add(1);
        return;
    }
    while queue.len() >= MAX_WINDOW_SAMPLES {
        if let Some((_, dropped)) = queue.pop_front() {
            *total = total.saturating_sub(u64::from(dropped));
        }
    }
    queue.push_back((recv_ms, 1));
    *total = total.saturating_add(1);
}

fn evict_trade_buckets(queue: &mut VecDeque<(i64, u32)>, total: &mut u64, cutoff_ms: i64) {
    while let Some(&(ts, count)) = queue.front() {
        if ts > cutoff_ms {
            break;
        }
        queue.pop_front();
        *total = total.saturating_sub(u64::from(count));
    }
}

fn best_ask(levels: &[BookSideLevel]) -> Option<BookSideLevel> {
    levels
        .iter()
        .copied()
        .filter(|level| level.price_won > 0 && level.qty > 0)
        .min_by_key(|level| level.price_won)
        .or_else(|| levels.iter().copied().filter(|level| level.price_won > 0).min_by_key(|level| level.price_won))
}

fn best_bid(levels: &[BookSideLevel]) -> Option<BookSideLevel> {
    levels
        .iter()
        .copied()
        .filter(|level| level.price_won > 0 && level.qty > 0)
        .max_by_key(|level| level.price_won)
        .or_else(|| levels.iter().copied().filter(|level| level.price_won > 0).max_by_key(|level| level.price_won))
}

fn compute_ofi_delta(
    prev_asks: &[BookSideLevel],
    prev_bids: &[BookSideLevel],
    curr_asks: &[BookSideLevel],
    curr_bids: &[BookSideLevel],
) -> Option<i64> {
    let prev_bid = best_bid(prev_bids)?;
    let curr_bid = best_bid(curr_bids)?;
    let prev_ask = best_ask(prev_asks)?;
    let curr_ask = best_ask(curr_asks)?;

    let bid_delta: i128 = if curr_bid.price_won > prev_bid.price_won {
        i128::from(curr_bid.qty)
    } else if curr_bid.price_won == prev_bid.price_won {
        i128::from(curr_bid.qty) - i128::from(prev_bid.qty)
    } else {
        -i128::from(prev_bid.qty)
    };

    let ask_delta: i128 = if curr_ask.price_won < prev_ask.price_won {
        i128::from(curr_ask.qty)
    } else if curr_ask.price_won == prev_ask.price_won {
        i128::from(curr_ask.qty) - i128::from(prev_ask.qty)
    } else {
        -i128::from(prev_ask.qty)
    };

    Some((bid_delta - ask_delta).clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn levels(pairs: &[(u64, u64)]) -> Vec<BookSideLevel> {
        pairs.iter().map(|&(price_won, qty)| BookSideLevel { price_won, qty }).collect()
    }

    fn normal_book(ask_q0: u64, bid_q0: u64) -> (Vec<BookSideLevel>, Vec<BookSideLevel>) {
        (
            levels(&[(70_100, ask_q0), (70_200, 1_000), (70_300, 1_000), (70_400, 1_000), (70_500, 1_000)]),
            levels(&[(70_000, bid_q0), (69_900, 1_000), (69_800, 1_000), (69_700, 1_000), (69_600, 1_000)]),
        )
    }

    #[test]
    fn detects_pure_cancel_as_spoof() {
        let mut detector = MicroEventDetector::default();
        let (asks1, bids1) = normal_book(5_000, 2_000);
        let (events1, ofi1) = detector.on_book(1_000, &asks1, &bids1);
        assert!(events1.is_empty());
        assert_eq!(ofi1.buy_pressure_pct, 50);

        let (asks2, bids2) = normal_book(100, 2_000);
        let (events2, ofi2) = detector.on_book(1_500, &asks2, &bids2);
        assert_eq!(events2.len(), 1);
        assert_eq!(
            events2[0],
            MicroEvent {
                recv_ms: 1_500,
                kind: MicroEventKind::SpoofCancel,
                side: MicroSide::Ask,
                price_won: 70_100,
                cancelled_or_absorbed_qty: 4_900,
                displayed_qty: 5_000,
                executed_qty: 0,
                ratio_bps: 10_000,
            }
        );
        assert_eq!(ofi2.ofi_qty, 4_900);
        assert_eq!(ofi2.buy_pressure_pct, 100);
    }

    #[test]
    fn matched_equal_execution_suppresses_spoof() {
        let mut detector = MicroEventDetector::default();
        let (asks1, bids1) = normal_book(5_000, 2_000);
        detector.on_book(1_000, &asks1, &bids1);

        detector.on_trade(1_200, 70_100, 4_900);

        let (asks2, bids2) = normal_book(100, 2_000);
        let (events, _) = detector.on_book(1_500, &asks2, &bids2);
        assert!(events.is_empty());
    }

    #[test]
    fn partial_execution_still_triggers_spoof_above_ratio_threshold() {
        let mut detector = MicroEventDetector::default();
        let (asks1, bids1) = normal_book(2_000, 4_000);
        detector.on_book(1_000, &asks1, &bids1);

        detector.on_trade(1_100, 70_000, -300);

        let (asks2, bids2) = normal_book(2_000, 1_000);
        let (events, _) = detector.on_book(1_500, &asks2, &bids2);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, MicroEventKind::SpoofCancel);
        assert_eq!(events[0].side, MicroSide::Bid);
        assert_eq!(events[0].cancelled_or_absorbed_qty, 2_700);
        assert_eq!(events[0].executed_qty, 300);
        assert_eq!(events[0].ratio_bps, 9_000);
    }

    #[test]
    fn detects_refilling_iceberg_absorption() {
        let mut detector = MicroEventDetector::default();
        let (asks1, bids1) = normal_book(1_000, 2_000);
        detector.on_book(1_000, &asks1, &bids1);

        detector.on_trade(1_100, 70_100, 800);
        detector.on_trade(1_200, 70_100, 900);

        let (asks2, bids2) = normal_book(600, 2_000);
        let (events, _) = detector.on_book(1_500, &asks2, &bids2);
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0],
            MicroEvent {
                recv_ms: 1_500,
                kind: MicroEventKind::IcebergAbsorb,
                side: MicroSide::Ask,
                price_won: 70_100,
                cancelled_or_absorbed_qty: 1_700,
                displayed_qty: 1_000,
                executed_qty: 1_700,
                ratio_bps: 17_000,
            }
        );
    }

    #[test]
    fn iceberg_requires_level_to_remain_refilled() {
        let mut detector = MicroEventDetector::default();
        let (asks1, bids1) = normal_book(1_000, 2_000);
        detector.on_book(1_000, &asks1, &bids1);
        detector.on_trade(1_200, 70_100, 2_000);

        let asks2 = levels(&[(70_200, 1_000), (70_300, 1_000), (70_400, 1_000), (70_500, 1_000)]);
        let (events, _) = detector.on_book(1_500, &asks2, &bids1);
        assert!(events.is_empty());
    }

    #[test]
    fn single_price_auction_guard_skips_and_resets_tracking() {
        let mut detector = MicroEventDetector::default();
        let (asks1, bids1) = normal_book(5_000, 5_000);
        detector.on_book(1_000, &asks1, &bids1);

        let vi_asks = levels(&[(70_100, 100), (70_200, 100), (70_300, 100)]);
        let vi_bids = levels(&[(70_000, 100), (69_900, 100), (69_800, 100)]);
        let (vi_events, _) = detector.on_book(2_000, &vi_asks, &vi_bids);
        assert!(vi_events.is_empty());

        let (asks2, bids2) = normal_book(100, 100);
        let (after_vi_events, _) = detector.on_book(3_000, &asks2, &bids2);
        assert!(after_vi_events.is_empty());
    }

    #[test]
    fn ofi_rolling_window_expires_and_bounds_buy_pressure() {
        let mut detector = MicroEventDetector::default();
        let (asks1, bids1) = normal_book(2_000, 2_000);
        detector.on_book(10_000, &asks1, &bids1);

        let (asks2, bids2) = normal_book(2_000, 3_000);
        let (_, ofi2) = detector.on_book(12_000, &asks2, &bids2);
        assert_eq!(ofi2.ofi_qty, 1_000);
        assert_eq!(ofi2.buy_pressure_pct, 100);

        let (asks3, bids3) = normal_book(2_000, 2_500);
        let (_, ofi3) = detector.on_book(15_000, &asks3, &bids3);
        assert_eq!(ofi3.ofi_qty, 500);
        assert_eq!(ofi3.buy_pressure_pct, 66);

        let (asks4, bids4) = normal_book(2_000, 2_500);
        let (_, ofi4) = detector.on_book(22_001, &asks4, &bids4);
        assert_eq!(ofi4.ofi_qty, -500);
        assert_eq!(ofi4.buy_pressure_pct, 0);

        let (_, ofi5) = detector.on_book(26_000, &asks4, &bids4);
        assert_eq!(ofi5.ofi_qty, 0);
        assert_eq!(ofi5.buy_pressure_pct, 50);
    }

    #[test]
    fn tape_speed_ratio_tracks_acceleration_over_baseline() {
        let mut detector = MicroEventDetector::default();
        let (asks, bids) = normal_book(2_000, 2_000);
        for second in 0..=60 {
            detector.on_trade(second * 1_000, 70_100, 10);
        }
        let (_, steady) = detector.on_book(60_000, &asks, &bids);
        assert_eq!(steady.tape_speed_ratio_bps, 10_000);

        for idx in 0..20 {
            detector.on_trade(60_500 + idx * 100, 70_100, 10);
        }
        let (_, surge) = detector.on_book(63_000, &asks, &bids);
        assert!(surge.tape_speed_ratio_bps > 15_000, "got {}", surge.tape_speed_ratio_bps);
    }

    #[test]
    fn single_price_auction_guard_ignores_zero_qty_placeholder_levels() {
        let mut detector = MicroEventDetector::default();
        let (asks1, bids1) = normal_book(5_000, 5_000);
        detector.on_book(1_000, &asks1, &bids1);

        let placeholder_asks = levels(&[(70_100, 100), (70_200, 100), (70_300, 100), (70_400, 0), (70_500, 0)]);
        let placeholder_bids = levels(&[(70_000, 100), (69_900, 100), (69_800, 100), (69_700, 0), (69_600, 0)]);
        let (vi_events, _) = detector.on_book(2_000, &placeholder_asks, &placeholder_bids);
        assert!(vi_events.is_empty());

        let (asks2, bids2) = normal_book(100, 100);
        let (after_vi_events, _) = detector.on_book(3_000, &asks2, &bids2);
        assert!(after_vi_events.is_empty());
    }
}
