use std::collections::HashSet;

use serde_json::json;

use crate::protocol::{Batch, REGISTER_BATCH_SIZE, RealType, Registration};

pub const STREAM_TYPES: [RealType; 4] = [RealType::Trade, RealType::OrderBook, RealType::ProgramTrade, RealType::BrokerFlow];
const STANDALONE_ID: &str = "items";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
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
}

impl Registry {
    pub fn standalone(items: Vec<String>) -> Registry {
        Registry {
            wanted: vec![Chunk { id: STANDALONE_ID.to_owned(), part: 0, parts: 1, items, types: STREAM_TYPES.to_vec() }],
        }
    }

    pub fn wanted(&self) -> &[Chunk] {
        &self.wanted
    }

    pub fn add(&mut self, chunks: &[Chunk]) {
        for chunk in chunks {
            self.subtract(&chunk.items, &chunk.types);
        }
        self.wanted.extend_from_slice(chunks);
    }

    pub fn remove(&mut self, chunks: &[Chunk]) {
        for chunk in chunks {
            self.subtract(&chunk.items, &chunk.types);
        }
    }

    pub fn forget(&mut self, chunk: &Chunk) {
        self.wanted.retain(|wanted| wanted != chunk);
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
    fn registering_the_same_pair_again_keeps_one_copy() {
        let mut registry = Registry::default();
        registry.add(&Chunk::split(&registration("a", 3, &[RealType::Trade])));
        registry.add(&Chunk::split(&registration("b", 2, &[RealType::Trade])));
        let ids: Vec<(&str, usize)> = registry.wanted().iter().map(|chunk| (chunk.id.as_str(), chunk.items.len())).collect();
        assert_eq!(ids, [("a", 1), ("b", 2)]);
    }

    #[test]
    fn unregistering_removes_only_the_named_items_and_types() {
        let mut registry = Registry::default();
        registry.add(&Chunk::split(&registration("a", 3, &[RealType::Trade, RealType::OrderBook])));
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
        let chunks = Chunk::split(&registration("a", 60, &[RealType::Trade]));
        registry.add(&chunks);
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
