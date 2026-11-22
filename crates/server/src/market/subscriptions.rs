//! 구독 관리자(backend.md §5.3). 순수하다. 같은 상태와 같은 `now`면 언제나 같은 계획을 낸다.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use domain::{KstTime, Symbol};

use super::{ConnId, SubId};
use crate::market_source::stream::{DesiredFeeds, SeatRules, StreamKind};

/// 보유자가 모두 빠진 종목을 이만큼 더 받는다. 칸의 종목을 바꿨다가 바로 돌아와도 다시 받기를 기다리지 않는다.
pub const RELEASE_GRACE_SECS: i64 = 30;

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Holder {
    /// 브라우저 연결 하나의 구독 하나.
    Cell { conn: ConnId, sub: SubId },
    Watch { conn: ConnId, symbol: Symbol },
    Feed { conn: ConnId, sub: SubId, kind: StreamKind },
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
    pub realtime: BTreeSet<Symbol>,
    pub feeds: DesiredFeeds,
    pub rejected: BTreeSet<Holder>,
}

pub struct SubscriptionManager {
    rules: Arc<dyn SeatRules>,
    holders: BTreeMap<Symbol, BTreeSet<Holder>>,
    held_order: BTreeMap<Symbol, u64>,
    next_order: u64,
    released_at: BTreeMap<Symbol, KstTime>,
    kind_released_at: BTreeMap<(Symbol, StreamKind), KstTime>,
    admitted: BTreeSet<Symbol>,
    admitted_venue: BTreeSet<(Symbol, StreamKind)>,
    watch_rows: BTreeMap<ConnId, BTreeMap<Symbol, usize>>,
}

impl SubscriptionManager {
    pub fn new(rules: Arc<dyn SeatRules>) -> SubscriptionManager {
        SubscriptionManager {
            rules,
            holders: BTreeMap::new(),
            held_order: BTreeMap::new(),
            next_order: 0,
            released_at: BTreeMap::new(),
            kind_released_at: BTreeMap::new(),
            admitted: BTreeSet::new(),
            admitted_venue: BTreeSet::new(),
            watch_rows: BTreeMap::new(),
        }
    }

    /// 유예 중인 종목이면 유예를 취소한다.
    pub fn hold(&mut self, symbol: Symbol, h: Holder) {
        if self.has_seat(symbol, &h) || !self.admitted.contains(&symbol) {
            self.released_at.remove(&symbol);
        }
        if let Some(kind) = h.feed_kind() {
            self.kind_released_at.remove(&(symbol, kind));
        }
        if !self.held_order.contains_key(&symbol) {
            self.held_order.insert(symbol, self.next_order);
            self.next_order += 1;
        }
        self.holders.entry(symbol).or_default().insert(h);
    }

    pub fn release(&mut self, symbol: Symbol, h: &Holder, now: KstTime) {
        let was_held = self.holders.get(&symbol).is_some_and(|hs| hs.contains(h));
        let left_empty = self.remove_holder_left_empty(symbol, h);
        if !self.admitted.contains(&symbol) {
            return;
        }
        if was_held && let Some(kind) = h.feed_kind() && !self.kind_is_held(symbol, kind) && self.has_kind_seat(symbol, kind) {
            self.kind_released_at.insert((symbol, kind), now);
        }
        if left_empty || !self.is_served(symbol) {
            self.released_at.entry(symbol).or_insert(now);
        }
    }

    fn kind_is_held(&self, symbol: Symbol, kind: StreamKind) -> bool {
        self.holders.get(&symbol).into_iter().flatten().any(|h| h.feed_kind() == Some(kind))
    }

    fn has_kind_seat(&self, symbol: Symbol, kind: StreamKind) -> bool {
        self.rules.own_seats(symbol, kind).iter().all(|seat| self.admitted_venue.contains(&(symbol, *seat)))
    }

    fn has_seat(&self, symbol: Symbol, holder: &Holder) -> bool {
        self.admitted.contains(&symbol) && holder.feed_kind().is_none_or(|kind| self.has_kind_seat(symbol, kind))
    }

    fn needs_only_venue_codes(&self, symbol: Symbol) -> bool {
        self.holders.get(&symbol).into_iter().flatten().all(|h| h.feed_kind().is_some_and(|kind| !self.rules.own_seats(symbol, kind).is_empty()))
    }

    fn is_served(&self, symbol: Symbol) -> bool {
        self.holders.get(&symbol).into_iter().flatten().any(|h| h.feed_kind().is_none_or(|kind| self.has_kind_seat(symbol, kind)))
    }

    fn held_venue_kinds(&self, symbol: Symbol) -> BTreeSet<StreamKind> {
        self.holders.get(&symbol).into_iter().flatten().filter_map(Holder::feed_kind).flat_map(|kind| self.rules.own_seats(symbol, kind)).collect()
    }

    fn seat_wanted(&self, symbol: Symbol, seat: StreamKind) -> bool {
        self.seat_wanted_without(symbol, seat, &[])
    }

    fn seat_wanted_without(&self, symbol: Symbol, seat: StreamKind, evicted: &[Eviction]) -> bool {
        let gone = |kind: StreamKind| evicted.iter().any(|e| matches!(*e, Eviction::Venue(s, k) if s == symbol && k == kind));
        let held = self.holders.get(&symbol).into_iter().flatten().filter_map(Holder::feed_kind).filter(|kind| self.has_kind_seat(symbol, *kind));
        let in_grace = self.kind_released_at.keys().filter(|(s, kind)| *s == symbol && !gone(*kind)).map(|(_, kind)| *kind);
        held.chain(in_grace).any(|kind| self.rules.own_seats(symbol, kind).contains(&seat))
    }

