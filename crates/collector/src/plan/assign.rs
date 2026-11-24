use std::collections::BTreeMap;

use super::check::Violation;
use super::model::{FORMAT_VERSION, InputSummary, KEY_CAPACITY, KeyShare, MARKET_TYPES, PlanFile};
use super::PlanError;
use crate::keys::{KeyIdentity, KeyRole};
use crate::kst::KstTime;
use crate::universe::{UniverseFile, kst_stamp};

pub struct PlanInput<'a> {
    pub date: u32,
    pub created_at: KstTime,
    pub keys: &'a [KeyIdentity],
    pub universe: &'a UniverseFile,
    pub previous_messages: &'a BTreeMap<String, u64>,
    pub turnover: Option<&'a BTreeMap<String, u64>>,
}

struct Pending<'a> {
    code: &'a str,
    load: u64,
}

pub fn build_plan(input: &PlanInput) -> Result<PlanFile, PlanError> {
    let mut shares: Vec<KeyShare> = input
        .keys
        .iter()
        .map(|key| KeyShare {
            name: key.name.clone(),
            role: key.role,
            app_key_hash: key.app_key_hash.clone(),
            stocks: Vec::new(),
            market_types: Vec::new(),
            rest_jobs: Vec::new(),
            load: 0,
        })
        .collect();
    shares.sort_by(|a, b| a.name.cmp(&b.name));
    let collecting = shares.iter().filter(|share| share.role == KeyRole::Collecting).count();
    if collecting == 0 {
        return Err(PlanError::NoCollectingKey);
    }

    let mut registrable: Vec<&str> = input.universe.registrable().map(|entry| entry.code.as_str()).collect();
    match input.turnover {
        Some(turnover) => registrable.sort_unstable_by(|a, b| {
            let a_value = turnover.get(*a).copied().unwrap_or(0);
            let b_value = turnover.get(*b).copied().unwrap_or(0);
            b_value.cmp(&a_value).then_with(|| a.cmp(b))
        }),
        None => registrable.sort_unstable(),
    }
    let mut unregistered: Vec<String> =
        input.universe.stocks.iter().filter(|entry| !entry.registered).map(|entry| entry.code.clone()).collect();
    unregistered.sort_unstable();

    let capacity = collecting * KEY_CAPACITY;
    let mut excluded: Vec<String> = registrable.split_off(capacity.min(registrable.len())).into_iter().map(str::to_owned).collect();
    excluded.sort_unstable();

    let mut pending: Vec<Pending> =
        registrable.iter().map(|code| Pending { code, load: input.previous_messages.get(*code).copied().unwrap_or(0) }).collect();
    pending.sort_by(|a, b| b.load.cmp(&a.load).then(a.code.cmp(b.code)));
    for stock in &pending {
        let has_room = |share: &&mut KeyShare| share.role == KeyRole::Collecting && share.stocks.len() < KEY_CAPACITY;
        let share = if stock.load > 0 {
            shares.iter_mut().filter(has_room).min_by_key(|share| (share.load, share.stocks.len()))
        } else {
            shares.iter_mut().filter(has_room).min_by_key(|share| (share.stocks.len(), share.load))
        }
        .expect("종목 수가 수집 키의 몫 합계 이하라 빈 자리가 있다");
        share.stocks.push(stock.code.to_owned());
        share.load = share.load.saturating_add(stock.load);
    }

    let market_holder = shares
        .iter_mut()
        .filter(|share| share.role == KeyRole::Collecting)
        .min_by_key(|share| (share.load, share.stocks.len()))
        .expect("수집 키가 하나 이상이다");
    market_holder.market_types = MARKET_TYPES.to_vec();
    for share in &mut shares {
        share.stocks.sort_unstable();
    }

    Ok(PlanFile {
        format_version: FORMAT_VERSION,
        date: input.date,
        created_at: kst_stamp(input.created_at),
        input: InputSummary { active_keys: input.keys.len(), universe_replaced: input.universe.replaced.clone() },
        alerts: alerts(collecting, registrable.len() + excluded.len(), &excluded, input.keys, input.turnover.is_some()),
        keys: shares,
        excluded,
        unregistered,
    })
}

fn alerts(collecting: usize, registrable: usize, excluded: &[String], keys: &[KeyIdentity], by_turnover: bool) -> Vec<String> {
    let mut alerts = Vec::new();
    if let (Some(first), Some(last)) = (excluded.first(), excluded.last()) {
        let capacity = collecting * KEY_CAPACITY;
        let needed = registrable.div_ceil(KEY_CAPACITY);
        let message = if by_turnover {
            format!("등록할 종목 {registrable}개가 수집 키 {collecting}개의 몫 {capacity}개를 넘어 거래대금 순서로 {}개를 제외했습니다. 수집 키가 {needed}개 필요합니다", excluded.len())
        } else {
            format!("등록할 종목 {registrable}개가 수집 키 {collecting}개의 몫 {capacity}개를 넘어 종목코드 순서로 {}개({first}~{last})를 제외했습니다. 수집 키가 {needed}개 필요합니다", excluded.len())
        };
        alerts.push(message);
    }
    if !keys.iter().any(|key| key.role == KeyRole::Spare) {
        alerts.push("활성 예비 키가 없어 인계할 수 없습니다".to_owned());
    }
    alerts
}

impl From<Violation> for PlanError {
    fn from(violation: Violation) -> PlanError {
        PlanError::Violation(violation)
    }
}
