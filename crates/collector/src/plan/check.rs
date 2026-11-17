use std::collections::BTreeMap;
use std::fmt;

use super::model::{KEY_CAPACITY, MARKET_TYPES, PlanFile};
use crate::keys::KeyRole;
use crate::protocol::KeyName;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Violation {
    DuplicateKey(KeyName),
    StockOnTwoKeys { code: String, first: KeyName, second: KeyName },
    StockAlsoUnplaced { code: String, key: KeyName },
    KeyOverCapacity { key: KeyName, stocks: usize },
    SpareHoldsWork(KeyName),
    MarketTypeCount { market_type: &'static str, keys: usize },
}

impl fmt::Display for Violation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Violation::DuplicateKey(key) => write!(formatter, "키 {key}가 계획에 두 번 있습니다"),
            Violation::StockOnTwoKeys { code, first, second } => write!(formatter, "종목 {code}가 키 {first}와 {second}에 모두 있습니다"),
            Violation::StockAlsoUnplaced { code, key } => write!(formatter, "종목 {code}가 키 {key}에 있으면서 제외나 등록하지 않음에도 있습니다"),
            Violation::KeyOverCapacity { key, stocks } => write!(formatter, "키 {key}의 종목이 {stocks}개로 한 키의 몫 {KEY_CAPACITY}개를 넘습니다"),
            Violation::SpareHoldsWork(key) => write!(formatter, "예비 키 {key}에 종목, 시장 단위 타입, REST 작업이 있습니다"),
            Violation::MarketTypeCount { market_type, keys } => write!(formatter, "시장 단위 타입 {market_type}이 {keys}개 키에 있습니다. 수집 키 하나에만 있어야 합니다"),
        }
    }
}

impl std::error::Error for Violation {}

pub fn check_plan(plan: &PlanFile) -> Result<(), Violation> {
    let mut holder: BTreeMap<&str, &KeyName> = BTreeMap::new();
    let mut names: Vec<&KeyName> = Vec::new();
    for key in &plan.keys {
        if names.contains(&&key.name) {
            return Err(Violation::DuplicateKey(key.name.clone()));
        }
        names.push(&key.name);
        if key.role == KeyRole::Spare && !(key.stocks.is_empty() && key.market_types.is_empty() && key.rest_jobs.is_empty()) {
            return Err(Violation::SpareHoldsWork(key.name.clone()));
        }
        if key.stocks.len() > KEY_CAPACITY {
            return Err(Violation::KeyOverCapacity { key: key.name.clone(), stocks: key.stocks.len() });
        }
        for code in &key.stocks {
            if let Some(first) = holder.insert(code, &key.name) {
                return Err(Violation::StockOnTwoKeys { code: code.clone(), first: first.clone(), second: key.name.clone() });
            }
        }
    }
    for code in plan.excluded.iter().chain(&plan.unregistered) {
        if let Some(key) = holder.get(code.as_str()) {
            return Err(Violation::StockAlsoUnplaced { code: code.clone(), key: (*key).clone() });
        }
    }
    for market_type in MARKET_TYPES {
        let keys = plan.keys.iter().filter(|key| key.market_types.contains(&market_type)).count();
        if keys != 1 {
            return Err(Violation::MarketTypeCount { market_type: market_type.wire(), keys });
        }
    }
    Ok(())
}
