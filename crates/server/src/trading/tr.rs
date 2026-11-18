const ACCOUNT_PATH: &str = "/api/dostk/acnt";

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum TradingApiId {
    Ka00001,
    Kt00018,
    Ka10075,
    Kt00010,
    Kt00007,
}

impl TradingApiId {
    pub const fn path(self) -> &'static str {
        match self {
            TradingApiId::Ka00001 | TradingApiId::Kt00018 | TradingApiId::Ka10075 | TradingApiId::Kt00010 | TradingApiId::Kt00007 => ACCOUNT_PATH,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            TradingApiId::Ka00001 => "ka00001",
            TradingApiId::Kt00018 => "kt00018",
            TradingApiId::Ka10075 => "ka10075",
            TradingApiId::Kt00010 => "kt00010",
            TradingApiId::Kt00007 => "kt00007",
        }
    }
}
