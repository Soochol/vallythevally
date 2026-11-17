use std::collections::HashSet;

use serde_json::json;

use crate::protocol::{Batch, REGISTER_BATCH_SIZE, RealType, Registration};

pub const STREAM_TYPES: [RealType; 4] = [RealType::Trade, RealType::OrderBook, RealType::ProgramTrade, RealType::BrokerFlow];
const STANDALONE_ID: &str = "items";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub seq: u64,
    pub id: String,
    pub part: u32,
    pub parts: u32,
    pub items: Vec<String>,
    pub types: Vec<RealType>,
}

impl Chunk {
    pub fn split(registration: &Registration) -> Vec<Chunk> {
        let items = registration.wire_items();
        let parts = items.len().div_ceil(REGISTER_BATCH_SIZE) as u32;
        items
            .chunks(REGISTER_BATCH_SIZE)
            .enumerate()
            .map(|(part, items)| Chunk {
                seq: 0,
                id: registration.id().to_owned(),
                part: part as u32,
                parts,
                items: items.to_vec(),
                types: registration.types().to_vec(),
            })
            .collect()
    }

    pub fn batch(&self) -> Batch {
        Batch { id: self.id.clone(), part: self.part, parts: self.parts, items: self.items.len() }
    }

    pub fn register_message(&self) -> String {
        json!({"trnm": "REG", "grp_no": "1", "refresh": "1", "data": [self.entry()]}).to_string()
    }

    pub fn remove_message(&self) -> String {
        json!({"trnm": "REMOVE", "grp_no": "1", "data": [self.entry()]}).to_string()
    }

    fn entry(&self) -> serde_json::Value {
        json!({"item": self.items, "type": self.types.iter().map(|kind| kind.wire()).collect::<Vec<_>>()})
    }

    fn without(&self, items: &HashSet<&str>, types: &[RealType]) -> Vec<Chunk> {
        let overlaps = self.types.iter().any(|kind| types.contains(kind));
        let (hit, kept): (Vec<&String>, Vec<&String>) = self.items.iter().partition(|item| items.contains(item.as_str()));
        if !overlaps || hit.is_empty() {
            return vec![self.clone()];
        }
        let mut rest = Vec::new();
        if !kept.is_empty() {
            rest.push(Chunk { items: kept.into_iter().cloned().collect(), ..self.clone() });
        }
        let remaining_types: Vec<RealType> = self.types.iter().copied().filter(|kind| !types.contains(kind)).collect();
        if !remaining_types.is_empty() {
            rest.push(Chunk { items: hit.into_iter().cloned().collect(), types: remaining_types, ..self.clone() });
        }
        rest
    }
}

#[derive(Debug, Default)]
pub struct Registry {
    wanted: Vec<Chunk>,
    next_seq: u64,
}

impl Registry {
    pub fn standalone(items: Vec<String>) -> Registry {
        Registry {
            wanted: vec![Chunk { seq: 0, id: STANDALONE_ID.to_owned(), part: 0, parts: 1, items, types: STREAM_TYPES.to_vec() }],
            next_seq: 1,
        }
    }

    pub fn wanted(&self) -> &[Chunk] {
        &self.wanted
    }

    pub fn add(&mut self, chunks: Vec<Chunk>) -> Vec<Chunk> {
        let numbered: Vec<Chunk> = chunks
            .into_iter()
            .map(|chunk| {
                self.next_seq += 1;
                Chunk { seq: self.next_seq, ..chunk }
            })
            .collect();
        self.wanted.extend_from_slice(&numbered);
        numbered
    }

    pub fn accepted(&mut self, chunk: &Chunk) {
        let items: HashSet<&str> = chunk.items.iter().map(String::as_str).collect();
        self.wanted = self
            .wanted
            .iter()
            .flat_map(|wanted| if wanted.seq < chunk.seq { wanted.without(&items, &chunk.types) } else { vec![wanted.clone()] })
            .collect();
    }

    pub fn remove(&mut self, chunks: &[Chunk]) {
        for chunk in chunks {
            self.subtract(&chunk.items, &chunk.types);
        }
    }

    pub fn forget(&mut self, chunk: &Chunk) {
        self.wanted.retain(|wanted| wanted.seq != chunk.seq);
    }

