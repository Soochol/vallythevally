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
