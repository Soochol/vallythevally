mod support;

use std::sync::Arc;
use std::time::Duration;

use domain::{KstDate, KstTime, Market, Price, Symbol, SymbolInfo, SymbolKind, TimeOfDay, Venue, Volume};
use server::api::{self, ServerMessage};
use server::bars::BarService;
use server::clock::Clock;
use server::config::Secret;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomSeats;
use server::market::hub::{HubHandle, MarketHub};
use server::market::outbox::Outbox;
use server::market::ConnId;
use server::market_source::stream::{DayTotals, DesiredFeeds, Exchange, ExpectedQuote, MarketStream, RealTick, SeatRules, StreamEvent};
use server::symbols::{Directory, SymbolDirectory};
use support::ScriptedTransport;
use tokio::sync::{mpsc, watch};

const ON_NXT: &str = "005930";
const KRX_ONLY: &str = "006360";

struct FakeStream {
    desired: watch::Sender<DesiredFeeds>,
}

impl MarketStream for FakeStream {
    fn seat_rules(&self) -> Arc<dyn SeatRules> {
        Arc::new(KiwoomSeats)
    }

    fn set_desired(&self, desired: DesiredFeeds) {
        self.desired.send_replace(desired);
    }

    fn watch_desired(&self) -> watch::Receiver<DesiredFeeds> {
        self.desired.subscribe()
    }
}

struct Harness {
    hub: HubHandle,
    events: mpsc::Sender<StreamEvent>,
    _stream: Arc<FakeStream>,
}

fn day() -> KstDate {
    KstDate::new(2026, 11, 24).unwrap()
}

fn at(hms: (u32, u32, u32)) -> KstTime {
    KstTime::from_kst_civil(day(), TimeOfDay::hms(hms.0, hms.1, hms.2).unwrap())
}

fn symbol(code: &str) -> Symbol {
    Symbol::parse(code).unwrap()
}

async fn harness(start: (u32, u32, u32)) -> Harness {
    let clock = Clock::fake(at(start));
    let rest = KiwoomRest::new(ScriptedTransport::new().transport(), KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None), clock.clone());
    rest.set_access(Access::Closed);
    let symbols = Arc::new(SymbolDirectory::default());
    let info = |code: &str, nxt_enabled| SymbolInfo { symbol: symbol(code), name: code.into(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled };
    symbols.replace(Directory::build(vec![info(ON_NXT, true), info(KRX_ONLY, false)]));
    let bars = Arc::new(BarService::new(rest, symbols, clock.clone()));
    let stream = Arc::new(FakeStream { desired: watch::channel(DesiredFeeds::new()).0 });
    let (events, receiver) = mpsc::channel(64);
    let hub = MarketHub::spawn(bars, stream.clone(), receiver, clock.clone());
    events.send(StreamEvent::Live { since: clock.now() }).await.unwrap();
    Harness { hub, events, _stream: stream }
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(1_100)).await;
}

async fn watching(h: &Harness, code: &str, venue: Venue) -> (ConnId, Arc<Outbox>) {
    let out = Outbox::new();
    let conn = h.hub.connect(out.clone());
    settle().await;
    h.hub.watch(conn, vec![symbol(code)], venue);
    settle().await;
    out.take(true);
    (conn, out)
}

async fn quotes(out: &Outbox) -> Vec<api::Quote> {
    settle().await;
    out.take(true).messages.into_iter().flat_map(|m| if let ServerMessage::Quotes { quotes, .. } = m { quotes } else { Vec::new() }).collect()
}

fn expected(code: &str, hms: (u32, u32, u32), price_won: u64, change_won: i64, qty: u64) -> StreamEvent {
    let quote = ExpectedQuote { symbol: symbol(code), hhmmss: TimeOfDay::hms(hms.0, hms.1, hms.2).unwrap(), price: Price::from_centi(price_won * 100).unwrap(), change_centi: change_won * 100, expected_qty: Volume(qty) };
    StreamEvent::Expected { quote, received_at: at(hms) }
}

fn fill(code: &str, hms: (u32, u32, u32), price_won: u64, exchange: Exchange, change_won: i64, cumulative: u64) -> StreamEvent {
    let tick = RealTick {
        symbol: symbol(code),
        hhmmss: TimeOfDay::hms(hms.0, hms.1, hms.2).unwrap(),
        price: Price::from_centi(price_won * 100).unwrap(),
        qty: Volume(1),
        exchange: Some(exchange),
        day: Some(DayTotals { change_centi: change_won * 100, cumulative: Volume(cumulative) }),
        strength_centi: None,
        side: None,
    };
    StreamEvent::Tick { tick, received_at: at(hms) }
}

fn sources(quotes: &[api::Quote]) -> Vec<(f64, api::QuoteSource)> {
    quotes.iter().map(|q| (q.price, q.source)).collect()
}

