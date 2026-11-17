use std::sync::mpsc::Sender;

use serde_json::{Map, Value};
use tokio::sync::{mpsc, watch};

use crate::protocol::{Batch, Command, Event, ProtocolError, Rejection, SessionState};

pub type Incoming = Result<Command, ProtocolError>;
pub type Commands = mpsc::UnboundedReceiver<Incoming>;

#[derive(Clone, Default)]
pub struct Events {
    sink: Option<Sender<Event>>,
}

impl Events {
    pub fn none() -> Events {
        Events { sink: None }
    }

    pub fn to(sink: Sender<Event>) -> Events {
        Events { sink: Some(sink) }
    }

    pub fn enabled(&self) -> bool {
        self.sink.is_some()
    }

    pub fn emit(&self, event: Event) {
        if let Some(sink) = &self.sink {
            let _ = sink.send(event);
        }
    }

    pub fn registered(&self, batch: Batch, replay: bool, rejection: Option<Rejection>) {
        self.emit(Event::Registered { batch, ok: rejection.is_none(), replay, rejection });
    }

    pub fn unregistered(&self, batch: Batch, rejection: Option<Rejection>) {
        self.emit(Event::Unregistered { batch, ok: rejection.is_none(), rejection });
    }

    pub fn live(&self) {
        self.emit(Event::Live);
    }

    pub fn down(&self, reason: &str) {
        self.emit(Event::Down { reason: reason.to_owned() });
    }

    pub fn token_invalid(&self, generation: u64) {
        self.emit(Event::TokenInvalid { generation });
    }

    pub fn market_open(&self, recv_ms: i64, values: Map<String, Value>) {
        self.emit(Event::MarketOpen { recv_ms, values });
    }

    pub fn halted(&self, reason: &str, action: &str) {
        self.emit(Event::Halted { reason: reason.to_owned(), action: action.to_owned() });
    }

    pub fn heartbeat(&self, frames: u64, bytes: u64, state: SessionState) {
        self.emit(Event::Heartbeat { frames, bytes, state });
    }
}

pub struct ChildLink {
    pub commands: Commands,
    pub events: Events,
    pub state: watch::Sender<SessionState>,
}