    fn unwanted_seats(&self, symbol: Symbol, evicted: &[Eviction]) -> usize {
        self.admitted_venue.iter().filter(|(s, seat)| *s == symbol && !self.seat_wanted_without(symbol, *seat, evicted)).count()
    }

    fn seats_used(&self) -> usize {
        self.admitted.len() + self.admitted_venue.len()
    }

    /// 유예 없이 놓는다. 키움에 없는 종목처럼 받을 이유가 없는 보유자에 쓴다.
    pub fn forget(&mut self, symbol: Symbol, h: &Holder) {
        if let Some(kind) = h.feed_kind() {
            self.kind_released_at.remove(&(symbol, kind));
        }
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

    pub fn admitted_watch(&self, conn: ConnId) -> impl Iterator<Item = Symbol> + '_ {
        self.watch_rows.get(&conn).into_iter().flat_map(BTreeMap::keys).copied().filter(|s| self.admitted.contains(s))
    }

    pub fn watchers(&self, symbol: Symbol) -> impl Iterator<Item = ConnId> + '_ {
        self.holders.get(&symbol).into_iter().flatten().filter_map(|h| match h {
            Holder::Watch { conn, .. } => Some(*conn),
            Holder::Cell { .. } | Holder::Feed { .. } => None,
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
        self.kind_released_at.retain(|_, at| at.plus_secs(RELEASE_GRACE_SECS) > now);
        self.admitted_venue = self.admitted_venue.iter().copied().filter(|&(s, kind)| self.admitted.contains(&s) && self.seat_wanted(s, kind)).collect();
        let unserved: Vec<Symbol> = self.admitted.iter().copied().filter(|&s| self.holders.contains_key(&s) && !self.released_at.contains_key(&s) && !self.is_served(s)).collect();
        for s in unserved {
            self.admitted.remove(&s);
        }
        let mut candidates: Vec<(Rank, Symbol)> =
            self.holders.keys().filter(|s| !self.admitted.contains(s)).map(|s| (self.rank(*s), *s)).collect();
        candidates.sort();
        for (rank, s) in candidates {
            let venue_kinds = if self.needs_only_venue_codes(s) { self.held_venue_kinds(s) } else { BTreeSet::new() };
            if !self.seats_fit(1 + venue_kinds.len(), rank, None) {
                continue;
            }
            self.admitted.insert(s);
            self.admitted_venue.extend(venue_kinds.into_iter().map(|kind| (s, kind)));
        }
        let mut wanting: Vec<(Rank, Symbol, StreamKind)> = Vec::new();
        for &s in &self.admitted {
            let held = self.holders.get(&s).into_iter().flatten().filter_map(Holder::feed_kind).collect::<BTreeSet<_>>();
            wanting.extend(held.into_iter().map(|kind| (self.rank(s), s, kind)));
        }
        wanting.sort();
        for (rank, s, kind) in wanting {
            let missing: Vec<StreamKind> = self.rules.own_seats(s, kind).into_iter().filter(|seat| !self.admitted_venue.contains(&(s, *seat))).collect();
            if !missing.is_empty() && self.admitted.contains(&s) && self.seats_fit(missing.len(), rank, Some(s)) {
                self.admitted_venue.extend(missing.into_iter().map(|seat| (s, seat)));
                self.released_at.remove(&s);
            }
        }
        let rejected = self.holders.iter().flat_map(|(s, hs)| hs.iter().filter(|h| !self.has_seat(*s, h)).cloned()).collect();
        let mut kind_released_at = std::mem::take(&mut self.kind_released_at);
        kind_released_at.retain(|&(s, kind), _| self.admitted.contains(&s) && self.has_kind_seat(s, kind));
        self.kind_released_at = kind_released_at;
        let feeds: DesiredFeeds = self.admitted.iter().map(|&s| (s, self.kinds_to_receive(s))).collect();
        debug_assert_eq!(self.rules.seats(&feeds), self.seats_used(), "관리자와 규칙이 자리를 다르게 센다");
        Plan { realtime: self.admitted.clone(), feeds, rejected }
    }

    fn kinds_to_receive(&self, symbol: Symbol) -> BTreeSet<StreamKind> {
        let held = self.holders.get(&symbol).into_iter().flatten().filter(|h| self.has_seat(symbol, h)).filter_map(Holder::feed_kind);
        let in_grace = self.kind_released_at.keys().filter(|(s, kind)| *s == symbol && self.has_kind_seat(symbol, *kind)).map(|(_, kind)| *kind);
        let feeds: Vec<StreamKind> = held.chain(in_grace).collect();
        std::iter::once(StreamKind::base(symbol)).chain(feeds.iter().copied()).chain(feeds.iter().filter_map(|kind| self.rules.companion(*kind))).collect()
    }

    fn seats_fit(&mut self, cost: usize, rank: Rank, keep: Option<Symbol>) -> bool {
        let needed = (self.seats_used() + cost).saturating_sub(self.rules.limit());
        needed == 0 || self.make_room(rank, needed, keep)
    }

    fn make_room(&mut self, rank: Rank, needed: usize, keep: Option<Symbol>) -> bool {
        let mut victims: Vec<Eviction> = Vec::new();
        let mut freed = 0;
        for victim in self.eviction_order(rank).into_iter().filter(|victim| keep != Some(victim.symbol())) {
            freed += self.seats_freed_by(victim, &victims);
            victims.push(victim);
            if freed >= needed {
                break;
            }
        }
        if freed < needed {
            return false;
        }
        for victim in victims {
            self.evict(victim);
        }
        true
    }

    fn eviction_order(&self, rank: Rank) -> Vec<Eviction> {
        let mut graces: Vec<(KstTime, Symbol, Option<StreamKind>)> = self.released_at.iter().map(|(s, at)| (*at, *s, None)).collect();
        graces.extend(
            self.kind_released_at
                .iter()
                .filter(|((s, kind), _)| !self.released_at.contains_key(s) && self.rules.own_seats(*s, *kind).iter().any(|seat| self.admitted_venue.contains(&(*s, *seat))))
                .map(|((s, kind), at)| (*at, *s, Some(*kind))),
        );
        graces.sort();
        let mut watch_only: Vec<(Rank, Symbol)> = self
            .admitted
            .iter()
            .filter(|s| self.holders.contains_key(s) && !self.released_at.contains_key(s))
            .map(|s| (self.rank(*s), *s))
            .filter(|(r, _)| r.is_watch_only() && *r > rank)
            .collect();
        watch_only.sort_by(|a, b| b.cmp(a));
        graces
            .into_iter()
            .map(|(_, s, kind)| kind.map_or(Eviction::Symbol(s), |kind| Eviction::Venue(s, kind)))
            .chain(watch_only.into_iter().map(|(_, s)| Eviction::Symbol(s)))
            .collect()
    }

    fn seats_freed_by(&self, victim: Eviction, chosen: &[Eviction]) -> usize {
        let symbol = victim.symbol();
        let whole_symbol_out = |list: &[Eviction]| list.iter().any(|e| matches!(*e, Eviction::Symbol(x) if x == symbol));
        if whole_symbol_out(chosen) {
            return 0;
        }
        let already_out = self.unwanted_seats(symbol, chosen);
        match victim {
            Eviction::Symbol(_) => 1 + self.admitted_venue.iter().filter(|(x, _)| *x == symbol).count() - already_out,
            Eviction::Venue(..) => {
                let with_victim: Vec<Eviction> = chosen.iter().copied().chain([victim]).collect();
                self.unwanted_seats(symbol, &with_victim) - already_out
            }
        }
    }

    fn evict(&mut self, victim: Eviction) {
        match victim {
            Eviction::Symbol(s) => {
                self.released_at.remove(&s);
                self.admitted.remove(&s);
                self.admitted_venue.retain(|(x, _)| *x != s);
            }
            Eviction::Venue(s, kind) => {
                self.kind_released_at.remove(&(s, kind));
                for seat in self.rules.own_seats(s, kind) {
                    if !self.seat_wanted(s, seat) {
                        self.admitted_venue.remove(&(s, seat));
                    }
                }
            }
        }
    }

    fn rank(&self, symbol: Symbol) -> Rank {
        let held = self.held_order[&symbol];
        self.holders[&symbol]
            .iter()
            .map(|h| match h {
                Holder::Cell { .. } | Holder::Feed { .. } => Rank::Cell { held },
                Holder::Watch { conn, .. } => Rank::Watch { row: self.watch_rows[conn][&symbol], held },
            })
            .min()
            .expect("보유자가 있는 종목")
    }
}

#[derive(Debug, Clone, Copy)]
enum Eviction {
    Symbol(Symbol),
    Venue(Symbol, StreamKind),
}

impl Eviction {
    fn symbol(self) -> Symbol {
        match self {
            Eviction::Symbol(s) | Eviction::Venue(s, _) => s,
        }
    }
}

impl Holder {
    fn conn(&self) -> ConnId {
        match self {
            Holder::Cell { conn, .. } | Holder::Watch { conn, .. } | Holder::Feed { conn, .. } => *conn,
        }
    }

