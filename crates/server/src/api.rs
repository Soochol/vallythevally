//! 브라우저 계약(backend.md §8). 이 모듈의 타입만 JSON으로 나가고 들어온다.
//! ts-rs가 `web/src/api/generated/`에 TypeScript 정의를 쓴다(`cargo test`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Unix 초(UTC 기준 정수). 봉의 `t`는 봉 시작 시각이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UnixSeconds(#[ts(type = "number")] pub i64);

/// 주식·ETF "005930", 지수 "IDX:001"(코스피) "IDX:101"(코스닥).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
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

/// 거래소(ADR 0007). 주식에만 있고 지수에는 없다(`null`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Venue {
    /// 통합 시세(KRX + NXT). 칸의 기본값.
    Combined,
    Krx,
    Nxt,
}

impl From<domain::Venue> for Venue {
    fn from(v: domain::Venue) -> Self {
        match v {
            domain::Venue::Combined => Venue::Combined,
            domain::Venue::Krx => Venue::Krx,
            domain::Venue::Nxt => Venue::Nxt,
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

/// `GET /api/bars?symbol=005930&venue=krx&period=D&limit=500[&before=…]`.
/// `venue`는 주식에서 생략하면 `combined`이고, 지수에 주면 `bad_request`다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BarsPage {
    pub symbol: SymbolCode,
    /// 지수면 null.
    pub venue: Option<Venue>,
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
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SymbolInfo {
    pub code: SymbolCode,
    pub name: String,
    pub kind: SymbolKind,
    pub market: Market,
    /// NXT를 고를 수 있는가. 지수는 false.
    pub nxt_enabled: bool,
}

impl From<&domain::SymbolInfo> for SymbolInfo {
    fn from(s: &domain::SymbolInfo) -> Self {
        SymbolInfo {
            code: SymbolCode(s.symbol.as_wire()),
            name: s.name.clone(),
            kind: s.kind.into(),
            market: s.market.into(),
            nxt_enabled: s.nxt_enabled,
        }
    }
}

/// 현재가 값의 출처. #3은 언제나 `polled`(REST 조회), #4부터 실시간이면 `realtime`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum QuoteSource {
    Realtime,
    Polled,
}

/// `GET /api/quotes?symbols=005930,IDX:001` → `Quote[]`.
/// 주식은 통합 시세(ka10095 `_AL`), 지수는 지수 일봉의 최신 페이지에서 만든다.
/// 값을 얻지 못한 종목(없는 코드, 빈 행)은 응답에서 빠진다. 순서는 요청 순서다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Quote {
    pub symbol: SymbolCode,
    pub price: f64,
    /// 현재가 − 기준가. 부호 있음.
    pub change: f64,
    /// %, 부호 있음.
    pub change_rate: f64,
    /// 당일 누적.
    #[ts(type = "number")]
    pub volume: u64,
    pub t: UnixSeconds,
    pub source: QuoteSource,
}

/// `GET /api/watchlist` 응답이자 `PUT /api/watchlist` 본문. 표시 순서대로. 중복은 400.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Watchlist {
    pub symbols: Vec<SymbolCode>,
}

/// 칸 배치. `2h` 좌우, `2v` 상하. #3은 `1`만 쓴다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Arrangement {
    #[serde(rename = "1")]
    One,
    #[serde(rename = "2h")]
    TwoH,
    #[serde(rename = "2v")]
    TwoV,
    #[serde(rename = "3")]
    Three,
    #[serde(rename = "4")]
    Four,
}

impl Arrangement {
    pub const fn cell_count(self) -> usize {
        match self {
            Arrangement::One => 1,
            Arrangement::TwoH | Arrangement::TwoV => 2,
            Arrangement::Three => 3,
            Arrangement::Four => 4,
        }
    }
}

/// 칸 동기화. 저장된 값에 키가 빠져 있으면 true로 읽는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LayoutSync {
    #[serde(default = "yes")]
    pub crosshair: bool,
    #[serde(default = "yes")]
    pub scroll: bool,
}

const fn yes() -> bool {
    true
}

/// 레이아웃의 칸 하나. 칸 = (종목, 거래소, 봉 주기, 차트 설정).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Cell {
    /// 0부터. 칸 수보다 작다.
    #[ts(type = "0 | 1 | 2 | 3")]
    pub slot: u8,
    pub symbol: SymbolCode,
    /// 지수면 null, 주식이면 언제나 값이 있다(ADR 0007).
    pub venue: Option<Venue>,
    pub period: Period,
    /// 종목 연동(#7).
    pub symbol_link: bool,
    /// 프런트엔드가 모양을 정한다. 64KB 이하. 서버는 모르는 키까지 그대로 저장한다.
    #[ts(type = "unknown")]
    pub chart_settings: serde_json::Value,
}

