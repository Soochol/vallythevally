use std::collections::{HashMap, VecDeque};

use super::day_index::FileStamp;

pub(crate) const DEFAULT_CAPACITY: usize = 16;

struct CachedEntry<V> {
    stamp: FileStamp,
    value: V,
}

pub(crate) struct StampLru<V> {
    capacity: usize,
    order: VecDeque<(String, String)>,
    entries: HashMap<(String, String), CachedEntry<V>>,
}

impl<V: Clone> StampLru<V> {
    pub(crate) fn new() -> Self {
        Self::with_capacity(DEFAULT_CAPACITY)
    }

    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity,
            order: VecDeque::with_capacity(capacity),
            entries: HashMap::with_capacity(capacity),
        }
    }

    pub(crate) fn get(&mut self, key: &(String, String), stamp: &FileStamp) -> Option<V> {
        let value = {
            let entry = self.entries.get(key)?;
            if &entry.stamp != stamp {
                return None;
            }
            entry.value.clone()
        };
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            self.order.remove(pos);
        }
        self.order.push_back(key.clone());
        Some(value)
    }

    pub(crate) fn insert(&mut self, key: (String, String), stamp: FileStamp, value: V) {
        if let Some(pos) = self.order.iter().position(|k| k == &key) {
            self.order.remove(pos);
        } else if self.order.len() >= self.capacity
            && let Some(oldest) = self.order.pop_front()
        {
            self.entries.remove(&oldest);
        }
        self.order.push_back(key.clone());
        self.entries.insert(key, CachedEntry { stamp, value });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamp(len: u64) -> FileStamp {
        FileStamp { len, modified: None, ino: None }
    }

    #[test]
    fn evicts_least_recently_used_and_invalidates_on_stamp_change() {
        let mut cache = StampLru::with_capacity(2);
        let k1 = ("005930".to_owned(), "20261123".to_owned());
        let k2 = ("000660".to_owned(), "20261123".to_owned());
        let k3 = ("035420".to_owned(), "20261123".to_owned());
        cache.insert(k1.clone(), stamp(10), 1);
        cache.insert(k2.clone(), stamp(20), 2);
        assert_eq!(cache.get(&k1, &stamp(10)), Some(1));
        assert_eq!(cache.get(&k1, &stamp(11)), None);
        cache.insert(k3.clone(), stamp(30), 3);
        assert_eq!(cache.get(&k1, &stamp(10)), Some(1));
        assert_eq!(cache.get(&k2, &stamp(20)), None);
        assert_eq!(cache.get(&k3, &stamp(30)), Some(3));
    }
}
