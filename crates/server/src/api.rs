//! 브라우저 계약(backend.md §8). 이 모듈의 타입만 JSON으로 나가고 들어온다.
//! ts-rs가 `web/src/api/generated/`에 TypeScript 정의를 쓴다(`cargo test`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Unix 초(UTC 기준 정수). 봉의 `t`는 봉 시작 시각이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UnixSeconds(#[ts(type = "number")] pub i64);

impl UnixSeconds {
    pub const fn millis(self) -> i64 {
        self.0 * 1000
    }
}

/// 주식·ETF "005930", 지수 "IDX:001"(코스피) "IDX:101"(코스닥).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
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
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Venue {
    /// 통합 시세(KRX + NXT). 칸의 기본값.
    #[default]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JumpBarsPage {
    pub symbol: SymbolCode,
    pub venue: Option<Venue>,
    pub period: Period,
    pub date: KstDate,
    pub bars: Vec<Bar>,
    pub next_before: Option<UnixSeconds>,
    pub unadjusted_days: Vec<KstDate>,
}

/// `/api/ws` 브라우저 → 서버. `sub`는 브라우저가 정하는 연결 안에서 유일한 문자열이다.
/// `venue` 규칙은 `GET /api/bars`와 같다(주식에서 빼면 combined, 지수에 주면 bad_request). 구독 하나의 `venue`는 체결(`trades`)과 호가(`book`)에만 쓰고, 나머지 종류는 통합이다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum ClientMessage {
    Subscribe { sub: String, symbol: SymbolCode, venue: Option<Venue>, period: Period },
    SubscribeFeed { sub: String, symbol: SymbolCode, kind: FeedKind, venue: Option<Venue> },
    Unsubscribe { sub: String },
    /// 지금 보이는 관심종목 목록 전체, 위에서부터. 받을 때마다 통째로 바꾼다. 빈 배열은 목록을 닫았다는 뜻이다.
    /// `venue`는 이 연결의 관심종목 시세 거래소 하나다. 없거나 null이면 통합이다. 같은 목록으로 거래소만 바꿔 다시 보내면
    /// 다음 시세부터 새 거래소 기준이고, 실시간 등록 집합은 바뀌지 않는다.
    Watch { symbols: Vec<SymbolCode>, venue: Option<Venue> },
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
    FeedSubscribed { sub: String, kind: FeedKind },
    FeedTrades {
        sub: String,
        #[ts(type = "number")]
        seq: u64,
        trades: Vec<FeedTrade>,
    },
    FeedBook { sub: String, book: FeedBook },
    FeedAfterHours { sub: String, totals: FeedAfterHoursTotals },
    FeedProgram { sub: String, row: FeedProgramRow },
    FeedBrokers { sub: String, brokers: FeedBrokers },
    FeedMicro { sub: String, event: MicroEvent },
    FeedOfi { sub: String, ofi: OfiSnapshot },
    FeedLink { sub: String, live: bool, at: UnixSeconds },
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
    /// `venue`는 그 시점에 이 연결이 `watch`로 요청한 거래소다. 한 메시지의 `quotes`는 모두 이 요청에서 만든 값이다.
    /// `watch`가 거래소를 바꾸면 그 전 요청으로 만든 값은 더 보내지 않지만 이미 나간 메시지는 `venue`로 가려낸다.
    Quotes { venue: Venue, quotes: Vec<Quote> },
    /// 이 연결의 관심종목 가운데 실시간 한도로 받지 못하는 종목, 목록 순서. 바뀔 때만 온다. 브라우저는 통째로 바꾼다.
    WatchLimited { symbols: Vec<SymbolCode> },
    KiwoomLink { status: KiwoomLinkStatus },
    MarketSource { status: MarketSourceStatus },
    Account { status: AccountStatus },
    CollectorDaemon { judgment: crate::collector::DaemonJudgment, at: UnixSeconds },
    SetupChanged { kinds: Vec<setup::DocumentKind> },
    TradingAccountChanged {
        account_ref: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        fill: Option<TradingFillNotice>,
    },
    ViSnapshot { states: Vec<ViState> },
    ViUpdate { state: ViState },
    ViExpectedSnapshot {
        symbol: SymbolCode,
        market: ViMarket,
        triggered_at: Option<UnixSeconds>,
        points: Vec<ViExpectedPoint>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ViExpectedPoint {
    pub t: UnixSeconds,
    pub price: f64,
    #[ts(type = "number")]
    pub qty: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TradingFillNotice {
    pub order_no: Option<String>,
    #[ts(type = "number | null")]
    pub quantity: Option<u64>,
    #[ts(type = "number | null")]
    pub cumulative_quantity: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ViMarket {
    Krx,
    Nxt,
}

impl From<crate::market_source::vi::ViMarket> for ViMarket {
    fn from(market: crate::market_source::vi::ViMarket) -> ViMarket {
        match market {
            crate::market_source::vi::ViMarket::Krx => ViMarket::Krx,
            crate::market_source::vi::ViMarket::Nxt => ViMarket::Nxt,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ViDirection {
    Up,
    Down,
}

impl From<crate::market_source::vi::ViDirection> for ViDirection {
    fn from(direction: crate::market_source::vi::ViDirection) -> ViDirection {
        match direction {
            crate::market_source::vi::ViDirection::Up => ViDirection::Up,
            crate::market_source::vi::ViDirection::Down => ViDirection::Down,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ViState {
    pub symbol: SymbolCode,
    pub market: ViMarket,
    pub active: bool,
    pub direction: Option<ViDirection>,
    pub trigger_price: Option<f64>,
    pub base: Option<f64>,
    pub triggered_at: Option<UnixSeconds>,
    pub released_at: Option<UnixSeconds>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FeedKind {
    Trades,
    Book,
    Program,
    Brokers,
    Micro,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MicroSide {
    Ask,
    Bid,
}

impl From<domain::MicroSide> for MicroSide {
    fn from(side: domain::MicroSide) -> Self {
        match side {
            domain::MicroSide::Ask => MicroSide::Ask,
            domain::MicroSide::Bid => MicroSide::Bid,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MicroEventKind {
    SpoofCancel,
    IcebergAbsorb,
}

impl From<domain::MicroEventKind> for MicroEventKind {
    fn from(kind: domain::MicroEventKind) -> Self {
        match kind {
            domain::MicroEventKind::SpoofCancel => MicroEventKind::SpoofCancel,
            domain::MicroEventKind::IcebergAbsorb => MicroEventKind::IcebergAbsorb,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MicroEvent {
    #[ts(type = "number")]
    pub recv_ms: i64,
    pub kind: MicroEventKind,
    pub side: MicroSide,
    #[ts(type = "number")]
    pub price_won: u64,
    #[ts(type = "number")]
    pub cancelled_or_absorbed_qty: u64,
    #[ts(type = "number")]
    pub displayed_qty: u64,
    #[ts(type = "number")]
    pub executed_qty: u64,
    pub ratio_bps: u32,
}

impl From<domain::MicroEvent> for MicroEvent {
    fn from(event: domain::MicroEvent) -> Self {
        Self {
            recv_ms: event.recv_ms,
            kind: event.kind.into(),
            side: event.side.into(),
            price_won: event.price_won,
            cancelled_or_absorbed_qty: event.cancelled_or_absorbed_qty,
            displayed_qty: event.displayed_qty,
            executed_qty: event.executed_qty,
            ratio_bps: event.ratio_bps,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OfiSnapshot {
    #[ts(type = "number")]
    pub recv_ms: i64,
    pub buy_pressure_pct: u8,
    #[ts(type = "number")]
    pub ofi_qty: i64,
    pub tape_speed_ratio_bps: u32,
}

impl From<domain::OfiSnapshot> for OfiSnapshot {
    fn from(ofi: domain::OfiSnapshot) -> Self {
        Self {
            recv_ms: ofi.recv_ms,
            buy_pressure_pct: ofi.buy_pressure_pct,
            ofi_qty: ofi.ofi_qty,
            tape_speed_ratio_bps: ofi.tape_speed_ratio_bps,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MicroEventsPage {
    pub symbol: SymbolCode,
    pub date: String,
    pub source: BrokerDaySource,
    pub events: Vec<MicroEvent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FeedTrade {
    pub t: UnixSeconds,
    pub price: f64,
    #[ts(type = "number")]
    pub qty: i64,
    pub venue: Option<Venue>,
    pub strength: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub same_time_ratio: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FeedBookLevel {
    pub price: f64,
    #[ts(type = "number")]
    pub qty: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FeedExpected {
    pub price: f64,
    #[ts(type = "number")]
    pub qty: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FeedBook {
    pub t: UnixSeconds,
    pub asks: Vec<Option<FeedBookLevel>>,
    pub bids: Vec<Option<FeedBookLevel>>,
    #[ts(type = "number")]
    pub total_ask_qty: u64,
    #[ts(type = "number")]
    pub total_bid_qty: u64,
    pub expected: Option<FeedExpected>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FeedAfterHoursTotals {
    pub t: UnixSeconds,
    #[ts(type = "number")]
    pub ask_qty: u64,
    #[ts(type = "number")]
    pub bid_qty: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FeedProgramRow {
    pub t: UnixSeconds,
    pub price: Option<f64>,
    #[ts(type = "number")]
    pub sell_qty: u64,
    #[ts(type = "number")]
    pub sell_amount: u64,
    #[ts(type = "number")]
    pub buy_qty: u64,
    #[ts(type = "number")]
    pub buy_amount: u64,
    #[ts(type = "number")]
    pub net_qty: i64,
    #[ts(type = "number")]
    pub net_qty_change: i64,
    #[ts(type = "number")]
    pub net_amount: i64,
    #[ts(type = "number")]
    pub net_amount_change: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FeedBroker {
    pub code: String,
    pub name: String,
    #[ts(type = "number")]
    pub qty: u64,
    #[ts(type = "number")]
    pub qty_change: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FeedBrokers {
    pub t: UnixSeconds,
    pub sells: Vec<FeedBroker>,
    pub buys: Vec<FeedBroker>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BrokerDaySource {
    Store,
    Flow,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BrokerDay {
    pub symbol: SymbolCode,
    pub date: String,
    pub source: BrokerDaySource,
    pub snapshots: Vec<FeedBrokers>,
    #[ts(type = "[number, number][]")]
    pub gaps: Vec<[i64; 2]>,
    pub live: bool,
    pub cursor: String,
    pub reset: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BrokerDays {
    pub symbol: SymbolCode,
    pub days: Vec<String>,
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

/// 키움 실시간 연결. `reconnecting`이면 `since`부터 현재 봉이 멈춰 있을 수 있다. `halted`는 운영자가 고쳐야 한다. `notConnected`는 사용자가 키움에 연결하지 않았거나 연결을 끊은 상태다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RealtimeState {
    Live,
    Reconnecting,
    Halted,
    NotConnected,
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
pub enum KeySource {
    Env,
    File,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum KiwoomLinkState {
    NoKey,
    Disconnected,
    Connecting,
    Connected,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum KiwoomConnectStep {
    CheckingKey,
    Token,
    IssueInterval,
    Symbols,
    Realtime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum KiwoomAtStart {
    Connects,
    KeptDisconnected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum KiwoomLinkProblem {
    AuthBlocked8050,
    KeyNeedsCheck,
    IssueIntervalWait,
    AuthUncertain,
    Network,
    TokenFileUnusable,
    PathStopped,
    KeyFileUnusable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum KiwoomEnvironment {
    #[default]
    Real,
    Mock,
}

impl KiwoomEnvironment {
    pub fn as_str(self) -> &'static str {
        match self {
            KiwoomEnvironment::Real => "real",
            KiwoomEnvironment::Mock => "mock",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KiwoomLinkStatus {
    pub environment: KiwoomEnvironment,
    pub key_source: KeySource,
    pub app_key_tail: Option<String>,
    pub credential_id: Option<String>,
    pub state: KiwoomLinkState,
    pub problem: Option<KiwoomLinkProblem>,
    pub message: String,
    pub retry_at: Option<UnixSeconds>,
    pub needs_acknowledgement: bool,
    pub step: Option<KiwoomConnectStep>,
    pub token_expires_at: Option<UnixSeconds>,
    pub realtime_registered: Option<u32>,
    pub symbol_count: Option<u32>,
    pub registered_ip: Option<RegisteredIp>,
    pub at_start: Option<KiwoomAtStart>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RankingChoicesView {
    pub venues: Vec<Venue>,
    pub sessions: Vec<TradingSession>,
    pub baselines: Vec<SurgeBaseline>,
    pub surge_sorts: Vec<SurgeSort>,
    pub min_trade_amounts: Vec<MinTradeAmount>,
    pub investors: Vec<RankingInvestor>,
    pub spans: Vec<ViewSpan>,
    pub excludes_managed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RankingKindChoices {
    pub kind: crate::market_source::rankings::RankingKind,
    pub choices: RankingChoicesView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FeedBrokerStatus {
    pub broker: Broker,
    pub ranking_kinds: Vec<crate::market_source::rankings::RankingKind>,
    pub ranking_choices: Vec<RankingKindChoices>,
    pub overview_features: Vec<crate::market_source::OverviewFeature>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarketSourceStatus {
    pub broker: Broker,
    pub key_id: Option<String>,
    pub alias: Option<String>,
    pub state: KiwoomLinkState,
    pub problem: Option<KiwoomLinkProblem>,
    pub step: Option<KiwoomConnectStep>,
    pub retry_at: Option<UnixSeconds>,
    pub features: Vec<crate::market_source::MarketFeature>,
    pub feed_broker: Option<FeedBrokerStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KiwoomUsage {
    pub last_minute_started_at: Option<UnixSeconds>,
    pub total_rate_limited: u32,
    pub trs: Vec<KiwoomUsageTr>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KiwoomUsageTr {
    pub api_id: String,
    pub limit: u32,
    pub last_minute: KiwoomUsageMinute,
    pub total_sent: u32,
    pub total_rate_limited: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KiwoomUsageMinute {
    pub sent: u32,
    pub max_per_second: u32,
    pub max_wait_ms: u32,
    pub rate_limited: u32,
    pub resent: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RegisteredIp {
    pub ip: String,
    pub at: UnixSeconds,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PublicIpCheck {
    pub ip: String,
    pub checked_at: UnixSeconds,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RegisteredIpInput {
    pub ip: String,
}

#[derive(Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KiwoomKeyInput {
    pub app_key: String,
    pub app_secret: String,
    #[serde(default)]
    #[ts(optional)]
    pub account_no: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub hts_id: Option<String>,
}

impl std::fmt::Debug for KiwoomKeyInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("KiwoomKeyInput([가림])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Broker {
    Kiwoom,
    Kis,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KiwoomKey {
    pub key_id: String,
    pub alias: String,
    pub broker: Broker,
    pub source: KeySource,
    pub app_key_tail: Option<String>,
    pub market: bool,
    pub link: KiwoomLinkStatus,
    pub kis_account: Option<KisAccountListing>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KisAccountListing {
    pub account_tail: Option<String>,
    pub account_masked: Option<String>,
    pub hts_id_set: bool,
    pub source: KeySource,
}

#[derive(Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KisAccountInput {
    pub account_no: String,
    #[serde(default)]
    #[ts(optional)]
    pub hts_id: Option<String>,
}

impl std::fmt::Debug for KisAccountInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("KisAccountInput([가림])")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KiwoomKeyList {
    pub limit: u32,
    pub keys: Vec<KiwoomKey>,
    pub key_file_problem: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KiwoomKeyAdd {
    pub alias: String,
    pub app_key: String,
    pub app_secret: String,
    #[serde(default)]
    #[ts(optional)]
    pub broker: Option<Broker>,
    #[serde(default)]
    #[ts(optional)]
    pub account_no: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub hts_id: Option<String>,
}

impl std::fmt::Debug for KiwoomKeyAdd {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("KiwoomKeyAdd([가림])")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KiwoomKeyAlias {
    pub alias: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KiwoomMarketKeyInput {
    pub key_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KiwoomConnectInput {
    pub acknowledged: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum KiwoomTargetKind {
    Kiwoom,
    Loopback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KiwoomTarget {
    pub kind: KiwoomTargetKind,
    pub host: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AccountProvider {
    Google,
    Naver,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum AccountStatus {
    LocalOnly,
    SignedOut,
    SignedIn { provider: AccountProvider, account_id: String, signed_in_at: UnixSeconds, sync: SyncStatus },
    OwnerMismatch { provider: AccountProvider, account_id: String, signed_in_at: UnixSeconds, local_owner: String, sync: SyncStatus },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum SyncState {
    Running,
    NeedsChoice {
        #[ts(type = "number")]
        local_documents: i64,
        #[ts(type = "number")]
        account_documents: i64,
    },
    OwnerMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncStatus {
    #[serde(flatten)]
    pub state: SyncState,
    pub last_success_at: Option<UnixSeconds>,
    #[ts(type = "number")]
    pub pending_documents: i64,
    #[ts(type = "number")]
    pub refused_documents: i64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum InitialSyncChoice {
    UploadLocal,
    TakeAccount,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct InitialSyncRequest {
    pub choice: InitialSyncChoice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AccountLoginRequest {
    pub provider: AccountProvider,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AccountLoginStart {
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AccountConfirm {
    pub confirm: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SystemSettings {
    pub environment: KiwoomEnvironment,
    pub bind: String,
    pub log_filter: String,
    pub static_dir: String,
    pub db_path: String,
    pub screener_db_path: String,
    pub financial_db_path: String,
    pub hoga_data_dir: Option<String>,
    pub shared_data_dir: Option<String>,
    pub screener_update_on_start: bool,
    pub token_path: String,
    pub key_path: String,
    pub lock_path: String,
    pub kiwoom_target: KiwoomTarget,
    pub server_version: String,
    pub account_server_url: Option<String>,
    pub account_state_path: Option<String>,
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
    Etn,
    Infrastructure,
    MutualFund,
}

impl From<domain::SymbolKind> for SymbolKind {
    fn from(k: domain::SymbolKind) -> Self {
        match k {
            domain::SymbolKind::Index => SymbolKind::Index,
            domain::SymbolKind::Common => SymbolKind::Common,
            domain::SymbolKind::Preferred => SymbolKind::Preferred,
            domain::SymbolKind::Etf => SymbolKind::Etf,
            domain::SymbolKind::Reit => SymbolKind::Reit,
            domain::SymbolKind::Etn => SymbolKind::Etn,
            domain::SymbolKind::Infrastructure => SymbolKind::Infrastructure,
            domain::SymbolKind::MutualFund => SymbolKind::MutualFund,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum QuoteSource {
    Realtime,
    Polled,
    Expected,
}

/// `GET /api/quotes?symbols=005930,IDX:001&venue=krx` → `Quote[]`.
/// 주식은 `venue`(`combined` 기본, `krx`, `nxt`)의 시세(ka10095), 지수는 지수 일봉의 최신 페이지에서 만든다.
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
    /// 이 값을 만든 거래소. 요청이 NXT인데 그 종목이 NXT에서 거래되지 않으면 요청과 달리 통합이다. 지수면 null.
    pub venue: Option<Venue>,
    /// 당일 누적 거래대금, 백만원(ka10095 `trde_prica`). REST 주식 시세에만 있고 지수와 실시간 프레임에는 없다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub traded_million_won: Option<u64>,
}

/// `GET /api/symbols/:code/day-summary?venue=krx` → 주식 한 종목의 당일 요약(ka10095 한 행). 지수는 400 `bad_request`.
/// `venue`는 `combined`(기본), `krx`, `nxt`다. 요청이 NXT인데 그 종목이 NXT에서 거래되지 않으면 통합으로 묻고 `venue`에 통합이 온다.
/// 장 전처럼 키움이 0이나 빈 값을 준 항목과 행이 없는 종목의 모든 항목은 null이다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SymbolDaySummary {
    pub symbol: SymbolCode,
    pub venue: Venue,
    pub price: Option<f64>,
    /// 전일 종가(ka10095 기준가), 원.
    pub previous_close: Option<f64>,
    pub open: Option<f64>,
    pub high: Option<f64>,
    pub low: Option<f64>,
    /// 당일 누적.
    #[ts(type = "number | null")]
    pub volume: Option<u64>,
    /// 당일 누적 거래대금, 원.
    #[ts(type = "number | null")]
    pub trade_value_won: Option<u64>,
    pub t: Option<UnixSeconds>,
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
    pub credit_rate: Option<f64>,
    /// 최근 250관측일 최고가(원).
    #[ts(type = "number | null")]
    pub high52w: Option<u64>,
    /// 최근 250관측일 최저가(원).
    #[ts(type = "number | null")]
    pub low52w: Option<u64>,
    /// 오늘의 상한가(원).
    #[ts(type = "number | null")]
    pub upper_limit: Option<u64>,
    /// 오늘의 하한가(원).
    #[ts(type = "number | null")]
    pub lower_limit: Option<u64>,
}

/// 호가 한 단. 가격은 원, 잔량은 주.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OrderBookLevel {
    #[ts(type = "number")]
    pub price: u64,
    #[ts(type = "number")]
    pub quantity: u64,
}

/// `GET /api/symbols/:code/order-book?venue=` → ka10004의 10호가. `venue`는 `combined`(기본)·`krx`·`nxt`다. NXT에서 거래되지 않는 종목은 어느 값이든 통합 호가다. 지수는 400 `bad_request`.
/// 매도·매수 모두 1호가부터 순서대로이고, 키움이 가격을 주지 않은 단은 빠진다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OrderBook {
    pub symbol: SymbolCode,
    pub asks: Vec<OrderBookLevel>,
    pub bids: Vec<OrderBookLevel>,
    #[ts(type = "number")]
    pub total_ask_quantity: u64,
    #[ts(type = "number")]
    pub total_bid_quantity: u64,
    #[ts(type = "number | null")]
    pub after_hours_ask_quantity: Option<u64>,
    #[ts(type = "number | null")]
    pub after_hours_bid_quantity: Option<u64>,
    /// 호가 기준 시각 `HH:MM:SS`(KST). 키움은 날짜를 주지 않는다. 없으면 null.
    pub book_time: Option<String>,
    #[serde(default)]
    pub expected: Option<FeedExpected>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BookReplayAccess {
    pub available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BookReplayDays {
    pub symbol: SymbolCode,
    pub days: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BookReplayCoverage {
    Collected,
    SymbolNotCollected,
    DayNotCollected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BookReplayBook {
    pub minute: u32,
    #[ts(type = "[number, number][]")]
    pub asks: Vec<[u64; 2]>,
    #[ts(type = "[number, number][]")]
    pub bids: Vec<[u64; 2]>,
    #[ts(type = "number")]
    pub total_ask: u64,
    #[ts(type = "number")]
    pub total_bid: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BookReplayResolution {
    Tick,
    MinuteOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BookReplaySpanSummary {
    pub start_minute: u32,
    pub book_rows: u32,
    pub trade_rows: u32,
    pub program_rows: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BookReplayMinuteCheckpoint {
    pub minute: u32,
    #[ts(type = "number | null")]
    pub open: Option<u64>,
    #[ts(type = "number | null")]
    pub high: Option<u64>,
    #[ts(type = "number | null")]
    pub low: Option<u64>,
    #[ts(type = "number | null")]
    pub close: Option<u64>,
    #[ts(type = "number")]
    pub volume: u64,
    #[ts(type = "number")]
    pub cum_vol: u64,
    #[ts(type = "number")]
    pub cum_val: u64,
    #[ts(type = "number")]
    pub cum_buy_qty: u64,
    #[ts(type = "number")]
    pub cum_sell_qty: u64,
    #[ts(type = "number | null")]
    pub day_open: Option<u64>,
    #[ts(type = "number | null")]
    pub day_high: Option<u64>,
    #[ts(type = "number | null")]
    pub day_low: Option<u64>,
    #[ts(type = "number | null")]
    pub total_ask: Option<u64>,
    #[ts(type = "number | null")]
    pub total_bid: Option<u64>,
    #[ts(type = "number | null")]
    pub program_net_qty: Option<i64>,
    #[ts(type = "number | null")]
    pub program_net_amt_million: Option<i64>,
    pub single_price: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BookReplayMeta {
    pub symbol: SymbolCode,
    pub date: String,
    pub coverage: BookReplayCoverage,
    pub resolution: BookReplayResolution,
    pub span_minutes: u32,
    #[ts(type = "[number, number][]")]
    pub covered: Vec<[u32; 2]>,
    #[ts(type = "[number, number][]")]
    pub gaps_ms: Vec<[i64; 2]>,
    pub spans: Vec<BookReplaySpanSummary>,
    pub minutes: Vec<BookReplayMinuteCheckpoint>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BookReplayDay {
    pub symbol: SymbolCode,
    pub date: String,
    pub coverage: BookReplayCoverage,
    #[ts(type = "[number, number][]")]
    pub covered: Vec<[u32; 2]>,
    pub books: Vec<BookReplayBook>,
    #[ts(type = "[number, number, number, number][]")]
    pub trades: Vec<(u32, u32, u64, i64)>,
}

/// 체결 한 건. 수량의 부호가 방향이다(+ 매수 체결, - 매도 체결).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TradePrint {
    /// 체결 시각 `HH:MM:SS`(KST).
    pub time: String,
    #[ts(type = "number")]
    pub price: u64,
    #[ts(type = "number")]
    pub quantity: i64,
    /// 그 체결이 난 거래소. 키움이 행에 적지 않았으면 null.
    pub exchange: Option<Venue>,
}

/// `GET /api/symbols/:code/trades?venue=&limit=` → 당일 체결(ka10003), 최근부터. 지수는 400 `bad_request`.
/// `venue`는 combined·krx·nxt이고 기본은 combined다. 요청이 nxt인데 그 종목이 NXT에서 거래되지 않으면 combined로 묻고
/// 응답의 `venue`가 그 사실을 알린다. `limit`는 기본 200, 최대 500이다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TradeTape {
    pub symbol: SymbolCode,
    /// 실제로 물은 거래소.
    pub venue: Venue,
    pub trades: Vec<TradePrint>,
    /// 읽지 못해 뺀 행 수.
    pub skipped_rows: u32,
}

/// 프로그램매매 한 시점(통합). 수량은 주, 금액은 원. 매수·매도는 당일 누적이고 순매수는 부호가 방향이다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProgramTradePoint {
    /// `HH:MM:SS`(KST).
    pub time: String,
    #[ts(type = "number | null")]
    pub price: Option<u64>,
    #[ts(type = "number")]
    pub buy_quantity: u64,
    #[ts(type = "number")]
    pub sell_quantity: u64,
    #[ts(type = "number")]
    pub net_quantity: i64,
    #[ts(type = "number")]
    pub buy_amount: i64,
    #[ts(type = "number")]
    pub sell_amount: i64,
    #[ts(type = "number")]
    pub net_amount: i64,
}

/// `GET /api/symbols/:code/program-trades` → 당일 프로그램매매 시간대(ka90008, 통합), 키움이 주는 순서대로.
/// 지수는 400 `bad_request`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProgramTradeTimeline {
    pub symbol: SymbolCode,
    pub points: Vec<ProgramTradePoint>,
    /// 읽지 못해 뺀 행 수.
    pub skipped_rows: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub date: Option<String>,
}

/// 저장 순서 번호. 브라우저가 저장할 때마다 늘려 보낸다(`max(지금 ms, 마지막 + 1)`).
/// PUT은 저장된 것보다 클 때만 받고, 아니면 409 `stale_revision`이다. GET은 저장된 값을 돌려준다. 처음은 0.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Revision(#[ts(type = "number")] pub i64);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct WatchGroup {
    pub id: String,
    pub name: String,
    pub symbols: Vec<SymbolCode>,
}

/// 관심종목 목록 하나. `symbols`는 전체 종목이고 중복이 없다. `groups`는 겹칠 수 있는 부분집합을 묶는다(ADR 0018).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Watchlist {
    pub id: String,
    pub name: String,
    pub symbols: Vec<SymbolCode>,
    #[serde(default)]
    pub groups: Vec<WatchGroup>,
}

/// `GET /api/watchlists` 응답이자 `PUT /api/watchlists` 본문. `lists`는 표시 순서대로이고 1~20개다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Watchlists {
    pub lists: Vec<Watchlist>,
    pub revision: Revision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HeatmapTheme {
    pub id: String,
    pub name: String,
    pub symbols: Vec<SymbolCode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HeatmapThemes {
    pub themes: Vec<HeatmapTheme>,
    pub revision: Revision,
}

/// 칸 동기화. 저장된 값에 키가 빠져 있으면 true로 읽는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LayoutSync {
    #[serde(default = "yes")]
    pub crosshair: bool,
    #[serde(default = "yes")]
    pub scroll: bool,
    #[serde(default)]
    pub crosshair_scope: CrosshairScope,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum CrosshairScope {
    #[default]
    All,
    Symbol,
    Link,
}

const fn yes() -> bool {
    true
}

pub const WINDOW_ID_BYTES: std::ops::RangeInclusive<usize> = 1..=64;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(try_from = "String", into = "String")]
#[ts(export, type = "string")]
pub struct WindowId(String);

impl WindowId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for WindowId {
    type Error = String;

    fn try_from(text: String) -> Result<Self, String> {
        let valid = WINDOW_ID_BYTES.contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        if valid {
            Ok(WindowId(text))
        } else {
            Err(format!("창 id는 {}~{}바이트의 A-Z a-z 0-9 _ -여야 합니다: {text:?}", WINDOW_ID_BYTES.start(), WINDOW_ID_BYTES.end()))
        }
    }
}

impl From<WindowId> for String {
    fn from(id: WindowId) -> String {
        id.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum LinkColor {
    A,
    B,
    C,
    D,
    E,
    F,
    G,
    H,
    I,
    J,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "LayoutFeedFields", into = "LayoutFeedFields")]
pub struct ChartFeed(pub domain::Feed);

#[derive(Serialize, Deserialize, TS)]
struct LayoutFeedFields {
    symbol: SymbolCode,
    venue: Option<Venue>,
}

pub(crate) fn parse_layout_feed(symbol: &str, venue: Option<Venue>) -> Result<ChartFeed, String> {
    match (domain::Symbol::parse(symbol).map_err(|e| e.to_string())?, venue) {
        (domain::Symbol::Stock(code), Some(venue)) => Ok(ChartFeed(domain::Feed::Stock(code, venue.into()))),
        (domain::Symbol::Index(code), None) => Ok(ChartFeed(domain::Feed::Index(code))),
        (domain::Symbol::Stock(_), None) => Err(format!("주식 차트 창에는 거래소가 있어야 합니다: {symbol}")),
        (domain::Symbol::Index(_), Some(_)) => Err(format!("지수에는 거래소가 없습니다: {symbol}")),
    }
}

impl TryFrom<LayoutFeedFields> for ChartFeed {
    type Error = String;

    fn try_from(fields: LayoutFeedFields) -> Result<Self, Self::Error> {
        parse_layout_feed(&fields.symbol.0, fields.venue)
    }
}

impl From<ChartFeed> for LayoutFeedFields {
    fn from(feed: ChartFeed) -> Self {
        Self { symbol: SymbolCode(feed.0.symbol().as_wire()), venue: feed.0.venue().map(Into::into) }
    }
}

impl TS for ChartFeed {
    type WithoutGenerics = Self;
    type OptionInnerType = Self;

    fn decl() -> String {
        LayoutFeedFields::decl()
    }

    fn decl_concrete() -> String {
        LayoutFeedFields::decl_concrete()
    }

    fn name() -> String {
        LayoutFeedFields::name()
    }

    fn inline() -> String {
        LayoutFeedFields::inline()
    }

    fn inline_flattened() -> String {
        LayoutFeedFields::inline_flattened()
    }

    fn visit_dependencies(visitor: &mut impl ts_rs::TypeVisitor) {
        LayoutFeedFields::visit_dependencies(visitor);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum BrokerView {
    Board,
    List,
    Table,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum BrokerCards {
    Bars,
    Both,
    Numbers,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export)]
pub enum WindowContent {
    Chart {
        #[serde(flatten)]
        feed: ChartFeed,
        period: Period,
        #[serde(rename = "chartSettings")]
        #[ts(type = "unknown")]
        chart_settings: serde_json::Value,
    },
    Watchlist {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        list: Option<String>,
    },
    Screener {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        screen: Option<String>,
    },
    Indicators,
    Trades {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        symbol: Option<SymbolCode>,
    },
    Book {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        symbol: Option<SymbolCode>,
    },
    Program {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        symbol: Option<SymbolCode>,
    },
    Brokers {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        symbol: Option<SymbolCode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, inline)]
        view: Option<BrokerView>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, inline)]
        cards: Option<BrokerCards>,
    },
    Order {
        #[serde(default = "default_order_venue")]
        venue: Venue,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        symbol: Option<SymbolCode>,
    },
    Ranking {
        ranking: Ranking,
    },
    PreMarket {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        symbol: Option<SymbolCode>,
    },
}

fn default_order_venue() -> Venue {
    Venue::Krx
}

impl WindowContent {
    pub const fn is_chart(&self) -> bool {
        matches!(self, WindowContent::Chart { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LayoutWindow {
    pub id: WindowId,
    pub link: Option<LinkColor>,
    #[serde(flatten)]
    pub content: WindowContent,
}

/// `GET /api/layouts` → `LayoutSummary[]`(표시 순서).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LayoutSummary {
    pub id: String,
    pub name: String,
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
    pub sync: LayoutSync,
    pub windows: Vec<LayoutWindow>,
    #[ts(type = "unknown")]
    pub placement: serde_json::Map<String, serde_json::Value>,
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
    pub sync: LayoutSync,
    pub windows: Vec<LayoutWindow>,
    #[ts(type = "unknown")]
    pub placement: serde_json::Map<String, serde_json::Value>,
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
    pub source: Broker,
    pub skipped_days: Vec<SkippedDay>,
    pub undated_rows: Vec<UndatedRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub estimated_days: Option<Vec<KstDate>>,
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
    Etn,
    Infrastructure,
    MutualFund,
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
    ProgramNetBuy { days: u32, min_million_won: Bound, max_million_won: Bound },
    WhaleNetBuy { days: u32, min_million_won: Bound, max_million_won: Bound },
    ViTriggered { days: u32, min_count: u32 },
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number", optional)]
    pub traded_million_won: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number", optional)]
    pub program_net_million_won: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number", optional)]
    pub whale_net_million_won: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub vi_count: Option<u32>,
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
    AccountServerUnavailable,
    Forbidden,
    CollectorUnavailable,
    SignedOut,
    NotPrepared,
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
    BusinessRejected,
    Unsupported,
    UnknownFailure,
    Protocol,
    SymbolListLoading,
    MissingDay,
    Updating,
    DataChanged,
    StaleData,
    NotConnected,
    OrdersOff,
    AccountChanged,
    UnsupportedBySource,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum OrderSide {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum OrdersState {
    Off,
    On,
    FileUnusable,
    AccountChanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OrdersStatus {
    pub state: OrdersState,
    pub account_ref: Option<String>,
    pub account_tail: Option<String>,
    pub message: String,
    pub accounts: Vec<OrdersAccount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OrdersAccount {
    pub key_id: String,
    pub broker: Broker,
    pub alias: String,
    pub market: bool,
    pub state: OrdersState,
    pub account_ref: Option<String>,
    pub account_tail: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MarginPolicy {
    #[default]
    CashOnly,
    AllowMargin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OrdersMargin {
    pub policy: MarginPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OrdersMarginInput {
    pub policy: MarginPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OrdersAccountCheck {
    pub broker: Broker,
    pub account_tail: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TradingAccountNumber {
    pub account_number: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OrdersSwitchInput {
    pub enabled: bool,
    pub confirm_account_tail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TradingHolding {
    pub code: String,
    pub name: String,
    #[ts(type = "number")]
    pub quantity: u64,
    #[ts(type = "number")]
    pub sellable_quantity: u64,
    #[ts(type = "number")]
    pub average_price: u64,
    #[ts(type = "number")]
    pub current_price: u64,
    #[ts(type = "number")]
    pub evaluation_profit: i64,
    #[ts(type = "number | null")]
    pub profit_rate_centi: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TradingBalance {
    pub account_ref: String,
    pub holdings: Vec<TradingHolding>,
    pub credit_holdings: Vec<TradingHolding>,
    #[ts(type = "number")]
    pub total_purchase: i64,
    #[ts(type = "number")]
    pub total_evaluation: i64,
    #[ts(type = "number")]
    pub total_profit: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TradingOpenOrder {
    pub order_no: String,
    pub code: String,
    pub name: String,
    pub side: OrderSide,
    #[ts(type = "number")]
    pub quantity: u64,
    #[ts(type = "number")]
    pub price: u64,
    #[ts(type = "number")]
    pub open_quantity: u64,
    pub status: String,
    pub ordered_at: String,
    pub original_order_no: Option<String>,
    pub venue: Venue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TradingOpenOrders {
    pub account_ref: String,
    pub orders: Vec<TradingOpenOrder>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TradingOrderable {
    pub account_ref: String,
    pub code: String,
    pub side: OrderSide,
    #[ts(type = "number")]
    pub price: u64,
    #[ts(type = "number")]
    pub amount: u64,
    #[ts(type = "number")]
    pub quantity: u64,
    pub policy: MarginPolicy,
    #[ts(type = "number")]
    pub cash_amount: u64,
    #[ts(type = "number")]
    pub cash_quantity: u64,
    #[ts(type = "number | null")]
    pub margin_amount: Option<u64>,
    #[ts(type = "number | null")]
    pub margin_quantity: Option<u64>,
    #[ts(type = "number")]
    pub deposit: u64,
    #[ts(type = "number")]
    pub unpaid: u64,
    pub stock_rate: Option<f64>,
    pub account_rate: Option<f64>,
    pub applied_rate: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TradingExecution {
    pub order_no: String,
    pub code: String,
    pub name: String,
    pub side: OrderSide,
    #[ts(type = "number")]
    pub quantity: u64,
    #[ts(type = "number")]
    pub price: u64,
    pub time: String,
    pub venue: Venue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TradingExecutions {
    pub account_ref: String,
    pub day: KstDate,
    pub executions: Vec<TradingExecution>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DiagnosisTag {
    IcebergSupport,
    WhaleDivergence,
    SpoofChaseTrap,
    EarlyStopBeforeProgram,
    Neutral,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExecutionForensic {
    pub order_no: String,
    pub code: SymbolCode,
    pub name: String,
    pub side: OrderSide,
    pub time: String,
    pub fill_at: UnixSeconds,
    #[ts(type = "number")]
    pub price: u64,
    #[ts(type = "number")]
    pub quantity: u64,
    pub collected: bool,
    pub diagnosis: DiagnosisTag,
    pub mfe_pct: Option<f64>,
    pub mae_pct: Option<f64>,
    #[ts(type = "number | null")]
    pub slippage_ticks: Option<i64>,
    pub pre_entry_cancel_rate_pct: Option<f64>,
    pub program_delta_million_won: Option<f64>,
    pub whale_net_delta_million_won: Option<f64>,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExecutionForensics {
    pub date: String,
    pub account: Option<String>,
    pub items: Vec<ExecutionForensic>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum OrderCommandKind {
    Buy,
    Sell,
    Modify,
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum OrderCommandState {
    Prepared,
    Sending,
    Accepted,
    Rejected,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum OrderRejectReason {
    OrdersOff,
    NotConnected,
    AuthBlocked,
    AccountChanged,
    UnknownPending,
    InvalidOrder,
    UnknownSymbol,
    HighValueUnconfirmed,
    OverSingleOrderCap,
    OffTick,
    OutOfLimit,
    LimitsUnavailable,
    SellOverSellable,
    BuyOverBuyingPower,
    NxtUnavailable,
    MockKrxOnly,
    OrderNotFound,
    NotSent,
    KiwoomRejected,
    KiwoomUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OrderCommand {
    pub command_id: String,
    pub account_ref: String,
    pub kind: OrderCommandKind,
    pub code: Option<String>,
    pub venue: Option<Venue>,
    #[ts(type = "number | null")]
    pub quantity: Option<u64>,
    #[ts(type = "number | null")]
    pub price: Option<u64>,
    pub target_order_no: Option<String>,
    pub state: OrderCommandState,
    pub reason: Option<OrderRejectReason>,
    pub order_no: Option<String>,
    pub reconciled: bool,
    pub created_at: UnixSeconds,
    pub updated_at: UnixSeconds,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OrderPlaceInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<String>,
    pub command_id: String,
    pub code: String,
    pub side: OrderSide,
    #[ts(type = "number")]
    pub quantity: u64,
    #[ts(type = "number")]
    pub price: u64,
    pub venue: Option<Venue>,
    #[serde(default)]
    pub confirm_high_value: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OrderModifyInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<String>,
    pub command_id: String,
    pub order_no: String,
    #[ts(type = "number")]
    pub price: u64,
    #[serde(default)]
    pub confirm_high_value: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OrderCancelInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<String>,
    pub command_id: String,
    pub order_no: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OrderCancelBatchInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<String>,
    pub batch_id: String,
    pub code: String,
    pub side: OrderSide,
    #[ts(type = "number")]
    pub price: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OrderCommands {
    pub account_ref: String,
    pub blocked: bool,
    pub commands: Vec<OrderCommand>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OrderReconciliation {
    pub account_ref: String,
    #[ts(type = "number")]
    pub cleared: u64,
    pub open_orders: Vec<TradingOpenOrder>,
    pub executions: Vec<TradingExecution>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RankingMarket {
    All,
    Kospi,
    Kosdaq,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TradingSession {
    All,
    Regular,
    PreMarket,
    AfterHours,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SurgeBaseline {
    PreviousDay,
    Minutes1,
    Minutes5,
    Minutes10,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SurgeSort {
    SurgeVolume,
    SurgeRate,
    DropRate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MinTradeAmount {
    Any,
    AtLeast100Million,
    AtLeast1Billion,
    AtLeast10Billion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ExpectedSort {
    Gainers,
    Losers,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RankingInvestor {
    Foreign,
    ForeignFirm,
    FinancialInvestment,
    InvestmentTrust,
    OtherFinancial,
    Bank,
    Insurance,
    PensionFund,
    State,
    OtherCorporation,
    Institution,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum NetDirection {
    NetBuy,
    NetSell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TradeUnit {
    Amount,
    Quantity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BalanceSort {
    NetBuyRemaining,
    NetSellRemaining,
    BuyRatio,
    SellRatio,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ViewSpan {
    Seconds30,
    Minute1,
    Minutes10,
    Hour1,
    Today,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Excludes {
    pub etf_etn: bool,
    pub preferred: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum Ranking {
    TradeAmount { market: RankingMarket, venue: Venue, excludes: Excludes, exclude_managed: bool },
    TradeVolume { market: RankingMarket, venue: Venue, session: TradingSession, excludes: Excludes, exclude_managed: bool },
    Turnover { market: RankingMarket, venue: Venue, excludes: Excludes, exclude_managed: bool },
    VolumeSurge { market: RankingMarket, venue: Venue, baseline: SurgeBaseline, sort: SurgeSort, excludes: Excludes, exclude_managed: bool },
    Gainers { market: RankingMarket, venue: Venue, include_limit: bool, min_trade_amount: MinTradeAmount, excludes: Excludes, exclude_managed: bool },
    Losers { market: RankingMarket, venue: Venue, include_limit: bool, min_trade_amount: MinTradeAmount, excludes: Excludes, exclude_managed: bool },
    Expected { market: RankingMarket, venue: Venue, sort: ExpectedSort, excludes: Excludes, exclude_managed: bool },
    InvestorNetBuy { market: RankingMarket, investor: RankingInvestor, direction: NetDirection, unit: TradeUnit, excludes: Excludes },
    ForeignStreak { market: RankingMarket, venue: Venue, direction: NetDirection, excludes: Excludes },
    Program { market: Market, venue: Venue, direction: NetDirection, excludes: Excludes },
    BidAskBalance { market: Market, venue: Venue, sort: BalanceSort, excludes: Excludes, exclude_managed: bool },
    CreditRatio { market: RankingMarket, venue: Venue, excludes: Excludes, exclude_managed: bool },
    MostViewed { span: ViewSpan, excludes: Excludes },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RankingTrigger {
    User,
    Refresh,
}

pub const MAX_RANKING_PAGES: u8 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(try_from = "u8", into = "u8")]
#[ts(export, type = "number")]
pub struct RankingPages(u8);

impl TryFrom<u8> for RankingPages {
    type Error = &'static str;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        if (1..=MAX_RANKING_PAGES).contains(&value) {
            Ok(Self(value))
        } else {
            Err("순위 페이지 수는 1 이상 30 이하의 정수여야 합니다")
        }
    }
}

impl From<RankingPages> for u8 {
    fn from(value: RankingPages) -> u8 { value.0 }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Won(#[ts(type = "number")] pub i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Shares(#[ts(type = "number")] pub i64);

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Percent(pub f64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RankingRequest {
    pub ranking: Ranking,
    pub pages: RankingPages,
    pub trigger: RankingTrigger,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum RankingFigures {
    TradeAmount { trade_amount: Won, volume: Shares, places_gained: Option<i32> },
    TradeVolume { volume: Shares, previous_day_volume_rate: Option<Percent> },
    Turnover { turnover_rate: Percent, volume: Shares },
    VolumeSurge { surge_rate: Percent, surge_volume: Shares, volume: Shares },
    Movers { price_change: Won, volume: Shares },
    Expected { expected_price: Won, expected_change_rate: Percent, expected_volume: Shares },
    NetAmounts { net: Won, buy: Won, sell: Won },
    NetQuantities { net: Shares, buy: Shares, sell: Shares },
    ForeignStreak { net_d1: Shares, net_d2: Shares, net_d3: Shares, net_total: Shares, limit_exhaustion_rate: Percent },
    BidAskBalance { total_sell_remaining: Shares, total_buy_remaining: Shares, net_buy_remaining: Shares, buy_ratio: Percent },
    CreditRatio { credit_ratio: Percent, volume: Shares },
    MostViewed { reference_price: Won, change_from_reference_rate: Percent, places_gained: Option<i32> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RankingRow {
    pub rank: u32,
    pub code: SymbolCode,
    pub name: String,
    pub listed: bool,
    pub price: Option<Won>,
    pub change_rate: Option<Percent>,
    pub figures: RankingFigures,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RankingPage {
    pub rows: Vec<RankingRow>,
    pub pages: RankingPages,
    pub end: bool,
    pub limited: bool,
    pub hidden: u32,
    pub fetched_at: UnixSeconds,
    pub source: Broker,
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
    fn layout_chart_feed_json_round_trips_existing_flat_fields() {
        let stock = domain::StockCode::parse("005930").unwrap();
        let index = domain::IndexCode::parse("001").unwrap();
        for (symbol, venue, expected) in [
            ("005930", Some("combined"), domain::Feed::Stock(stock, domain::Venue::Combined)),
            ("005930", Some("krx"), domain::Feed::Stock(stock, domain::Venue::Krx)),
            ("005930", Some("nxt"), domain::Feed::Stock(stock, domain::Venue::Nxt)),
            ("IDX:001", None, domain::Feed::Index(index)),
        ] {
            let body = json!({"id": "chart", "link": "a", "kind": "chart", "symbol": symbol, "venue": venue, "period": "5m", "chartSettings": {"future": [1, 2]}});
            let window: LayoutWindow = serde_json::from_value(body.clone()).unwrap();
            assert_eq!(window.content, WindowContent::Chart { feed: ChartFeed(expected), period: Period::M5, chart_settings: json!({"future": [1, 2]}) });
            assert_eq!(serde_json::to_value(window).unwrap(), body);
        }
        let window: LayoutWindow = serde_json::from_value(json!({"id": "chart", "kind": "chart", "symbol": "IDX:001", "period": "D", "chartSettings": {}})).unwrap();
        assert_eq!(serde_json::to_value(window).unwrap()["venue"], serde_json::Value::Null);
    }

    #[test]
    fn link_colors_run_from_a_to_j_on_the_wire() {
        assert_eq!(serde_json::to_value(LinkColor::J).unwrap(), json!("j"));
        assert_eq!(serde_json::from_value::<LinkColor>(json!("j")).unwrap(), LinkColor::J);
        assert!(serde_json::from_value::<LinkColor>(json!("k")).is_err());
    }

    #[test]
    fn layout_chart_feed_json_rejects_invalid_symbol_venue_combinations() {
        for (symbol, venue) in [
            ("005930", None),
            ("005930", Some(serde_json::Value::Null)),
            ("IDX:001", Some(json!("combined"))),
            ("IDX:001", Some(json!("krx"))),
            ("IDX:001", Some(json!("nxt"))),
            ("bad", Some(json!("krx"))),
            ("IDX:bad", None),
            ("005930", Some(json!("unknown"))),
        ] {
            let mut body = json!({"id": "chart", "kind": "chart", "symbol": symbol, "period": "D", "chartSettings": {}});
            if let Some(venue) = venue {
                body["venue"] = venue;
            }
            assert!(serde_json::from_value::<LayoutWindow>(body.clone()).is_err(), "{body}");
        }
    }

    #[test]
    fn user_data_json_shape() {
        let body = json!({
            "id": "01900000-0000-7000-8000-000000000001", "name": "기본", "sync": {"scroll": false},
            "windows": [
                {"id": "cell-0", "link": "a", "kind": "chart", "symbol": "005930", "venue": "nxt", "period": "5m",
                 "chartSettings": {"v": 1, "future": [1, 2]}},
                {"id": "watchlist", "link": null, "kind": "watchlist"}
            ],
            "placement": {"v": 1, "dock": null},
            "revision": 1_794_152_040_123_i64
        });
        let layout: LayoutInput = serde_json::from_value(body.clone()).unwrap();
        assert_eq!(layout.sync, LayoutSync { crosshair: true, scroll: false, crosshair_scope: CrosshairScope::All });
        assert_eq!(layout.windows[0].link, Some(LinkColor::A));
        let WindowContent::Chart { feed, chart_settings, .. } = &layout.windows[0].content else { panic!("{:?}", layout.windows[0]) };
        assert_eq!(feed.0, domain::Feed::Stock(domain::StockCode::parse("005930").unwrap(), domain::Venue::Nxt));
        assert_eq!(*chart_settings, json!({"v": 1, "future": [1, 2]}));
        assert_eq!(layout.windows[1].content, WindowContent::Watchlist { list: None });
        assert_eq!(layout.revision, Revision(1_794_152_040_123), "Date.now() 크기의 ms도 정확히 받는다");
        let mut expected = body.clone();
        expected["sync"] = json!({"crosshair": true, "scroll": false, "crosshairScope": "all"});
        assert_eq!(serde_json::to_value(&layout).unwrap(), expected);
        for bad_id in ["", "a b", "창", &"x".repeat(65)] {
            let mut bad = body.clone();
            bad["windows"][1]["id"] = json!(bad_id);
            assert!(serde_json::from_value::<LayoutInput>(bad).is_err(), "{bad_id:?}");
        }
        let mut list = body.clone();
        list["placement"] = json!([]);
        assert!(serde_json::from_value::<LayoutInput>(list).is_err(), "배치는 객체여야 한다");

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
            venue: Some(Venue::Krx),
            traded_million_won: None,
        };
        assert_eq!(
            serde_json::to_value(&q).unwrap(),
            json!({"symbol": "005930", "price": 193_400.0, "change": -8_100.0, "changeRate": -4.02,
                   "volume": 56_147_847, "t": 1_794_131_999, "source": "polled", "venue": "krx"})
        );
    }

    #[test]
    fn websocket_message_json_shape() {
        let sub: ClientMessage = serde_json::from_value(json!({"type": "subscribe", "sub": "c0", "symbol": "005930", "venue": "krx", "period": "1m"})).unwrap();
        assert_eq!(sub, ClientMessage::Subscribe { sub: "c0".into(), symbol: SymbolCode("005930".into()), venue: Some(Venue::Krx), period: Period::M1 });
        let feed: ClientMessage = serde_json::from_value(json!({"type": "subscribe_feed", "sub": "f0", "symbol": "005930", "kind": "trades", "venue": "krx"})).unwrap();
        assert_eq!(feed, ClientMessage::SubscribeFeed { sub: "f0".into(), symbol: SymbolCode("005930".into()), kind: FeedKind::Trades, venue: Some(Venue::Krx) });
        let unsub: ClientMessage = serde_json::from_value(json!({"type": "unsubscribe", "sub": "c0"})).unwrap();
        assert_eq!(unsub, ClientMessage::Unsubscribe { sub: "c0".into() });
        let watch: ClientMessage = serde_json::from_value(json!({"type": "watch", "symbols": ["005930", "IDX:001"]})).unwrap();
        assert_eq!(watch, ClientMessage::Watch { symbols: vec![SymbolCode("005930".into()), SymbolCode("IDX:001".into())], venue: None });
        let krx_watch: ClientMessage = serde_json::from_value(json!({"type": "watch", "symbols": ["005930"], "venue": "krx"})).unwrap();
        assert_eq!(krx_watch, ClientMessage::Watch { symbols: vec![SymbolCode("005930".into())], venue: Some(Venue::Krx) });
        let null_watch: ClientMessage = serde_json::from_value(json!({"type": "watch", "symbols": [], "venue": null})).unwrap();
        assert_eq!(null_watch, ClientMessage::Watch { symbols: vec![], venue: None });

        let status = ConnectionStatus { realtime: RealtimeState::Reconnecting, since: UnixSeconds(1_794_182_400), backfilling: true };
        let bar = Bar { t: UnixSeconds(1_794_182_400), o: 1.0, h: 2.0, l: 1.0, c: 2.0, v: 3 };
        let cases = [
            (
                ServerMessage::Hello { protocol: 1, server_time: UnixSeconds(5), status },
                json!({"type": "hello", "protocol": 1, "serverTime": 5, "status": {"realtime": "reconnecting", "since": 1_794_182_400, "backfilling": true}}),
            ),
            (ServerMessage::Subscribed { sub: "c0".into(), seq: 7, current: None }, json!({"type": "subscribed", "sub": "c0", "seq": 7, "current": null})),
            (ServerMessage::SubError { sub: "c0".into(), code: SubErrorCode::RealtimeLimit }, json!({"type": "sub_error", "sub": "c0", "code": "realtime_limit"})),
            (ServerMessage::FeedSubscribed { sub: "f0".into(), kind: FeedKind::Brokers }, json!({"type": "feed_subscribed", "sub": "f0", "kind": "brokers"})),
            (
                ServerMessage::FeedTrades { sub: "f0".into(), seq: 3, trades: vec![FeedTrade { t: UnixSeconds(5), price: 71_100.0, qty: -7, venue: Some(Venue::Nxt), strength: None, same_time_ratio: None }] },
                json!({"type": "feed_trades", "sub": "f0", "seq": 3, "trades": [{"t": 5, "price": 71100.0, "qty": -7, "venue": "nxt", "strength": null}]}),
            ),
            (ServerMessage::FeedLink { sub: "f0".into(), live: false, at: UnixSeconds(9) }, json!({"type": "feed_link", "sub": "f0", "live": false, "at": 9})),
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
                    venue: Venue::Nxt,
                    quotes: vec![Quote {
                        symbol: SymbolCode("005930".into()),
                        price: 71_200.0,
                        change: 200.0,
                        change_rate: 0.5,
                        volume: 9,
                        t: UnixSeconds(4),
                        source: QuoteSource::Realtime,
                        venue: Some(Venue::Combined),
                        traded_million_won: None,
                    }],
                },
                json!({"type": "quotes", "venue": "nxt", "quotes": [{"symbol": "005930", "price": 71_200.0, "change": 200.0, "changeRate": 0.5, "volume": 9, "t": 4, "source": "realtime", "venue": "combined"}]}),
            ),
            (ServerMessage::WatchLimited { symbols: vec![SymbolCode("000660".into())] }, json!({"type": "watch_limited", "symbols": ["000660"]})),
            (ServerMessage::ViSnapshot { states: vec![] }, json!({"type": "vi_snapshot", "states": []})),
            (
                ServerMessage::ViUpdate {
                    state: ViState {
                        symbol: SymbolCode("005930".into()),
                        market: ViMarket::Krx,
                        active: true,
                        direction: Some(ViDirection::Up),
                        trigger_price: Some(881_000.0),
                        base: None,
                        triggered_at: Some(UnixSeconds(4)),
                        released_at: None,
                    },
                },
                json!({"type": "vi_update", "state": {"symbol": "005930", "market": "krx", "active": true, "direction": "up", "triggerPrice": 881_000.0, "base": null, "triggeredAt": 4, "releasedAt": null}}),
            ),
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
            rows: vec![ScreenerRow { symbol: SymbolCode("005930".into()), name: "삼성전자".into(), close: 193_400.0, change_rate: None, matched_date: day(2026, 11, 9), latest_bar_date: day(2026, 11, 10), provisional: true, traded_million_won: None, program_net_million_won: None, whale_net_million_won: None, vi_count: None }],
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
pub enum FinancialUpdatePhase { Planning, #[default] Recent, Changes, History, Complete }

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
    pub automatic: bool,
    pub latest_check_pending: bool,
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
