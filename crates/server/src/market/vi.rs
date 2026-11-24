use std::collections::{BTreeMap, HashMap};

use domain::{KstTime, Price, StockCode, Symbol};

use crate::api::{self, UnixSeconds};
use crate::market_source::vi::{ViAlert, ViDirection, ViReading, vi_session_open, vi_triggers_at};

const ACTIVE_LIMIT_SECS: i64 = 5 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BaseAfterRelease {
    FirstKrxTrade,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BaseOrigin {
    Alert,
    Reading,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ViRow {
    origin: BaseOrigin,
    active: bool,
    direction: Option<ViDirection>,
    trigger_price: Option<Price>,
    base: Option<Price>,
    triggered_at: Option<KstTime>,
    released_at: Option<KstTime>,
}

impl ViRow {
    fn without_vi(origin: BaseOrigin) -> ViRow {
        ViRow { origin, active: false, direction: None, trigger_price: None, base: None, triggered_at: None, released_at: None }
    }

    fn awaits_release(&self) -> bool {
        self.triggered_at.is_some() && self.released_at.is_none()
    }

    fn state(&self, code: StockCode) -> api::ViState {
        let seconds = |at: KstTime| UnixSeconds(at.unix());
        api::ViState {
            symbol: api::SymbolCode(Symbol::Stock(code).as_wire()),
            active: self.active,
            direction: self.direction.map(api::ViDirection::from),
            trigger_price: self.trigger_price.map(won),
            base: self.base.map(won),
            triggered_at: self.triggered_at.map(seconds),
            released_at: self.released_at.map(seconds),
        }
    }
}

fn won(price: Price) -> f64 {
    price.centi() as f64 / 100.0
}

#[derive(Debug, Default)]
pub struct ViBoard {
    rows: BTreeMap<StockCode, ViRow>,
    active_until: HashMap<StockCode, KstTime>,
    awaiting_base: HashMap<StockCode, KstTime>,
}

impl ViBoard {
    pub fn apply_alert(&mut self, alert: &ViAlert, now: KstTime, after_release: BaseAfterRelease) -> bool {
        let today = now.kst_date();
        let triggered_at = KstTime::from_kst_civil(today, alert.triggered);
        let released_at = alert.released.map(|time| KstTime::from_kst_civil(today, time));
        let known = self.rows.get(&alert.code).copied();
        let same_vi = known.filter(|row| row.triggered_at == Some(triggered_at));
        let already_known = match same_vi {
            Some(row) => released_at.is_none() || !row.awaits_release(),
            None => known.is_some_and(|row| row.triggered_at > Some(triggered_at)),
        };
        if already_known || !vi_triggers_at(alert.triggered) {
            return false;
        }
        let active_until = triggered_at.plus_secs(ACTIVE_LIMIT_SECS);
        let active = released_at.is_none() && now < active_until;
        let next = ViRow {
            origin: BaseOrigin::Alert,
            active,
            direction: alert.direction,
            trigger_price: alert.trigger_price,
            base: if active { alert.static_base.or(known.and_then(|row| row.base)) } else { None },
            triggered_at: Some(triggered_at),
            released_at,
        };
        self.active_until.remove(&alert.code);
        self.awaiting_base.remove(&alert.code);
        if active {
            self.active_until.insert(alert.code, active_until);
        }
        if let Some(released_at) = released_at
            && after_release == BaseAfterRelease::FirstKrxTrade
        {
            self.awaiting_base.insert(alert.code, released_at);
        }
        self.rows.insert(alert.code, next);
        true
    }

    pub fn apply_reading(&mut self, reading: &ViReading, now: KstTime) -> bool {
        let known = self.rows.get(&reading.code).copied();
        let row = known.unwrap_or(ViRow::without_vi(BaseOrigin::Reading));
        let mut next = ViRow { base: reading.static_base.or(row.base), ..row };
        if reading.active {
            if !row.awaits_release() && vi_session_open(now) {
                next.active = true;
                next.triggered_at = Some(now);
                next.released_at = None;
                self.active_until.insert(reading.code, now.plus_secs(ACTIVE_LIMIT_SECS));
            }
        } else if row.awaits_release() {
            next.active = false;
            next.released_at = Some(now);
            self.active_until.remove(&reading.code);
        }
        if next == row {
            return false;
        }
        self.rows.insert(reading.code, next);
        true
    }

    pub fn expire(&mut self, now: KstTime) -> Vec<StockCode> {
        if self.active_until.is_empty() {
            return Vec::new();
        }
        let due: Vec<StockCode> = self.active_until.iter().filter(|(_, until)| **until <= now).map(|(code, _)| *code).collect();
        for code in &due {
            self.active_until.remove(code);
            if let Some(row) = self.rows.get_mut(code) {
                row.active = false;
                if row.origin == BaseOrigin::Alert {
                    row.base = None;
                }
            }
        }
        due
    }

    pub fn awaits_base(&self) -> bool {
        !self.awaiting_base.is_empty()
    }

    pub fn take_base(&mut self, code: StockCode, price: Price, traded_at: KstTime) -> bool {
        if self.awaiting_base.get(&code).is_none_or(|released_at| traded_at < *released_at) {
            return false;
        }
        self.awaiting_base.remove(&code);
        match self.rows.get_mut(&code) {
            Some(row) => {
                row.base = Some(price);
                true
            }
            None => false,
        }
    }

    pub fn await_base_only_for(&mut self, hears_trades: impl Fn(StockCode) -> bool) {
        self.awaiting_base.retain(|code, _| hears_trades(*code));
    }

    pub fn stop_awaiting_base(&mut self) {
        self.awaiting_base.clear();
    }

    pub fn clear(&mut self) {
        *self = ViBoard::default();
    }

    pub fn state(&self, code: StockCode) -> Option<api::ViState> {
        self.rows.get(&code).map(|row| row.state(code))
    }

    pub fn states(&self) -> Vec<api::ViState> {
        self.rows.iter().map(|(code, row)| row.state(*code)).collect()
    }
}

#[cfg(test)]
mod tests {
    use domain::{KstDate, TimeOfDay};

    use super::*;
    use crate::clock::kst;

    const SAMSUNG: &str = "005930";
    const HYNIX: &str = "000660";

    fn code(text: &str) -> StockCode {
        StockCode::parse(text).unwrap()
    }

    fn at(h: u32, m: u32, s: u32) -> KstTime {
        kst(KstDate::new(2026, 11, 24).unwrap(), h, m, s)
    }

    fn time(h: u32, m: u32, s: u32) -> TimeOfDay {
        TimeOfDay::hms(h, m, s).unwrap()
    }

    fn price(won: u64) -> Price {
        Price::from_centi(won * 100).unwrap()
    }

    fn alert(text: &str, triggered: TimeOfDay, released: Option<TimeOfDay>) -> ViAlert {
        ViAlert { code: code(text), direction: Some(ViDirection::Up), trigger_price: Some(price(881_000)), static_base: Some(price(800_000)), triggered, released }
    }

    fn samsung(released: Option<TimeOfDay>) -> ViAlert {
        alert(SAMSUNG, time(9, 30, 0), released)
    }

    fn base(board: &ViBoard, text: &str) -> Option<f64> {
        board.state(code(text)).unwrap().base
    }

    fn triggered_board() -> ViBoard {
        let mut board = ViBoard::default();
        assert!(board.apply_alert(&samsung(None), at(9, 30, 0), BaseAfterRelease::FirstKrxTrade));
        board
    }

    fn released_board() -> ViBoard {
        let mut board = triggered_board();
        assert!(board.apply_alert(&samsung(Some(time(9, 32, 14))), at(9, 32, 14), BaseAfterRelease::FirstKrxTrade));
        board
    }

    #[test]
    fn the_first_krx_trade_after_release_becomes_the_base() {
        use crate::market_source::stream::Exchange;
        let mut board = triggered_board();
        assert_eq!(base(&board, SAMSUNG), Some(800_000.0));
        assert!(!board.awaits_base(), "발동 중에는 체결을 기다리지 않는다");
        assert!(board.apply_alert(&samsung(Some(time(9, 32, 14))), at(9, 32, 14), BaseAfterRelease::FirstKrxTrade));
        assert_eq!(base(&board, SAMSUNG), None);
        let mut trade = |exchange: Exchange, won: u64, traded_at: KstTime| board.awaits_base() && exchange == Exchange::Krx && board.take_base(code(SAMSUNG), price(won), traded_at);
        assert!(!trade(Exchange::Krx, 881_000, at(9, 32, 13)), "해제 전에 찍힌 체결은 쓰지 않는다");
        assert!(!trade(Exchange::Nxt, 882_000, at(9, 32, 15)));
        assert!(trade(Exchange::Krx, 884_000, at(9, 32, 16)));
        assert!(!trade(Exchange::Krx, 890_000, at(9, 32, 17)));
        assert_eq!(base(&board, SAMSUNG), Some(884_000.0));
        assert!(!board.awaits_base());
    }

    #[test]
    fn a_vi_without_a_release_turns_off_after_five_minutes() {
        let mut board = triggered_board();
        assert!(board.expire(at(9, 34, 59)).is_empty());
        assert!(board.state(code(SAMSUNG)).unwrap().active);
        assert_eq!(board.expire(at(9, 35, 0)), [code(SAMSUNG)]);
        let state = board.state(code(SAMSUNG)).unwrap();
        assert!(!state.active);
        assert_eq!((state.released_at, state.base), (None, None));
        assert!(board.expire(at(9, 35, 1)).is_empty());
        assert!(!board.apply_alert(&samsung(None), at(9, 35, 2), BaseAfterRelease::FirstKrxTrade), "같은 발동이 다시 와도 켜지지 않는다");
        assert!(board.apply_alert(&samsung(Some(time(9, 36, 0))), at(9, 36, 0), BaseAfterRelease::FirstKrxTrade), "늦은 해제는 반영한다");
        assert!(board.awaits_base());
    }

    #[test]
    fn a_rest_row_never_undoes_a_newer_realtime_state() {
        let mut board = released_board();
        assert!(board.take_base(code(SAMSUNG), price(884_000), at(9, 32, 16)));
        let before = board.state(code(SAMSUNG));
        assert!(!board.apply_alert(&samsung(None), at(10, 0, 0), BaseAfterRelease::Unknown));
        assert_eq!(board.state(code(SAMSUNG)), before);
        assert!(board.apply_alert(&alert(HYNIX, time(9, 10, 0), Some(time(9, 12, 14))), at(10, 0, 0), BaseAfterRelease::Unknown));
        let hynix = board.state(code(HYNIX)).unwrap();
        assert!(!hynix.active);
        assert_eq!((hynix.base, hynix.released_at), (None, Some(UnixSeconds(at(9, 12, 14).unix()))));
        assert!(!board.awaits_base(), "지난 해제는 지금 체결을 기준가로 쓰지 않는다");
        assert!(!board.apply_alert(&alert(SAMSUNG, time(9, 5, 0), Some(time(9, 7, 0))), at(10, 0, 0), BaseAfterRelease::Unknown), "더 오래된 발동은 무시한다");
        assert_eq!(board.state(code(SAMSUNG)), before);
    }

    #[test]
    fn a_dynamic_vi_keeps_the_last_base_and_a_repeated_release_changes_nothing() {
        let mut board = released_board();
        assert!(!board.apply_alert(&samsung(Some(time(9, 32, 14))), at(9, 32, 20), BaseAfterRelease::FirstKrxTrade));
        assert!(board.take_base(code(SAMSUNG), price(884_000), at(9, 32, 14)), "해제와 같은 초의 체결도 쓴다");
        let dynamic = ViAlert { static_base: None, ..alert(SAMSUNG, time(10, 0, 0), None) };
        assert!(board.apply_alert(&dynamic, at(10, 0, 0), BaseAfterRelease::FirstKrxTrade));
        assert_eq!(base(&board, SAMSUNG), Some(884_000.0));
    }

    #[test]
    fn a_vi_triggered_outside_regular_hours_is_left_out() {
        let mut board = ViBoard::default();
        for triggered in [time(8, 59, 59), time(15, 20, 0), time(18, 0, 0)] {
            assert!(!board.apply_alert(&alert(SAMSUNG, triggered, None), at(18, 0, 0), BaseAfterRelease::FirstKrxTrade));
        }
        assert!(board.states().is_empty());
        assert!(board.apply_alert(&alert(SAMSUNG, time(15, 19, 59), None), at(15, 19, 59), BaseAfterRelease::FirstKrxTrade));
        assert!(board.apply_alert(&alert(SAMSUNG, time(15, 19, 59), Some(time(15, 22, 13))), at(15, 22, 13), BaseAfterRelease::FirstKrxTrade), "정규장에 발동한 VI는 뒤에 해제돼도 반영한다");
    }

    #[test]
    fn a_stopped_wait_leaves_the_base_empty() {
        let mut board = released_board();
        board.await_base_only_for(|_| true);
        assert!(board.awaits_base());
        board.await_base_only_for(|_| false);
        assert!(!board.take_base(code(SAMSUNG), price(884_000), at(9, 40, 0)));
        assert_eq!(base(&board, SAMSUNG), None);
    }

    #[test]
    fn readings_follow_the_feed_base_without_direction_or_trigger_price() {
        let mut board = ViBoard::default();
        let reading = |base: Option<u64>, active: bool| ViReading { code: code(SAMSUNG), static_base: base.map(price), active };
        assert!(!board.apply_reading(&reading(None, false), at(9, 29, 0)));
        assert!(board.states().is_empty());
        assert!(board.apply_reading(&reading(Some(800_000), false), at(9, 29, 0)));
        assert!(!board.apply_reading(&reading(Some(800_000), false), at(9, 29, 1)));
        assert!(board.apply_reading(&reading(Some(800_000), true), at(9, 30, 0)));
        let state = board.state(code(SAMSUNG)).unwrap();
        assert!(state.active);
        assert_eq!((state.direction, state.trigger_price, state.base), (None, None, Some(800_000.0)));
        assert_eq!(board.expire(at(9, 35, 0)), [code(SAMSUNG)]);
        assert_eq!(base(&board, SAMSUNG), Some(800_000.0));
        assert!(!board.apply_reading(&reading(Some(800_000), true), at(9, 35, 1)), "꺼진 VI를 다시 켜지 않는다");
        assert!(board.apply_reading(&reading(Some(884_000), false), at(9, 36, 0)));
        let state = board.state(code(SAMSUNG)).unwrap();
        assert_eq!((state.active, state.base, state.released_at), (false, Some(884_000.0), Some(UnixSeconds(at(9, 36, 0).unix()))));
        assert!(!board.apply_reading(&reading(Some(884_000), true), at(15, 20, 0)), "정규장 밖의 발동 표시는 쓰지 않는다");
    }
}
