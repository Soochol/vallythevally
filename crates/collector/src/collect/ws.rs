use futures::future::BoxFuture;
use futures::{Sink, Stream};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

pub trait SessionSocket: Sink<Message, Error = WsError> + Stream<Item = Result<Message, WsError>> + Unpin + Send {}

impl<T> SessionSocket for T where T: Sink<Message, Error = WsError> + Stream<Item = Result<Message, WsError>> + Unpin + Send {}

pub type Socket = Box<dyn SessionSocket>;

pub trait Connector: Send + Sync {
    fn connect(&self) -> BoxFuture<'_, Result<Socket, WsError>>;
}

pub struct WebSocketConnector {
    url: String,
}

impl WebSocketConnector {
    pub fn new(url: impl Into<String>) -> WebSocketConnector {
        WebSocketConnector { url: url.into() }
    }
}

impl Connector for WebSocketConnector {
    fn connect(&self) -> BoxFuture<'_, Result<Socket, WsError>> {
        Box::pin(async { connect_async(self.url.as_str()).await.map(|(socket, _)| Box::new(socket) as Socket) })
    }
}
