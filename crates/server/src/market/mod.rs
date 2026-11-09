//! 실시간(backend.md §5.3, §5.5): 구독 관리자와 `MarketHub` 액터.

pub mod subscriptions;

/// 브라우저 WebSocket 연결 하나. 서버가 연결마다 새로 붙인다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ConnId(pub u64);

/// 브라우저가 정하는 구독 이름. 연결 안에서만 유일하다.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SubId(pub String);