    fn subtract(&mut self, items: &[String], types: &[RealType]) {
        let items: HashSet<&str> = items.iter().map(String::as_str).collect();
        self.wanted = self.wanted.iter().flat_map(|chunk| chunk.without(&items, types)).collect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registration(id: &str, count: usize, types: &[RealType]) -> Registration {
        Registration::new(id, (0..count).map(|number| format!("{:06}", number + 1)).collect(), types.to_vec()).unwrap()
    }

    #[test]
    fn a_registration_splits_into_batches_of_fifty_in_order() {
        let chunks = Chunk::split(&registration("r1", 120, &[RealType::Trade]));
        let shape: Vec<(u32, u32, usize)> = chunks.iter().map(|chunk| (chunk.part, chunk.parts, chunk.items.len())).collect();
        assert_eq!(shape, [(0, 3, 50), (1, 3, 50), (2, 3, 20)]);
        assert_eq!(chunks[0].items[0], "000001_AL");
        assert_eq!(chunks[2].items[19], "000120_AL");
        assert_eq!(Chunk::split(&registration("r2", 50, &[RealType::Trade])).len(), 1);
        assert_eq!(Chunk::split(&registration("r3", 51, &[RealType::Trade])).len(), 2);
    }

    #[test]
    fn messages_follow_the_kiwoom_shape() {
        let chunk = Chunk::split(&registration("r", 2, &[RealType::Trade, RealType::OrderBook])).remove(0);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&chunk.register_message()).unwrap(),
            json!({"trnm": "REG", "grp_no": "1", "refresh": "1", "data": [{"item": ["000001_AL", "000002_AL"], "type": ["0B", "0D"]}]})
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&chunk.remove_message()).unwrap(),
            json!({"trnm": "REMOVE", "grp_no": "1", "data": [{"item": ["000001_AL", "000002_AL"], "type": ["0B", "0D"]}]})
        );
    }

    #[test]
    fn an_accepted_registration_takes_over_the_pairs_of_older_ones_only() {
        let mut registry = Registry::default();
        let first = registry.add(Chunk::split(&registration("a", 3, &[RealType::Trade])));
        registry.accepted(&first[0]);
        let second = registry.add(Chunk::split(&registration("b", 2, &[RealType::Trade])));
        registry.accepted(&second[0]);
        let ids: Vec<(&str, usize)> = registry.wanted().iter().map(|chunk| (chunk.id.as_str(), chunk.items.len())).collect();
        assert_eq!(ids, [("a", 1), ("b", 2)]);
    }

    #[test]
    fn two_pending_registrations_of_the_same_pair_leave_the_newer_one_when_both_are_accepted() {
        let mut registry = Registry::default();
        let first = registry.add(Chunk::split(&registration("a", 3, &[RealType::Trade])));
        let second = registry.add(Chunk::split(&registration("b", 3, &[RealType::Trade])));
        registry.accepted(&first[0]);
        registry.accepted(&second[0]);
        assert_eq!(registry.wanted(), &second[..]);
    }

    #[test]
    fn a_rejected_re_registration_leaves_the_accepted_one_whole() {
        let mut registry = Registry::default();
        let first = registry.add(Chunk::split(&registration("a", 2, &[RealType::Trade])));
        registry.accepted(&first[0]);
        let second = registry.add(Chunk::split(&registration("b", 1, &[RealType::Trade])));
        registry.forget(&second[0]);
        assert_eq!(registry.wanted(), &first[..]);
    }

    #[test]
    fn a_rejected_chunk_that_was_split_meanwhile_is_forgotten_in_every_piece() {
        let mut registry = Registry::default();
        let chunks = registry.add(Chunk::split(&registration("a", 60, &[RealType::Trade])));
        registry.remove(&Chunk::split(&registration("x", 1, &[RealType::Trade])));
        assert_eq!(registry.wanted()[0].items.len(), 49);
        registry.forget(&chunks[0]);
        assert_eq!(registry.wanted().len(), 1);
        assert_eq!(registry.wanted()[0].items.len(), 10);
    }

    #[test]
    fn unregistering_removes_only_the_named_items_and_types() {
        let mut registry = Registry::default();
        registry.add(Chunk::split(&registration("a", 3, &[RealType::Trade, RealType::OrderBook])));
        registry.remove(&Chunk::split(&registration("x", 1, &[RealType::Trade])));
        let left: Vec<(Vec<String>, Vec<RealType>)> = registry.wanted().iter().map(|chunk| (chunk.items.clone(), chunk.types.clone())).collect();
        assert_eq!(
            left,
            [
                (vec!["000002_AL".to_owned(), "000003_AL".to_owned()], vec![RealType::Trade, RealType::OrderBook]),
                (vec!["000001_AL".to_owned()], vec![RealType::OrderBook]),
            ]
        );
        registry.remove(&Chunk::split(&registration("y", 3, &[RealType::Trade, RealType::OrderBook])));
        assert!(registry.wanted().is_empty());
    }

    #[test]
    fn forgetting_a_rejected_chunk_leaves_the_others() {
        let mut registry = Registry::default();
        let chunks = registry.add(Chunk::split(&registration("a", 60, &[RealType::Trade])));
        registry.forget(&chunks[0]);
        assert_eq!(registry.wanted(), &chunks[1..]);
    }

    #[test]
    fn the_standalone_registry_is_one_unsplit_chunk_of_the_four_stream_types() {
        let items: Vec<String> = (0..120).map(|number| format!("{:06}_AL", number + 1)).collect();
        let registry = Registry::standalone(items.clone());
        assert_eq!(registry.wanted().len(), 1);
        assert_eq!(registry.wanted()[0].items, items);
        assert_eq!(registry.wanted()[0].types, STREAM_TYPES);
    }
}
