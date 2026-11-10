//! 구독 관리자(backend.md §5.3). 순수하다. 같은 상태와 같은 `now`면 언제나 같은 계획을 낸다.
//!
//! 키움 쪽 구독 단위는 종목이다.

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
    Watch { conn: ConnId, symbol: Symbol },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Rank {
    Cell { held: u64 },
    Watch { row: usize, held: u64 },
}

impl Rank {
    /// 보유자 가운데 가장 앞선 순위라서, 관심종목 순위면 칸이 잡지 않은 종목이다.
    fn is_watch_only(self) -> bool {
        matches!(self, Rank::Watch { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Plan {
    /// 키움에 REG 할 집합. 크기 ≤ REALTIME_LIMIT.
    pub realtime: BTreeSet<Symbol>,
    pub rejected: BTreeSet<Holder>,
}

#[derive(Debug, Default)]
pub struct SubscriptionManager {
    holders: BTreeMap<Symbol, BTreeSet<Holder>>,
    held_order: BTreeMap<Symbol, u64>,
    next_order: u64,
    released_at: BTreeMap<Symbol, KstTime>,
    admitted: BTreeSet<Symbol>,
    watch_rows: BTreeMap<ConnId, BTreeMap<Symbol, usize>>,
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

    pub fn set_watch(&mut self, conn: ConnId, symbols: Vec<Symbol>, now: KstTime) {
        let mut rows: BTreeMap<Symbol, usize> = BTreeMap::new();
        for (row, s) in symbols.into_iter().enumerate() {
            rows.entry(s).or_insert(row);
        }
        let old = if rows.is_empty() { self.watch_rows.remove(&conn) } else { self.watch_rows.insert(conn, rows.clone()) }.unwrap_or_default();
        for &symbol in old.keys().filter(|s| !rows.contains_key(s)) {
            self.release(symbol, &Holder::Watch { conn, symbol }, now);
        }
        for &symbol in rows.keys().filter(|s| !old.contains_key(s)) {
            self.hold(symbol, Holder::Watch { conn, symbol });
        }
    }

    pub fn release_conn(&mut self, conn: ConnId, now: KstTime) {
        let held: Vec<(Symbol, Holder)> = self
            .holders
            .iter()
            .flat_map(|(s, hs)| hs.iter().filter(|h| h.conn() == conn).map(|h| (*s, h.clone())))
            .collect();
        for (s, h) in held {
            self.release(s, &h, now);
        }
        self.watch_rows.remove(&conn);
    }

    pub fn is_admitted(&self, symbol: Symbol) -> bool {
        self.admitted.contains(&symbol)
    }

    pub fn watchers(&self, symbol: Symbol) -> impl Iterator<Item = ConnId> + '_ {
        self.holders.get(&symbol).into_iter().flatten().filter_map(|h| match h {
            Holder::Watch { conn, .. } => Some(*conn),
            Holder::Cell { .. } => None,
        })
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
        let mut candidates: Vec<(Rank, Symbol)> =
            self.holders.keys().filter(|s| !self.admitted.contains(s)).map(|s| (self.rank(*s), *s)).collect();
        candidates.sort();
        for (rank, s) in candidates {
            if self.admitted.len() >= REALTIME_LIMIT && !self.make_room(rank) {
                continue;
            }
            self.admitted.insert(s);
        }
        let rejected = self.holders.iter().filter(|(s, _)| !self.admitted.contains(s)).flat_map(|(_, hs)| hs.iter().cloned()).collect();
        Plan { realtime: self.admitted.clone(), rejected }
    }

    fn make_room(&mut self, rank: Rank) -> bool {
        let out = self.oldest_in_grace().or_else(|| {
            self.admitted
                .iter()
                .filter(|s| self.holders.contains_key(s))
                .map(|s| (self.rank(*s), *s))
                .filter(|(r, _)| r.is_watch_only() && *r > rank)
                .max()
                .map(|(_, s)| s)
        });
        let Some(s) = out else {
            return false;
        };
        self.released_at.remove(&s);
        self.admitted.remove(&s);
        true
    }

    fn rank(&self, symbol: Symbol) -> Rank {
        let held = self.held_order[&symbol];
        self.holders[&symbol]
            .iter()
            .map(|h| match h {
                Holder::Cell { .. } => Rank::Cell { held },
                Holder::Watch { conn, .. } => Rank::Watch { row: self.watch_rows[conn][&symbol], held },
            })
            .min()
            .expect("보유자가 있는 종목")
    }

    fn oldest_in_grace(&self) -> Option<Symbol> {
        self.released_at.iter().min_by_key(|(s, at)| (**at, **s)).map(|(s, _)| *s)
    }
}

impl Holder {
    fn conn(&self) -> ConnId {
        match self {
            Holder::Cell { conn, .. } | Holder::Watch { conn, .. } => *conn,
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

    fn watch(conn: u64, i: usize) -> Holder {
        Holder::Watch { conn: ConnId(conn), symbol: stock(i) }
    }

    fn stocks(range: impl Iterator<Item = usize>) -> Vec<Symbol> {
        range.map(stock).collect()
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
    fn watch_rows_get_places_from_the_top_of_the_list() {
        let mut m = SubscriptionManager::default();
        m.set_watch(ConnId(1), stocks(0..REALTIME_LIMIT + 3), t(0));
        let plan = m.plan(t(0));
        assert_eq!(plan.realtime, stocks(0..REALTIME_LIMIT).into_iter().collect());
        assert_eq!(plan.rejected, BTreeSet::from([watch(1, REALTIME_LIMIT), watch(1, REALTIME_LIMIT + 1), watch(1, REALTIME_LIMIT + 2)]));
    }

    #[test]
    fn moving_a_row_to_the_top_takes_the_place_of_the_last_realtime_row() {
        let mut m = SubscriptionManager::default();
        m.set_watch(ConnId(1), stocks(0..REALTIME_LIMIT + 1), t(0));
        m.plan(t(0));
        let mut moved = vec![stock(REALTIME_LIMIT)];
        moved.extend(stocks(0..REALTIME_LIMIT));
        m.set_watch(ConnId(1), moved, t(1));
        let plan = m.plan(t(1));
        assert!(plan.realtime.contains(&stock(REALTIME_LIMIT)));
        assert_eq!(plan.rejected, BTreeSet::from([watch(1, REALTIME_LIMIT - 1)]), "유예 없이 맨 아래 실시간 줄이 자리를 내준다");
        assert_eq!(m.plan(t(1)), plan, "다시 불러도 같다");
    }

    #[test]
    fn a_cell_takes_the_place_of_the_last_watch_only_symbol() {
        let mut m = SubscriptionManager::default();
        m.set_watch(ConnId(1), stocks(0..REALTIME_LIMIT), t(0));
        m.plan(t(0));
        m.hold(stock(500), cell(2, "c"));
        let plan = m.plan(t(1));
        assert!(plan.realtime.contains(&stock(500)));
        assert_eq!(plan.rejected, BTreeSet::from([watch(1, REALTIME_LIMIT - 1)]));
    }

    #[test]
    fn a_symbol_held_by_a_cell_and_a_watch_row_ranks_as_a_cell() {
        let mut m = SubscriptionManager::default();
        m.set_watch(ConnId(1), stocks(0..REALTIME_LIMIT), t(0));
        m.hold(stock(REALTIME_LIMIT - 1), cell(2, "c"));
        m.plan(t(0));
        m.hold(stock(500), cell(2, "d"));
        let plan = m.plan(t(1));
        assert!(plan.realtime.contains(&stock(REALTIME_LIMIT - 1)), "칸이 잡은 종목은 밀리지 않는다");
        assert_eq!(plan.rejected, BTreeSet::from([watch(1, REALTIME_LIMIT - 2)]));
    }

    #[test]
    fn a_watch_row_never_pushes_out_a_cell() {
        let mut m = SubscriptionManager::default();
        fill(&mut m, REALTIME_LIMIT);
        m.plan(t(0));
        m.set_watch(ConnId(2), vec![stock(500)], t(1));
        let plan = m.plan(t(1));
        assert!(!plan.realtime.contains(&stock(500)));
        assert_eq!(plan.rejected, BTreeSet::from([Holder::Watch { conn: ConnId(2), symbol: stock(500) }]));
    }

    #[test]
    fn rows_of_two_connections_share_places_by_row() {
        let mut m = SubscriptionManager::default();
        m.set_watch(ConnId(1), stocks(0..REALTIME_LIMIT), t(0));
        m.plan(t(0));
        m.set_watch(ConnId(2), vec![stock(500)], t(1));
        let plan = m.plan(t(1));
        assert!(plan.realtime.contains(&stock(500)), "다른 연결의 맨 윗줄이 이 연결의 맨 아랫줄보다 앞선다");
        assert_eq!(plan.rejected, BTreeSet::from([watch(1, REALTIME_LIMIT - 1)]));
    }

    #[test]
    fn a_dropped_row_keeps_the_symbol_for_the_grace() {
        let mut m = SubscriptionManager::default();
        m.set_watch(ConnId(1), stocks(0..2), t(0));
        m.plan(t(0));
        m.set_watch(ConnId(1), vec![stock(1)], t(0));
        assert_eq!(m.plan(t(29)).realtime, stocks(0..2).into_iter().collect());
        assert_eq!(m.plan(t(30)).realtime, BTreeSet::from([stock(1)]));
        m.set_watch(ConnId(1), Vec::new(), t(30));
        assert_eq!(m.plan(t(59)).realtime, BTreeSet::from([stock(1)]), "목록을 닫아도 30초 더 받는다");
        assert_eq!(m.plan(t(60)).realtime, BTreeSet::new());
    }

    #[test]
    fn release_conn_releases_watch_rows() {
        let mut m = SubscriptionManager::default();
        m.set_watch(ConnId(1), vec![stock(0)], t(0));
        m.plan(t(0));
        m.release_conn(ConnId(1), t(0));
        assert_eq!(m.watchers(stock(0)).count(), 0);
        assert_eq!(m.plan(t(29)).realtime, BTreeSet::from([stock(0)]));
        assert_eq!(m.plan(t(30)).realtime, BTreeSet::new());
    }

    #[test]
    fn same_state_and_now_give_the_same_plan() {
        let build = || {
            let mut m = SubscriptionManager::default();
            fill(&mut m, REALTIME_LIMIT - 10);
            m.set_watch(ConnId(2), stocks(300..320), t(0));
            m.plan(t(0));
            m.release(stock(4), &cell(1, "s4"), t(1));
            m.set_watch(ConnId(2), stocks(305..325), t(1));
            m
        };
        let (mut a, mut b) = (build(), build());
        let pa = a.plan(t(2));
        assert_eq!(pa, b.plan(t(2)));
        assert_eq!(pa, a.plan(t(2)), "다시 불러도 같다");
    }
}
