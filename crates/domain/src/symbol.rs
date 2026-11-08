use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SymbolError {
    Malformed(String),
}

impl fmt::Display for SymbolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SymbolError::Malformed(s) => write!(f, "종목코드 형식이 아닙니다: {s}"),
        }
    }
}

impl std::error::Error for SymbolError {}

/// KRX 단축코드 6자리. 영문 대문자가 섞일 수 있고 끝자리도 글자일 수 있다(예: "0000D0", "03481K").
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StockCode([u8; 6]);

impl StockCode {
    pub fn parse(s: &str) -> Result<Self, SymbolError> {
        let bytes: [u8; 6] = s
            .as_bytes()
            .try_into()
            .map_err(|_| SymbolError::Malformed(s.to_owned()))?;
        if bytes.iter().all(|b| b.is_ascii_digit() || b.is_ascii_uppercase()) {
            Ok(StockCode(bytes))
        } else {
            Err(SymbolError::Malformed(s.to_owned()))
        }
    }

    pub fn as_str(&self) -> &str {
        std::str::from_utf8(&self.0).expect("parse admits ASCII only")
    }

    /// 끝자리가 '0'이 아니면 우선주다(kiwoom.md §5). 주식 집합 안에서만 쓴다.
    pub fn is_preferred_code(&self) -> bool {
        self.0[5] != b'0'
    }
}

impl fmt::Debug for StockCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "StockCode({})", self.as_str())
    }
}

/// 키움 업종코드 3자리. 코스피 "001", 코스닥 "101".
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct IndexCode([u8; 3]);

impl IndexCode {
    pub const KOSPI: IndexCode = IndexCode(*b"001");
    pub const KOSDAQ: IndexCode = IndexCode(*b"101");

    pub fn parse(s: &str) -> Result<Self, SymbolError> {
        let bytes: [u8; 3] = s
            .as_bytes()
            .try_into()
            .map_err(|_| SymbolError::Malformed(s.to_owned()))?;
        if bytes.iter().all(u8::is_ascii_digit) {
            Ok(IndexCode(bytes))
        } else {
            Err(SymbolError::Malformed(s.to_owned()))
        }
    }

    pub fn as_str(&self) -> &str {
        std::str::from_utf8(&self.0).expect("parse admits ASCII only")
    }
}

impl fmt::Debug for IndexCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "IndexCode({})", self.as_str())
    }
}

/// 종목 또는 지수. 드로잉처럼 거래소와 무관한 것이 붙는 단위다. 차트로 그리는 시세는 `Feed`다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Symbol {
    /// 주식(보통주·우선주·리츠)과 ETF.
    Stock(StockCode),
    Index(IndexCode),
}

const INDEX_PREFIX: &str = "IDX:";

impl Symbol {
    /// 브라우저와 DB에서 쓰는 문자열. 주식 "005930", 지수 "IDX:001".
    pub fn parse(s: &str) -> Result<Self, SymbolError> {
        match s.strip_prefix(INDEX_PREFIX) {
            Some(rest) => IndexCode::parse(rest).map(Symbol::Index),
            None => StockCode::parse(s).map(Symbol::Stock),
        }
    }

    pub fn as_wire(&self) -> String {
        match self {
            Symbol::Stock(c) => c.as_str().to_owned(),
            Symbol::Index(c) => format!("{INDEX_PREFIX}{}", c.as_str()),
        }
    }
}

/// 시세가 체결된 곳(ADR 0007). 칸마다 하나를 고르고 기본은 통합이다. 지수에는 없다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
pub enum Venue {
    /// KRX와 NXT를 합친 통합 시세.
    #[default]
    Combined,
    Krx,
    Nxt,
}

impl Venue {
    pub const ALL: [Venue; 3] = [Venue::Combined, Venue::Krx, Venue::Nxt];

    pub fn as_wire(self) -> &'static str {
        match self {
            Venue::Combined => "combined",
            Venue::Krx => "krx",
            Venue::Nxt => "nxt",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Venue::ALL.into_iter().find(|v| v.as_wire() == s)
    }
}

