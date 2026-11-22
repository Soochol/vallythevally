mod support;

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use domain::{Feed, KstDate, KstTime, Market, Period, SeriesKey, StockCode, Symbol, SymbolInfo, SymbolKind, TimeOfDay, Venue};
use server::api::{FeedKind, ServerMessage, SubErrorCode, SymbolCode};
use server::bars::BarService;
use server::clock::Clock;
use server::config::Secret;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::{KIWOOM_REALTIME_LIMIT, KiwoomSeats};
use server::market::hub::{HubHandle, MarketHub};
use server::market::outbox::Outbox;
use server::market::{ConnId, SubId};
use server::market_source::stream::{DesiredFeeds, MarketStream, SeatRules, StreamEvent, StreamKind};
use server::symbols::{Directory, SymbolDirectory};
use support::ScriptedTransport;
use tokio::sync::{mpsc, watch};

const SEAT_LIMIT: usize = 3;

struct OneSeatPerKind;

impl SeatRules for OneSeatPerKind {
    fn limit(&self) -> usize {
        SEAT_LIMIT
    }

    fn takes_own_seat(&self, kind: StreamKind) -> bool {
        !matches!(kind, StreamKind::Trades | StreamKind::Index)
    }

    fn companion(&self, _: StreamKind) -> Option<StreamKind> {
        None
    }
}

struct FakeStream {
    desired: watch::Sender<DesiredFeeds>,
    history: Mutex<Vec<DesiredFeeds>>,
}

impl MarketStream for FakeStream {
    fn seat_rules(&self) -> Arc<dyn SeatRules> {
        Arc::new(OneSeatPerKind)
    }

    fn set_desired(&self, desired: DesiredFeeds) {
        self.history.lock().unwrap().push(desired.clone());
        self.desired.send_replace(desired);
    }

    fn watch_desired(&self) -> watch::Receiver<DesiredFeeds> {
        self.desired.subscribe()
    }
}

struct Harness {
    hub: HubHandle,
    stream: Arc<FakeStream>,
    clock: Clock,
    _events: mpsc::Sender<StreamEvent>,
}

fn stock(i: usize) -> Symbol {
    Symbol::parse(&format!("{:06}", 100_000 + i)).unwrap()
}

fn sub(name: &str) -> SubId {
    SubId(name.into())
}

fn start() -> KstTime {
    KstTime::from_kst_civil(KstDate::new(2026, 11, 9).unwrap(), TimeOfDay::hms(10, 0, 0).unwrap())
}

async fn harness() -> Harness {
    let clock = Clock::fake(start());
    let rest = KiwoomRest::new(ScriptedTransport::new().transport(), KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None), clock.clone());
    rest.set_access(Access::Closed);
    let symbols = Arc::new(SymbolDirectory::default());
    let listed = (0..8).map(|i| SymbolInfo { symbol: stock(i), name: format!("s{i}"), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled: false }).collect();
    symbols.replace(Directory::build(listed));
    let bars = Arc::new(BarService::new(rest, symbols, clock.clone()));
    let stream = Arc::new(FakeStream { desired: watch::channel(DesiredFeeds::new()).0, history: Mutex::new(Vec::new()) });
    let (events, receiver) = mpsc::channel(8);
    let hub = MarketHub::spawn(bars, stream.clone(), receiver, clock.clone());
    events.send(StreamEvent::Live { since: clock.now() }).await.unwrap();
    Harness { hub, stream, clock, _events: events }
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(1_100)).await;
}

async fn connect(h: &Harness) -> (ConnId, Arc<Outbox>) {
    let out = Outbox::new();
    let conn = h.hub.connect(out.clone());
    settle().await;
    out.take(true);
    (conn, out)
}

fn seats(h: &Harness) -> usize {
    OneSeatPerKind.seats(&h.stream.desired.borrow())
}

fn kinds(h: &Harness, symbol: Symbol) -> BTreeSet<StreamKind> {
    h.stream.desired.borrow().get(&symbol).cloned().unwrap_or_default()
}

fn chart(i: usize) -> SeriesKey {
    SeriesKey { feed: Feed::Stock(StockCode::parse(&format!("{:06}", 100_000 + i)).unwrap(), Venue::Combined), period: Period::M1 }
}

