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

async fn after_the_krx_close_fill_nxt_expected_moves_nxt_and_combined_rows_and_keeps_the_krx_close() {
    let h = harness((15, 29, 50)).await;
    let (_, combined) = watching(&h, ON_NXT, Venue::Combined).await;
    let (_, krx) = watching(&h, ON_NXT, Venue::Krx).await;
    let (_, nxt) = watching(&h, ON_NXT, Venue::Nxt).await;
    h.events.send(fill(ON_NXT, (15, 30, 2), 194_000, Exchange::Krx, 16_500, 1_000)).await.unwrap();
    quotes(&combined).await;
    quotes(&krx).await;
    quotes(&nxt).await;
    h.events.send(expected(ON_NXT, (15, 30, 10), 194_500, 17_000, 30)).await.unwrap();
    assert_eq!(sources(&quotes(&combined).await), vec![(194_500.0, api::QuoteSource::Expected)]);
    assert_eq!(sources(&quotes(&nxt).await), vec![(194_500.0, api::QuoteSource::Expected)]);
    assert_eq!(sources(&quotes(&krx).await), vec![], "KRX 줄은 종가를 유지한다");
}

async fn rows_first_watched_after_the_close_follow_their_venue_without_any_fill_record() {
    let h = harness((15, 33, 0)).await;
    let (_, combined) = watching(&h, ON_NXT, Venue::Combined).await;
    let (_, krx) = watching(&h, ON_NXT, Venue::Krx).await;
    let (_, nxt) = watching(&h, ON_NXT, Venue::Nxt).await;
    h.events.send(expected(ON_NXT, (15, 33, 4), 194_500, 17_000, 30)).await.unwrap();
    assert_eq!(sources(&quotes(&combined).await), vec![(194_500.0, api::QuoteSource::Expected)]);
    assert_eq!(sources(&quotes(&nxt).await), vec![(194_500.0, api::QuoteSource::Expected)]);
    assert_eq!(sources(&quotes(&krx).await), vec![], "체결 기록이 없어도 KRX 줄은 종가를 유지한다");
}

async fn the_krx_closing_tail_after_1530_does_not_move_the_nxt_row() {
    let h = harness((15, 29, 50)).await;
    h.events.send(fill(ON_NXT, (15, 19, 59), 193_000, Exchange::Krx, 15_500, 1_000)).await.unwrap();
    settle().await;
    let (_, combined) = watching(&h, ON_NXT, Venue::Combined).await;
    let (_, krx) = watching(&h, ON_NXT, Venue::Krx).await;
    let (_, nxt) = watching(&h, ON_NXT, Venue::Nxt).await;
    h.events.send(expected(ON_NXT, (15, 30, 1), 194_000, 16_500, 900)).await.unwrap();
    assert_eq!(sources(&quotes(&combined).await), vec![(194_000.0, api::QuoteSource::Expected)]);
    assert_eq!(sources(&quotes(&nxt).await), vec![], "KRX 종가 체결 전 첫 1분의 0H는 NXT 값이 아니다");
    assert_eq!(sources(&quotes(&krx).await), vec![], "15:30부터 NXT 종목의 KRX 줄은 0H로 바꾸지 않는다");
}

async fn the_krx_closing_tail_after_1530_still_moves_a_krx_only_row() {
    let h = harness((15, 29, 50)).await;
    let (_, out) = watching(&h, KRX_ONLY, Venue::Krx).await;
    h.events.send(expected(KRX_ONLY, (15, 30, 1), 640_000, 99_000, 577)).await.unwrap();
    assert_eq!(sources(&quotes(&out).await), vec![(640_000.0, api::QuoteSource::Expected)]);
}

#[tokio::test(start_paused = true)]
async fn rows_follow_their_venue_from_1530_to_1540() {
    after_the_krx_close_fill_nxt_expected_moves_nxt_and_combined_rows_and_keeps_the_krx_close().await;
    rows_first_watched_after_the_close_follow_their_venue_without_any_fill_record().await;
    the_krx_closing_tail_after_1530_does_not_move_the_nxt_row().await;
    the_krx_closing_tail_after_1530_still_moves_a_krx_only_row().await;
}
