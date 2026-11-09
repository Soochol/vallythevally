use std::fmt;

use crate::period::{Bucket, Period};
use crate::price::{Price, Volume};
use crate::symbol::Feed;
use crate::trade::Trade;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OhlcvError {
    pub open: Price,
    pub high: Price,
    pub low: Price,
    pub close: Price,
}

impl fmt::Display for OhlcvError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "low ≤ open, close ≤ high가 아니다: o={} h={} l={} c={}",
            self.open.centi(),
            self.high.centi(),
            self.low.centi(),
            self.close.centi()
        )
    }
}

impl std::error::Error for OhlcvError {}

/// 시가·고가·저가·종가·거래량. 불변식: low ≤ open, close ≤ high.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ohlcv {
    open: Price,
    high: Price,
    low: Price,
    close: Price,
    volume: Volume,
}

impl Ohlcv {
    /// 키움 응답처럼 바깥에서 온 값. 불변식을 검사한다.
    pub fn try_new(open: Price, high: Price, low: Price, close: Price, volume: Volume) -> Result<Self, OhlcvError> {
        if low <= open.min(close) && open.max(close) <= high {
            Ok(Ohlcv { open, high, low, close, volume })
        } else {
            Err(OhlcvError { open, high, low, close })
        }
    }

    pub fn from_trade(t: &Trade) -> Self {
        Ohlcv { open: t.price, high: t.price, low: t.price, close: t.price, volume: t.qty }
    }

    pub fn absorb(&mut self, t: &Trade) {
        self.high = self.high.max(t.price);
        self.low = self.low.min(t.price);
        self.close = t.price;
        self.volume = Volume(self.volume.0.saturating_add(t.qty.0));
    }

    pub fn open(&self) -> Price {
        self.open
    }

    pub fn high(&self) -> Price {
        self.high
    }

    pub fn low(&self) -> Price {
        self.low
    }

    pub fn close(&self) -> Price {
        self.close
    }

    pub fn volume(&self) -> Volume {
        self.volume
    }
}

/// 봉 출처. 실시간으로 만든 봉은 같은 구간을 키움에서 받으면 교체된다(ADR 0003).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BarSource {
    Realtime,
    Kiwoom,
}

/// 확정 봉. 캐시에 들어갈 수 있는 유일한 봉 타입이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConfirmedBar {
    pub bucket: Bucket,
    pub ohlcv: Ohlcv,
    pub source: BarSource,
    /// 실시간으로 만든 봉 중 체결이 빠졌거나 겹쳤을 수 있는 것(#4). 키움 봉은 언제나 false.
    pub needs_verify: bool,
}

impl ConfirmedBar {
    pub fn from_kiwoom(bucket: Bucket, ohlcv: Ohlcv) -> Self {
        ConfirmedBar { bucket, ohlcv, source: BarSource::Kiwoom, needs_verify: false }
    }
}

/// 캐시 키: (종목, 거래소, 봉 주기). 지수에는 거래소가 없다(ADR 0007).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SeriesKey {
    pub feed: Feed,
    pub period: Period,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(v: u64) -> Price {
        Price::from_centi(v).unwrap()
    }

    #[test]
    fn ohlcv_invariant() {
        assert!(Ohlcv::try_new(p(100), p(120), p(90), p(110), Volume(5)).is_ok());
        assert!(Ohlcv::try_new(p(100), p(100), p(100), p(100), Volume(0)).is_ok());
        assert!(Ohlcv::try_new(p(130), p(120), p(90), p(110), Volume(5)).is_err());
        assert!(Ohlcv::try_new(p(100), p(120), p(105), p(110), Volume(5)).is_err());
        assert!(Ohlcv::try_new(p(100), p(120), p(90), p(80), Volume(5)).is_err());
    }
}
