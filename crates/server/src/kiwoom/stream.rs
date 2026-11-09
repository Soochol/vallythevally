//! 키움 WebSocket 세션(backend.md §5.1, §5.2). 토큰 하나에 세션 하나라서 서버 안에서도 세션은 언제나 하나다.

use std::collections::BTreeSet;

use domain::{KstTime, Price, Symbol, TimeOfDay, Volume};
use tokio::sync::{mpsc, watch};

use super::rest::KiwoomRest;
use crate::clock::Clock;

/// 0B `9081`. `_AL` 한 흐름이 KRX와 NXT 체결을 함께 준다(kiwoom.md 11.1, 11.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Exchange {
    Krx,
    Nxt,
}

/// 실시간 체결 하나. 날짜는 아직 없다(`domain::resolve_trade_time`이 붙인다).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RealTick {
    pub symbol: Symbol,
    pub hhmmss: TimeOfDay,
    pub price: Price,
    pub qty: Volume,
    /// 지수(0J)와 `9081`이 없거나 모르는 값이면 None.
    pub exchange: Option<Exchange>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamEvent {
    Tick { tick: RealTick, received_at: KstTime },
    /// 세션이 LOGIN을 마치고 원하는 집합을 모두 REG 했다.
    Live { since: KstTime },
    /// 세션이 끊겼다. 다음 Live까지는 체결이 빠졌을 수 있다.
    Down { at: KstTime },
    /// 인증 실패. 운영자가 고칠 때까지 다시 연결하지 않는다. REST는 그대로 쓴다.
    Halted,
}

/// 세션 태스크의 손잡이. 받을 종목 전체 집합을 통째로 주면 세션이 차이를 REG/REMOVE 한다.
pub struct KiwoomStream {
    desired: watch::Sender<BTreeSet<Symbol>>,
}

impl KiwoomStream {
    pub fn spawn(url: String, rest: KiwoomRest, clock: Clock) -> (KiwoomStream, mpsc::Receiver<StreamEvent>) {
        let _ = (url, rest, clock);
        todo!("#4 세션 태스크")
    }

    /// 세션 없이 손잡이만 만든다. 시험이 원하는 집합을 읽는다.
    pub fn detached() -> (KiwoomStream, watch::Receiver<BTreeSet<Symbol>>) {
        let (desired, rx) = watch::channel(BTreeSet::new());
        (KiwoomStream { desired }, rx)
    }

    pub fn set_desired(&self, desired: BTreeSet<Symbol>) {
        self.desired.send_if_modified(|cur| {
            let changed = *cur != desired;
            *cur = desired;
            changed
        });
    }
}
