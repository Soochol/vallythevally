use std::num::NonZeroU64;

/// 0.01 단위 가격. 0보다 크다.
/// 주식 193,500원 → Price(19_350_000). 코스피 5,059.69 → Price(505_969).
/// TR마다 배율이 달라서 자연 단위 → centi 변환은 키움 파서가 TR마다 따로 한다(backend.md §4.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Price(NonZeroU64);

impl Price {
    pub fn from_centi(v: u64) -> Option<Self> {
        NonZeroU64::new(v).map(Price)
    }

    pub fn centi(self) -> u64 {
        self.0.get()
    }

    /// 자연 단위(원, 포인트). 지표 계산과 브라우저 전송에만 쓴다.
    pub fn to_f64(self) -> f64 {
        self.0.get() as f64 / 100.0
    }
}

/// 봉 거래량 또는 체결 수량. 지수 거래량의 단위는 아직 모른다(backend.md §4.6). 받은 값을 그대로 담는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Volume(pub u64);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centi_scale() {
        assert_eq!(Price::from_centi(19_350_000).unwrap().to_f64(), 193_500.0);
        assert_eq!(Price::from_centi(505_969).unwrap().to_f64(), 5_059.69);
        assert!(Price::from_centi(0).is_none());
    }
}
