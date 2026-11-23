use std::path::Path;

use domain::{KstTime, TimeOfDay};
use serde_json::Value;
use server::api::Market as ApiMarket;
use server::market_overview::{MarketOverview, Sample, SampleValue, investor_sample, is_sampling_minute, minute_floor, program_sample};
use server::market_source::OverviewSource;
use server::shared_data::Broker;
use tokio::sync::OnceCell;

use super::{owns, source_of};
use crate::shared::job::{JobCall, JobFuture, JobWindow, SharedJob};
use server::market_source::OverviewFeature;

const SAMPLES_FOLDER: &str = "market-samples";
const OPENS_AT: TimeOfDay = match TimeOfDay::hms(9, 0, 0) {
    Some(time) => time,
    None => unreachable!(),
};
const CLOSES_AFTER: TimeOfDay = match TimeOfDay::hms(15, 31, 0) {
    Some(time) => time,
    None => unreachable!(),
};

#[derive(Clone, Copy)]
enum Kind {
    Investors,
    Program,
}

const UNITS: [(ApiMarket, Kind); 4] = [(ApiMarket::Kospi, Kind::Investors), (ApiMarket::Kospi, Kind::Program), (ApiMarket::Kosdaq, Kind::Investors), (ApiMarket::Kosdaq, Kind::Program)];

#[derive(Default)]
pub struct IntradaySamplesJob {
    book: MarketOverview,
    opened: OnceCell<()>,
}

async fn value_of(source: &dyn OverviewSource, market: ApiMarket, kind: Kind, now: KstTime) -> Option<SampleValue> {
    match kind {
        Kind::Investors => investor_sample(source, market, now).await,
        Kind::Program => program_sample(source, market, now).await,
    }
}

impl SharedJob for IntradaySamplesJob {
    fn window(&self) -> JobWindow {
        JobWindow { start: OPENS_AT, end: CLOSES_AFTER }
    }

    fn brokers(&self) -> &'static [Broker] {
        &[Broker::Kiwoom, Broker::Kis]
    }

    fn check_options(&self, options: &Value) -> Result<(), String> {
        match options.is_null() {
            true => Ok(()),
            false => Err("intraday_samples는 선택값을 받지 않습니다".to_owned()),
        }
    }

    fn run<'a>(&'a self, call: JobCall<'a>) -> JobFuture<'a> {
        Box::pin(async move {
            let (source, _) = source_of(&call.market)?;
            let now = call.clock.now();
            let samples = &self.book.samples;
            self.opened.get_or_init(|| samples.open(Path::new(call.shared_dir).join(SAMPLES_FOLDER), now)).await;
            samples.roll_over(now).await;
            let mark = minute_floor(now);
            if !is_sampling_minute(mark) || !source.is_open() {
                return Ok(());
            }
            let started = samples.ticket();
            let mine = UNITS.iter().enumerate().filter(|(unit, _)| owns(call.slice, call.peers, *unit as u32, OverviewFeature::IntradayFlow));
            let source = source.as_ref();
            let taken = futures::future::join_all(mine.map(|(_, (market, kind))| async move { (*market, value_of(source, *market, *kind, now).await) })).await;
            for (market, value) in taken {
                if let Some(value) = value {
                    samples.record(now, Sample { at: mark.unix(), received_at: call.clock.now().unix(), market, value }, started).await;
                }
            }
            Ok(())
        })
    }
}
