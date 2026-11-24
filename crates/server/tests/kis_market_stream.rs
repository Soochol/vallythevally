mod support;

use std::collections::{BTreeSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use domain::{IndexCode, KstDate, KstTime, Market, Symbol, SymbolInfo, SymbolKind, TimeOfDay, Venue, Volume};
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use futures::future::BoxFuture;
use futures::{Sink, Stream, StreamExt};
use serde_json::Value;
use server::api::{FeedKind, ServerMessage, SubErrorCode};
use server::bars::BarService;
use server::clock::{Clock, kst};
use server::config::{KisCredentials, Secret};
use server::kis::auth::KisAuth;
use server::kis::market_stream::{KisMarketStream, KisSeats};
use server::kis::notice::KisNotices;
use server::kiwoom::link::LinkState;
use server::kis::stream::{Connector, Socket, StreamStatus};
use server::market_source::active::ActiveStream;
use server::kis::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::market::hub::{HubHandle, MarketHub};
use server::market::outbox::Outbox;
use server::market::subscriptions::{Holder, SubscriptionManager};
use server::market::{ConnId, SubId};
use server::market_source::stream::{DesiredFeeds, Exchange, MarketStream, SeatRules, StreamEvent, StreamKind, TradeSide};
use server::symbols::{Directory, SymbolDirectory};
use support::ScriptedTransport;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

const WAIT: Duration = Duration::from_secs(120);
const LIMIT: usize = 40;

fn fixture(name: &str) -> String {
    std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/kis").join(name)).unwrap().trim().to_owned()
}

fn now() -> KstTime {
    kst(KstDate::new(2026, 11, 22).unwrap(), 9, 30, 0)
}

struct TokenAndApproval {
    approvals: Mutex<usize>,
}

impl Transport for TokenAndApproval {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let body = if req.path == "/oauth2/Approval" {
            *self.approvals.lock().unwrap() += 1;
            fixture("approval.json")
        } else {
            fixture("token.json")
        };
        Box::pin(async move { Ok(HttpResponse { status: 200, tr_cont: None, body }) })
    }
}

struct ChannelSocket {
    incoming: UnboundedReceiver<Result<Message, WsError>>,
    outgoing: UnboundedSender<Message>,
}

impl Stream for ChannelSocket {
    type Item = Result<Message, WsError>;

    fn poll_next(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Option<Self::Item>> {
        std::pin::Pin::new(&mut self.incoming).poll_next(cx)
    }
}

impl Sink<Message> for ChannelSocket {
    type Error = WsError;