#[tokio::test(start_paused = true)]
async fn opening_auction_expected_moves_the_combined_row_of_a_krx_only_stock() {
    let h = harness((8, 55, 0)).await;
    let (_, out) = watching(&h, KRX_ONLY, Venue::Combined).await;
    h.events.send(expected(KRX_ONLY, (8, 55, 0), 640_000, 99_000, 577)).await.unwrap();
    let got = quotes(&out).await;
    assert_eq!(got.len(), 1, "{got:?}");
    let q = &got[0];
    assert_eq!((q.symbol.0.as_str(), q.price, q.change, q.source, q.venue), (KRX_ONLY, 640_000.0, 99_000.0, api::QuoteSource::Expected, Some(api::Venue::Combined)));
    assert!((q.change_rate - 99_000.0 / 541_000.0 * 100.0).abs() < 1e-9, "{}", q.change_rate);
    assert_eq!(q.t, api::UnixSeconds(at((8, 55, 0)).unix()));
}

#[tokio::test(start_paused = true)]
async fn expected_between_0850_and_0900_moves_only_krx_and_combined_rows_of_an_nxt_stock() {
    let h = harness((8, 55, 0)).await;
    let (_, combined) = watching(&h, ON_NXT, Venue::Combined).await;
    let (_, krx) = watching(&h, ON_NXT, Venue::Krx).await;
    let (_, nxt) = watching(&h, ON_NXT, Venue::Nxt).await;
    h.events.send(expected(ON_NXT, (8, 55, 0), 194_900, 17_400, 355_581)).await.unwrap();
    assert_eq!(sources(&quotes(&combined).await), vec![(194_900.0, api::QuoteSource::Expected)]);
    assert_eq!(sources(&quotes(&krx).await), vec![(194_900.0, api::QuoteSource::Expected)]);
    assert_eq!(sources(&quotes(&nxt).await), vec![], "NXT는 08:50~09:00에 닫혀 있다");
}

#[tokio::test(start_paused = true)]
async fn krx_vi_expected_moves_only_the_krx_row_while_nxt_trades_and_combined_follows_nxt_fills() {
    let h = harness((13, 3, 0)).await;
    let (_, combined) = watching(&h, ON_NXT, Venue::Combined).await;
    let (_, krx) = watching(&h, ON_NXT, Venue::Krx).await;
    h.events.send(fill(ON_NXT, (13, 3, 5), 23_550, Exchange::Krx, 1_050, 1_000)).await.unwrap();
    h.events.send(fill(ON_NXT, (13, 3, 9), 22_450, Exchange::Nxt, -50, 1_001)).await.unwrap();
    quotes(&combined).await;
    quotes(&krx).await;
    h.events.send(expected(ON_NXT, (13, 3, 10), 22_600, 100, 7)).await.unwrap();
    assert_eq!(sources(&quotes(&krx).await), vec![(22_600.0, api::QuoteSource::Expected)], "마지막 체결이 더 오래된 KRX가 단일가 중이다");
    assert_eq!(sources(&quotes(&combined).await), vec![], "NXT가 체결 중이면 통합 줄은 예상가로 바꾸지 않는다");
    h.events.send(fill(ON_NXT, (13, 3, 11), 22_800, Exchange::Nxt, 300, 1_002)).await.unwrap();
    assert_eq!(sources(&quotes(&combined).await), vec![(22_800.0, api::QuoteSource::Realtime)]);
}

#[tokio::test(start_paused = true)]
async fn nxt_single_price_expected_at_0800_moves_nxt_and_combined_rows_but_not_krx() {
    let h = harness((8, 0, 5)).await;
    let (_, combined) = watching(&h, ON_NXT, Venue::Combined).await;
    let (_, krx) = watching(&h, ON_NXT, Venue::Krx).await;
    let (_, nxt) = watching(&h, ON_NXT, Venue::Nxt).await;
    h.events.send(expected(ON_NXT, (8, 0, 5), 194_000, 16_500, 1_420)).await.unwrap();
    assert_eq!(sources(&quotes(&combined).await), vec![(194_000.0, api::QuoteSource::Expected)]);
    assert_eq!(sources(&quotes(&nxt).await), vec![(194_000.0, api::QuoteSource::Expected)]);
    assert_eq!(sources(&quotes(&krx).await), vec![], "KRX는 08:00~08:50에 단일가가 없다");
}

#[tokio::test(start_paused = true)]
async fn an_expected_row_returns_to_the_fill_on_the_next_trade() {
    let h = harness((8, 59, 59)).await;
    let (_, out) = watching(&h, KRX_ONLY, Venue::Combined).await;
    h.events.send(expected(KRX_ONLY, (8, 59, 59), 640_000, 99_000, 577)).await.unwrap();
    assert_eq!(sources(&quotes(&out).await), vec![(640_000.0, api::QuoteSource::Expected)]);
    h.events.send(fill(KRX_ONLY, (9, 0, 0), 641_000, Exchange::Krx, 100_000, 1_900)).await.unwrap();
    assert_eq!(sources(&quotes(&out).await), vec![(641_000.0, api::QuoteSource::Realtime)]);
}
