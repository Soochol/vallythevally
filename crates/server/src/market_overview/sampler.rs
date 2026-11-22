use std::path::PathBuf;
use std::sync::Arc;

use domain::KstTime;

use super::overview_source;
use super::samples::{Sample, SampleValue};
use super::session::{SAMPLE_INTERVAL_SECS, is_sampling_minute, minute_floor};
use crate::api::Market;
use crate::http::AppState;
use crate::market_source::{IntradayProgram, InvestorNetEok, Priority};

const MARKETS: [Market; 2] = [Market::Kospi, Market::Kosdaq];
const MILLION_WON_PER_EOK: f64 = 100.0;

pub fn start(state: Arc<AppState>, dir: PathBuf) -> tokio::task::JoinHandle<()> {
    tokio::spawn(run(state, dir))
}

async fn run(st: Arc<AppState>, dir: PathBuf) {
    st.market_overview.samples.open(dir, st.clock.now()).await;
    loop {
        st.clock.sleep_until(KstTime::from_unix(minute_floor(st.clock.now()).unix() + SAMPLE_INTERVAL_SECS)).await;
        let now = st.clock.now();
        st.market_overview.samples.roll_over(now).await;
        let mark = minute_floor(now);
        if is_sampling_minute(mark) && overview_source(&st).is_open() {
            tokio::join!(
                take(&st, Market::Kospi, mark, now, Kind::Investors),
                take(&st, Market::Kospi, mark, now, Kind::Program),
                take(&st, Market::Kosdaq, mark, now, Kind::Investors),
                take(&st, Market::Kosdaq, mark, now, Kind::Program),
            );
        }
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Investors,
    Program,
}

async fn take(st: &AppState, market: Market, mark: KstTime, now: KstTime, kind: Kind) {
    debug_assert!(MARKETS.contains(&market));
    let value = match kind {
        Kind::Investors => investors(st, market, now).await,
        Kind::Program => program(st, market, now).await,
    };
    if let Some(value) = value {
        st.market_overview.samples.record(now, Sample { at: mark.unix(), received_at: st.clock.now().unix(), market, value }).await;
    }
}

async fn investors(st: &AppState, market: Market, now: KstTime) -> Option<SampleValue> {
    match overview_source(st).intraday_investors(market, now, Priority::Background).await {
        Ok(net) => net.map(|InvestorNetEok { individual, foreign, institution }| SampleValue::Investors { individual_eok: individual, foreign_eok: foreign, institution_eok: institution }),
        Err(e) => {
            tracing::warn!(?market, reason = %e, "장중 업종별 투자자 표본을 받지 못했습니다. 이 분의 표본은 비웁니다");
            None
        }
    }
}

fn million_won(eok: f64) -> i64 {
    (eok * MILLION_WON_PER_EOK).round() as i64
}

async fn program(st: &AppState, market: Market, now: KstTime) -> Option<SampleValue> {
    match overview_source(st).intraday_program(market, now, Priority::Background).await {
        Ok(latest) => latest.map(|IntradayProgram { total_eok, split }| SampleValue::Program {
            arbitrage_million_won: split.map(|s| million_won(s.arbitrage_eok)),
            non_arbitrage_million_won: split.map(|s| million_won(s.non_arbitrage_eok)),
            total_million_won: million_won(total_eok),
        }),
        Err(e) => {
            tracing::warn!(?market, reason = %e, "장중 프로그램 매매 표본을 받지 못했습니다. 이 분의 표본은 비웁니다");
            None
        }
    }
}