    fn poll_ready(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn start_send(self: std::pin::Pin<&mut Self>, message: Message) -> Result<(), Self::Error> {
        self.outgoing.unbounded_send(message).map_err(|_| WsError::ConnectionClosed)
    }

    fn poll_flush(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn poll_close(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
        self.outgoing.close_channel();
        std::task::Poll::Ready(Ok(()))
    }
}

struct Peer {
    to_client: Option<UnboundedSender<Result<Message, WsError>>>,
    from_client: UnboundedReceiver<Message>,
}

impl Peer {
    fn say(&self, text: &str) {
        self.to_client.as_ref().unwrap().unbounded_send(Ok(Message::Text(text.into()))).unwrap();
    }

    fn hang_up(&mut self) {
        self.to_client = None;
    }

    async fn heard(&mut self) -> Value {
        let message = tokio::time::timeout(WAIT, self.from_client.next()).await.expect("클라이언트가 보내지 않았다").expect("연결이 닫혔다");
        let Message::Text(text) = message else { panic!("글이 아니다: {message:?}") };
        serde_json::from_str(text.as_str()).unwrap()
    }

    fn heard_so_far(&mut self) -> Vec<Control> {
        let mut heard = Vec::new();
        while let Ok(Message::Text(text)) = self.from_client.try_recv() {
            heard.push(Control::of(&serde_json::from_str(text.as_str()).unwrap()));
        }
        heard
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Control {
    registers: bool,
    tr_id: String,
    tr_key: String,
}

impl Control {
    fn of(value: &Value) -> Control {
        let input = &value["body"]["input"];
        Control { registers: value["header"]["tr_type"] == "1", tr_id: input["tr_id"].as_str().unwrap().to_owned(), tr_key: input["tr_key"].as_str().unwrap().to_owned() }
    }

    fn register(tr_id: &str, tr_key: &str) -> Control {
        Control { registers: true, tr_id: tr_id.into(), tr_key: tr_key.into() }
    }

    fn unregister(tr_id: &str, tr_key: &str) -> Control {
        Control { registers: false, tr_id: tr_id.into(), tr_key: tr_key.into() }
    }
}

#[derive(Clone, Default)]
struct ScriptedConnector {
    sockets: Arc<Mutex<VecDeque<Socket>>>,
    attempts: Arc<Mutex<usize>>,
}

impl ScriptedConnector {
    fn queue_connection(&self) -> Peer {
        let (to_client, incoming) = unbounded();
        let (outgoing, from_client) = unbounded();
        self.sockets.lock().unwrap().push_back(Box::new(ChannelSocket { incoming, outgoing }));
        Peer { to_client: Some(to_client), from_client }
    }

    fn attempts(&self) -> usize {
        *self.attempts.lock().unwrap()
    }
}

impl Connector for ScriptedConnector {
    fn connect(&self) -> BoxFuture<'_, Result<Socket, WsError>> {
        *self.attempts.lock().unwrap() += 1;
        let next = self.sockets.lock().unwrap().pop_front();
        Box::pin(async move { next.ok_or(WsError::ConnectionClosed) })
    }
}

struct Rig {
    stream: Arc<KisMarketStream>,
    events: mpsc::Receiver<StreamEvent>,
    connector: ScriptedConnector,
    transport: Arc<TokenAndApproval>,
    symbols: Arc<SymbolDirectory>,
    clock: Clock,
    _dir: tempfile::TempDir,
}

fn nxt_listing(listed: &[(Symbol, bool)]) -> Directory {
    Directory::build(listed.iter().map(|(symbol, nxt_enabled)| SymbolInfo { symbol: *symbol, name: symbol.as_wire(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled: *nxt_enabled }).collect())
}

fn rig() -> Rig {
    rig_with(None).0
}

fn rig_with(hts_id: Option<&str>) -> (Rig, Option<KisNotices>) {
    rig_with_notices(hts_id, true)
}

fn rig_with_notices(hts_id: Option<&str>, wanted: bool) -> (Rig, Option<KisNotices>) {
    let dir = tempfile::tempdir().unwrap();
    let token_path: PathBuf = dir.path().join("state/vallythevally/kis-token.json");
    let transport = Arc::new(TokenAndApproval { approvals: Mutex::new(0) });
    let clock = Clock::fake(now());
    let credentials = KisCredentials { app_key: Secret::new("FAKE-KIS-APPKEY-stream".into()), app_secret: Secret::new("FAKE-KIS-SECRET-stream".into()) };
    let auth = KisAuth::new(credentials, token_path, transport.clone(), clock.clone());
    let connector = ScriptedConnector::default();
    let symbols = Arc::new(SymbolDirectory::default());
    let notices = hts_id.map(|hts_id| {
        let notices = KisNotices::new(None, auth.clone(), tokio::sync::watch::channel(LinkState::Disconnected).1);
        if wanted {
            notices.want(Some(Secret::new(hts_id.to_owned())));
        }
        notices
    });
    let (stream, events) = KisMarketStream::spawn(Box::new(connector.clone()), auth, clock.clone(), symbols.updates(), 0, notices.clone());
    (Rig { stream: Arc::new(stream), events, connector, transport, symbols, clock, _dir: dir }, notices)
}

async fn next_event(events: &mut mpsc::Receiver<StreamEvent>) -> StreamEvent {
    tokio::time::timeout(WAIT, events.recv()).await.expect("이벤트가 오지 않았다").expect("세션이 끝났다")
}

async fn next_data_event(events: &mut mpsc::Receiver<StreamEvent>) -> StreamEvent {
    loop {
        match next_event(events).await {
            StreamEvent::Live { .. } => {}
            event => return event,
        }
    }
}

fn stock(code: &str) -> Symbol {
    Symbol::parse(code).unwrap()
}

fn feeds(spec: &[(Symbol, &[StreamKind])]) -> DesiredFeeds {
    spec.iter().map(|(symbol, kinds)| (*symbol, kinds.iter().copied().collect::<BTreeSet<_>>())).collect()
}

fn frame(tr_id: &str, width: usize, fields: &[(usize, &str)]) -> String {
    let mut all = vec![String::new(); width];
    for (index, value) in fields {
        all[*index] = (*value).to_owned();
    }
    format!("0|{tr_id}|001|{}", all.join("^"))
}

async fn settled(peer: &mut Peer) -> Vec<Control> {
    tokio::time::sleep(Duration::from_millis(50)).await;
    peer.heard_so_far()
}

#[tokio::test(start_paused = true)]
async fn a_chart_cell_and_a_book_window_on_the_combined_venue_register_two_unified_trs_and_take_two_seats() {
    let mut rig = rig();
    let mut peer = rig.connector.queue_connection();
    let samsung = stock("005930");
    let desired = feeds(&[(samsung, &[StreamKind::Trades, StreamKind::Book(Venue::Combined)])]);
    rig.stream.set_desired(desired.clone());
    let registered = [peer.heard().await, peer.heard().await].iter().map(Control::of).collect::<BTreeSet<_>>();
    assert_eq!(registered, BTreeSet::from([Control::register("H0UNASP0", "005930"), Control::register("H0UNCNT0", "005930")]));
    assert_eq!(rig.stream.seat_rules().seats(&desired), 2);
    assert!(matches!(next_event(&mut rig.events).await, StreamEvent::Live { .. }));
}

#[tokio::test(start_paused = true)]
async fn the_manager_counts_trades_and_book_of_one_symbol_as_two_seats_and_refuses_the_one_past_the_limit_without_dropping_earlier_ones() {
    let rules: Arc<dyn SeatRules> = Arc::new(KisSeats::new(0));
    let mut manager = SubscriptionManager::new(rules.clone());
    let symbols: Vec<Symbol> = (0..21).map(|i| stock(&format!("{:06}", 100_000 + i))).collect();
    let cell = |i: usize| Holder::Cell { conn: ConnId(1), sub: SubId(format!("cell{i}")) };
    let book = |i: usize| Holder::Feed { conn: ConnId(1), sub: SubId(format!("book{i}")), kind: StreamKind::Book(Venue::Combined) };
    for (i, symbol) in symbols.iter().take(20).enumerate() {
        manager.hold(*symbol, cell(i));
        manager.hold(*symbol, book(i));
    }
    let plan = manager.plan(now());
    assert_eq!(rules.seats(&plan.feeds), LIMIT, "체결과 호가를 받는 종목 스무 개는 마흔 자리다");
    assert!(plan.rejected.is_empty());
    manager.hold(symbols[20], cell(20));
    let plan = manager.plan(now());
    assert!(plan.rejected.contains(&cell(20)), "마흔 한 번째 자리는 받지 못한다");
    assert_eq!(plan.realtime.len(), 20, "앞선 스무 종목은 그대로다");
    assert!(symbols.iter().take(20).all(|s| plan.feeds[s].contains(&StreamKind::Book(Venue::Combined))));
    assert_eq!(rules.seats(&plan.feeds), LIMIT);
}

struct HubRig {
    hub: HubHandle,
    rig: Rig,
    peer: Peer,
}

fn listed(n: usize) -> Vec<Symbol> {
    (0..n).map(|i| stock(&format!("{:06}", 100_000 + i))).collect()
}

async fn hub_rig(count: usize) -> HubRig {
    hub_rig_on(rig(), count)
}

fn hub_rig_on(mut rig: Rig, count: usize) -> HubRig {
    let peer = rig.connector.queue_connection();
    rig.symbols.replace(nxt_listing(&listed(count).into_iter().map(|s| (s, true)).collect::<Vec<_>>()));
    let kiwoom = KiwoomRest::new(ScriptedTransport::new().transport(), KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None), rig.clock.clone());
    kiwoom.set_access(Access::Closed);
    let bars = Arc::new(BarService::new(kiwoom, rig.symbols.clone(), rig.clock.clone()));
    let (stub_events, replaced) = mpsc::channel(1);
    drop(stub_events);
    let events = std::mem::replace(&mut rig.events, replaced);
    let hub = MarketHub::spawn(bars, rig.stream.clone(), events, rig.clock.clone());
    HubRig { hub, rig, peer }
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(1_100)).await;
}

async fn connect(h: &HubRig) -> (ConnId, Arc<Outbox>) {
    let out = Outbox::new();
    let conn = h.hub.connect(out.clone());
    settle().await;
    out.take(true);
    (conn, out)
}

fn sub(name: &str) -> SubId {
    SubId(name.into())
}

#[tokio::test(start_paused = true)]
async fn the_forty_first_seat_gets_realtime_limit_and_no_registration_goes_out() {
    let mut h = hub_rig(45).await;
    let (conn, out) = connect(&h).await;
    let symbols = listed(45);
    for (i, symbol) in symbols.iter().take(LIMIT).enumerate() {
        h.hub.subscribe_feed(conn, sub(&format!("t{i}")), *symbol, FeedKind::Trades, Venue::Combined);
    }
    settle().await;
    let registered = settled(&mut h.peer).await;
    assert_eq!(registered.len(), LIMIT);
    assert!(registered.iter().all(|c| c.registers && c.tr_id == "H0UNCNT0"));
    out.take(true);

    h.hub.subscribe_feed(conn, sub("over"), symbols[LIMIT], FeedKind::Trades, Venue::Combined);
    settle().await;
    let messages = out.take(true).messages;
    assert!(messages.contains(&ServerMessage::SubError { sub: "over".into(), code: SubErrorCode::RealtimeLimit }), "{messages:?}");
    assert!(settled(&mut h.peer).await.is_empty(), "등록도 해지도 나가지 않는다");

    h.hub.subscribe_feed(conn, sub("book"), symbols[0], FeedKind::Book, Venue::Combined);
    settle().await;
    let messages = out.take(true).messages;
    assert!(messages.contains(&ServerMessage::SubError { sub: "book".into(), code: SubErrorCode::RealtimeLimit }), "{messages:?}");
    assert!(settled(&mut h.peer).await.is_empty(), "종목의 호가 자리도 한도를 넘으면 등록하지 않는다");
}

#[tokio::test(start_paused = true)]
async fn trades_and_book_of_twenty_symbols_fill_forty_seats_and_a_twenty_first_symbol_is_refused() {
    let mut h = hub_rig(25).await;
    let (conn, out) = connect(&h).await;
    let symbols = listed(25);
    for (i, symbol) in symbols.iter().take(20).enumerate() {
        h.hub.subscribe_feed(conn, sub(&format!("t{i}")), *symbol, FeedKind::Trades, Venue::Combined);
        h.hub.subscribe_feed(conn, sub(&format!("b{i}")), *symbol, FeedKind::Book, Venue::Combined);
    }
    settle().await;
    let registered = settled(&mut h.peer).await;
    assert_eq!(registered.len(), LIMIT, "{registered:?}");
    assert_eq!(registered.iter().filter(|c| c.tr_id == "H0UNASP0").count(), 20);
    out.take(true);
    h.hub.subscribe_feed(conn, sub("t20"), symbols[20], FeedKind::Trades, Venue::Combined);
    settle().await;
    assert!(out.take(true).messages.contains(&ServerMessage::SubError { sub: "t20".into(), code: SubErrorCode::RealtimeLimit }));
    assert!(settled(&mut h.peer).await.is_empty());
    assert_eq!(h.rig.stream.status(), StreamStatus::Open);
}

#[tokio::test(start_paused = true)]
async fn switching_the_app_venue_to_krx_unregisters_the_unified_trs_before_it_registers_the_krx_ones() {
    let rig = rig();
    let mut peer = rig.connector.queue_connection();
    let samsung = stock("005930");
    rig.symbols.replace(nxt_listing(&[(samsung, true)]));
    rig.stream.set_desired(feeds(&[(samsung, &[StreamKind::Trades, StreamKind::Book(Venue::Combined)])]));
    assert_eq!(settled(&mut peer).await.len(), 2);

    rig.stream.set_venue(Venue::Krx);
    rig.stream.set_desired(feeds(&[(samsung, &[StreamKind::Trades, StreamKind::Book(Venue::Krx)])]));
    let sent = settled(&mut peer).await;
    let position = |wanted: &Control| sent.iter().position(|c| c == wanted).unwrap_or_else(|| panic!("{wanted:?}가 없다: {sent:?}"));
    assert_eq!(sent.len(), 4, "{sent:?}");
    assert!(position(&Control::unregister("H0UNCNT0", "005930")) < position(&Control::register("H0STCNT0", "005930")));
    assert!(position(&Control::unregister("H0UNASP0", "005930")) < position(&Control::register("H0STASP0", "005930")));
}

#[tokio::test(start_paused = true)]
async fn a_symbol_that_nxt_does_not_trade_keeps_the_unified_trades_tr_when_the_app_venue_is_nxt() {
    let rig = rig();
    let mut peer = rig.connector.queue_connection();
    let (both, krx_only) = (stock("005930"), stock("000020"));
    rig.symbols.replace(nxt_listing(&[(both, true), (krx_only, false)]));
    rig.stream.set_venue(Venue::Nxt);
    rig.stream.set_desired(feeds(&[(both, &[StreamKind::Trades]), (krx_only, &[StreamKind::Trades])]));
    let sent: BTreeSet<Control> = settled(&mut peer).await.into_iter().collect();
    assert_eq!(sent, BTreeSet::from([Control::register("H0NXCNT0", "005930"), Control::register("H0UNCNT0", "000020")]));
}

#[tokio::test(start_paused = true)]
async fn program_broker_and_index_kinds_register_their_own_trs() {
    let rig = rig();
    let mut peer = rig.connector.queue_connection();
    let kospi = Symbol::Index(IndexCode::KOSPI);
    let samsung = stock("005930");
    rig.stream.set_desired(feeds(&[(samsung, &[StreamKind::Trades, StreamKind::Program, StreamKind::Brokers, StreamKind::AfterHours]), (kospi, &[StreamKind::Index, StreamKind::Trades])]));
    let sent: BTreeSet<Control> = settled(&mut peer).await.into_iter().collect();
    assert_eq!(
        sent,
        BTreeSet::from([
            Control::register("H0UNCNT0", "005930"),
            Control::register("H0UNPGM0", "005930"),
            Control::register("H0UNMBC0", "005930"),
            Control::register("H0UPCNT0", "0001"),
        ])
    );
    assert_eq!(rig.stream.seat_rules().seats(&rig.stream.watch_desired().borrow()), 4);
}

fn trade_fields() -> Vec<(usize, &'static str)> {
    vec![(0, "005930"), (1, "093001"), (2, "71200"), (3, "2"), (4, "300"), (5, "0.42"), (12, "15"), (13, "1200"), (18, "112.34"), (21, "1")]
}

#[tokio::test(start_paused = true)]
async fn a_krx_trade_frame_becomes_one_tick_with_price_quantity_and_side() {
    let mut rig = rig();
    let peer = rig.connector.queue_connection();
    peer.say(&frame("H0STCNT0", 46, &trade_fields()));
    let StreamEvent::Tick { tick, received_at } = next_data_event(&mut rig.events).await else { panic!("체결이 아니다") };
    assert_eq!(received_at, now());
    assert_eq!((tick.symbol, tick.price.centi(), tick.qty, tick.hhmmss), (stock("005930"), 7_120_000, Volume(15), TimeOfDay::hms(9, 30, 1).unwrap()));
    assert_eq!((tick.side, tick.exchange, tick.strength_centi, tick.same_time_ratio_centi), (Some(TradeSide::Buy), Some(Exchange::Krx), Some(11_234), None));
    let day = tick.day.unwrap();
    assert_eq!((day.change_centi, day.cumulative), (30_000, Volume(1200)));

    let mut falling = trade_fields();
    falling.extend([(3, "5"), (21, "5")]);
    peer.say(&frame("H0UNCNT0", 47, &falling));
    let StreamEvent::Tick { tick, .. } = next_data_event(&mut rig.events).await else { panic!("체결이 아니다") };
    assert_eq!((tick.side, tick.exchange, tick.day.unwrap().change_centi), (Some(TradeSide::Sell), None, -30_000));
}

#[tokio::test(start_paused = true)]
async fn an_ask_frame_becomes_a_ten_level_book_with_the_expected_price() {
    let mut rig = rig();
    let peer = rig.connector.queue_connection();
    let levels: Vec<(usize, String)> = (0..10)
        .flat_map(|i| [(3 + i, (71_300 + 100 * i).to_string()), (13 + i, (71_200 - 100 * i).to_string()), (23 + i, (10 + i).to_string()), (33 + i, (20 + i).to_string())])
        .collect();
    let mut fields: Vec<(usize, &str)> = levels.iter().map(|(i, v)| (*i, v.as_str())).collect();
    fields.extend([(0, "005930"), (1, "083000"), (43, "1000"), (44, "2000"), (47, "71250"), (48, "300")]);
    peer.say(&frame("H0STASP0", 66, &fields));
    let StreamEvent::Book { book, .. } = next_data_event(&mut rig.events).await else { panic!("호가가 아니다") };
    assert_eq!((book.symbol, book.venue, book.total_ask_qty, book.total_bid_qty), (stock("005930"), Venue::Krx, Volume(1000), Volume(2000)));
    let first_ask = book.asks[0].unwrap();
    let last_bid = book.bids[9].unwrap();
    assert_eq!((first_ask.price.centi(), first_ask.qty), (7_130_000, Volume(10)));
    assert_eq!((last_bid.price.centi(), last_bid.qty), (7_030_000, Volume(29)));
    assert!(book.asks.iter().chain(book.bids.iter()).all(Option::is_some));
    let expected = book.expected.unwrap();
    assert_eq!((expected.price.centi(), expected.qty), (7_125_000, Volume(300)));
}

#[tokio::test(start_paused = true)]
async fn a_frame_with_too_few_fields_fills_what_it_read_and_the_session_goes_on() {
    let mut rig = rig();
    let peer = rig.connector.queue_connection();
    peer.say("0|H0STCNT0|001|005930^093001^71200^2^300^0.42^71100^70000^71500^69900^71300^71200^15^1200");
    let StreamEvent::Tick { tick, .. } = next_data_event(&mut rig.events).await else { panic!("체결이 아니다") };
    assert_eq!((tick.price.centi(), tick.qty), (7_120_000, Volume(15)));
    assert_eq!((tick.side, tick.strength_centi, tick.same_time_ratio_centi), (None, None, None), "읽지 못한 필드는 비어 있다");
    assert_eq!(tick.day.unwrap().cumulative, Volume(1200));

    peer.say("0|H0STCNT0|001|005930^093001");
    peer.say("0|H0STASP0|001|005930^083000^0^71300^71400");
    let StreamEvent::Book { book, .. } = next_data_event(&mut rig.events).await else { panic!("호가가 아니다") };
    assert_eq!(book.asks[0].map(|level| (level.price.centi(), level.qty)), Some((7_130_000, Volume(0))));
    assert_eq!(book.asks[1].map(|level| level.price.centi()), Some(7_140_000));
    assert!(book.asks[2].is_none() && book.bids.iter().all(Option::is_none) && book.expected.is_none());

    peer.say(&frame("H0STCNT0", 46, &trade_fields()));
    assert!(matches!(next_data_event(&mut rig.events).await, StreamEvent::Tick { .. }), "그 뒤 프레임도 읽는다");
    assert_eq!(rig.stream.status(), StreamStatus::Open);
}

#[tokio::test(start_paused = true)]
async fn index_program_and_broker_frames_become_their_events() {
    let mut rig = rig();
    let peer = rig.connector.queue_connection();
    let index_fields = |cumulative: &'static str| vec![(0, "0001"), (1, "093001"), (2, "2650.12"), (3, "5"), (4, "3.10"), (5, cumulative)];
    peer.say(&frame("H0UPCNT0", 30, &index_fields("1000")));
    peer.say(&frame("H0UPCNT0", 30, &index_fields("1600")));
    let StreamEvent::Tick { tick: first, .. } = next_data_event(&mut rig.events).await else { panic!("지수가 아니다") };
    let StreamEvent::Tick { tick: second, .. } = next_data_event(&mut rig.events).await else { panic!("지수가 아니다") };
    assert_eq!((first.symbol, first.price.centi(), first.qty), (Symbol::Index(IndexCode::KOSPI), 265_012, Volume(0)));
    assert_eq!((second.qty, second.day.map(|d| (d.change_centi, d.cumulative))), (Volume(600), Some((-310, Volume(1600)))));

    let program = |net: &'static str| vec![(0, "005930"), (1, "093001"), (2, "100"), (3, "7200000"), (4, "300"), (5, "21600000"), (6, net), (7, "14400000")];
    peer.say(&frame("H0UNPGM0", 11, &program("200")));
    peer.say(&frame("H0UNPGM0", 11, &program("260")));
    let StreamEvent::Program { row: first, .. } = next_data_event(&mut rig.events).await else { panic!("프로그램이 아니다") };
    let StreamEvent::Program { row: second, .. } = next_data_event(&mut rig.events).await else { panic!("프로그램이 아니다") };
    assert_eq!((first.sell_qty, first.sell_amount_million_won, first.buy_qty, first.buy_amount_million_won), (Volume(100), 7, Volume(300), 21));
    assert_eq!((first.net_buy_qty, first.net_buy_qty_change, first.price), (200, 200, None));
    assert_eq!((second.net_buy_qty, second.net_buy_qty_change), (260, 60));

    let broker = vec![(0, "005930"), (1, "키움증권"), (2, "XYZ증권"), (11, "500"), (12, "40"), (31, "004"), (51, "10"), (6, "한국증권"), (16, "700"), (36, "009"), (56, "-5"), (37, "077"), (17, "9")];
    peer.say(&frame("H0UNMBC0", 78, &broker));
    let StreamEvent::Broker { snapshot, .. } = next_data_event(&mut rig.events).await else { panic!("거래원이 아니다") };
    let sells: Vec<_> = snapshot.sells.iter().map(|e| (e.member_code.as_str(), e.member_name.as_str(), e.cumulative_qty, e.change_qty)).collect();
    assert_eq!(sells, [("004", "키움증권", Volume(500), 10), ("XYZ증권", "XYZ증권", Volume(40), 0)]);
    let buys: Vec<_> = snapshot.buys.iter().map(|e| (e.member_code.as_str(), e.member_name.as_str(), e.cumulative_qty, e.change_qty)).collect();
    assert_eq!(buys, [("009", "한국증권", Volume(700), -5), ("077", "077", Volume(9), 0)], "이름을 모르면 코드 그대로다");
}

#[tokio::test(start_paused = true)]
async fn a_lost_connection_goes_down_then_asks_a_new_approval_key_and_registers_everything_again() {
    let mut rig = rig();
    let mut first = rig.connector.queue_connection();
    let mut second = rig.connector.queue_connection();
    let (samsung, hynix) = (stock("005930"), stock("000660"));
    rig.stream.set_desired(feeds(&[(samsung, &[StreamKind::Trades, StreamKind::Book(Venue::Combined)]), (hynix, &[StreamKind::Trades])]));
    let before: BTreeSet<Control> = settled(&mut first).await.into_iter().collect();
    assert_eq!(before.len(), 3);
    assert!(matches!(next_event(&mut rig.events).await, StreamEvent::Live { .. }));
    assert_eq!(*rig.transport.approvals.lock().unwrap(), 1);

    first.hang_up();
    assert!(matches!(next_event(&mut rig.events).await, StreamEvent::Down { .. }), "허브에 끊김이 간다");
    let StreamEvent::Live { since } = next_event(&mut rig.events).await else { panic!("이어짐이 아니다") };
    assert_eq!(since, rig.clock.now());
    let after: BTreeSet<Control> = settled(&mut second).await.into_iter().collect();
    assert_eq!(after, before, "원하는 등록을 모두 다시 보낸다");
    assert_eq!(*rig.transport.approvals.lock().unwrap(), 2, "접속키를 새로 받는다");
    assert_eq!(rig.connector.attempts(), 2);
}

#[tokio::test(start_paused = true)]
async fn an_in_use_elsewhere_answer_halts_the_stream_and_ten_minutes_later_there_is_still_one_connection_attempt() {
    let mut rig = rig();
    let mut peer = rig.connector.queue_connection();
    let _spare = rig.connector.queue_connection();
    rig.stream.set_desired(feeds(&[(stock("005930"), &[StreamKind::Trades])]));
    peer.heard().await;
    peer.say(&fixture("in_use_elsewhere.json"));
    assert!(matches!(next_data_event(&mut rig.events).await, StreamEvent::Halted));
    assert_eq!(rig.stream.status(), StreamStatus::InUseElsewhere);

    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(rig.connector.attempts(), 1, "다시 접속하지 않는다");
    assert_eq!(rig.stream.status(), StreamStatus::InUseElsewhere);
}

#[tokio::test(start_paused = true)]
async fn a_reconnect_while_the_bridge_is_backed_up_still_reports_down_and_then_live() {
    let mut rig = rig();
    let mut first = rig.connector.queue_connection();
    let _second = rig.connector.queue_connection();
    rig.stream.set_desired(feeds(&[(stock("005930"), &[StreamKind::Trades])]));
    first.heard().await;
    let record = frame("H0STCNT0", 46, &trade_fields());
    let fields = record.splitn(4, '|').nth(3).unwrap();
    let burst = format!("0|H0STCNT0|999|{}", vec![fields; 999].join("^"));
    for _ in 0..5 {
        first.say(&burst);
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    first.hang_up();
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(rig.connector.attempts(), 2);
    let mut lifecycle = Vec::new();
    while let Ok(Some(event)) = tokio::time::timeout(Duration::from_secs(5), rig.events.recv()).await {
        match event {
            StreamEvent::Live { .. } => lifecycle.push("Live"),
            StreamEvent::Down { .. } => lifecycle.push("Down"),
            _ => {}
        }
    }
    assert_eq!(lifecycle, ["Live", "Down", "Live"]);
}

#[tokio::test(start_paused = true)]
async fn frames_with_unreadable_keys_or_extreme_numbers_are_dropped_and_the_session_goes_on() {
    let mut rig = rig();
    let peer = rig.connector.queue_connection();
    peer.say(&frame("H0UPCNT0", 30, &[(0, "é01"), (1, "093001"), (2, "2650.12")]));
    let program = |net: &'static str| frame("H0UNPGM0", 11, &[(0, "005930"), (1, "093001"), (6, net)]);
    for net in ["9223372036854775807", "-9223372036854775807", "5"] {
        peer.say(&program(net));
    }
    for _ in 0..3 {
        assert!(matches!(next_data_event(&mut rig.events).await, StreamEvent::Program { .. }));
    }
    peer.say(&frame("H0UPCNT0", 30, &[(0, "0001"), (1, "093001"), (2, "2650.12")]));
    assert!(matches!(next_data_event(&mut rig.events).await, StreamEvent::Tick { .. }));
    assert_eq!(rig.stream.status(), StreamStatus::Open);
}

#[tokio::test(start_paused = true)]
async fn reseating_the_manager_for_the_kis_limit_keeps_the_first_forty_holders_and_rejects_the_rest() {
    let kiwoom: Arc<dyn SeatRules> = Arc::new(server::kiwoom::stream::KiwoomSeats);
    let mut manager = SubscriptionManager::new(kiwoom);
    let symbols = listed(50);
    let cell = |i: usize| Holder::Cell { conn: ConnId(1), sub: SubId(format!("cell{i}")) };
    for (i, symbol) in symbols.iter().enumerate() {
        manager.hold(*symbol, cell(i));
    }
    let plan = manager.plan(now());
    assert!(plan.rejected.is_empty(), "키움 자리에는 쉰 종목이 다 들어간다");
    manager.reseat(Arc::new(KisSeats::new(0)));
    let plan = manager.plan(now());
    assert_eq!(plan.realtime.len(), LIMIT);
    assert_eq!(plan.rejected.len(), 10);
    assert!(symbols.iter().take(LIMIT).all(|symbol| plan.realtime.contains(symbol)), "먼저 잡은 종목이 남는다");
}

struct KiwoomSideStream {
    desired: tokio::sync::watch::Sender<DesiredFeeds>,
}

impl MarketStream for KiwoomSideStream {
    fn seat_rules(&self) -> Arc<dyn SeatRules> {
        Arc::new(server::kiwoom::stream::KiwoomSeats)
    }

    fn set_desired(&self, desired: DesiredFeeds) {
        self.desired.send_replace(desired);
    }

    fn watch_desired(&self) -> tokio::sync::watch::Receiver<DesiredFeeds> {
        self.desired.subscribe()
    }

    fn set_venue(&self, _: Venue) {}
}

fn open_registrations(heard: &[Control]) -> Vec<usize> {
    let mut open = BTreeSet::new();
    heard
        .iter()
        .map(|control| {
            let key = (control.tr_id.clone(), control.tr_key.clone());
            if control.registers { open.insert(key) } else { open.remove(&key) };
            open.len()
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn registrations_never_exceed_the_realtime_limit_between_activate_and_replan() {
    let mut rig = rig();
    let mut peer = rig.connector.queue_connection();
    let (kiwoom_events_in, kiwoom_events) = mpsc::channel(1);
    drop(kiwoom_events_in);
    let kiwoom_side = Arc::new(KiwoomSideStream { desired: tokio::sync::watch::channel(DesiredFeeds::new()).0 });
    let (active, _merged, _first) = ActiveStream::new(kiwoom_side, kiwoom_events, rig.clock.clone());
    let (stub_events, replaced) = mpsc::channel(1);
    drop(stub_events);
    let kis_events = std::mem::replace(&mut rig.events, replaced);
    let kis = active.attach(rig.stream.clone(), kis_events);
    let crowded = listed(60);
    let trades: &[StreamKind] = &[StreamKind::Trades];
    let kiwoom_plan = feeds(&crowded.iter().map(|symbol| (*symbol, trades)).collect::<Vec<_>>());
    active.set_desired(kiwoom_plan.clone());
    assert!(KisSeats::new(0).seats(&kiwoom_plan) > LIMIT, "키움 자리 규칙에서는 예순 종목이 다 들어간다");

    active.activate(&kis).await;
    let before_replan = settled(&mut peer).await;
    assert!(open_registrations(&before_replan).into_iter().all(|open| open <= LIMIT), "재계획 전에 한투 세션에 나간 등록이 {LIMIT}을 넘었다: {}", before_replan.len());

    let kis_plan = feeds(&crowded.iter().take(LIMIT).map(|symbol| (*symbol, trades)).collect::<Vec<_>>());
    active.set_desired(kis_plan);
    let after_replan = settled(&mut peer).await;
    let heard: Vec<Control> = before_replan.into_iter().chain(after_replan).collect();
    assert!(open_registrations(&heard).into_iter().all(|open| open <= LIMIT), "어느 순간에도 등록은 {LIMIT}을 넘지 않는다");
    assert_eq!(open_registrations(&heard).last().copied(), Some(LIMIT), "재계획 뒤에는 마흔 자리가 찬다");
}

#[tokio::test(start_paused = true)]
async fn a_wanted_fill_notice_takes_one_seat_on_the_market_session_and_its_sealed_frame_opens_into_a_notice() {
    use aes::Aes256;
    use base64::Engine;
    use cbc::cipher::block_padding::Pkcs7;
    use cbc::cipher::{BlockEncryptMut, KeyIvInit};
    let (mut rig, notices) = rig_with(Some("fakehtsmarket"));
    let notices = notices.unwrap();
    let mut received = notices.subscribe();
    let mut peer = rig.connector.queue_connection();
    let samsung = stock("005930");
    let desired = feeds(&[(samsung, &[StreamKind::Trades])]);
    rig.stream.set_desired(desired.clone());
    let registered = [peer.heard().await, peer.heard().await].iter().map(Control::of).collect::<BTreeSet<_>>();
    assert_eq!(registered, BTreeSet::from([Control::register("H0STCNI0", "fakehtsmarket"), Control::register("H0UNCNT0", "005930")]));
    assert_eq!(rig.stream.seat_rules().limit(), LIMIT - 1, "체결통보가 자리 하나를 먼저 잡는다");
    assert!(matches!(next_event(&mut rig.events).await, StreamEvent::Live { .. }));

    let (key, iv) = ("FAKE-NOTICE-KEY-market-012345678", "FAKE-NOTICE-IV-1");
    peer.say(&serde_json::json!({"header": {"tr_id": "H0STCNI0", "tr_key": "fakehtsmarket", "encrypt": "N"}, "body": {"rt_cd": "0", "msg_cd": "OPSP0000", "msg1": "SUBSCRIBE SUCCESS", "output": {"iv": iv, "key": key}}}).to_string());
    let plain = "fakehtsmarket^5001235601^0000117057^^02^0^00^0^005930^1^71000^093001^0^2^2^91252^1^합성^0^4^Y^^^^^71000";
    let sealed = base64::engine::general_purpose::STANDARD.encode(cbc::Encryptor::<Aes256>::new_from_slices(key.as_bytes(), iv.as_bytes()).unwrap().encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes()));
    peer.say(&format!("1|H0STCNI0|001|{sealed}"));
    let notice = tokio::time::timeout(WAIT, received.recv()).await.unwrap().unwrap();
    assert_eq!((notice.order_no.as_str(), notice.filled, notice.venue), ("0000117057", true, Some(Venue::Nxt)));
    notices.want(None);
    assert_eq!(rig.stream.seat_rules().limit(), LIMIT, "구독하지 않으면 자리를 돌려준다");
}

#[derive(Clone, Default)]
struct CapturedLogs(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for CapturedLogs {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test(start_paused = true)]
async fn a_rejected_fill_notice_registration_does_not_log_the_hts_id() {
    let logs = CapturedLogs::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt().with_writer(move || writer.clone()).with_ansi(false).with_max_level(tracing::Level::TRACE).finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let (mut rig, _notices) = rig_with(Some("fakehtslog77"));
    let mut peer = rig.connector.queue_connection();
    let samsung = stock("005930");
    rig.stream.set_desired(feeds(&[(samsung, &[StreamKind::Trades])]));
    let _ = [peer.heard().await, peer.heard().await];
    assert!(matches!(next_event(&mut rig.events).await, StreamEvent::Live { .. }));
    peer.say(&serde_json::json!({"header": {"tr_id": "H0STCNI0", "tr_key": "fakehtslog77", "encrypt": "N"}, "body": {"rt_cd": "1", "msg_cd": "OPSP0011", "msg1": "invalid tr_key"}}).to_string());
    tokio::time::sleep(Duration::from_secs(1)).await;
    let text = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    assert!(text.contains("등록이 거절"), "거절 로그가 있어야 한다: {text}");
    assert!(!text.contains("fakehtslog77"), "HTS ID가 로그에 나왔다: {text}");
}

const SEAT_HTS_ID: &str = "fakehtsseats";

fn refused_subs(messages: Vec<ServerMessage>) -> Vec<String> {
    messages.into_iter().filter_map(|message| match message {
        ServerMessage::SubError { sub, code: SubErrorCode::RealtimeLimit } => Some(sub),
        _ => None,
    }).collect()
}

struct NoticeSeatRig {
    h: HubRig,
    notices: KisNotices,
    out: Arc<Outbox>,
    symbols: Vec<Symbol>,
    heard: Vec<Control>,
}

async fn forty_trade_seats_with_notices_off() -> NoticeSeatRig {
    let (rig, notices) = rig_with_notices(Some(SEAT_HTS_ID), false);
    let notices = notices.unwrap();
    let mut h = hub_rig_on(rig, LIMIT);
    let (conn, out) = connect(&h).await;
    let symbols = listed(LIMIT);
    for (i, symbol) in symbols.iter().enumerate().rev() {
        h.hub.subscribe_feed(conn, sub(&format!("t{i}")), *symbol, FeedKind::Trades, Venue::Combined);
    }
    settle().await;
    let heard = settled(&mut h.peer).await;
    assert_eq!(open_registrations(&heard).last().copied(), Some(LIMIT), "체결 구독 마흔 개가 마흔 자리를 채운다: {heard:?}");
    assert!(refused_subs(out.take(true).messages).is_empty(), "마흔 개까지는 모두 받는다");
    NoticeSeatRig { h, notices, out, symbols, heard }
}

fn refused_symbol(rig: &NoticeSeatRig, refused: &str) -> String {
    let index: usize = refused.strip_prefix('t').and_then(|i| i.parse().ok()).unwrap_or_else(|| panic!("모르는 구독 이름: {refused}"));
    rig.symbols[index].as_wire()
}

async fn turn_notices_on(rig: &mut NoticeSeatRig) -> String {
    rig.notices.want(Some(Secret::new(SEAT_HTS_ID.to_owned())));
    settle().await;
    let after = settled(&mut rig.h.peer).await;
    rig.heard.extend(after.iter().cloned());
    let refused = refused_subs(rig.out.take(true).messages);
    assert_eq!(refused.len(), 1, "체결통보 자리 때문에 구독 하나만 한도 오류를 받는다: {refused:?}");
    let symbol = refused_symbol(rig, &refused[0]);
    assert!(after.contains(&Control::register("H0STCNI0", SEAT_HTS_ID)), "체결통보가 등록된다: {after:?}");
    assert!(after.contains(&Control::unregister("H0UNCNT0", &symbol)), "밀려난 구독의 종목이 해지된다: {after:?}");
    let interrupted: Vec<&Control> = after.iter().filter(|control| !control.registers && control.tr_id == "H0UNCNT0" && control.tr_key != symbol).collect();
    assert!(interrupted.is_empty(), "허브가 남긴 종목은 한 번도 해지되지 않는다(밀려난 것은 {symbol}): {interrupted:?}");
    refused[0].clone()
}

#[tokio::test(start_paused = true)]
async fn turning_on_fill_notices_with_forty_trade_seats_refuses_one_holder_and_never_registers_past_forty() {
    let mut rig = forty_trade_seats_with_notices_off().await;
    let refused = turn_notices_on(&mut rig).await;
    let refused_symbol = refused_symbol(&rig, &refused);
    let opens = open_registrations(&rig.heard);
    assert!(opens.iter().all(|&open| open <= LIMIT), "어느 순간에도 열린 등록은 {LIMIT}을 넘지 않는다: {opens:?}");
    assert_eq!(opens.last().copied(), Some(LIMIT), "체결통보와 서른아홉 종목이 마흔 자리를 채운다");
    let mut open = BTreeSet::new();
    for control in &rig.heard {
        let key = (control.tr_id.clone(), control.tr_key.clone());
        if control.registers { open.insert(key) } else { open.remove(&key) };
    }
    for symbol in rig.symbols.iter().map(Symbol::as_wire) {
        assert_eq!(open.contains(&("H0UNCNT0".to_owned(), symbol.clone())), symbol != refused_symbol, "{symbol}의 등록 상태");
    }
    settle().await;
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert!(settled(&mut rig.h.peer).await.is_empty(), "다음 재계획에서도 등록이 다시 넘치지 않는다");
    assert!(refused_subs(rig.out.take(true).messages).is_empty(), "같은 구독에 오류를 거듭 보내지 않는다");
}

#[tokio::test(start_paused = true)]
async fn turning_fill_notices_off_again_brings_the_refused_holder_back() {
    let mut rig = forty_trade_seats_with_notices_off().await;
    let refused = turn_notices_on(&mut rig).await;
    let refused_symbol = refused_symbol(&rig, &refused);
    rig.notices.want(None);
    settle().await;
    let after = settled(&mut rig.h.peer).await;
    rig.heard.extend(after.iter().cloned());
    assert!(after.contains(&Control::unregister("H0STCNI0", SEAT_HTS_ID)), "체결통보 등록이 풀린다: {after:?}");
    assert!(after.contains(&Control::register("H0UNCNT0", &refused_symbol)), "밀려난 종목이 다시 등록된다: {after:?}");
    let opens = open_registrations(&rig.heard);
    assert!(opens.iter().all(|&open| open <= LIMIT), "어느 순간에도 열린 등록은 {LIMIT}을 넘지 않는다: {opens:?}");
    assert_eq!(opens.last().copied(), Some(LIMIT));
    let messages = rig.out.take(true).messages;
    assert!(messages.contains(&ServerMessage::FeedSubscribed { sub: refused.clone(), kind: FeedKind::Trades }), "밀려난 구독이 다시 받는다고 알린다: {messages:?}");
    assert!(refused_subs(messages).is_empty());
}
