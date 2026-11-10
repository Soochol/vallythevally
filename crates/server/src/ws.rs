//! 브라우저 WebSocket `/api/ws`(backend.md §8.3, §8.4). 읽기는 이 태스크가, 쓰기는 연결마다의 쓰기 태스크가 한다.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use domain::{Feed, SeriesKey, Symbol};
use futures::stream::SplitSink;
use futures::{SinkExt, StreamExt};

use crate::api::{ClientMessage, ServerMessage, SubErrorCode};
use crate::http::AppState;
use crate::market::hub::HubHandle;
use crate::market::outbox::Outbox;
use crate::market::{ConnId, SubId};

/// 구독 하나에 `bar`는 초당 10회까지다.
pub const BAR_FLUSH: Duration = Duration::from_millis(100);

pub async fn upgrade(State(st): State<Arc<AppState>>, ws: WebSocketUpgrade) -> Response {
    let hub = st.hub.clone();
    ws.on_upgrade(move |socket| serve(socket, hub))
}

async fn serve(socket: WebSocket, hub: HubHandle) {
    let outbox = Outbox::new();
    let conn = hub.connect(outbox.clone());
    let (sink, mut incoming) = socket.split();
    let mut writer = tokio::spawn(write(sink, outbox.clone()));
    loop {
        tokio::select! {
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
        Ok(ClientMessage::Unsubscribe { sub }) => hub.unsubscribe(conn, SubId(sub)),
        Err(e) => tracing::debug!(error = %e, "읽을 수 없는 브라우저 메시지를 버립니다"),
    }
}
