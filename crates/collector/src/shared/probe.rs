use domain::{StockCode, TimeOfDay};
use serde::Deserialize;
use serde_json::Value;
use server::kiwoom::api::{StockBasicInfo, StockForeignHoldings};
use server::kiwoom::rest::{MergeScope, Priority};
use server::shared_data::{Broker, DataKind, Header, ProbeBody, SourceKey, write_snapshot};

use super::job::{JobCall, JobError, JobFuture, JobWindow, Market, SharedJob};

const DEFAULT_CALLS_PER_TR: u32 = 5;
const MAX_CALLS_PER_TR: u32 = 200;
const END_OF_WINDOW: TimeOfDay = match TimeOfDay::hms(23, 59, 59) {
    Some(time) => time,
    None => unreachable!(),
};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProbeOptions {
    #[serde(default = "default_calls")]
    calls_per_tr: u32,
}

fn default_calls() -> u32 {
    DEFAULT_CALLS_PER_TR
}

fn options_of(options: &Value) -> Result<ProbeOptions, String> {
    let parsed = match options.is_null() {
        true => ProbeOptions { calls_per_tr: DEFAULT_CALLS_PER_TR },
        false => serde_json::from_value::<ProbeOptions>(options.clone()).map_err(|error| error.to_string())?,
    };
    match parsed.calls_per_tr {
        1..=MAX_CALLS_PER_TR => Ok(parsed),
        other => Err(format!("calls_per_tr는 1~{MAX_CALLS_PER_TR}여야 합니다({other})")),
    }
}

fn stock_code(unit: u32) -> StockCode {
    StockCode::parse(&format!("{:06}", 100_000 + unit)).expect("숫자 여섯 자리는 종목 코드다")
}

pub(super) struct ProbeJob;

impl SharedJob for ProbeJob {
    fn window(&self) -> JobWindow {
        JobWindow { start: TimeOfDay::MIDNIGHT, end: END_OF_WINDOW }
    }

    fn brokers(&self) -> &'static [Broker] {
        &[Broker::Kiwoom]
    }

    fn check_options(&self, options: &Value) -> Result<(), String> {
        options_of(options).map(|_| ())
    }

    fn run<'a>(&'a self, call: JobCall<'a>) -> JobFuture<'a> {
        Box::pin(async move {
            let Market::Kiwoom(rest) = call.market else { return Err(JobError("probe는 키움 키만 받습니다".to_owned())) };
            let options = options_of(call.options).map_err(JobError)?;
            let mine: Vec<u32> = (0..options.calls_per_tr).filter(|unit| call.slice.owns(*unit)).collect();
            let both = mine.iter().map(|unit| async move {
                let (basic_request, foreign_request) = (StockBasicInfo::new(stock_code(*unit)), StockForeignHoldings::new(stock_code(*unit)));
                let basic = rest.call(&basic_request, None, Priority::Background, MergeScope::default());
                let foreign = rest.call(&foreign_request, None, Priority::Background, MergeScope::default());
                let (basic, foreign) = futures::join!(basic, foreign);
                basic.map(|_| ()).and(foreign.map(|_| ()))
            });
            let outcomes = futures::future::join_all(both).await;
            let failed = outcomes.iter().filter(|outcome| outcome.is_err()).count();
            let now = call.clock.now();
            let header = Header::new(DataKind::Probe, call.observation_date, now.unix(), now.unix(), vec![SourceKey { key_name: call.key.as_str().to_owned(), broker: Broker::Kiwoom }]);
            let value = format!("slice {}/{} units {} failed {failed}", call.slice.index, call.slice.count, mine.len());
            write_snapshot(call.shared_dir, header, ProbeBody { value }).map_err(|error| JobError(format!("공용 자료를 쓰지 못했습니다: {error}")))?;
            match failed {
                0 => Ok(()),
                count => Err(JobError(format!("{count}건이 실패했습니다"))),
            }
        })
    }
}

