use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::model::Entry;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Named {
    pub code: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Renamed {
    pub code: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diff {
    pub added: Vec<Named>,
    pub removed: Vec<Named>,
    pub renamed: Vec<Renamed>,
    pub halt_started: Vec<Named>,
    pub halt_lifted: Vec<Named>,
}

fn named(entry: &Entry) -> Named {
    Named { code: entry.code.clone(), name: entry.name.clone() }
}

pub fn diff(previous: &[Entry], current: &[Entry]) -> Diff {
    let before: HashMap<&str, &Entry> = previous.iter().map(|entry| (entry.code.as_str(), entry)).collect();
    let after: HashMap<&str, &Entry> = current.iter().map(|entry| (entry.code.as_str(), entry)).collect();
    let mut result = Diff::default();
    for entry in current {
        let Some(old) = before.get(entry.code.as_str()) else {
            result.added.push(named(entry));
            continue;
        };
        if old.name != entry.name {
            result.renamed.push(Renamed { code: entry.code.clone(), from: old.name.clone(), to: entry.name.clone() });
        }
        match (old.registered, entry.registered) {
            (true, false) => result.halt_started.push(named(entry)),
            (false, true) => result.halt_lifted.push(named(entry)),
            _ => {}
        }
    }
    result.removed = previous.iter().filter(|entry| !after.contains_key(entry.code.as_str())).map(named).collect();
    result
}
