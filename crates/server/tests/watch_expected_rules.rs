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
use server::quotes::{OpenExchanges, expected_exchange, expected_moves_row, open_exchanges};
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
    fill_on(day(), code, hms, price_won, exchange, change_won, cumulative)
}

fn fill_on(date: KstDate, code: &str, hms: (u32, u32, u32), price_won: u64, exchange: Exchange, change_won: i64, cumulative: u64) -> StreamEvent {
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
    StreamEvent::Tick { tick, received_at: KstTime::from_kst_civil(date, TimeOfDay::hms(hms.0, hms.1, hms.2).unwrap()) }
}

fn sources(quotes: &[api::Quote]) -> Vec<(f64, api::QuoteSource)> {
    quotes.iter().map(|q| (q.price, q.source)).collect()
}

fn time(hms: (u32, u32, u32)) -> KstTime {
    at(hms)
}

#[test]
fn both_open_expected_is_krx_unless_both_exchanges_filled_today_and_nxt_is_older() {
    let now = TimeOfDay::hms(13, 3, 10).unwrap();
    let decide = |krx: Option<(u32, u32, u32)>, nxt: Option<(u32, u32, u32)>| expected_exchange(true, now, krx.map(time), nxt.map(time));
    assert_eq!(decide(Some((13, 3, 5)), None), Exchange::Krx);
    assert_eq!(decide(None, Some((13, 3, 9))), Exchange::Krx);
    assert_eq!(decide(None, None), Exchange::Krx);
    assert_eq!(decide(Some((13, 3, 5)), Some((13, 3, 5))), Exchange::Krx);
    assert_eq!(decide(Some((13, 3, 9)), Some((13, 3, 5))), Exchange::Nxt);
}

#[test]
fn single_price_windows_switch_exactly_at_their_boundaries() {
    let open = |h, m, s| open_exchanges(TimeOfDay::hms(h, m, s).unwrap());
    assert_eq!(
        [open(7, 59, 59), open(8, 0, 0), open(8, 49, 59), open(8, 50, 0), open(9, 0, 29), open(9, 0, 30), open(15, 19, 59), open(15, 20, 0), open(15, 29, 59), open(15, 30, 0), open(15, 39, 59), open(15, 40, 0)],
        [
            OpenExchanges::Both,
            OpenExchanges::NxtOnly,
            OpenExchanges::NxtOnly,
            OpenExchanges::KrxOnly,
            OpenExchanges::KrxOnly,
            OpenExchanges::Both,
            OpenExchanges::Both,
            OpenExchanges::KrxOnly,
            OpenExchanges::KrxOnly,
            OpenExchanges::NxtOnly,
            OpenExchanges::NxtOnly,
            OpenExchanges::Both,
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn fills_before_the_row_is_watched_still_decide_the_exchange_of_an_intraday_expected() {
    let h = harness((13, 3, 0)).await;
    h.events.send(fill(ON_NXT, (13, 0, 0), 22_450, Exchange::Nxt, -50, 1_000)).await.unwrap();
    h.events.send(fill(ON_NXT, (13, 2, 59), 23_550, Exchange::Krx, 1_050, 1_001)).await.unwrap();
    settle().await;
    let (_, nxt) = watching(&h, ON_NXT, Venue::Nxt).await;
    h.events.send(expected(ON_NXT, (13, 3, 0), 22_600, 100, 7)).await.unwrap();
    assert_eq!(sources(&quotes(&nxt).await), vec![(22_600.0, api::QuoteSource::Expected)]);
}

#[tokio::test(start_paused = true)]
async fn an_expected_row_does_not_carry_yesterdays_volume() {
    let h = harness((8, 55, 0)).await;
    let (_, out) = watching(&h, KRX_ONLY, Venue::Combined).await;
    let yesterday = KstDate::new(2026, 11, 23).unwrap();
    h.events.send(fill_on(yesterday, KRX_ONLY, (15, 0, 0), 541_000, Exchange::Krx, 1_000, 5_000)).await.unwrap();
    assert_eq!(sources(&quotes(&out).await), vec![(541_000.0, api::QuoteSource::Realtime)]);
    h.events.send(expected(KRX_ONLY, (8, 55, 0), 640_000, 99_000, 577)).await.unwrap();
    let got = quotes(&out).await;
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!((got[0].source, got[0].volume), (api::QuoteSource::Expected, 0));
}

#[test]
fn after_close_tail_window_splits_at_1531_and_uses_krx_close_fill() {
    let tod = |h, m, s| TimeOfDay::hms(h, m, s).unwrap();
    assert_eq!(expected_exchange(true, tod(15, 30, 0), None, None), Exchange::Krx);
    assert_eq!(expected_exchange(true, tod(15, 30, 59), None, None), Exchange::Krx);
    assert_eq!(expected_exchange(true, tod(15, 30, 59), Some(time((15, 29, 59))), None), Exchange::Krx);
    assert_eq!(expected_exchange(true, tod(15, 30, 59), Some(time((15, 30, 0))), None), Exchange::Nxt);
    assert_eq!(expected_exchange(true, tod(15, 31, 0), None, None), Exchange::Nxt);
    assert_eq!(expected_exchange(true, tod(15, 31, 0), Some(time((15, 19, 59))), None), Exchange::Nxt);
    assert_eq!(expected_exchange(true, tod(15, 39, 59), None, None), Exchange::Nxt);
    assert_eq!(expected_exchange(false, tod(15, 30, 59), None, None), Exchange::Krx);
    assert_eq!(expected_exchange(false, tod(15, 30, 59), Some(time((15, 30, 0))), None), Exchange::Krx);
    assert_eq!(expected_exchange(false, tod(15, 31, 0), None, None), Exchange::Krx);
}

#[test]
fn expected_moves_row_keeps_krx_unchanged_for_nxt_stocks_only_from_1530_to_1540() {
    let tod = |h, m, s| TimeOfDay::hms(h, m, s).unwrap();
    let moves = |nxt_enabled, from, h, m, s| {
        let at = tod(h, m, s);
        (expected_moves_row(Venue::Krx, from, nxt_enabled, at), expected_moves_row(Venue::Nxt, from, nxt_enabled, at), expected_moves_row(Venue::Combined, from, nxt_enabled, at))
    };
    assert_eq!(moves(true, Exchange::Krx, 15, 29, 59), (true, false, true));
    assert_eq!(moves(true, Exchange::Krx, 15, 30, 0), (false, false, true));
    assert_eq!(moves(true, Exchange::Krx, 15, 30, 59), (false, false, true));
    assert_eq!(moves(true, Exchange::Nxt, 15, 30, 59), (false, true, true));
    assert_eq!(moves(true, Exchange::Nxt, 15, 31, 0), (false, true, true));
    assert_eq!(moves(true, Exchange::Nxt, 15, 39, 59), (false, true, true));
    assert_eq!(moves(true, Exchange::Krx, 15, 40, 0), (true, false, false));
    assert_eq!(moves(false, Exchange::Krx, 15, 30, 0), (true, false, true));
    assert_eq!(moves(false, Exchange::Krx, 15, 39, 59), (true, false, true));
}
