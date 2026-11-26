//! 브라우저 WebSocket `/api/ws`(backend.md §8.3, §8.4). 읽기는 이 태스크가, 쓰기는 연결마다의 쓰기 태스크가 한다.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use domain::{Feed, SeriesKey, Symbol};
use futures::stream::SplitSink;
use futures::{SinkExt, StreamExt};

use crate::api::{ClientMessage, FeedKind, ServerMessage, SubErrorCode, SymbolCode};
use crate::collector::DaemonNotice;
use crate::http::AppState;
use crate::market::hub::HubHandle;
use crate::market::outbox::Outbox;
use crate::system_routes::kiwoom_status;
use crate::market::{ConnId, SubId};

/// 구독 하나에 `bar`는 초당 10회까지다.
pub const BAR_FLUSH: Duration = Duration::from_millis(100);

pub async fn upgrade(State(st): State<Arc<AppState>>, ws: WebSocketUpgrade) -> Response {
    let hub = st.hub.clone();
    ws.on_upgrade(move |socket| serve(socket, st, hub))
}

async fn serve(socket: WebSocket, st: Arc<AppState>, hub: HubHandle) {
    let outbox = Outbox::new();
    let conn = hub.connect(outbox.clone());
    let (sink, mut incoming) = socket.split();
    let mut writer = tokio::spawn(write(sink, outbox.clone()));
    let mut link_changes = st.link.subscribe();
    let mut account_changes = st.system.account().subscribe();
    let mut setup_changes = st.system.account().subscribe_setup_changes();
    let mut collector_notices = st.system.collector().map(|board| board.subscribe_notices());
    let mut trading_changes = st.accounts.subscribe_changes();
    hub.send_to(conn, ServerMessage::KiwoomLink { status: kiwoom_status(&st) });
    let mut market_source_changes = st.market_control.subscribe();
    let mut market_source_sent = st.market_control.snapshot();
    send_account(&st, &hub, conn).await;
    hub.send_to(conn, ServerMessage::MarketSource { status: market_source_sent.clone() });
    loop {
        tokio::select! {
            changed = account_changes.changed() => {
                if changed.is_err() {
                    break;
                }
                send_account(&st, &hub, conn).await;
            }
            changed = setup_changes.recv() => match changed {
                Ok(kinds) => hub.send_to(conn, ServerMessage::SetupChanged { kinds }),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => hub.send_to(conn, ServerMessage::SetupChanged { kinds: setup::DocumentKind::ALL.to_vec() }),
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
            notice = next_collector_notice(&mut collector_notices) => match notice {
                Ok(notice) => send_collector_notice(&st, &hub, conn, notice),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => collector_notices = None,
            },
            changed = trading_changes.recv() => match changed {
                Ok(changed) => hub.send_to(conn, ServerMessage::TradingAccountChanged { account_ref: changed.account_ref, fill: changed.fill }),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
            changed = link_changes.changed() => {
                if changed.is_err() {
                    break;
                }
                hub.send_to(conn, ServerMessage::KiwoomLink { status: kiwoom_status(&st) });
            }
            changed = market_source_changes.changed() => {
                if changed.is_err() {
                    break;
                }
                let status = market_source_changes.borrow_and_update().clone();
                if status != market_source_sent {
                    market_source_sent = status.clone();
                    hub.send_to(conn, ServerMessage::MarketSource { status });
                }
            }
            msg = incoming.next() => match msg {
                Some(Ok(Message::Text(text))) => on_text(&hub, &outbox, conn, text.as_str()),
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            _ = &mut writer => break,
        }
    }
    hub.disconnect(conn);
    outbox.close();
}

async fn next_collector_notice(notices: &mut Option<tokio::sync::broadcast::Receiver<DaemonNotice>>) -> Result<DaemonNotice, tokio::sync::broadcast::error::RecvError> {
    match notices {
        Some(notices) => notices.recv().await,
        None => std::future::pending().await,
    }
}

fn send_collector_notice(st: &AppState, hub: &HubHandle, conn: ConnId, notice: DaemonNotice) {
    let allowed = st.system.collector().is_some_and(|board| board.allows(st.system.account().signed_in_identity().as_ref()));
    if allowed {
        hub.send_to(conn, ServerMessage::CollectorDaemon { judgment: notice.judgment, at: notice.at });
    }
}

async fn send_account(st: &AppState, hub: &HubHandle, conn: ConnId) {
    match st.system.account().status(&st.db).await {
        Ok(status) => hub.send_to(conn, ServerMessage::Account { status }),
        Err(e) => tracing::warn!(error = %e, "계정 상태를 읽지 못해 브라우저에 알리지 못했습니다"),
    }
}

async fn write(mut sink: SplitSink<WebSocket, Message>, outbox: Arc<Outbox>) {
    let mut tick = tokio::time::interval(BAR_FLUSH);
    loop {
        let with_bars = tokio::select! {
            _ = outbox.notified() => false,
            _ = tick.tick() => true,
        };
        let batch = outbox.take(with_bars);
        for m in &batch.messages {
            let text = serde_json::to_string(m).expect("ServerMessage는 언제나 직렬화된다");
            if sink.send(Message::Text(text.into())).await.is_err() {
                return;
            }
        }
        if batch.closed {
            let _ = sink.send(Message::Close(None)).await;
            return;
        }
    }
}

fn on_text(hub: &HubHandle, outbox: &Outbox, conn: ConnId, text: &str) {
    match serde_json::from_str::<ClientMessage>(text) {
        Ok(ClientMessage::Subscribe { sub, symbol, venue, period }) => {
            let key = Symbol::parse(&symbol.0).ok().and_then(|s| Feed::new(s, venue.map(Into::into))).map(|feed| SeriesKey { feed, period: period.into() });
            match key {
                Some(key) => hub.subscribe(conn, SubId(sub), key),
                None => {
                    let _ = outbox.push(ServerMessage::SubError { sub, code: SubErrorCode::BadRequest });
                }
            }
        }
        Ok(ClientMessage::SubscribeFeed { sub, symbol, kind, venue }) => match Symbol::parse(&symbol.0) {
            Ok(symbol) => {
                let venue = if matches!(kind, FeedKind::Trades | FeedKind::Book | FeedKind::Micro) { venue.map_or(domain::Venue::Combined, Into::into) } else { domain::Venue::Combined };
                hub.subscribe_feed(conn, SubId(sub), symbol, kind, venue);
            }
            Err(_) => {
                let _ = outbox.push(ServerMessage::SubError { sub, code: SubErrorCode::BadRequest });
            }
        },
        Ok(ClientMessage::Unsubscribe { sub }) => hub.unsubscribe(conn, SubId(sub)),
        Ok(ClientMessage::Watch { symbols, venue }) => hub.watch(conn, watch_symbols(&symbols), venue.map_or(domain::Venue::Combined, Into::into)),
        Err(e) => tracing::debug!(error = %e, "읽을 수 없는 브라우저 메시지를 버립니다"),
    }
}

fn watch_symbols(codes: &[SymbolCode]) -> Vec<Symbol> {
    let mut out: Vec<Symbol> = Vec::with_capacity(codes.len());
    for code in codes {
        match Symbol::parse(&code.0) {
            Ok(s) if !out.contains(&s) => out.push(s),
            Ok(_) => {}
            Err(e) => tracing::debug!(error = %e, code = %code.0, "관심종목의 읽을 수 없는 코드를 뺍니다"),
        }
    }
    out
}
