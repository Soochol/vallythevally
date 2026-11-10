//! 구독 관리자(backend.md §5.3). 순수하다. 같은 상태와 같은 `now`면 언제나 같은 계획을 낸다.
//!
//! 키움 쪽 구독 단위는 종목이다. 보유자는 브라우저 칸의 구독 하나다(관심종목·알림 보유자는 #4 범위 밖).

use std::collections::{BTreeMap, BTreeSet};

use domain::{KstTime, Symbol};

use super::{ConnId, SubId};

/// 보유자가 모두 빠진 종목을 이만큼 더 받는다. 칸의 종목을 바꿨다가 바로 돌아와도 다시 받기를 기다리지 않는다.
pub const RELEASE_GRACE_SECS: i64 = 30;
/// 키움 접속 전체 한도. 0B 종목과 0J 지수를 더해서 센다(kiwoom.md §10.7).
pub const REALTIME_LIMIT: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Holder {
    /// 브라우저 연결 하나의 구독 하나.
    Cell { conn: ConnId, sub: SubId },
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Plan {
    /// 키움에 REG 할 집합. 크기 ≤ REALTIME_LIMIT.
    pub realtime: BTreeSet<Symbol>,
    /// 한도를 넘어 받을 수 없는 보유자.
    pub rejected: BTreeSet<Holder>,
}

#[derive(Debug, Default)]
pub struct SubscriptionManager {
    holders: BTreeMap<Symbol, BTreeSet<Holder>>,
    held_order: BTreeMap<Symbol, u64>,
    next_order: u64,
    released_at: BTreeMap<Symbol, KstTime>,
    admitted: BTreeSet<Symbol>,
}

impl SubscriptionManager {
    /// 유예 중인 종목이면 유예를 취소한다.
    pub fn hold(&mut self, symbol: Symbol, h: Holder) {
        self.released_at.remove(&symbol);
        if !self.held_order.contains_key(&symbol) {
            self.held_order.insert(symbol, self.next_order);
            self.next_order += 1;
        }
        self.holders.entry(symbol).or_default().insert(h);
    }

    pub fn release(&mut self, symbol: Symbol, h: &Holder, now: KstTime) {
        if self.remove_holder_left_empty(symbol, h) && self.admitted.contains(&symbol) {
            self.released_at.insert(symbol, now);
        }
    }

    /// 유예 없이 놓는다. 키움에 없는 종목처럼 받을 이유가 없는 보유자에 쓴다.
    pub fn forget(&mut self, symbol: Symbol, h: &Holder) {
        if self.remove_holder_left_empty(symbol, h) {
            self.admitted.remove(&symbol);
        }
    }

    /// 연결이 끊긴 브라우저의 모든 구독을 놓는다.
    pub fn release_conn(&mut self, conn: ConnId, now: KstTime) {
        let held: Vec<(Symbol, Holder)> = self
            .holders
            .iter()
            .flat_map(|(s, hs)| hs.iter().filter(|h| h.conn() == conn).map(|h| (*s, h.clone())))
            .collect();
        for (s, h) in held {
            self.release(s, &h, now);
        }
    }

    pub fn is_admitted(&self, symbol: Symbol) -> bool {
        self.admitted.contains(&symbol)
    }

    fn remove_holder_left_empty(&mut self, symbol: Symbol, h: &Holder) -> bool {
        let Some(hs) = self.holders.get_mut(&symbol) else {
            return false;
        };
        hs.remove(h);
        if !hs.is_empty() {
            return false;
        }
        self.holders.remove(&symbol);
        self.held_order.remove(&symbol);
        true
    }

    /// admitted를 갱신한다. 한 번 더 같은 now로 부르면 같은 계획이다.
    pub fn plan(&mut self, now: KstTime) -> Plan {
        let expired: Vec<Symbol> =
            self.released_at.iter().filter(|(_, at)| at.plus_secs(RELEASE_GRACE_SECS) <= now).map(|(s, _)| *s).collect();
        for s in expired {
            self.released_at.remove(&s);
            self.admitted.remove(&s);
        }
        let mut candidates: Vec<(u64, Symbol)> =
            self.holders.keys().filter(|s| !self.admitted.contains(s)).map(|s| (self.held_order[s], *s)).collect();
        candidates.sort();
        let mut rejected = BTreeSet::new();
        for (_, s) in candidates {
            if self.admitted.len() >= REALTIME_LIMIT {
                match self.oldest_in_grace() {
                    Some(g) => {
                        self.released_at.remove(&g);
                        self.admitted.remove(&g);
                    }
                    None => {
                        rejected.extend(self.holders[&s].iter().cloned());
                        continue;
                    }
                }
            }
            self.admitted.insert(s);
        }
        Plan { realtime: self.admitted.clone(), rejected }
    }

    fn oldest_in_grace(&self) -> Option<Symbol> {
        self.released_at.iter().min_by_key(|(s, at)| (**at, **s)).map(|(s, _)| *s)
    }
}

impl Holder {
    fn conn(&self) -> ConnId {
        match self {
            Holder::Cell { conn, .. } => *conn,
        }
    }
}

#[cfg(test)]
mod tests {
    use domain::{IndexCode, KstDate};

    use super::*;
    use crate::clock::kst;

    fn t(s: i64) -> KstTime {
        kst(KstDate::new(2026, 11, 9).unwrap(), 10, 0, 0).plus_secs(s)
    }

    fn stock(i: usize) -> Symbol {
        Symbol::parse(&format!("{:06}", 100_000 + i)).unwrap()
    }

    fn cell(conn: u64, sub: &str) -> Holder {
        Holder::Cell { conn: ConnId(conn), sub: SubId(sub.into()) }
    }

    fn fill(m: &mut SubscriptionManager, n: usize) {
        for i in 0..n {
            m.hold(stock(i), cell(1, &format!("s{i}")));
        }
    }

    #[test]
    fn hold_admits_and_release_keeps_the_symbol_for_the_grace() {
        let mut m = SubscriptionManager::default();
        m.hold(stock(0), cell(1, "a"));
        assert_eq!(m.plan(t(0)).realtime, BTreeSet::from([stock(0)]));
        m.release(stock(0), &cell(1, "a"), t(0));
        assert_eq!(m.plan(t(29)).realtime, BTreeSet::from([stock(0)]), "30초 유예 동안 계속 받는다");
        assert_eq!(m.plan(t(30)).realtime, BTreeSet::new());
    }

    #[test]
    fn resubscribe_within_the_grace_keeps_the_symbol() {
        let mut m = SubscriptionManager::default();
        m.hold(stock(0), cell(1, "a"));
        m.plan(t(0));
        m.release(stock(0), &cell(1, "a"), t(0));
        m.hold(stock(0), cell(2, "b"));
        assert_eq!(m.plan(t(60)).realtime, BTreeSet::from([stock(0)]));
    }

    #[test]
    fn one_holder_leaving_keeps_the_symbol_while_another_holds_it() {
        let mut m = SubscriptionManager::default();
        m.hold(stock(0), cell(1, "a"));
        m.hold(stock(0), cell(2, "a"));
        m.plan(t(0));
        m.release_conn(ConnId(1), t(0));
        assert_eq!(m.plan(t(100)).realtime, BTreeSet::from([stock(0)]));
        m.release_conn(ConnId(2), t(100));
        assert_eq!(m.plan(t(129)).realtime, BTreeSet::from([stock(0)]));
        assert_eq!(m.plan(t(130)).realtime, BTreeSet::new());
    }

    #[test]
    fn indices_count_toward_the_limit() {
        let mut m = SubscriptionManager::default();
        m.hold(Symbol::Index(IndexCode::KOSPI), cell(9, "k"));
        m.hold(Symbol::Index(IndexCode::KOSDAQ), cell(9, "q"));
        fill(&mut m, REALTIME_LIMIT - 1);
        let plan = m.plan(t(0));
        assert_eq!(plan.realtime.len(), REALTIME_LIMIT);
        assert!(plan.realtime.contains(&Symbol::Index(IndexCode::KOSPI)));
        assert_eq!(plan.rejected, BTreeSet::from([cell(1, &format!("s{}", REALTIME_LIMIT - 2))]), "먼저 잡은 순서로 넣고 마지막 하나가 넘친다");
    }

    #[test]
    fn a_new_symbol_never_pushes_out_an_admitted_held_one() {
        let mut m = SubscriptionManager::default();
        fill(&mut m, REALTIME_LIMIT);
        let before = m.plan(t(0)).realtime;
        m.hold(stock(500), cell(2, "new"));
        let plan = m.plan(t(1));
        assert_eq!(plan.realtime, before);
        assert_eq!(plan.rejected, BTreeSet::from([cell(2, "new")]));
    }

    #[test]
    fn a_symbol_in_grace_makes_room_and_the_oldest_release_goes_first() {
        let mut m = SubscriptionManager::default();
        fill(&mut m, REALTIME_LIMIT);
        m.plan(t(0));
        m.release(stock(7), &cell(1, "s7"), t(1));
        m.release(stock(3), &cell(1, "s3"), t(2));
        m.hold(stock(500), cell(2, "new"));
        let plan = m.plan(t(3));
        assert!(plan.rejected.is_empty());
        assert!(plan.realtime.contains(&stock(500)));
        assert!(!plan.realtime.contains(&stock(7)), "먼저 놓인 종목을 뺀다");
        assert!(plan.realtime.contains(&stock(3)));
        assert_eq!(plan.realtime.len(), REALTIME_LIMIT);
    }

    #[test]
    fn rejected_holders_recover_when_room_frees() {
        let mut m = SubscriptionManager::default();
        fill(&mut m, REALTIME_LIMIT);
        m.hold(stock(500), cell(2, "x"));
        m.hold(stock(500), cell(3, "y"));
        m.hold(stock(501), cell(2, "z"));
        assert_eq!(m.plan(t(0)).rejected, BTreeSet::from([cell(2, "x"), cell(3, "y"), cell(2, "z")]));
        m.release(stock(0), &cell(1, "s0"), t(10));
        let plan = m.plan(t(10));
        assert!(plan.realtime.contains(&stock(500)), "유예 중인 종목을 빼서 먼저 잡은 종목을 넣는다");
        assert_eq!(plan.rejected, BTreeSet::from([cell(2, "z")]));
    }

    #[test]
    fn a_rejected_holder_leaving_frees_nothing_and_needs_no_grace() {
        let mut m = SubscriptionManager::default();
        fill(&mut m, REALTIME_LIMIT);
        m.hold(stock(500), cell(2, "x"));
        m.plan(t(0));
        m.release(stock(500), &cell(2, "x"), t(1));
        let plan = m.plan(t(1));
        assert!(plan.rejected.is_empty());
        assert!(!plan.realtime.contains(&stock(500)));
    }

    #[test]
    fn forget_drops_the_symbol_without_grace() {
        let mut m = SubscriptionManager::default();
        m.hold(stock(0), cell(1, "a"));
        m.plan(t(0));
        m.forget(stock(0), &cell(1, "a"));
        assert_eq!(m.plan(t(0)).realtime, BTreeSet::new());
    }

    #[test]
    fn same_state_and_now_give_the_same_plan() {
        let build = || {
            let mut m = SubscriptionManager::default();
            fill(&mut m, REALTIME_LIMIT + 5);
            m.plan(t(0));
            m.release(stock(4), &cell(1, "s4"), t(1));
            m
        };
        let (mut a, mut b) = (build(), build());
        let pa = a.plan(t(2));
        assert_eq!(pa, b.plan(t(2)));
        assert_eq!(pa, a.plan(t(2)), "다시 불러도 같다");
    }
}