/// `GET /api/layouts` → `LayoutSummary[]`(표시 순서).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LayoutSummary {
    pub id: String,
    pub name: String,
    pub arrangement: Arrangement,
    pub updated_at: UnixSeconds,
}

/// `GET /api/layouts/:id` → `Layout`. `PUT /api/layouts/:id`의 응답.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Layout {
    /// 브라우저가 만드는 UUID v7.
    pub id: String,
    pub name: String,
    pub arrangement: Arrangement,
    pub sync: LayoutSync,
    /// 길이는 arrangement의 칸 수와 같다. slot 0부터 차례로.
    pub cells: Vec<Cell>,
    pub updated_at: UnixSeconds,
}

/// `PUT /api/layouts/:id` 본문(없으면 만들고 있으면 바꾼다). `id`는 주소의 id와 같아야 한다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LayoutInput {
    pub id: String,
    pub name: String,
    pub arrangement: Arrangement,
    pub sync: LayoutSync,
    pub cells: Vec<Cell>,
}

/// `GET /api/ui-state`, `PUT /api/ui-state`. 64KB 이하. 서버는 객체인지만 보고 모르는 키까지 그대로 왕복시킨다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, type = r#"{ lastLayoutId: string | null; theme: "dark" | "light"; [k: string]: unknown }"#)]
pub struct UiState(pub serde_json::Map<String, serde_json::Value>);

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
    /// 있는 API 경로에 틀린 메서드를 보냈다.
    MethodNotAllowed,
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
            venue: None,
            period: Period::Day,
            bars: vec![Bar { t: UnixSeconds(1_793_890_800), o: 5263.26, h: 5269.1, l: 4911.28, c: 5059.69, v: 323_267 }],
            current: None,
            next_before: Some(UnixSeconds(1_793_890_800)),
            seq: None,
        };
        assert_eq!(
            serde_json::to_value(&page).unwrap(),
            json!({
                "symbol": "IDX:001", "venue": null, "period": "D",
                "bars": [{"t": 1_793_890_800, "o": 5263.26, "h": 5269.1, "l": 4911.28, "c": 5059.69, "v": 323_267}],
                "current": null, "nextBefore": 1_793_890_800, "seq": null
            })
        );
    }

    #[test]
    fn error_and_symbol_json_shape() {
        let err = ApiError { error: ApiErrorBody { code: ApiErrorCode::KiwoomUnavailable, message: "m".into() } };
        assert_eq!(serde_json::to_value(&err).unwrap(), json!({"error": {"code": "kiwoom_unavailable", "message": "m"}}));
        let info = SymbolInfo { code: SymbolCode("005935".into()), name: "삼성전자우".into(), kind: SymbolKind::Preferred, market: Market::Kospi, nxt_enabled: false };
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            json!({"code": "005935", "name": "삼성전자우", "kind": "preferred", "market": "kospi", "nxtEnabled": false})
        );
    }

    #[test]
    fn user_data_json_shape() {
        let layout: LayoutInput = serde_json::from_value(json!({
            "id": "01900000-0000-7000-8000-000000000001", "name": "기본", "arrangement": "1", "sync": {"scroll": false},
            "cells": [{"slot": 0, "symbol": "005930", "venue": "nxt", "period": "5m", "symbolLink": false,
                       "chartSettings": {"v": 1, "future": [1, 2]}}]
        }))
        .unwrap();
        assert_eq!(layout.sync, LayoutSync { crosshair: true, scroll: false });
        assert_eq!(layout.cells[0].venue, Some(Venue::Nxt));
        assert_eq!(layout.cells[0].chart_settings, json!({"v": 1, "future": [1, 2]}));
        assert_eq!(layout.arrangement.cell_count(), 1);

        let ui: UiState = serde_json::from_value(json!({"lastLayoutId": null, "theme": "light", "watchCollapsed": true})).unwrap();
        assert_eq!(serde_json::to_value(&ui).unwrap(), json!({"lastLayoutId": null, "theme": "light", "watchCollapsed": true}));

        let q = Quote {
            symbol: SymbolCode("005930".into()),
            price: 193_400.0,
            change: -8_100.0,
            change_rate: -4.02,
            volume: 56_147_847,
            t: UnixSeconds(1_794_131_999),
            source: QuoteSource::Polled,
        };
        assert_eq!(
            serde_json::to_value(&q).unwrap(),
            json!({"symbol": "005930", "price": 193_400.0, "change": -8_100.0, "changeRate": -4.02,
                   "volume": 56_147_847, "t": 1_794_131_999, "source": "polled"})
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
