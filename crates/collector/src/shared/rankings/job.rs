use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};

use domain::{StockCode, Symbol, TimeOfDay};
use serde_json::Value;
use server::market_source::Priority;
use server::market_source::rankings::{RankedRow, RankingSource};
use server::api::SymbolCode;
use server::kis::rankings::KisRankings;
use server::rankings::KiwoomRankings;
use server::shared_data::{Broker, ConditionEntry, ConditionState, DEFAULT_PERIOD_SECS, DataKind, Header, RankingsPartBody, ReceivedRanking, SharedRankingRow, SourceKey, part_path, read_own_part, write_snapshot_at};
use tokio::sync::watch;

use super::capability::Capability;
use super::options::{Condition, RankingsOptions, options_of};
use super::owner::{Owner, owner_of};
use super::walk::{Walked, walk};
use crate::shared::job::{JobCall, JobError, JobFuture, JobWindow, Market, SharedJob};

const OPENS_AT: TimeOfDay = match TimeOfDay::hms(8, 0, 0) {
    Some(time) => time,
    None => unreachable!(),
};
const CLOSES_AT: TimeOfDay = match TimeOfDay::hms(20, 0, 0) {
    Some(time) => time,
    None => unreachable!(),
};

#[derive(Default)]
pub struct RankingsJob {
    capability: OnceLock<Capability>,
    last_good: Mutex<BTreeMap<String, ReceivedRanking>>,
    resumed: OnceLock<()>,
}

fn row_of(row: RankedRow) -> SharedRankingRow {
    SharedRankingRow { code: SymbolCode(Symbol::Stock(StockCode::clone(&row.code)).as_wire()), name: row.name, price: row.price, change_rate: row.change_rate, figures: row.figures }
}

fn broker_of(market: &Market<'_>) -> Broker {
    match market {
        Market::Kiwoom(_) => Broker::Kiwoom,
        Market::Kis(_) => Broker::Kis,
    }
}

fn source_of(call: &JobCall<'_>) -> Result<Arc<dyn RankingSource>, JobError> {
    match &call.market {
        Market::Kiwoom(rest) => Ok(Arc::new(KiwoomRankings::new((*rest).clone()))),
        Market::Kis(Some(rest)) => Ok(Arc::new(KisRankings::new((*rest).clone(), call.clock.clone()))),
        Market::Kis(None) => Err(JobError("이 한투 키에는 아직 순위를 받을 연결이 없습니다".to_owned())),
    }
}

struct Plan<'a> {
    mine: Vec<&'a Condition>,
    unavailable: Vec<&'a Condition>,
}

fn plan<'a>(options: &'a RankingsOptions, capability: &Capability, peers: &[Broker], my_index: usize) -> Plan<'a> {
    let mut plan = Plan { mine: Vec::new(), unavailable: Vec::new() };
    for (number, condition) in options.conditions.iter().enumerate() {
        match owner_of(number, peers, |broker| capability.can_take(broker, &condition.ranking)) {
            Owner::Key(index) if index == my_index => plan.mine.push(condition),
            Owner::Nobody if my_index == 0 => plan.unavailable.push(condition),
            _ => {}
        }
    }
    plan
}

async fn fetch_one(source: &dyn RankingSource, condition: &Condition, pages: u8) -> Result<Walked, String> {
    let (_demand_sender, best) = watch::channel(Priority::Background);
    let mut demand = server::market_source::rankings::Demand::new(best);
    walk(source, &condition.ranking, pages, &mut demand).await
}

impl RankingsJob {
    fn resume_from_file(&self, call: &JobCall<'_>) {
        self.resumed.get_or_init(|| {
            let Some(body) = read_own_part(call.shared_dir, &call.observation_date.yyyymmdd(), call.key.as_str()) else { return };
            let mut memory = self.last_good.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            memory.extend(body.conditions.into_iter().filter_map(|entry| entry.last.map(|last| (entry.key, last))));
        });
    }

