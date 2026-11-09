//! 연결 하나의 보낼 것(backend.md §8.4). 허브가 넣고 그 연결의 쓰기 태스크가 꺼낸다.
//!
//! 버리면 안 되는 메시지는 순서대로 쌓는다(용량 MUST_CAPACITY, 차면 연결을 닫는다). `bar`는 구독마다 가장 새 것 하나만 둔다.
//! 구독 하나에 대해 브라우저가 받는 `seq`는 늘어나기만 한다: 버리면 안 되는 메시지를 넣을 때 그 구독의 대기 중 `bar`를 버리고,
//! 꺼낼 때는 쌓인 메시지를 먼저, 대기 중 `bar`를 나중에 한 번에 꺼낸다.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

use super::SubId;
use crate::api::{Bar, ServerMessage};

pub const MUST_CAPACITY: usize = 256;

/// 버리면 안 되는 메시지가 MUST_CAPACITY만큼 밀렸거나 연결이 이미 닫혔다. 연결을 닫는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Closed;

#[derive(Default)]
pub struct Outbox {
    state: Mutex<State>,
    wake: Notify,
}

#[derive(Default)]
struct State {
    must: VecDeque<ServerMessage>,
    bars: BTreeMap<String, (u64, Bar)>,
    closed: bool,
}

/// 쓰기 태스크가 한 번에 꺼낸 것. 이 순서대로 보낸다.
#[derive(Debug, PartialEq)]
pub struct Batch {
    pub messages: Vec<ServerMessage>,
    pub closed: bool,
}

impl Outbox {
    pub fn new() -> Arc<Self> {
        Arc::new(Outbox::default())
    }

    pub fn push(&self, msg: ServerMessage) -> Result<(), Closed> {
        let mut s = self.state.lock().expect("outbox 잠금");
        if s.closed || s.must.len() >= MUST_CAPACITY {
            s.closed = true;
            drop(s);
            self.wake.notify_one();
            return Err(Closed);
        }
        if let Some(sub) = sub_of(&msg) {
            s.bars.remove(sub);
        }
        s.must.push_back(msg);
        drop(s);
        self.wake.notify_one();
        Ok(())
    }

    /// 그 구독의 대기 중 `bar`를 덮어쓴다. 100ms마다 나간다.
    pub fn set_bar(&self, sub: &SubId, seq: u64, bar: Bar) {
        let mut s = self.state.lock().expect("outbox 잠금");
        if !s.closed {
            s.bars.insert(sub.0.clone(), (seq, bar));
        }
    }

    pub fn close(&self) {
        self.state.lock().expect("outbox 잠금").closed = true;
        self.wake.notify_one();
    }

    /// `with_bars`가 false면 쌓인 메시지만 꺼낸다(곧바로 보낼 때). true면 대기 중 `bar`까지(100ms 타이머).
    pub fn take(&self, with_bars: bool) -> Batch {
        let mut s = self.state.lock().expect("outbox 잠금");
        let mut messages: Vec<ServerMessage> = s.must.drain(..).collect();
        if with_bars {
            messages.extend(std::mem::take(&mut s.bars).into_iter().map(|(sub, (seq, bar))| ServerMessage::Bar { sub, seq, bar }));
        }
        Batch { messages, closed: s.closed }
    }

    /// push나 close가 있을 때까지 기다린다.
    pub async fn notified(&self) {
        self.wake.notified().await;
    }
}

