const ACCOUNT_PATH: &str = "/api/dostk/acnt";
const ORDER_PATH: &str = "/api/dostk/ordr";

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum TradingApiId {
    Ka00001,
    Kt00018,
    Ka10075,
    Kt00011,
    Kt00007,
    Kt10000,
    Kt10001,
    Kt10002,
    Kt10003,
}

impl TradingApiId {
    pub const ORDER_WRITES: [TradingApiId; 4] = [TradingApiId::Kt10000, TradingApiId::Kt10001, TradingApiId::Kt10002, TradingApiId::Kt10003];

    pub fn is_order_write(self) -> bool {
        Self::ORDER_WRITES.contains(&self)
    }

    pub const fn path(self) -> &'static str {
        match self {
            TradingApiId::Ka00001 | TradingApiId::Kt00018 | TradingApiId::Ka10075 | TradingApiId::Kt00011 | TradingApiId::Kt00007 => ACCOUNT_PATH,
            TradingApiId::Kt10000 | TradingApiId::Kt10001 | TradingApiId::Kt10002 | TradingApiId::Kt10003 => ORDER_PATH,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            TradingApiId::Ka00001 => "ka00001",
            TradingApiId::Kt00018 => "kt00018",
            TradingApiId::Ka10075 => "ka10075",
            TradingApiId::Kt00011 => "kt00011",
            TradingApiId::Kt00007 => "kt00007",
            TradingApiId::Kt10000 => "kt10000",
            TradingApiId::Kt10001 => "kt10001",
            TradingApiId::Kt10002 => "kt10002",
            TradingApiId::Kt10003 => "kt10003",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum KisTradingApiId {
    CashSell,
    CashBuy,
    ReviseCancel,
    Balance,
    Revisable,
    Buyable,
    DailyFills,
}

impl KisTradingApiId {
    pub const ALL: [KisTradingApiId; 7] = [KisTradingApiId::CashSell, KisTradingApiId::CashBuy, KisTradingApiId::ReviseCancel, KisTradingApiId::Balance, KisTradingApiId::Revisable, KisTradingApiId::Buyable, KisTradingApiId::DailyFills];

    pub fn is_order_write(self) -> bool {
        matches!(self, KisTradingApiId::CashSell | KisTradingApiId::CashBuy | KisTradingApiId::ReviseCancel)
    }

    pub const fn tr_id(self) -> &'static str {
        match self {
            KisTradingApiId::CashSell => "TTTC0011U",
            KisTradingApiId::CashBuy => "TTTC0012U",
            KisTradingApiId::ReviseCancel => "TTTC0013U",
            KisTradingApiId::Balance => "TTTC8434R",
            KisTradingApiId::Revisable => "TTTC0084R",
            KisTradingApiId::Buyable => "TTTC8908R",
            KisTradingApiId::DailyFills => "TTTC0081R",
        }
    }

    pub const fn path(self) -> &'static str {
        match self {
            KisTradingApiId::CashSell | KisTradingApiId::CashBuy => "/uapi/domestic-stock/v1/trading/order-cash",
            KisTradingApiId::ReviseCancel => "/uapi/domestic-stock/v1/trading/order-rvsecncl",
            KisTradingApiId::Balance => "/uapi/domestic-stock/v1/trading/inquire-balance",
            KisTradingApiId::Revisable => "/uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl",
            KisTradingApiId::Buyable => "/uapi/domestic-stock/v1/trading/inquire-psbl-order",
            KisTradingApiId::DailyFills => "/uapi/domestic-stock/v1/trading/inquire-daily-ccld",
        }
    }
}

#[cfg(test)]
impl TradingApiId {
    pub(crate) const BALANCE_READ: TradingApiId = TradingApiId::Kt00018;
    pub(crate) const FILLS_READ: TradingApiId = TradingApiId::Kt00007;
    pub(crate) const OPEN_ORDERS_READ: TradingApiId = TradingApiId::Ka10075;
    pub(crate) const BUYABLE_READ: TradingApiId = TradingApiId::Kt00011;
}

#[cfg(test)]
mod tests {
    use super::*;

    const KIS_TRADING_PATH: &str = "/uapi/domestic-stock/v1/trading/";

    #[test]
    fn every_kis_trading_tr_has_its_own_id_a_trading_path_and_no_mock_prefix() {
        let ids: std::collections::HashSet<&str> = KisTradingApiId::ALL.iter().map(|id| id.tr_id()).collect();
        assert_eq!(ids.len(), KisTradingApiId::ALL.len());
        for id in KisTradingApiId::ALL {
            assert!(id.path().starts_with(KIS_TRADING_PATH) && id.tr_id().starts_with("TTTC"), "{id:?}");
        }
        assert_eq!(KisTradingApiId::ALL.iter().filter(|id| id.is_order_write()).count(), 3);
    }
}
