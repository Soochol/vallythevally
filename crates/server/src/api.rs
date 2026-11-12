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
    #[serde(rename = "10m")]
    M10,
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
    #[serde(rename = "Q")]
    Quarter,
    #[serde(rename = "Y")]
    Year,
}

impl From<domain::Period> for Period {
    fn from(p: domain::Period) -> Self {
        match p {
            domain::Period::M1 => Period::M1,
            domain::Period::M3 => Period::M3,
            domain::Period::M5 => Period::M5,
            domain::Period::M10 => Period::M10,
            domain::Period::M15 => Period::M15,
            domain::Period::M30 => Period::M30,
            domain::Period::M60 => Period::M60,
            domain::Period::Day => Period::Day,
            domain::Period::Week => Period::Week,
            domain::Period::Month => Period::Month,
            domain::Period::Quarter => Period::Quarter,
            domain::Period::Year => Period::Year,
        }
    }
}

impl From<Period> for domain::Period {
    fn from(p: Period) -> Self {
        match p {
            Period::M1 => domain::Period::M1,
            Period::M3 => domain::Period::M3,
            Period::M5 => domain::Period::M5,
            Period::M10 => domain::Period::M10,
            Period::M15 => domain::Period::M15,
            Period::M30 => domain::Period::M30,
            Period::M60 => domain::Period::M60,
            Period::Day => domain::Period::Day,
            Period::Week => domain::Period::Week,
            Period::Month => domain::Period::Month,
            Period::Quarter => domain::Period::Quarter,
            Period::Year => domain::Period::Year,
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

impl From<Venue> for domain::Venue {
    fn from(v: Venue) -> Self {
        match v {
            Venue::Combined => domain::Venue::Combined,
            Venue::Krx => domain::Venue::Krx,
            Venue::Nxt => domain::Venue::Nxt,
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

/// `/api/ws` 브라우저 → 서버. `sub`는 브라우저가 정하는 연결 안에서 유일한 문자열이다.
/// `venue` 규칙은 `GET /api/bars`와 같다(주식에서 빼면 combined, 지수에 주면 bad_request).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum ClientMessage {
    Subscribe { sub: String, symbol: SymbolCode, venue: Option<Venue>, period: Period },
    Unsubscribe { sub: String },
    /// 지금 보이는 관심종목 목록 전체, 위에서부터. 받을 때마다 통째로 바꾼다. 빈 배열은 목록을 닫았다는 뜻이다.
    Watch { symbols: Vec<SymbolCode> },
}

/// `/api/ws` 서버 → 브라우저. `seq`는 (종목, 거래소, 봉 주기) 흐름마다 하나씩 늘어나는 번호다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum ServerMessage {
    Hello {
        #[ts(type = "1")]
        protocol: u8,
        server_time: UnixSeconds,
        status: ConnectionStatus,
    },
    Status { status: ConnectionStatus },
    /// 구독 응답. 실시간 한도로 거절되었다가 자리가 나면 같은 sub로 다시 온다.
    Subscribed {
        sub: String,
        #[ts(type = "number")]
        seq: u64,
        current: Option<Bar>,
    },
    SubError { sub: String, code: SubErrorCode },
    /// 현재 봉 갱신. 구독 하나당 초당 최대 10회. 중간 값은 건너뛸 수 있다.
    Bar {
        sub: String,
        #[ts(type = "number")]
        seq: u64,
        bar: Bar,
    },
    /// 봉 확정. 연결이 살아 있는 동안 빠짐없이, 순서대로 온다.
    Confirmed {
        sub: String,
        #[ts(type = "number")]
        seq: u64,
        bar: Bar,
    },
    /// 확정 봉이 서버 쪽에서 바뀌었다. 브라우저는 칸을 통째로 다시 만든다. `from`은 `daily_reset`이면 null이다.
    Reload {
        sub: String,
        #[ts(type = "number")]
        seq: u64,
        reason: ReloadReason,
        from: Option<UnixSeconds>,
    },
    /// 관심종목 현재가(`source: realtime`). `bar`와 같은 100ms 묶음으로 바뀐 종목만 온다. 종목마다 가장 새 값 하나다.
    Quotes { quotes: Vec<Quote> },
    /// 이 연결의 관심종목 가운데 실시간 한도로 받지 못하는 종목, 목록 순서. 바뀔 때만 온다. 브라우저는 통째로 바꾼다.
    WatchLimited { symbols: Vec<SymbolCode> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SubErrorCode {
    BadRequest,
    UnknownSymbol,
    RealtimeLimit,
    KiwoomUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ReloadReason {
    /// 실시간 연결이 끊겼던 구간을 조회로 메웠다.
    GapFilled,
    /// 실시간으로 만든 봉이 키움 값으로 교체되었다.
    Replaced,
    /// 매일 07:45에 시세 캐시를 모두 비우고 다시 받았다.
    DailyReset,
}

/// 키움 실시간 연결. `reconnecting`이면 `since`부터 현재 봉이 멈춰 있을 수 있다. `halted`는 운영자가 고쳐야 한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RealtimeState {
    Live,
    Reconnecting,
    Halted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConnectionStatus {
    pub realtime: RealtimeState,
    pub since: UnixSeconds,
    /// 끊긴 구간을 조회로 메우는 중.
    pub backfilling: bool,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
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

/// 현재가 값의 출처. REST `/api/quotes`는 `polled`, WebSocket `quotes`는 `realtime`.
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

/// `GET /api/symbols/:code/fundamentals` → 주식의 기본 정보(ka10001, 통합 시세). 지수는 400 `bad_request`.
/// 키움이 값을 주지 않은 항목은 null이다. ETF·우선주는 PER·PBR·ROE·EPS·BPS가, 적자 종목은 PER가 null이다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Fundamentals {
    pub symbol: SymbolCode,
    /// 원.
    #[ts(type = "number | null")]
    pub market_cap: Option<u64>,
    /// 주.
    #[ts(type = "number | null")]
    pub listed_shares: Option<u64>,
    /// 배.
    pub per: Option<f64>,
    /// 배.
    pub pbr: Option<f64>,
    /// %. 적자면 음수.
    pub roe: Option<f64>,
    /// 원. 적자면 음수.
    #[ts(type = "number | null")]
    pub eps: Option<i64>,
    /// 원.
    #[ts(type = "number | null")]
    pub bps: Option<i64>,
    /// %. 외국인 보유 한도 대비 보유 비율.
    pub foreign_exhaustion_rate: Option<f64>,
    /// 최근 250관측일 최고가(원).
    #[ts(type = "number | null")]
    pub high52w: Option<u64>,
    /// 최근 250관측일 최저가(원).
    #[ts(type = "number | null")]
    pub low52w: Option<u64>,
}

/// 저장 순서 번호. 브라우저가 저장할 때마다 늘려 보낸다(`max(지금 ms, 마지막 + 1)`).
/// PUT은 저장된 것보다 클 때만 받고, 아니면 409 `stale_revision`이다. GET은 저장된 값을 돌려준다. 처음은 0.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Revision(#[ts(type = "number")] pub i64);

/// 관심종목 목록 하나. `symbols`는 표시 순서대로이고 중복이 없다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Watchlist {
    pub id: String,
    pub name: String,
    pub symbols: Vec<SymbolCode>,
}

/// `GET /api/watchlists` 응답이자 `PUT /api/watchlists` 본문. `lists`는 표시 순서대로이고 1~20개다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Watchlists {
    pub lists: Vec<Watchlist>,
    pub revision: Revision,
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
    pub revision: Revision,
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
    pub revision: Revision,
}

/// `GET /api/ui-state`, `PUT /api/ui-state`. 64KB 이하. 서버는 객체인지만 보고 모르는 키까지 그대로 왕복시킨다.
/// `revision`(저장 순서 번호, `Revision`)만은 서버가 읽는다. PUT에 없거나 정수가 아니면 400이다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, type = r#"{ lastLayoutId: string | null; theme: "dark" | "light"; revision: number; [k: string]: unknown }"#)]
pub struct UiState(pub serde_json::Map<String, serde_json::Value>);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, TS)]
#[ts(export, type = "string")]
pub struct KstDate(pub domain::KstDate);

impl Serialize for KstDate {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(&self.0)
    }
}

impl std::str::FromStr for KstDate {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, String> {
        domain::KstDate::parse_yyyymmdd(&text.replace('-', ""))
            .filter(|date| date.to_string() == text)
            .map(KstDate)
            .ok_or_else(|| format!("날짜는 YYYY-MM-DD여야 합니다: {text}"))
    }
}

impl<'de> Deserialize<'de> for KstDate {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        String::deserialize(d)?.parse().map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum RangeCoverage {
    WholeRange,
    KiwoomStartsLater { first_day: KstDate },
    NoReadableDates,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DayHistory<T> {
    pub symbol: SymbolCode,
    pub from: KstDate,
    pub to: KstDate,
    pub coverage: RangeCoverage,
    pub days: Vec<T>,
    pub skipped_days: Vec<SkippedDay>,
    pub undated_rows: Vec<UndatedRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UndatedRow {
    pub dt: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkippedDay {
    pub day: KstDate,
    pub field: String,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForeignHoldingDay {
    pub day: KstDate,
    #[ts(type = "number")]
    pub shares: u64,
    pub weight_pct: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InvestorNetSharesDay {
    pub day: KstDate,
    #[ts(type = "number")]
    pub individual: i64,
    #[ts(type = "number")]
    pub foreign: i64,
    #[ts(type = "number")]
    pub institution: i64,
    #[ts(type = "number")]
    pub financial_investment: i64,
    #[ts(type = "number")]
    pub insurance: i64,
    #[ts(type = "number")]
    pub investment_trust: i64,
    #[ts(type = "number")]
    pub other_financial: i64,
    #[ts(type = "number")]
    pub bank: i64,
    #[ts(type = "number")]
    pub pension_fund: i64,
    #[ts(type = "number")]
    pub private_fund: i64,
    #[ts(type = "number")]
    pub government: i64,
    #[ts(type = "number")]
    pub other_corporation: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum ScreenPeriod {
    #[serde(rename = "D")]
    Day,
    #[serde(rename = "W")]
    Week,
    #[serde(rename = "M")]
    Month,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BarField {
    Open,
    High,
    Low,
    Close,
    Volume,
    TradedValue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PriceField {
    Open,
    High,
    Low,
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SurgeField {
    Volume,
    TradedValue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Extreme {
    High,
    Low,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MaOrder {
    Bullish,
    Bearish,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Direction {
    Up,
    Down,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Side {
    Above,
    Below,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BollingerBand {
    Upper,
    Lower,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Bound(pub Option<f64>);

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum RsiTest {
    Range { min: Bound, max: Bound },
    Breakout { value: f64, direction: Direction },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum MacdTest {
    SignalCross { direction: Direction },
    ZeroBreakout { direction: Direction },
    VsSignal { side: Side },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum StochasticTest {
    Cross { direction: Direction },
    Range { min: Bound, max: Bound },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum BollingerTest {
    Outside { side: Side },
    Cross { band: BollingerBand, direction: Direction },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum IchimokuTest {
    Cloud { side: Side },
    Cross { direction: Direction },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ExcludeKind {
    Etf,
    Preferred,
    Reit,
    Spac,
    Managed,
    InvestmentCautionAlert,
    InvestmentWarning,
    InvestmentDanger,
    InvestmentCaution,
    ShortTermOverheated,
    TradingHalted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(try_from = "u64", into = "u64")]
#[ts(export, type = "number")]
pub struct RecentBars(u64);

impl TryFrom<u64> for RecentBars {
    type Error = &'static str;

    fn try_from(value: u64) -> Result<Self, Self::Error> {
        if (1..=u64::from(u32::MAX) + 1).contains(&value) {
            Ok(Self(value))
        } else {
            Err("최근 기간은 1 이상 4294967296 이하의 정수여야 합니다")
        }
    }
}

impl From<RecentBars> for u64 {
    fn from(value: RecentBars) -> u64 { value.0 }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub enum Condition {
    NewHigh { period: ScreenPeriod, recent_bars: RecentBars, field: BarField, n: u32 },
    NewLow { period: ScreenPeriod, recent_bars: RecentBars, field: BarField, n: u32 },
    ValueRange { period: ScreenPeriod, recent_bars: RecentBars, field: BarField, min: Bound, max: Bound },
    Change { period: ScreenPeriod, recent_bars: RecentBars, back: u32, min_pct: Bound, max_pct: Bound },
    NearExtreme { period: ScreenPeriod, recent_bars: RecentBars, extreme: Extreme, n: u32, within_pct: f64 },
    Surge { period: ScreenPeriod, recent_bars: RecentBars, field: SurgeField, n: u32, times: f64 },
    MaPosition { period: ScreenPeriod, recent_bars: RecentBars, field: PriceField, method: indicators::MaMethod, length: u16, side: Side },
    MaAlignment { period: ScreenPeriod, recent_bars: RecentBars, method: indicators::MaMethod, lengths: Vec<u16>, order: MaOrder },
    MaCross { period: ScreenPeriod, recent_bars: RecentBars, method: indicators::MaMethod, fast: Option<u16>, slow: u16, direction: Direction },
    Rsi { period: ScreenPeriod, recent_bars: RecentBars, length: u16, test: RsiTest },
    Macd { period: ScreenPeriod, recent_bars: RecentBars, fast: u16, slow: u16, signal: u16, test: MacdTest },
    Stochastic { period: ScreenPeriod, recent_bars: RecentBars, k: u16, d: u16, smooth: u16, test: StochasticTest },
    Bollinger { period: ScreenPeriod, recent_bars: RecentBars, length: u16, k: f64, test: BollingerTest },
    Ichimoku { period: ScreenPeriod, recent_bars: RecentBars, conversion: u16, base: u16, span_b: u16, displacement: u16, test: IchimokuTest },
    MarketCap { min: Bound, max: Bound },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Screen {
    pub id: String,
    pub name: String,
    pub markets: Vec<Market>,
    pub exclude: Vec<ExcludeKind>,
    pub conditions: Vec<Condition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Screens {
    pub screens: Vec<Screen>,
    pub revision: Revision,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScreenerResult {
    pub as_of: KstDate,
    pub collection_started_at: UnixSeconds,
    pub collection_completed_at: UnixSeconds,
    pub missing_summary: u32,
    pub universe: u32,
    pub excluded: ScreenerExcluded,
    pub rows: Vec<ScreenerRow>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScreenerExcluded {
    pub listed_too_short: u32,
    pub history_short: u32,
    pub unconfirmed: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScreenerRow {
    pub symbol: SymbolCode,
    pub name: String,
    pub close: f64,
    pub change_rate: Option<f64>,
    pub matched_date: KstDate,
    pub latest_bar_date: KstDate,
    pub provisional: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ScreenerUpdateRequest {
    pub full: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum UpdatePhase {
    Symbols,
    Recent,
    Backfill,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ScreenerUpdate {
    pub phase: UpdatePhase,
    pub done: u32,
    pub total: u32,
    pub error: Option<ApiErrorBody>,
    pub full: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FullHistory {
    pub done: u32,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScreenerStatus {
    pub last_day: Option<KstDate>,
    pub need_day: Option<KstDate>,
    pub today_available: bool,
    pub full_history: FullHistory,
    pub unconfirmed: u32,
    pub update: Option<ScreenerUpdate>,
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
    /// 저장된 것보다 크지 않은 revision으로 저장하려 했다. 더 새 편집이 이미 저장돼 있다.
    StaleRevision,
    ScreenerNotReady,
    /// 있는 API 경로에 틀린 메서드를 보냈다.
    MethodNotAllowed,
    Internal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ApiErrorReason {
    RateLimited,
    KiwoomUnreachable,
    KiwoomTimeout,
    KiwoomError,
    TokenInvalid,
    AuthBlocked,
    AuthIndeterminate,
    IssueInterval,
    TokenFile,
    SymbolMismatch,
    InvalidRequest,
    Unsupported,
    UnknownFailure,
    Protocol,
    SymbolListLoading,
    MissingDay,
    Updating,
    DataChanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ApiErrorBody {
    pub code: ApiErrorCode,
    /// 사람이 읽는 한국어 문장.
    pub message: String,
    pub reason: Option<ApiErrorReason>,
    pub retry_at: Option<UnixSeconds>,
    pub manual_action_required: bool,
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
        let err = ApiError {
            error: ApiErrorBody {
                code: ApiErrorCode::KiwoomUnavailable,
                message: "m".into(),
                reason: Some(ApiErrorReason::RateLimited),
                retry_at: Some(UnixSeconds(1_794_182_430)),
                manual_action_required: false,
            },
        };
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            json!({"error": {"code": "kiwoom_unavailable", "message": "m", "reason": "rate_limited", "retryAt": 1_794_182_430, "manualActionRequired": false}})
        );
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
                       "chartSettings": {"v": 1, "future": [1, 2]}}],
            "revision": 1_794_152_040_123_i64
        }))
        .unwrap();
        assert_eq!(layout.sync, LayoutSync { crosshair: true, scroll: false });
        assert_eq!(layout.cells[0].venue, Some(Venue::Nxt));
        assert_eq!(layout.cells[0].chart_settings, json!({"v": 1, "future": [1, 2]}));
        assert_eq!(layout.arrangement.cell_count(), 1);
        assert_eq!(layout.revision, Revision(1_794_152_040_123), "Date.now() 크기의 ms도 정확히 받는다");

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
    fn websocket_message_json_shape() {
        let sub: ClientMessage = serde_json::from_value(json!({"type": "subscribe", "sub": "c0", "symbol": "005930", "venue": "krx", "period": "1m"})).unwrap();
        assert_eq!(sub, ClientMessage::Subscribe { sub: "c0".into(), symbol: SymbolCode("005930".into()), venue: Some(Venue::Krx), period: Period::M1 });
        let unsub: ClientMessage = serde_json::from_value(json!({"type": "unsubscribe", "sub": "c0"})).unwrap();
        assert_eq!(unsub, ClientMessage::Unsubscribe { sub: "c0".into() });
        let watch: ClientMessage = serde_json::from_value(json!({"type": "watch", "symbols": ["005930", "IDX:001"]})).unwrap();
        assert_eq!(watch, ClientMessage::Watch { symbols: vec![SymbolCode("005930".into()), SymbolCode("IDX:001".into())] });

        let status = ConnectionStatus { realtime: RealtimeState::Reconnecting, since: UnixSeconds(1_794_182_400), backfilling: true };
        let bar = Bar { t: UnixSeconds(1_794_182_400), o: 1.0, h: 2.0, l: 1.0, c: 2.0, v: 3 };
        let cases = [
            (
                ServerMessage::Hello { protocol: 1, server_time: UnixSeconds(5), status },
                json!({"type": "hello", "protocol": 1, "serverTime": 5, "status": {"realtime": "reconnecting", "since": 1_794_182_400, "backfilling": true}}),
            ),
            (ServerMessage::Subscribed { sub: "c0".into(), seq: 7, current: None }, json!({"type": "subscribed", "sub": "c0", "seq": 7, "current": null})),
            (ServerMessage::SubError { sub: "c0".into(), code: SubErrorCode::RealtimeLimit }, json!({"type": "sub_error", "sub": "c0", "code": "realtime_limit"})),
            (
                ServerMessage::Confirmed { sub: "c0".into(), seq: 8, bar },
                json!({"type": "confirmed", "sub": "c0", "seq": 8, "bar": {"t": 1_794_182_400, "o": 1.0, "h": 2.0, "l": 1.0, "c": 2.0, "v": 3}}),
            ),
            (
                ServerMessage::Reload { sub: "c0".into(), seq: 9, reason: ReloadReason::GapFilled, from: Some(UnixSeconds(4)) },
                json!({"type": "reload", "sub": "c0", "seq": 9, "reason": "gap_filled", "from": 4}),
            ),
            (
                ServerMessage::Reload { sub: "c0".into(), seq: 9, reason: ReloadReason::DailyReset, from: None },
                json!({"type": "reload", "sub": "c0", "seq": 9, "reason": "daily_reset", "from": null}),
            ),
            (
                ServerMessage::Quotes {
                    quotes: vec![Quote {
                        symbol: SymbolCode("005930".into()),
                        price: 71_200.0,
                        change: 200.0,
                        change_rate: 0.5,
                        volume: 9,
                        t: UnixSeconds(4),
                        source: QuoteSource::Realtime,
                    }],
                },
                json!({"type": "quotes", "quotes": [{"symbol": "005930", "price": 71_200.0, "change": 200.0, "changeRate": 0.5, "volume": 9, "t": 4, "source": "realtime"}]}),
            ),
            (ServerMessage::WatchLimited { symbols: vec![SymbolCode("000660".into())] }, json!({"type": "watch_limited", "symbols": ["000660"]})),
        ];
        for (msg, want) in cases {
            assert_eq!(serde_json::to_value(&msg).unwrap(), want);
        }
    }

    #[test]
    fn screener_json_shape() {
        let every_kind = json!(["etf", "preferred", "reit", "spac", "managed", "investment_caution_alert", "investment_warning",
                                "investment_danger", "investment_caution", "short_term_overheated", "trading_halted"]);
        let sent = json!({"screens": [{"id": "S1", "name": "고가 200주", "markets": ["kosdaq"], "exclude": every_kind,
                                       "conditions": [{"kind": "new_high", "period": "W", "recentBars": 5, "field": "traded_value", "n": 200},
                                                      {"kind": "change", "period": "D", "recentBars": 1, "back": 20, "minPct": 30.0, "maxPct": null},
                                                      {"kind": "ichimoku", "period": "M", "recentBars": 1, "conversion": 9, "base": 26, "spanB": 52, "displacement": 26,
                                                       "test": {"kind": "cloud", "side": "above"}},
                                                      {"kind": "macd", "period": "D", "recentBars": 3, "fast": 12, "slow": 26, "signal": 9,
                                                       "test": {"kind": "zero_breakout", "direction": "down"}},
                                                      {"kind": "market_cap", "min": 300_000_000_000.0, "max": null}]}],
                          "revision": 1_794_152_040_123_i64});
        let screens: Screens = serde_json::from_value(sent.clone()).unwrap();
        let screen = &screens.screens[0];
        assert_eq!((screen.markets.as_slice(), screen.exclude.len()), ([Market::Kosdaq].as_slice(), 11));
        assert_eq!(screen.conditions[0], Condition::NewHigh { period: ScreenPeriod::Week, recent_bars: RecentBars::try_from(5).unwrap(), field: BarField::TradedValue, n: 200 });
        assert_eq!(screen.conditions[1], Condition::Change { period: ScreenPeriod::Day, recent_bars: RecentBars::try_from(1).unwrap(), back: 20, min_pct: Bound(Some(30.0)), max_pct: Bound(None) });
        assert_eq!(screen.conditions[4], Condition::MarketCap { min: Bound(Some(300_000_000_000.0)), max: Bound(None) });
        assert_eq!(serde_json::to_value(&screens).unwrap(), sent);

        let day = |y, m, d| KstDate(domain::KstDate::new(y, m, d).unwrap());
        let result = ScreenerResult {
            as_of: day(2026, 11, 10),
            collection_started_at: UnixSeconds(1),
            collection_completed_at: UnixSeconds(2),
            missing_summary: 3,
            universe: 3957,
            excluded: ScreenerExcluded { listed_too_short: 14, history_short: 120, unconfirmed: 2 },
            rows: vec![ScreenerRow { symbol: SymbolCode("005930".into()), name: "삼성전자".into(), close: 193_400.0, change_rate: None, matched_date: day(2026, 11, 9), latest_bar_date: day(2026, 11, 10), provisional: true }],
        };
        let result_json = json!({"asOf": "2026-11-10", "collectionStartedAt": 1, "collectionCompletedAt": 2, "missingSummary": 3, "universe": 3957, "excluded": {"listedTooShort": 14, "historyShort": 120, "unconfirmed": 2},
                                 "rows": [{"symbol": "005930", "name": "삼성전자", "close": 193_400.0, "changeRate": null, "matchedDate": "2026-11-09", "latestBarDate": "2026-11-10", "provisional": true}]});
        assert_eq!(serde_json::to_value(&result).unwrap(), result_json);
        assert_eq!(serde_json::from_value::<ScreenerResult>(result_json).unwrap(), result);

        let status = ScreenerStatus {
            last_day: None,
            need_day: Some(day(2026, 11, 10)),
            today_available: false,
            full_history: FullHistory { done: 0, total: 3960 },
            unconfirmed: 3,
            update: Some(ScreenerUpdate { phase: UpdatePhase::Recent, done: 12, total: 3960, error: None, full: false }),
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({"lastDay": null, "needDay": "2026-11-10", "todayAvailable": false, "fullHistory": {"done": 0, "total": 3960}, "unconfirmed": 3,
                   "update": {"phase": "recent", "done": 12, "total": 3960, "error": null, "full": false}})
        );
        assert_eq!(serde_json::from_value::<ScreenerUpdateRequest>(json!({"full": true})).unwrap(), ScreenerUpdateRequest { full: true });
        for bad in ["20261110", "2026-1-10", "2026-02-30", "2026-11-10T00:00"] {
            assert!(serde_json::from_value::<KstDate>(json!(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn quarterly_and_yearly_bars_do_not_expand_screener_periods() {
        for period in ["Q", "Y"] {
            assert!(serde_json::from_value::<Period>(json!(period)).is_ok());
            assert!(serde_json::from_value::<ScreenPeriod>(json!(period)).is_err());
        }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum FinancialPeriod { Q, Y }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FinancialUpdateStatus { Idle, Planning, Collecting, Pausing, Paused, Stopped, Checking, Ready, PartialFailure, Interrupted, Failed, NotConfigured }

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FinancialUpdatePhase { Planning, #[default] Recent, History, Complete }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FinancialUpdateStopReason { User, Storage, Interrupted, NotConfigured, Authentication, RateLimited }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FinancialUpdateFailure { pub code: String, pub name: String, pub reason: Option<String>, pub failure: Option<String> }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FinancialUpdatePage {
    #[ts(type = "number")]
    pub id: u64,
    pub status: FinancialUpdateStatus,
    pub phase: FinancialUpdatePhase,
    pub stop_reason: Option<FinancialUpdateStopReason>,
    pub next_check_at: Option<UnixSeconds>,
    pub can_resume: bool,
    pub history_completed_companies: usize,
    pub history_failed_companies: usize,
    pub recent_failed_companies: usize,
    pub history_complete: bool,
    pub from_year: i32,
    pub through_year: i32,
    pub total_symbols: usize,
    pub processed_symbols: usize,
    pub unsupported_symbols: usize,
    pub unverified_symbols: usize,
    pub unverified_dividends: usize,
    pub total_companies: usize,
    pub completed_companies: usize,
    pub failed_companies: usize,
    pub started_at: Option<UnixSeconds>,
    pub last_checked_at: Option<UnixSeconds>,
    pub failure: Option<String>,
    pub failures: Vec<FinancialUpdateFailure>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FinancialMetric { Revenue, OperatingIncome, OwnerRoe, InvestingCashFlow, Dps, DebtRatio }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FinancialValueStatus { Available, Unpublished, MissingItem, NotCalculable, Failed, Pending, Unsupported }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FinancialReason {
    AnnualOnly, ShareClassUnverified, AccountMappingUnverified, AmbiguousAccount,
    AmountMissing, PeriodUnverified, PeriodMismatch, ShortPeriod, PeriodOverlap,
    MissingComparison, BasisChanged, CurrencyMismatch, NonPositiveEquity,
    NonPositiveAverageEquity, NonFiniteResult, ReceiptMismatch, RefreshIncomplete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum FinancialReportingPeriod { Instant { date: String }, Duration { start: String, end: String } }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum FinancialBasis { CFS, OFS }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FinancialInputStatus { Available, MissingReport, Unpublished, MissingItem, NotCalculable, Failed, Pending }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FinancialInputUsage { Value, Comparison, ReportingPeriod }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FinancialInput {
    pub business_year: i32,
    pub report_code: String,
    pub usage: FinancialInputUsage,
    pub status: FinancialInputStatus,
    pub reason: Option<FinancialReason>,
    pub role: String,
    pub amount: Option<String>,
    pub period: Option<FinancialReportingPeriod>,
    pub verification_reason: Option<String>,
    pub basis: Option<FinancialBasis>,
    pub currency: Option<String>,
    pub receipt: Option<String>,
    pub disclosed_at: Option<String>,
    pub context_id: Option<String>,
    pub source_file: Option<String>,
    pub fields: std::collections::BTreeMap<String, String>,
    pub checked_at: Option<UnixSeconds>,
    pub last_success_at: Option<UnixSeconds>,
    pub failure: Option<String>,
    #[ts(type = "number")]
    pub refresh_version: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FinancialPoint {
    pub business_year: i32,
    pub report_code: String,
    pub status: FinancialValueStatus,
    pub reason: Option<FinancialReason>,
    pub value: Option<f64>,
    pub reported_value: Option<f64>,
    pub period: Option<FinancialReportingPeriod>,
    pub price_bucket: Option<UnixSeconds>,
    pub basis: Option<FinancialBasis>,
    pub currency: Option<String>,
    pub inputs: Vec<FinancialInput>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FinancialSeries { pub metric: FinancialMetric, pub points: Vec<FinancialPoint> }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FinancialProgress {
    pub total: usize,
    pub completed: usize,
    pub failed: usize,
    pub pending: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FinancialsPage {
    pub symbol: SymbolCode,
    pub period: FinancialPeriod,
    pub status: String,
    pub reason: Option<String>,
    pub failure: Option<String>,
    pub corp_code: Option<String>,
    pub fiscal_month: Option<u8>,
    pub share_class: Option<String>,
    pub share_class_reason: Option<String>,
    pub last_checked_at: Option<UnixSeconds>,
    pub last_attempt_at: Option<UnixSeconds>,
    pub disclosure_failure: Option<String>,
    #[ts(type = "number")]
    pub refresh_version: u64,
    #[ts(type = "number")]
    pub disclosure_version: u64,
    pub latest_corrections: bool,
    pub progress: FinancialProgress,
    pub series: Vec<FinancialSeries>,
}
