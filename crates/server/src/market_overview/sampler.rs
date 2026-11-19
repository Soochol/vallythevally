use std::path::PathBuf;
use std::sync::Arc;

use domain::KstTime;

use super::cards::listed;
use super::samples::{Sample, SampleValue};
use super::session::{SAMPLE_INTERVAL_SECS, is_sampling_minute, minute_floor};
use crate::api::Market;
use crate::http::AppState;
use crate::kiwoom::api::{ProgramTrendByMinute, SectorInvestorNet};
use crate::kiwoom::rest::{Access, MergeScope, Priority};

const MARKETS: [Market; 2] = [Market::Kospi, Market::Kosdaq];

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
        if is_sampling_minute(mark) && st.rest.access() == Access::Open {
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
    let request = SectorInvestorNet::new(listed(market), now.kst_date());
    let body = match st.rest.call(&request, None, Priority::Background, MergeScope::default()).await {
        Ok(page) => page.body,
        Err(e) => {
            tracing::warn!(?market, reason = %e, "장중 업종별 투자자 표본을 받지 못했습니다. 이 분의 표본은 비웁니다");
            return None;
        }
    };
    let rows = body.rows().rows;
    let whole = rows.into_iter().find(|r| r.code == super::cards::index_code(market));
    if whole.is_none() {
        tracing::info!(?market, "키움이 종합 행을 주지 않아 이 분의 투자자 표본을 비웁니다(휴장일이거나 장이 시작되지 않았을 수 있습니다)");
    }
    whole.map(|r| SampleValue::Investors { individual_eok: r.individual_eok, foreign_eok: r.foreign_eok, institution_eok: r.institution_eok })
}

async fn program(st: &AppState, market: Market, now: KstTime) -> Option<SampleValue> {
    let request = ProgramTrendByMinute::new(listed(market), now.kst_date());
    let body = match st.rest.call(&request, None, Priority::Background, MergeScope::default()).await {
        Ok(page) => page.body,
        Err(e) => {
            tracing::warn!(?market, reason = %e, "장중 프로그램 매매 표본을 받지 못했습니다. 이 분의 표본은 비웁니다");
            return None;
        }
    };
    let latest = body.rows().rows.into_iter().max_by_key(|r| r.time.secs());
    if latest.is_none() {
        tracing::info!(?market, "키움이 프로그램 매매 행을 주지 않아 이 분의 표본을 비웁니다");
    }
    latest.map(|r| SampleValue::Program { arbitrage_million_won: r.net.arbitrage, non_arbitrage_million_won: r.net.non_arbitrage, total_million_won: r.net.total })
}