    fn feed_kind(&self) -> Option<StreamKind> {
        match self {
            Holder::Feed { kind, .. } if *kind != StreamKind::Trades => Some(*kind),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use domain::{IndexCode, KstDate, Venue};

    use super::*;
    use crate::clock::kst;
    use crate::kiwoom::stream::{KIWOOM_REALTIME_LIMIT as REALTIME_LIMIT, KiwoomSeats};

    fn manager() -> SubscriptionManager {
        SubscriptionManager::new(Arc::new(KiwoomSeats))
    }

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
        let mut m = manager();
        m.hold(stock(0), cell(1, "a"));
        assert_eq!(m.plan(t(0)).realtime, BTreeSet::from([stock(0)]));
        m.release(stock(0), &cell(1, "a"), t(0));
        assert_eq!(m.plan(t(29)).realtime, BTreeSet::from([stock(0)]), "30초 유예 동안 계속 받는다");
        assert_eq!(m.plan(t(30)).realtime, BTreeSet::new());
    }

    #[test]
    fn resubscribe_within_the_grace_keeps_the_symbol() {
        let mut m = manager();
        m.hold(stock(0), cell(1, "a"));
        m.plan(t(0));
        m.release(stock(0), &cell(1, "a"), t(0));
        m.hold(stock(0), cell(2, "b"));
        assert_eq!(m.plan(t(60)).realtime, BTreeSet::from([stock(0)]));
    }

    #[test]
    fn one_holder_leaving_keeps_the_symbol_while_another_holds_it() {
        let mut m = manager();
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
        let mut m = manager();
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
        let mut m = manager();
        fill(&mut m, REALTIME_LIMIT);
        let before = m.plan(t(0)).realtime;
        m.hold(stock(500), cell(2, "new"));
        let plan = m.plan(t(1));
        assert_eq!(plan.realtime, before);
        assert_eq!(plan.rejected, BTreeSet::from([cell(2, "new")]));
    }

    #[test]
    fn a_symbol_in_grace_makes_room_and_the_oldest_release_goes_first() {
        let mut m = manager();
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
        let mut m = manager();
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
        let mut m = manager();
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
        let mut m = manager();
        m.hold(stock(0), cell(1, "a"));
        m.plan(t(0));
        m.forget(stock(0), &cell(1, "a"));
        assert_eq!(m.plan(t(0)).realtime, BTreeSet::new());
    }

    #[test]
    fn watch_rows_get_places_from_the_top_of_the_list() {
        let mut m = manager();
        m.set_watch(ConnId(1), stocks(0..REALTIME_LIMIT + 3), t(0));
        let plan = m.plan(t(0));
        assert_eq!(plan.realtime, stocks(0..REALTIME_LIMIT).into_iter().collect());
        assert_eq!(plan.rejected, BTreeSet::from([watch(1, REALTIME_LIMIT), watch(1, REALTIME_LIMIT + 1), watch(1, REALTIME_LIMIT + 2)]));
    }

    #[test]
    fn moving_a_row_to_the_top_takes_the_place_of_the_last_realtime_row() {
        let mut m = manager();
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
        let mut m = manager();
        m.set_watch(ConnId(1), stocks(0..REALTIME_LIMIT), t(0));
        m.plan(t(0));
        m.hold(stock(500), cell(2, "c"));
        let plan = m.plan(t(1));
        assert!(plan.realtime.contains(&stock(500)));
        assert_eq!(plan.rejected, BTreeSet::from([watch(1, REALTIME_LIMIT - 1)]));
    }

    #[test]
    fn a_symbol_held_by_a_cell_and_a_watch_row_ranks_as_a_cell() {
        let mut m = manager();
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
        let mut m = manager();
        fill(&mut m, REALTIME_LIMIT);
        m.plan(t(0));
        m.set_watch(ConnId(2), vec![stock(500)], t(1));
        let plan = m.plan(t(1));
        assert!(!plan.realtime.contains(&stock(500)));
        assert_eq!(plan.rejected, BTreeSet::from([Holder::Watch { conn: ConnId(2), symbol: stock(500) }]));
    }

    #[test]
    fn rows_of_two_connections_share_places_by_row() {
        let mut m = manager();
        m.set_watch(ConnId(1), stocks(0..REALTIME_LIMIT), t(0));
        m.plan(t(0));
        m.set_watch(ConnId(2), vec![stock(500)], t(1));
        let plan = m.plan(t(1));
        assert!(plan.realtime.contains(&stock(500)), "다른 연결의 맨 윗줄이 이 연결의 맨 아랫줄보다 앞선다");
        assert_eq!(plan.rejected, BTreeSet::from([watch(1, REALTIME_LIMIT - 1)]));
    }

    #[test]
    fn a_dropped_row_keeps_the_symbol_for_the_grace() {
        let mut m = manager();
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
        let mut m = manager();
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
            let mut m = manager();
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

    fn feed(conn: u64, sub: &str, kind: StreamKind) -> Holder {
        Holder::Feed { conn: ConnId(conn), sub: SubId(sub.into()), kind }
    }

    fn kinds(plan: &Plan, i: usize) -> BTreeSet<StreamKind> {
        plan.feeds.get(&stock(i)).cloned().unwrap_or_default()
    }

    fn with_book() -> BTreeSet<StreamKind> {
        BTreeSet::from([StreamKind::Trades, StreamKind::Book(Venue::Combined), StreamKind::AfterHours])
    }

    #[test]
    fn book_holder_adds_book_type_for_its_symbol_only() {
        let mut m = manager();
        m.set_watch(ConnId(1), stocks(0..2), t(0));
        m.hold(stock(0), feed(2, "b", StreamKind::Book(Venue::Combined)));
        let plan = m.plan(t(0));
        assert_eq!(kinds(&plan, 0), with_book());
        assert_eq!(kinds(&plan, 1), BTreeSet::from([StreamKind::Trades]), "관심종목 종목에는 0D와 0E가 들지 않는다");
    }

    #[test]
    fn each_feed_kind_adds_only_its_own_real_type() {
        let mut m = manager();
        m.hold(stock(0), feed(1, "t", StreamKind::Trades));
        m.hold(stock(1), feed(1, "p", StreamKind::Program));
        m.hold(stock(2), feed(1, "k", StreamKind::Brokers));
        let plan = m.plan(t(0));
        assert_eq!(kinds(&plan, 0), BTreeSet::from([StreamKind::Trades]));
        assert_eq!(kinds(&plan, 1), BTreeSet::from([StreamKind::Trades, StreamKind::Program]));
        assert_eq!(kinds(&plan, 2), BTreeSet::from([StreamKind::Trades, StreamKind::Brokers]));
    }

    #[test]
    fn feed_holders_rank_like_cells_under_the_limit() {
        let mut m = manager();
        m.set_watch(ConnId(1), stocks(0..REALTIME_LIMIT), t(0));
        m.plan(t(0));
        m.hold(stock(500), feed(2, "b", StreamKind::Book(Venue::Combined)));
        let plan = m.plan(t(1));
        assert!(plan.realtime.contains(&stock(500)));
        assert_eq!(plan.rejected, BTreeSet::from([watch(1, REALTIME_LIMIT - 1)]));
        assert!(plan.feeds[&stock(500)].contains(&StreamKind::Book(Venue::Combined)));
    }

    #[test]
    fn adding_a_book_feed_to_a_full_plan_keeps_the_slots_and_rejects_nothing_more() {
        let mut m = manager();
        fill(&mut m, REALTIME_LIMIT);
        let before = m.plan(t(0));
        assert_eq!((before.realtime.len(), before.rejected.len()), (REALTIME_LIMIT, 0));
        m.hold(stock(0), feed(2, "b", StreamKind::Book(Venue::Combined)));
        let plan = m.plan(t(1));
        assert_eq!((plan.realtime.len(), plan.rejected.len()), (REALTIME_LIMIT, 0));
        assert_eq!(kinds(&plan, 0), with_book());
    }

    #[test]
    fn released_feed_type_is_kept_for_the_grace_period() {
        let mut m = manager();
        m.hold(stock(0), cell(1, "chart"));
        m.hold(stock(0), feed(2, "b", StreamKind::Book(Venue::Combined)));
        m.plan(t(0));
        m.release(stock(0), &feed(2, "b", StreamKind::Book(Venue::Combined)), t(0));
        assert_eq!(kinds(&m.plan(t(29)), 0), with_book(), "30초 유예 동안 0D와 0E를 유지한다");
        assert_eq!(kinds(&m.plan(t(30)), 0), BTreeSet::from([StreamKind::Trades]));
    }

    #[test]
    fn a_feed_kind_still_held_by_another_window_is_not_released() {
        let mut m = manager();
        m.hold(stock(0), feed(1, "a", StreamKind::Book(Venue::Combined)));
        m.hold(stock(0), feed(2, "b", StreamKind::Book(Venue::Combined)));
        m.plan(t(0));
        m.release(stock(0), &feed(1, "a", StreamKind::Book(Venue::Combined)), t(0));
        assert_eq!(kinds(&m.plan(t(100)), 0), with_book());
    }

    #[test]
    fn resubscribing_a_feed_kind_within_the_grace_cancels_it() {
        let mut m = manager();
        m.hold(stock(0), cell(1, "chart"));
        m.hold(stock(0), feed(2, "b", StreamKind::Book(Venue::Combined)));
        m.plan(t(0));
        m.release(stock(0), &feed(2, "b", StreamKind::Book(Venue::Combined)), t(0));
        m.hold(stock(0), feed(3, "b2", StreamKind::Book(Venue::Combined)));
        assert_eq!(kinds(&m.plan(t(60)), 0), with_book());
    }

    #[test]
    fn feed_kinds_of_a_symbol_that_leaves_the_plan_do_not_come_back() {
        let mut m = manager();
        m.hold(stock(0), feed(1, "b", StreamKind::Book(Venue::Combined)));
        m.plan(t(0));
        m.release(stock(0), &feed(1, "b", StreamKind::Book(Venue::Combined)), t(0));
        assert!(m.plan(t(30)).feeds.is_empty());
        m.hold(stock(0), cell(2, "chart"));
        assert_eq!(kinds(&m.plan(t(31)), 0), BTreeSet::from([StreamKind::Trades]));
    }

    fn seats(plan: &Plan) -> usize {
        KiwoomSeats.seats(&plan.feeds)
    }

    #[test]
    fn a_venue_book_costs_a_second_place_and_keeps_trades_on_the_combined_code() {
        let mut m = manager();
        m.hold(stock(0), feed(1, "k", StreamKind::Book(Venue::Krx)));
        m.hold(stock(1), feed(1, "a", StreamKind::Book(Venue::Combined)));
        let plan = m.plan(t(0));
        assert_eq!(kinds(&plan, 0), BTreeSet::from([StreamKind::Trades, StreamKind::Book(Venue::Krx), StreamKind::AfterHours]));
        assert_eq!(kinds(&plan, 1), with_book());
        assert_eq!(seats(&plan), 3);
        assert!(plan.rejected.is_empty());
    }

    #[test]
    fn krx_and_nxt_books_of_one_symbol_take_two_extra_places() {
        let mut m = manager();
        m.hold(stock(0), feed(1, "k", StreamKind::Book(Venue::Krx)));
        m.hold(stock(0), feed(2, "n", StreamKind::Book(Venue::Nxt)));
        assert_eq!(seats(&m.plan(t(0))), 3);
    }

    #[test]
    fn a_venue_book_on_a_full_house_is_rejected_without_pushing_out_a_held_symbol() {
        let mut m = manager();
        fill(&mut m, REALTIME_LIMIT);
        let before = m.plan(t(0));
        m.hold(stock(0), feed(2, "n", StreamKind::Book(Venue::Nxt)));
        let plan = m.plan(t(1));
        assert_eq!(plan.realtime, before.realtime);
        assert_eq!(plan.rejected, BTreeSet::from([feed(2, "n", StreamKind::Book(Venue::Nxt))]));
        assert_eq!(kinds(&plan, 0), BTreeSet::from([StreamKind::Trades]), "자리를 못 받은 보유자는 0D도 0E도 부르지 않는다");
        assert_eq!(seats(&plan), REALTIME_LIMIT);
    }

    #[test]
    fn a_rejected_venue_book_recovers_when_a_symbol_in_grace_frees_a_place() {
        let mut m = manager();
        fill(&mut m, REALTIME_LIMIT);
        m.plan(t(0));
        m.hold(stock(0), feed(2, "n", StreamKind::Book(Venue::Nxt)));
        assert_eq!(m.plan(t(1)).rejected.len(), 1);
        m.release(stock(7), &cell(1, "s7"), t(2));
        let plan = m.plan(t(2));
        assert!(plan.rejected.is_empty());
        assert!(!plan.realtime.contains(&stock(7)));
        assert!(kinds(&plan, 0).contains(&StreamKind::Book(Venue::Nxt)));
        assert_eq!(seats(&plan), REALTIME_LIMIT);
    }

    #[test]
    fn a_venue_book_takes_the_place_of_the_last_watch_row() {
        let mut m = manager();
        m.set_watch(ConnId(1), stocks(0..REALTIME_LIMIT), t(0));
        m.plan(t(0));
        m.hold(stock(0), feed(2, "n", StreamKind::Book(Venue::Nxt)));
        let plan = m.plan(t(1));
        assert!(plan.rejected.contains(&watch(1, REALTIME_LIMIT - 1)));
        assert!(!plan.rejected.contains(&feed(2, "n", StreamKind::Book(Venue::Nxt))));
        assert_eq!(seats(&plan), REALTIME_LIMIT);
    }

    #[test]
    fn a_new_symbol_that_needs_two_places_is_rejected_whole_when_only_one_is_left() {
        let mut m = manager();
        fill(&mut m, REALTIME_LIMIT - 1);
        m.hold(stock(500), feed(2, "n", StreamKind::Book(Venue::Nxt)));
        let plan = m.plan(t(0));
        assert!(!plan.realtime.contains(&stock(500)), "통합 자리만 받고 거래소 자리를 못 받은 채로 남지 않는다");
        assert_eq!(plan.rejected, BTreeSet::from([feed(2, "n", StreamKind::Book(Venue::Nxt))]));
        assert_eq!(seats(&plan), REALTIME_LIMIT - 1);
    }

    #[test]
    fn the_last_holder_of_a_venue_book_leaving_drops_its_code_after_the_grace_and_keeps_the_rest() {
        let mut m = manager();
        m.hold(stock(0), feed(1, "a", StreamKind::Book(Venue::Combined)));
        m.hold(stock(0), feed(2, "n", StreamKind::Book(Venue::Nxt)));
        m.plan(t(0));
        m.release(stock(0), &feed(2, "n", StreamKind::Book(Venue::Nxt)), t(0));
        assert!(kinds(&m.plan(t(29)), 0).contains(&StreamKind::Book(Venue::Nxt)));
        assert_eq!(kinds(&m.plan(t(30)), 0), with_book());
        assert_eq!(seats(&m.plan(t(30))), 1);
    }

    #[test]
    fn a_venue_book_resubscribed_within_the_grace_keeps_its_place() {
        let mut m = manager();
        m.hold(stock(0), feed(1, "n", StreamKind::Book(Venue::Nxt)));
        m.plan(t(0));
        m.release(stock(0), &feed(1, "n", StreamKind::Book(Venue::Nxt)), t(0));
        m.hold(stock(0), feed(2, "n2", StreamKind::Book(Venue::Nxt)));
        let plan = m.plan(t(60));
        assert!(kinds(&plan, 0).contains(&StreamKind::Book(Venue::Nxt)));
        assert_eq!(seats(&plan), 2);
    }

    #[test]
    fn a_venue_book_in_grace_gives_its_place_to_a_new_symbol_before_a_held_one_moves() {
        let mut m = manager();
        fill(&mut m, REALTIME_LIMIT - 1);
        m.hold(stock(0), feed(2, "n", StreamKind::Book(Venue::Nxt)));
        assert_eq!(seats(&m.plan(t(0))), REALTIME_LIMIT);
        m.release(stock(0), &feed(2, "n", StreamKind::Book(Venue::Nxt)), t(1));
        m.hold(stock(500), cell(3, "new"));
        let plan = m.plan(t(2));
        assert!(plan.realtime.contains(&stock(500)) && plan.rejected.is_empty());
        assert!(!kinds(&plan, 0).contains(&StreamKind::Book(Venue::Nxt)));
        assert_eq!(seats(&plan), REALTIME_LIMIT);
    }

    #[test]
    fn a_watch_only_symbol_with_a_venue_grace_is_not_counted_twice_when_it_makes_room() {
        let mut m = manager();
        m.set_watch(ConnId(1), stocks(0..REALTIME_LIMIT - 1), t(0));
        m.hold(stock(198), feed(2, "n", StreamKind::Book(Venue::Nxt)));
        assert_eq!(seats(&m.plan(t(0))), REALTIME_LIMIT);
        m.release(stock(198), &feed(2, "n", StreamKind::Book(Venue::Nxt)), t(1));
        assert_eq!(seats(&m.plan(t(1))), REALTIME_LIMIT);
        m.hold(stock(500), feed(3, "k", StreamKind::Book(Venue::Krx)));
        m.hold(stock(500), feed(3, "n", StreamKind::Book(Venue::Nxt)));
        let plan = m.plan(t(2));
        assert!(seats(&plan) <= REALTIME_LIMIT, "seats {} > {}", seats(&plan), REALTIME_LIMIT);
    }

    #[test]
    fn a_rejected_venue_book_does_not_reject_its_chart_or_let_a_newer_symbol_jump_ahead() {
        let mut m = manager();
        fill(&mut m, REALTIME_LIMIT);
        m.plan(t(0));
        m.hold(stock(500), cell(2, "chart"));
        m.hold(stock(500), feed(2, "n", StreamKind::Book(Venue::Nxt)));
        m.plan(t(0));
        m.hold(stock(600), cell(3, "later"));
        m.plan(t(0));
        m.release(stock(7), &cell(1, "s7"), t(1));
        let plan = m.plan(t(1));
        assert!(!plan.rejected.contains(&cell(2, "chart")), "older chart cell should take the freed seat");
    }

    #[test]
    fn a_symbol_held_only_by_a_rejected_venue_book_gives_its_place_back() {
        let mut m = manager();
        fill(&mut m, REALTIME_LIMIT - 1);
        m.hold(stock(500), cell(2, "chart"));
        assert!(m.plan(t(0)).rejected.is_empty());
        m.hold(stock(500), feed(2, "n", StreamKind::Book(Venue::Nxt)));
        assert_eq!(m.plan(t(0)).rejected, BTreeSet::from([feed(2, "n", StreamKind::Book(Venue::Nxt))]));
        m.release(stock(500), &cell(2, "chart"), t(1));
        m.hold(stock(600), cell(3, "new"));
        let plan = m.plan(t(100));
        assert!(plan.realtime.contains(&stock(600)), "a seat held for nobody should not refuse a new symbol");
    }

    #[test]
    fn probe_last_served_holder_leaving_beside_a_rejected_venue_book_keeps_grace() {
        let mut m = manager();
        fill(&mut m, REALTIME_LIMIT - 1);
        m.hold(stock(500), cell(2, "chart"));
        m.hold(stock(500), feed(3, "n", StreamKind::Book(Venue::Nxt)));
        let plan = m.plan(t(0));
        assert_eq!(plan.rejected, BTreeSet::from([feed(3, "n", StreamKind::Book(Venue::Nxt))]));
        m.release(stock(500), &cell(2, "chart"), t(1));
        assert!(m.plan(t(1)).realtime.contains(&stock(500)), "30초 유예 동안 계속 받는다");
        assert!(m.plan(t(30)).realtime.contains(&stock(500)));
        assert!(!m.plan(t(31)).realtime.contains(&stock(500)), "유예가 지나면 해지한다");
    }

    #[test]
    fn releasing_another_rejected_holder_during_the_grace_does_not_extend_it() {
        let mut m = manager();
        fill(&mut m, REALTIME_LIMIT - 1);
        m.hold(stock(500), cell(2, "chart"));
        m.hold(stock(500), feed(3, "n1", StreamKind::Book(Venue::Nxt)));
        m.hold(stock(500), feed(4, "n2", StreamKind::Book(Venue::Nxt)));
        m.plan(t(0));
        m.release(stock(500), &cell(2, "chart"), t(1));
        m.plan(t(1));
        m.release(stock(500), &feed(3, "n1", StreamKind::Book(Venue::Nxt)), t(20));
        m.plan(t(20));
        assert!(!m.plan(t(31)).realtime.contains(&stock(500)), "마지막 서비스 보유자가 빠진 뒤 30초가 지나면 해지한다");
    }

    #[test]
    fn a_new_rejected_venue_holder_during_the_grace_does_not_drop_the_symbol_at_once() {
        let mut m = manager();
        fill(&mut m, REALTIME_LIMIT - 1);
        m.hold(stock(500), cell(2, "chart"));
        m.hold(stock(500), feed(3, "n", StreamKind::Book(Venue::Nxt)));
        m.plan(t(0));
        m.release(stock(500), &cell(2, "chart"), t(1));
        assert!(m.plan(t(1)).realtime.contains(&stock(500)));
        m.hold(stock(500), feed(4, "k", StreamKind::Book(Venue::Krx)));
        assert!(m.plan(t(5)).realtime.contains(&stock(500)), "유예 중에 받지 못할 거래소 호가가 더 와도 30초 유예를 지킨다");
    }

    #[test]
    fn a_combined_book_moved_to_a_venue_code_at_the_limit_keeps_the_old_place_for_the_grace() {
        let mut m = manager();
        fill(&mut m, REALTIME_LIMIT - 1);
        m.hold(stock(500), feed(3, "n", StreamKind::Book(Venue::Combined)));
        assert!(m.plan(t(0)).realtime.contains(&stock(500)));
        m.release(stock(500), &feed(3, "n", StreamKind::Book(Venue::Combined)), t(1));
        m.hold(stock(500), feed(3, "n", StreamKind::Book(Venue::Nxt)));
        assert!(m.plan(t(1)).realtime.contains(&stock(500)), "옛 코드는 30초 유예 뒤에 놓는다");
    }

    #[test]
    fn a_symbol_evicted_while_the_venue_places_are_handed_out_gets_no_place_and_leaves_the_plan_stable() {
        let mut m = manager();
        fill(&mut m, REALTIME_LIMIT - 5);
        m.hold(stock(500), cell(9, "a"));
        m.hold(stock(500), feed(9, "an", StreamKind::Book(Venue::Nxt)));
        m.hold(stock(501), feed(3, "sk", StreamKind::Book(Venue::Krx)));
        m.hold(stock(502), cell(5, "b"));
        assert_eq!(seats(&m.plan(t(0))), REALTIME_LIMIT);
        m.hold(stock(501), feed(4, "sn", StreamKind::Book(Venue::Nxt)));
        m.plan(t(1));
        m.release(stock(501), &feed(3, "sk", StreamKind::Book(Venue::Krx)), t(2));
        m.plan(t(2));
        m.hold(stock(500), feed(9, "ak", StreamKind::Book(Venue::Krx)));
        m.hold(stock(502), feed(5, "bn", StreamKind::Book(Venue::Nxt)));
        let first = m.plan(t(3));
        let second = m.plan(t(3));
        assert_eq!(first, second, "seats first={} second={}", seats(&first), seats(&second));
    }

    #[test]
    fn the_same_state_with_venue_graces_gives_the_same_plan() {
        let mut m = manager();
        m.set_watch(ConnId(1), stocks(0..REALTIME_LIMIT - 1), t(0));
        m.hold(stock(198), feed(2, "n", StreamKind::Book(Venue::Nxt)));
        m.plan(t(0));
        m.release(stock(198), &feed(2, "n", StreamKind::Book(Venue::Nxt)), t(1));
        m.hold(stock(500), feed(3, "n", StreamKind::Book(Venue::Nxt)));
        let a = m.plan(t(2));
        let b = m.plan(t(2));
        assert_eq!(a, b);
    }

    struct SeatRulesFor {
        limit: usize,
        own_seat: fn(StreamKind) -> bool,
        companion: fn(StreamKind) -> Option<StreamKind>,
    }

    impl SeatRules for SeatRulesFor {
        fn limit(&self) -> usize {
            self.limit
        }

        fn takes_own_seat(&self, kind: StreamKind) -> bool {
            (self.own_seat)(kind)
        }

        fn companion(&self, kind: StreamKind) -> Option<StreamKind> {
            (self.companion)(kind)
        }
    }

    #[test]
    fn a_rule_that_gives_the_base_kind_a_seat_still_counts_one_seat_per_symbol_in_the_manager_and_in_seats() {
        let rules = Arc::new(SeatRulesFor { limit: 3, own_seat: |_| true, companion: |_| None });
        let mut m = SubscriptionManager::new(rules.clone());
        fill(&mut m, 4);
        let plan = m.plan(t(0));
        assert_eq!(plan.realtime.len(), 3);
        assert_eq!(rules.seats(&plan.feeds), 3);
        assert_eq!(plan.rejected, BTreeSet::from([cell(1, "s3")]));
    }

    #[test]
    fn a_companion_kind_that_takes_a_seat_counts_against_the_limit_and_the_earlier_registration_stays() {
        let rules = Arc::new(SeatRulesFor {
            limit: 3,
            own_seat: |kind| matches!(kind, StreamKind::Book(_) | StreamKind::AfterHours),
            companion: |kind| matches!(kind, StreamKind::Book(_)).then_some(StreamKind::AfterHours),
        });
        let mut m = SubscriptionManager::new(rules.clone());
        let book = feed(1, "book", StreamKind::Book(Venue::Combined));
        m.hold(stock(0), cell(1, "a"));
        m.hold(stock(0), book.clone());
        let plan = m.plan(t(0));
        assert_eq!(plan.feeds[&stock(0)], BTreeSet::from([StreamKind::Trades, StreamKind::Book(Venue::Combined), StreamKind::AfterHours]));
        assert_eq!(rules.seats(&plan.feeds), 3, "체결, 호가, 호가의 동반 종류가 세 자리다");

        m.hold(stock(1), cell(1, "b"));
        let plan = m.plan(t(1));
        assert_eq!(plan.rejected, BTreeSet::from([cell(1, "b")]), "동반 종류의 자리도 한도에 든다");
        assert!(plan.feeds.contains_key(&stock(0)) && !plan.feeds.contains_key(&stock(1)));
        assert_eq!(rules.seats(&plan.feeds), 3);

        m.release(stock(0), &book, t(2));
        let plan = m.plan(t(40));
        assert_eq!(plan.feeds[&stock(0)], BTreeSet::from([StreamKind::Trades]), "호가를 놓으면 동반 종류의 자리도 돌아온다");
        assert!(plan.feeds.contains_key(&stock(1)));
        assert_eq!(rules.seats(&plan.feeds), 2);
    }

    fn book_companion_rules(limit: usize) -> Arc<SeatRulesFor> {
        Arc::new(SeatRulesFor {
            limit,
            own_seat: |kind| matches!(kind, StreamKind::Book(_) | StreamKind::AfterHours),
            companion: |kind| matches!(kind, StreamKind::Book(_)).then_some(StreamKind::AfterHours),
        })
    }

    #[test]
    fn a_kind_whose_companion_seat_does_not_fit_gets_neither_seat() {
        let rules = book_companion_rules(2);
        let mut m = SubscriptionManager::new(rules.clone());
        m.hold(stock(0), cell(1, "a"));
        m.hold(stock(0), feed(1, "book", StreamKind::Book(Venue::Combined)));
        let plan = m.plan(t(0));
        assert_eq!(plan.feeds[&stock(0)], BTreeSet::from([StreamKind::Trades]));
        assert_eq!(plan.rejected, BTreeSet::from([feed(1, "book", StreamKind::Book(Venue::Combined))]));
        assert_eq!(rules.seats(&plan.feeds), 1);
    }

    #[test]
    fn evicting_one_book_in_grace_keeps_the_companion_seat_the_other_held_book_needs() {
        let rules = book_companion_rules(4);
        let mut m = SubscriptionManager::new(rules.clone());
        let krx = feed(1, "krx", StreamKind::Book(Venue::Krx));
        m.hold(stock(0), cell(1, "a"));
        m.hold(stock(0), krx.clone());
        m.hold(stock(0), feed(1, "nxt", StreamKind::Book(Venue::Nxt)));
        let plan = m.plan(t(0));
        assert_eq!(rules.seats(&plan.feeds), 4);
        m.release(stock(0), &krx, t(1));
        m.hold(stock(1), cell(1, "b"));
        m.hold(stock(2), cell(1, "c"));
        let plan = m.plan(t(2));
        assert_eq!(rules.seats(&plan.feeds), plan.feeds.len() + plan.feeds.values().map(|kinds| kinds.iter().filter(|k| rules.takes_own_seat(**k)).count()).sum::<usize>());
        assert!(plan.feeds[&stock(0)].contains(&StreamKind::Book(Venue::Nxt)) && plan.feeds[&stock(0)].contains(&StreamKind::AfterHours), "{plan:?}");
    }

    #[test]
    fn a_refused_book_does_not_keep_the_companion_seat_of_an_evicted_book() {
        let rules = Arc::new(SeatRulesFor {
            limit: 3,
            own_seat: |kind| matches!(kind, StreamKind::Book(_) | StreamKind::AfterHours),
            companion: |kind| matches!(kind, StreamKind::Book(_)).then_some(StreamKind::AfterHours),
        });
        let mut m = SubscriptionManager::new(rules.clone());
        let combined = feed(1, "combined", StreamKind::Book(Venue::Combined));
        m.hold(stock(2), combined.clone());
        m.plan(t(0));
        m.set_watch(ConnId(1), vec![stock(2), stock(3)], t(0));
        m.hold(stock(2), feed(1, "nxt", StreamKind::Book(Venue::Nxt)));
        m.plan(t(0));
        m.hold(stock(0), feed(1, "trades", StreamKind::Trades));
        m.release(stock(2), &combined, t(0));
        let plan = m.plan(t(0));
        assert!(rules.seats(&plan.feeds) <= 3, "{plan:?}");
    }
}
