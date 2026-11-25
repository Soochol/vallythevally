use super::exact::{Decimal, Exact};
use super::store::MicroSums;

const MILLION_EXPONENT: i32 = -6;

#[derive(Debug, Clone, Copy)]
pub(super) enum MicroRule {
    ProgramNetBuy { days: u32, min: Option<Decimal>, max: Option<Decimal> },
    WhaleNetBuy { days: u32, min: Option<Decimal>, max: Option<Decimal> },
    ViTriggered { days: u32, min_count: u32 },
}

impl MicroRule {
    pub(super) fn days(&self) -> u32 {
        match *self {
            MicroRule::ProgramNetBuy { days, .. }
            | MicroRule::WhaleNetBuy { days, .. }
            | MicroRule::ViTriggered { days, .. } => days,
        }
    }

    pub(super) fn admits(&self, sums: Option<&MicroSums>) -> bool {
        let Some(sums) = sums else {
            return false;
        };
        match *self {
            MicroRule::ProgramNetBuy { min, max, .. } => matches_million_bounds(sums.program_net_won, min, max),
            MicroRule::WhaleNetBuy { min, max, .. } => matches_million_bounds(sums.whale_net_won, min, max),
            MicroRule::ViTriggered { min_count, .. } => sums.vi_count >= min_count,
        }
    }
}

fn matches_million_bounds(won: i128, min: Option<Decimal>, max: Option<Decimal>) -> bool {
    let million = Exact::new(won < 0, won.unsigned_abs(), MILLION_EXPONENT);
    min.is_none_or(|lo| million >= lo.times(1)) && max.is_none_or(|hi| million <= hi.times(1))
}