    fn remember(&self, key: &str, received: Option<ReceivedRanking>) -> Option<ReceivedRanking> {
        let mut memory = self.last_good.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match received {
            Some(received) => {
                memory.insert(key.to_owned(), received.clone());
                Some(received)
            }
            None => memory.get(key).cloned(),
        }
    }

    fn forget_others(&self, keep: &[&Condition]) {
        self.last_good.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).retain(|key, _| keep.iter().any(|condition| &condition.key == key));
    }
}

impl SharedJob for RankingsJob {
    fn window(&self) -> JobWindow {
        JobWindow { start: OPENS_AT, end: CLOSES_AT }
    }

    fn brokers(&self) -> &'static [Broker] {
        &[Broker::Kiwoom, Broker::Kis]
    }

    fn default_period_secs(&self) -> u64 {
        DEFAULT_PERIOD_SECS
    }

    fn check_options(&self, options: &Value) -> Result<(), String> {
        options_of(options).map(|_| ())
    }

    fn run<'a>(&'a self, call: JobCall<'a>) -> JobFuture<'a> {
        Box::pin(async move {
            let options = options_of(call.options).map_err(JobError)?;
            self.resume_from_file(&call);
            let own = broker_of(&call.market);
            let peers: &[Broker] = if call.peers.is_empty() { std::slice::from_ref(&own) } else { call.peers };
            let capability = self.capability.get_or_init(|| Capability::new(call.clock));
            let plan = plan(&options, capability, peers, call.slice.index as usize);
            let source = source_of(&call)?;
            let walks = plan.mine.iter().map(|condition| fetch_one(source.as_ref(), condition, options.pages));
            let outcomes = futures::future::join_all(walks).await;
            let now = call.clock.now();
            let mut failed = 0usize;
            let mut entries: Vec<(usize, ConditionEntry)> = Vec::new();
            for (condition, outcome) in plan.mine.iter().zip(outcomes) {
                let position = options.conditions.iter().position(|candidate| candidate.key == condition.key).unwrap_or(usize::MAX);
                let entry = match outcome {
                    Ok(walked) => {
                        let received = ReceivedRanking { rows: walked.rows.into_iter().map(row_of).collect(), pages: walked.pages, end: walked.end, limited: walked.limited, received_at: now.unix(), broker: own };
                        ConditionEntry { key: condition.key.clone(), state: ConditionState::Ready, last: self.remember(&condition.key, Some(received)) }
                    }
                    Err(message) => {
                        failed += 1;
                        tracing::warn!(key = %call.key, condition = %condition.key, %message, "순위 조건을 받지 못해 이전 값을 둡니다");
                        ConditionEntry { key: condition.key.clone(), state: ConditionState::Failed { at: now.unix(), message }, last: self.remember(&condition.key, None) }
                    }
                };
                entries.push((position, entry));
            }
            for condition in &plan.unavailable {
                let position = options.conditions.iter().position(|candidate| candidate.key == condition.key).unwrap_or(usize::MAX);
                entries.push((position, ConditionEntry { key: condition.key.clone(), state: ConditionState::Unavailable, last: None }));
            }
            self.forget_others(&plan.mine);
            entries.sort_by_key(|(position, _)| *position);
            let body = RankingsPartBody { period_secs: call.period.as_secs(), pages: options.pages, conditions: entries.into_iter().map(|(_, entry)| entry).collect() };
            let header = Header::new(DataKind::Rankings, call.observation_date, now.unix(), now.unix(), vec![SourceKey { key_name: call.key.as_str().to_owned(), broker: own }]);
            let path = part_path(call.shared_dir, &call.observation_date.yyyymmdd(), call.key.as_str());
            write_snapshot_at(path, header, body).map_err(|error| JobError(format!("공용 자료를 쓰지 못했습니다: {error}")))?;
            match failed {
                0 => Ok(()),
                count => Err(JobError(format!("순위 조건 {count}건을 받지 못했습니다"))),
            }
        })
    }
}