#[tokio::test(start_paused = true)]
async fn each_kind_of_one_symbol_takes_its_own_seat_and_the_fourth_seat_is_refused() {
    let h = harness().await;
    let (conn, out) = connect(&h).await;
    h.hub.subscribe_feed(conn, sub("trades"), stock(0), FeedKind::Trades, Venue::Combined);
    h.hub.subscribe_feed(conn, sub("book"), stock(0), FeedKind::Book, Venue::Combined);
    settle().await;
    assert_eq!(kinds(&h, stock(0)), BTreeSet::from([StreamKind::Trades, StreamKind::Book(Venue::Combined)]));
    assert_eq!(seats(&h), 2, "같은 종목의 체결과 호가는 두 자리다");
    h.hub.subscribe_feed(conn, sub("other"), stock(1), FeedKind::Trades, Venue::Combined);
    settle().await;
    assert_eq!(seats(&h), SEAT_LIMIT);
    out.take(true);
    h.hub.subscribe_feed(conn, sub("program"), stock(1), FeedKind::Program, Venue::Combined);
    settle().await;
    let messages = out.take(true).messages;
    assert!(messages.contains(&ServerMessage::SubError { sub: "program".into(), code: SubErrorCode::RealtimeLimit }), "{messages:?}");
    assert_eq!(seats(&h), SEAT_LIMIT, "넷째 자리는 받지 못했다");
    assert_eq!(kinds(&h, stock(1)), BTreeSet::from([StreamKind::Trades]));
}

#[tokio::test(start_paused = true)]
async fn a_chart_cell_takes_the_seat_of_the_lowest_watchlist_row_first() {
    let h = harness().await;
    let (watcher, watch_out) = connect(&h).await;
    let (viewer, _view_out) = connect(&h).await;
    h.hub.watch(watcher, vec![stock(0), stock(1), stock(2)], Venue::Combined);
    settle().await;
    assert_eq!(seats(&h), SEAT_LIMIT);
    watch_out.take(true);
    h.hub.subscribe(viewer, sub("cell"), chart(5));
    settle().await;
    let desired = h.stream.desired.borrow().clone();
    assert!(desired.contains_key(&stock(5)), "차트 칸이 자리를 받았다: {desired:?}");
    assert!(!desired.contains_key(&stock(2)) && desired.contains_key(&stock(0)) && desired.contains_key(&stock(1)), "관심종목 맨 아랫줄이 자리를 내놓았다: {desired:?}");
    assert_eq!(watch_out.take(true).messages, [ServerMessage::WatchLimited { symbols: vec![SymbolCode(stock(2).as_wire())] }]);
}

#[tokio::test(start_paused = true)]
async fn the_last_holder_of_a_kind_leaving_drops_it_only_after_the_thirty_second_grace() {
    let h = harness().await;
    let (conn, _out) = connect(&h).await;
    h.hub.subscribe_feed(conn, sub("trades"), stock(0), FeedKind::Trades, Venue::Combined);
    h.hub.subscribe_feed(conn, sub("book"), stock(0), FeedKind::Book, Venue::Combined);
    settle().await;
    assert_eq!(seats(&h), 2);
    let released = h.clock.now();
    h.hub.unsubscribe(conn, sub("book"));
    settle().await;
    let requests_before = h.stream.history.lock().unwrap().len();
    h.clock.sleep_until(released.plus_secs(27)).await;
    settle().await;
    assert!(kinds(&h, stock(0)).contains(&StreamKind::Book(Venue::Combined)), "유예 안에는 아직 받는다");
    assert!(h.stream.history.lock().unwrap().iter().skip(requests_before).all(|desired| desired.get(&stock(0)).is_some_and(|kinds| kinds.contains(&StreamKind::Book(Venue::Combined)))), "유예 안에는 해지 요청이 없다");
    h.clock.sleep_until(released.plus_secs(32)).await;
    settle().await;
    assert_eq!(kinds(&h, stock(0)), BTreeSet::from([StreamKind::Trades]), "30초가 지나 호가만 해지했다");
    assert_eq!(seats(&h), 1);
}

#[test]
fn kiwoom_counts_one_seat_per_registered_code_with_a_limit_of_two_hundred() {
    let samsung = Symbol::parse("005930").unwrap();
    let wanted = |kinds: &[StreamKind]| DesiredFeeds::from([(samsung, kinds.iter().copied().collect())]);
    assert_eq!(KiwoomSeats.limit(), KIWOOM_REALTIME_LIMIT);
    assert_eq!(KIWOOM_REALTIME_LIMIT, 200);
    assert_eq!(KiwoomSeats.seats(&wanted(&[StreamKind::Trades, StreamKind::Book(Venue::Combined), StreamKind::AfterHours])), 1);
    assert_eq!(KiwoomSeats.seats(&wanted(&[StreamKind::Trades, StreamKind::Book(Venue::Krx), StreamKind::AfterHours])), 2, "KRX 호가는 통합 코드와 거래소 코드 두 자리다");
    assert_eq!(KiwoomSeats.seats(&wanted(&[StreamKind::Trades, StreamKind::Book(Venue::Krx), StreamKind::Book(Venue::Nxt)])), 3);
}
