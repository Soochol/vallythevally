//! 브라우저 계약(backend.md §8). 이 모듈의 타입만 JSON으로 나가고 들어온다.
//! ts-rs가 `web/src/api/generated/`에 TypeScript 정의를 쓴다(`cargo test`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Unix 초(UTC 기준 정수). 봉의 `t`는 봉 시작 시각이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(transparent)]
#[ts(export)]
pub struct UnixSeconds(#[ts(type = "number")] pub i64);

/// 주식·ETF "005930", 지수 "IDX:001"(코스피) "IDX:101"(코스닥).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(transparent)]
#[ts(export)]
pub struct SymbolCode(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Period {
    #[serde(rename = "1m")]
    M1,
    #[serde(rename = "3m")]
    M3,
    #[serde(rename = "5m")]
    M5,
    #[serde(rename = "15m")]
    M15,
    #[serde(rename = "30m")]
    M30,
    #[serde(rename = "60m")]
    M60,
    #[serde(rename = "D")]
    Day,
    #[serde(rename = "W")]
    Week,
    #[serde(rename = "M")]
    Month,
}

impl From<domain::Period> for Period {
    fn from(p: domain::Period) -> Self {
        match p {
            domain::Period::M1 => Period::M1,
            domain::Period::M3 => Period::M3,
            domain::Period::M5 => Period::M5,
            domain::Period::M15 => Period::M15,
            domain::Period::M30 => Period::M30,
            domain::Period::M60 => Period::M60,
            domain::Period::Day => Period::Day,
            domain::Period::Week => Period::Week,
            domain::Period::Month => Period::Month,
        }
    }
}

impl From<Period> for domain::Period {
    fn from(p: Period) -> Self {
        match p {
            Period::M1 => domain::Period::M1,
            Period::M3 => domain::Period::M3,
            Period::M5 => domain::Period::M5,
            Period::M15 => domain::Period::M15,
            Period::M30 => domain::Period::M30,
            Period::M60 => domain::Period::M60,
            Period::Day => domain::Period::Day,
            Period::Week => domain::Period::Week,
            Period::Month => domain::Period::Month,
        }
    }
}

/// 봉 하나. 가격은 자연 단위(주식 원, 지수 포인트), 거래량은 정수.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Bar {
    pub t: UnixSeconds,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
    #[ts(type = "number")]
    pub v: u64,
}

impl From<&domain::ConfirmedBar> for Bar {
    fn from(b: &domain::ConfirmedBar) -> Self {
        Bar::new(b.bucket, &b.ohlcv)
    }
}

impl Bar {
    pub fn new(bucket: domain::Bucket, o: &domain::Ohlcv) -> Self {
        Bar {
            t: UnixSeconds(bucket.start().unix()),
            o: o.open().to_f64(),
            h: o.high().to_f64(),
            l: o.low().to_f64(),
            c: o.close().to_f64(),
            v: o.volume().0,
        }
    }
}

/// `GET /api/bars?symbol=005930&period=D&limit=500[&before=…]`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BarsPage {
    pub symbol: SymbolCode,
    pub period: Period,
    /// 확정 봉, t 오름차순.
    pub bars: Vec<Bar>,
    /// 최신 페이지일 때만. 진행 중 구간의 봉. #2·#3에서는 키움 조회가 준 값이다.
    pub current: Option<Bar>,
    /// 더 과거를 받을 커서. null이면 끝이다.
    pub next_before: Option<UnixSeconds>,
    /// 이 스냅숏이 반영한 마지막 seq. #2·#3에서는 언제나 null.
    #[ts(type = "number | null")]
    pub seq: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SymbolKind {
    Index,
    Common,
    Preferred,
    Etf,
    Reit,
}

impl From<domain::SymbolKind> for SymbolKind {
    fn from(k: domain::SymbolKind) -> Self {
        match k {
            domain::SymbolKind::Index => SymbolKind::Index,
            domain::SymbolKind::Common => SymbolKind::Common,
            domain::SymbolKind::Preferred => SymbolKind::Preferred,
            domain::SymbolKind::Etf => SymbolKind::Etf,
            domain::SymbolKind::Reit => SymbolKind::Reit,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Market {
    Kospi,
    Kosdaq,
}

impl From<domain::Market> for Market {
    fn from(m: domain::Market) -> Self {
        match m {
            domain::Market::Kospi => Market::Kospi,
            domain::Market::Kosdaq => Market::Kosdaq,
        }
    }
}

/// `GET /api/symbols?q=` → `SymbolInfo[]`, `GET /api/symbols/:code` → `SymbolInfo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SymbolInfo {
    pub code: SymbolCode,
    pub name: String,
    pub kind: SymbolKind,
    pub market: Market,
}

impl From<&domain::SymbolInfo> for SymbolInfo {
    fn from(s: &domain::SymbolInfo) -> Self {
        SymbolInfo {
            code: SymbolCode(s.symbol.as_wire()),
            name: s.name.clone(),
            kind: s.kind.into(),
            market: s.market.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ApiErrorCode {
    BadRequest,
    NotFound,
    UnknownSymbol,
    /// 키움 조회 실패(네트워크, 5xx, 요청 개수 초과 반복).
    KiwoomUnavailable,
    /// 운영자가 고쳐야 한다.
    KiwoomAuthFailed,
    Conflict,
    PayloadTooLarge,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ApiErrorBody {
    pub code: ApiErrorCode,
    /// 사람이 읽는 한국어 문장.
    pub message: String,
}

/// 오류 응답의 본문. HTTP 4xx/5xx와 함께 온다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ApiError {
    pub error: ApiErrorBody,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bars_page_json_shape() {
        let page = BarsPage {
            symbol: SymbolCode("IDX:001".into()),
            period: Period::Day,
            bars: vec![Bar { t: UnixSeconds(1_793_890_800), o: 5263.26, h: 5269.1, l: 4911.28, c: 5059.69, v: 323_267 }],
            current: None,
            next_before: Some(UnixSeconds(1_793_890_800)),
            seq: None,
        };
        assert_eq!(
            serde_json::to_value(&page).unwrap(),
            json!({
                "symbol": "IDX:001", "period": "D",
                "bars": [{"t": 1_793_890_800, "o": 5263.26, "h": 5269.1, "l": 4911.28, "c": 5059.69, "v": 323_267}],
                "current": null, "nextBefore": 1_793_890_800, "seq": null
            })
        );
    }

    #[test]
    fn error_and_symbol_json_shape() {
        let err = ApiError { error: ApiErrorBody { code: ApiErrorCode::KiwoomUnavailable, message: "m".into() } };
        assert_eq!(serde_json::to_value(&err).unwrap(), json!({"error": {"code": "kiwoom_unavailable", "message": "m"}}));
        let info = SymbolInfo { code: SymbolCode("005935".into()), name: "삼성전자우".into(), kind: SymbolKind::Preferred, market: Market::Kospi };
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            json!({"code": "005935", "name": "삼성전자우", "kind": "preferred", "market": "kospi"})
        );
    }

    #[test]
    fn period_wire_names_match_domain() {
        for p in domain::Period::ALL {
            let wire = serde_json::to_value(Period::from(p)).unwrap();
            assert_eq!(wire, json!(p.as_wire()));
            assert_eq!(domain::Period::from(serde_json::from_value::<Period>(wire).unwrap()), p);
        }
    }
}
