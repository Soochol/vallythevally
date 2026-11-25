use std::collections::HashMap;
use std::path::Path;

use domain::{KstDate, TimeOfDay};
use serde_json::Value;
use server::api::Market as ApiMarket;
use server::kiwoom::api::ViTriggeredStocks;
use server::kiwoom::rest::{MergeScope, Priority};
use server::shared_data::{Broker, DataKind, Header, SourceKey, ViEventRow, ViEventsBody, write_snapshot};

use super::job::{JobCall, JobError, JobFuture, JobWindow, Market, SharedJob};
use crate::universe::{MarketName, read_universe_if_present};

const OPENS_AT: TimeOfDay = match TimeOfDay::hms(9, 0, 0) {
    Some(time) => time,
    None => unreachable!(),
};
const CLOSES_AT: TimeOfDay = match TimeOfDay::hms(15, 35, 0) {
    Some(time) => time,
    None => unreachable!(),
};
const DEFAULT_PERIOD_SECS: u64 = 60;

#[derive(Default)]
pub(super) struct ViEventsJob;

fn universe_lookup(shared_dir: &Path, observation_date: KstDate) -> HashMap<String, (String, ApiMarket)> {
    let Some(data_dir) = shared_dir.parent() else {
        return HashMap::new();
    };
    let Ok(date) = observation_date.yyyymmdd().parse::<u32>() else {
        return HashMap::new();
    };
    let Ok(Some(file)) = read_universe_if_present(data_dir, date) else {
        return HashMap::new();
    };
    file.stocks
        .into_iter()
        .map(|entry| {
            let market = match entry.market {
                MarketName::Kospi => ApiMarket::Kospi,
                MarketName::Kosdaq => ApiMarket::Kosdaq,
            };
            (entry.code, (entry.name, market))
        })
        .collect()
}

impl SharedJob for ViEventsJob {
    fn window(&self) -> JobWindow {
        JobWindow { start: OPENS_AT, end: CLOSES_AT }
    }

    fn brokers(&self) -> &'static [Broker] {
        &[Broker::Kiwoom]
    }

    fn default_period_secs(&self) -> u64 {
        DEFAULT_PERIOD_SECS
    }

    fn check_options(&self, options: &Value) -> Result<(), String> {
        match options.is_null() {
            true => Ok(()),
            false => Err("vi_events는 선택값을 받지 않습니다".to_owned()),
        }
    }

    fn run<'a>(&'a self, call: JobCall<'a>) -> JobFuture<'a> {
        Box::pin(async move {
            let Market::Kiwoom(rest) = call.market else {
                return Err(JobError("vi_events는 키움 키만 받습니다".to_owned()));
            };
            if !call.slice.owns(0) {
                return Ok(());
            }
            let page = rest
                .call(&ViTriggeredStocks::KRX_TODAY, None, Priority::Background, MergeScope::default())
                .await
                .map_err(|error| JobError(format!("VI 발동 목록을 받지 못했습니다: {error}")))?;
            let lookup = universe_lookup(call.shared_dir, call.observation_date);
            let parsed = page.body.events();
            let events = parsed
                .rows
                .into_iter()
                .map(|event| {
                    let code = event.code.as_str().to_owned();
                    let found = lookup.get(&code);
                    let name = if event.name.is_empty() {
                        found.map(|(name, _)| name.clone()).unwrap_or_else(|| code.clone())
                    } else {
                        event.name
                    };
                    let market = event.market.or_else(|| found.map(|(_, market)| *market)).unwrap_or(ApiMarket::Kospi);
                    ViEventRow {
                        code,
                        name,
                        market,
                        direction: event.direction,
                        triggered_at: event.triggered.to_string(),
                        released_at: event.released.map(|time| time.to_string()),
                        trigger_price: event.trigger_price,
                        static_vi: event.static_vi,
                        dynamic_vi: event.dynamic_vi,
                        dispersion_rate: event.dispersion_rate,
                    }
                })
                .collect();
            let now = call.clock.now().unix();
            let header = Header::new(
                DataKind::ViEvents,
                call.observation_date,
                now,
                now,
                vec![SourceKey { key_name: call.key.as_str().to_owned(), broker: Broker::Kiwoom }],
            );
            write_snapshot(call.shared_dir, header, ViEventsBody { events })
                .map_err(|error| JobError(format!("공용 자료를 쓰지 못했습니다: {error}")))?;
            Ok(())
        })
    }
}
