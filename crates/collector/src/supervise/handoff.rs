use crate::plan::{KeyShare, PlanFile};
use crate::protocol::{KeyName, RealType, Registration, RegistrationError};

pub const STOCK_TYPES: [RealType; 8] = [
    RealType::Trade,
    RealType::OrderBook,
    RealType::ProgramTrade,
    RealType::BrokerFlow,
    RealType::VolatilityInterruption,
    RealType::ExpectedTrade,
    RealType::AfterHoursOrderBook,
    RealType::StockInfo,
];

pub fn registrations_of(share: &KeyShare, id_prefix: &str) -> Result<Vec<Registration>, RegistrationError> {
    let mut registrations = Vec::new();
    if !share.stocks.is_empty() {
        registrations.push(Registration::new(format!("{id_prefix}-stocks"), share.stocks.clone(), STOCK_TYPES.to_vec())?);
    }
    for market_type in &share.market_types {
        registrations.push(Registration::new(format!("{id_prefix}-market-{}", market_type.wire()), vec![String::new()], vec![*market_type])?);
    }
    Ok(registrations)
}

pub fn effective_plan(plan: &PlanFile, handoff: Option<(&KeyName, &KeyName)>) -> PlanFile {
    let mut effective = plan.clone();
    let Some((from, to)) = handoff else {
        return effective;
    };
    let moved = effective.keys.iter_mut().find(|share| &share.name == from).map(|share| {
        let stocks = std::mem::take(&mut share.stocks);
        let market_types = std::mem::take(&mut share.market_types);
        let rest_jobs = std::mem::take(&mut share.rest_jobs);
        let load = std::mem::take(&mut share.load);
        (share.role, stocks, market_types, rest_jobs, load)
    });
    let Some((from_role, stocks, market_types, rest_jobs, load)) = moved else {
        return effective;
    };
    let Some(receiver) = effective.keys.iter_mut().find(|share| &share.name == to) else {
        return effective;
    };
    let receiver_role = std::mem::replace(&mut receiver.role, from_role);
    (receiver.stocks, receiver.market_types, receiver.rest_jobs, receiver.load) = (stocks, market_types, rest_jobs, load);
    if let Some(giver) = effective.keys.iter_mut().find(|share| &share.name == from) {
        giver.role = receiver_role;
    }
    effective
}