fn sub_of(msg: &ServerMessage) -> Option<&str> {
    match msg {
        ServerMessage::Subscribed { sub, .. }
        | ServerMessage::SubError { sub, .. }
        | ServerMessage::Bar { sub, .. }
        | ServerMessage::Confirmed { sub, .. }
        | ServerMessage::Reload { sub, .. } => Some(sub),
        ServerMessage::Hello { .. } | ServerMessage::Status { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::api::{ReloadReason, UnixSeconds};

    fn bar(c: f64) -> Bar {
        Bar { t: UnixSeconds(0), o: c, h: c, l: c, c, v: 1 }
    }

    fn seq_of(m: &ServerMessage) -> Option<(&str, u64)> {
        match m {
            ServerMessage::Subscribed { sub, seq, .. }
            | ServerMessage::Bar { sub, seq, .. }
            | ServerMessage::Confirmed { sub, seq, .. }
            | ServerMessage::Reload { sub, seq, .. } => Some((sub, *seq)),
            _ => None,
        }
    }

    /// 허브 쪽 넣기와 쓰기 태스크 쪽 꺼내기를 섞어도 구독마다 받는 seq는 늘어나기만 하고, 버리면 안 되는 메시지는 모두 간다.
    #[test]
    fn seq_only_increases_per_sub_under_any_interleaving() {
        let subs = ["a", "b", "c"];
        for round in 0..200u64 {
            let mut rng = round.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            let mut next = move || {
                rng = rng.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
                rng >> 33
            };
            let out = Outbox::new();
            let mut seq: HashMap<&str, u64> = HashMap::new();
            let mut must_sent = 0;
            let mut received = Vec::new();
            for _ in 0..300 {
                let sub = subs[next() as usize % subs.len()];
                let s = seq.entry(sub).or_default();
                match next() % 7 {
                    0..=3 => {
                        *s += 1;
                        out.set_bar(&SubId(sub.into()), *s, bar(*s as f64));
                    }
                    4 => {
                        *s += 1;
                        out.push(ServerMessage::Confirmed { sub: sub.into(), seq: *s, bar: bar(0.0) }).unwrap();
                        must_sent += 1;
                    }
                    5 => {
                        *s += 1;
                        out.push(ServerMessage::Reload { sub: sub.into(), seq: *s, reason: ReloadReason::Replaced, from: None }).unwrap();
                        must_sent += 1;
                    }
                    _ => received.extend(out.take(next() % 2 == 0).messages),
                }
            }
            received.extend(out.take(true).messages);
            let mut last: HashMap<String, u64> = HashMap::new();
            for m in &received {
                let (sub, s) = seq_of(m).unwrap();
                let prev = last.insert(sub.to_owned(), s);
                assert!(prev.is_none_or(|p| p < s), "round {round}: {sub}의 seq {prev:?} 다음에 {s}");
            }
            let must_got = received.iter().filter(|m| !matches!(m, ServerMessage::Bar { .. })).count();
            assert_eq!(must_got, must_sent, "round {round}: 버리면 안 되는 메시지는 모두 간다");
            for (sub, s) in &seq {
                let newest_bar_or_must = received.iter().rev().find_map(|m| seq_of(m).filter(|(x, _)| x == sub)).map(|(_, s)| s);
                assert_eq!(newest_bar_or_must, Some(*s), "round {round}: {sub}의 마지막 상태가 간다");
            }
        }
    }

    #[test]
    fn bars_keep_only_the_newest_per_sub_and_wait_for_the_tick() {
        let out = Outbox::new();
        let a = SubId("a".into());
        out.set_bar(&a, 1, bar(1.0));
        out.set_bar(&a, 2, bar(2.0));
        assert_eq!(out.take(false).messages, vec![], "곧바로 보내는 꺼내기에는 bar가 없다");
        assert_eq!(out.take(true).messages, vec![ServerMessage::Bar { sub: "a".into(), seq: 2, bar: bar(2.0) }]);
        assert_eq!(out.take(true).messages, vec![], "보낸 bar는 다시 가지 않는다");
    }

    #[test]
    fn a_full_must_queue_closes_the_connection() {
        let out = Outbox::new();
        for i in 0..MUST_CAPACITY {
            out.push(ServerMessage::Confirmed { sub: "a".into(), seq: i as u64, bar: bar(0.0) }).unwrap();
        }
        assert_eq!(out.push(ServerMessage::Confirmed { sub: "a".into(), seq: 999, bar: bar(0.0) }), Err(Closed));
        assert!(out.take(true).closed);
        assert_eq!(out.push(ServerMessage::Status { status: crate::api::ConnectionStatus { realtime: crate::api::RealtimeState::Live, since: UnixSeconds(0), backfilling: false } }), Err(Closed));
    }
}