/// 차트가 그리는 시세 하나. 주식은 거래소를 고르고, 지수에는 거래소가 없다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Feed {
    Stock(StockCode, Venue),
    Index(IndexCode),
}

impl Feed {
    /// 지수에 거래소를 주면 `None`. 주식에 거래소를 주지 않으면 통합이다.
    pub fn new(symbol: Symbol, venue: Option<Venue>) -> Option<Feed> {
        match (symbol, venue) {
            (Symbol::Stock(c), v) => Some(Feed::Stock(c, v.unwrap_or_default())),
            (Symbol::Index(c), None) => Some(Feed::Index(c)),
            (Symbol::Index(_), Some(_)) => None,
        }
    }

    pub fn symbol(self) -> Symbol {
        match self {
            Feed::Stock(c, _) => Symbol::Stock(c),
            Feed::Index(c) => Symbol::Index(c),
        }
    }

    pub fn venue(self) -> Option<Venue> {
        match self {
            Feed::Stock(_, v) => Some(v),
            Feed::Index(_) => None,
        }
    }
}

/// 검색에서 같은 순위일 때 이 순서로 앞에 둔다(D5): Index > Common > Preferred > Etf > Reit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SymbolKind {
    Index,
    Common,
    Preferred,
    Etf,
    Reit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Market {
    Kospi,
    Kosdaq,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SymbolInfo {
    pub symbol: Symbol,
    pub name: String,
    pub kind: SymbolKind,
    pub market: Market,
    /// NXT에서 거래되는 종목인가(ka10099 `nxtEnable`). 지수는 언제나 false.
    pub nxt_enabled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stock_codes_accept_digits_and_uppercase() {
        for ok in ["005930", "0000D0", "03481K"] {
            assert_eq!(StockCode::parse(ok).unwrap().as_str(), ok);
        }
        for bad in ["", "5930", "0059301", "00593a", "005 30", "가나다라마바"] {
            assert!(StockCode::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn preferred_is_decided_by_the_last_character() {
        assert!(!StockCode::parse("005930").unwrap().is_preferred_code());
        assert!(StockCode::parse("005935").unwrap().is_preferred_code());
        assert!(StockCode::parse("03481K").unwrap().is_preferred_code());
        assert!(!StockCode::parse("0000D0").unwrap().is_preferred_code());
    }

    #[test]
    fn symbol_wire_round_trips() {
        for s in ["005930", "IDX:001", "IDX:101", "03481K"] {
            assert_eq!(Symbol::parse(s).unwrap().as_wire(), s);
        }
        assert_eq!(Symbol::parse("IDX:001").unwrap(), Symbol::Index(IndexCode::KOSPI));
        for bad in ["IDX:", "IDX:01", "IDX:ABC", "idx:001", "IDX:0001"] {
            assert!(Symbol::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn venue_wire_round_trips_and_index_has_none() {
        for v in Venue::ALL {
            assert_eq!(Venue::parse(v.as_wire()), Some(v));
        }
        assert_eq!(Venue::parse("KRX"), None);
        let stock = Symbol::parse("005930").unwrap();
        let kospi = Symbol::Index(IndexCode::KOSPI);
        assert_eq!(Feed::new(stock, None).unwrap().venue(), Some(Venue::Combined));
        assert_eq!(Feed::new(stock, Some(Venue::Nxt)).unwrap().symbol(), stock);
        assert_eq!(Feed::new(kospi, None), Some(Feed::Index(IndexCode::KOSPI)));
        assert_eq!(Feed::new(kospi, Some(Venue::Krx)), None);
    }

    #[test]
    fn kind_order_matches_search_tie_break() {
        let mut kinds = [SymbolKind::Reit, SymbolKind::Etf, SymbolKind::Common, SymbolKind::Index, SymbolKind::Preferred];
        kinds.sort();
        assert_eq!(kinds, [SymbolKind::Index, SymbolKind::Common, SymbolKind::Preferred, SymbolKind::Etf, SymbolKind::Reit]);
    }
}
