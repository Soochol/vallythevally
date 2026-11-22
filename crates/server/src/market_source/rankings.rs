use std::future::Future;

use futures::future::BoxFuture;
use serde_json::Value;
use tokio::sync::watch;

use super::{Cursor, Priority, SourceError, SourceFailure};
use crate::api::{self, ApiErrorCode, ApiErrorReason, Excludes, Percent, Ranking, RankingFigures, Venue, Won};
use domain::StockCode;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RankingKind {
    TradeAmount,
    TradeVolume,
    Turnover,
    VolumeSurge,
    Gainers,
    Losers,
    Expected,
    InvestorNetBuy,
    ForeignStreak,
    Program,
    BidAskBalance,
    CreditRatio,
    MostViewed,
}

impl RankingKind {
    pub const ALL: [RankingKind; 13] = [
        RankingKind::TradeAmount,
        RankingKind::TradeVolume,
        RankingKind::Turnover,
        RankingKind::VolumeSurge,
        RankingKind::Gainers,
        RankingKind::Losers,
        RankingKind::Expected,
        RankingKind::InvestorNetBuy,
        RankingKind::ForeignStreak,
        RankingKind::Program,
        RankingKind::BidAskBalance,
        RankingKind::CreditRatio,
        RankingKind::MostViewed,
    ];

    pub fn of(ranking: &Ranking) -> RankingKind {
        match ranking {
            Ranking::TradeAmount { .. } => RankingKind::TradeAmount,
            Ranking::TradeVolume { .. } => RankingKind::TradeVolume,
            Ranking::Turnover { .. } => RankingKind::Turnover,
            Ranking::VolumeSurge { .. } => RankingKind::VolumeSurge,
            Ranking::Gainers { .. } => RankingKind::Gainers,
            Ranking::Losers { .. } => RankingKind::Losers,
            Ranking::Expected { .. } => RankingKind::Expected,
            Ranking::InvestorNetBuy { .. } => RankingKind::InvestorNetBuy,
            Ranking::ForeignStreak { .. } => RankingKind::ForeignStreak,
            Ranking::Program { .. } => RankingKind::Program,
            Ranking::BidAskBalance { .. } => RankingKind::BidAskBalance,
            Ranking::CreditRatio { .. } => RankingKind::CreditRatio,
            Ranking::MostViewed { .. } => RankingKind::MostViewed,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            RankingKind::TradeAmount => "거래대금 순위",
            RankingKind::TradeVolume => "거래량 순위",
            RankingKind::Turnover => "회전율 순위",
            RankingKind::VolumeSurge => "거래 급증 순위",
            RankingKind::Gainers => "상승 순위",
            RankingKind::Losers => "하락 순위",
            RankingKind::Expected => "예상체결 순위",
            RankingKind::InvestorNetBuy => "투자자별 순매수 순위",
            RankingKind::ForeignStreak => "외국인 연속 순매수 순위",
            RankingKind::Program => "프로그램 순매수 순위",
            RankingKind::BidAskBalance => "호가잔량 순위",
            RankingKind::CreditRatio => "신용비율 순위",
            RankingKind::MostViewed => "많이 본 종목 순위",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RankingChoices {
    pub venues: Vec<Venue>,
    pub sessions: Vec<api::TradingSession>,
    pub baselines: Vec<api::SurgeBaseline>,
    pub surge_sorts: Vec<api::SurgeSort>,
    pub min_trade_amounts: Vec<api::MinTradeAmount>,
    pub investors: Vec<api::RankingInvestor>,
    pub spans: Vec<api::ViewSpan>,
    pub excludes_managed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unsupported {
    Kind(RankingKind),
    Choice(RankingKind, &'static str),
}

impl Unsupported {
    pub fn into_failure(self) -> SourceFailure {
        let message = match self {
            Unsupported::Kind(kind) => format!("지금 쓰는 시세 공급원은 {}을(를) 받을 수 없습니다", kind.label()),
            Unsupported::Choice(kind, choice) => format!("지금 쓰는 시세 공급원은 {}의 {choice}을(를) 받을 수 없습니다", kind.label()),
        };
        SourceFailure { code: ApiErrorCode::BadRequest, reason: ApiErrorReason::UnsupportedBySource, message, retry_at: None, manual_action_required: false }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RankedRow {
    pub code: StockCode,
    pub name: String,
    pub price: Option<Won>,
    pub change_rate: Option<Percent>,
    pub figures: RankingFigures,
}

pub struct RankingFetch {
    pub rows: Vec<RankedRow>,
    pub next: Option<Cursor>,
    pub continues_without_cursor: bool,
}

#[derive(Debug, Clone)]
pub enum RankingError {
    Source(SourceError),
    CursorRefused(SourceError),
    Unreadable,
    Unsupported(Unsupported),
}

impl From<Unsupported> for RankingError {
    fn from(unsupported: Unsupported) -> Self {
        RankingError::Unsupported(unsupported)
    }
}

impl From<SourceError> for RankingError {
    fn from(error: SourceError) -> Self {
        RankingError::Source(error)
    }
}

pub struct Demand {
    best: watch::Receiver<Priority>,
}

impl Demand {
    pub fn new(best: watch::Receiver<Priority>) -> Self {
        Demand { best }
    }

    pub async fn run<O, F: Future<Output = O>>(&mut self, start: impl Fn(Priority) -> F) -> O {
        let mut priority = *self.best.borrow_and_update();
        let mut call = Box::pin(start(priority));
        loop {
            tokio::select! {
                biased;
                output = &mut call => return output,
                Ok(()) = self.best.changed() => {
                    let best = *self.best.borrow_and_update();
                    if best < priority {
                        priority = best;
                        call = Box::pin(start(priority));
                    }
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct QueryKey {
    source: &'static str,
    body: String,
}

pub fn excludes_of(ranking: &Ranking) -> Excludes {
    match ranking {
        Ranking::TradeAmount { excludes, .. }
        | Ranking::TradeVolume { excludes, .. }
        | Ranking::Turnover { excludes, .. }
        | Ranking::VolumeSurge { excludes, .. }
        | Ranking::Gainers { excludes, .. }
        | Ranking::Losers { excludes, .. }
        | Ranking::Expected { excludes, .. }
        | Ranking::InvestorNetBuy { excludes, .. }
        | Ranking::ForeignStreak { excludes, .. }
        | Ranking::Program { excludes, .. }
        | Ranking::BidAskBalance { excludes, .. }
        | Ranking::CreditRatio { excludes, .. }
        | Ranking::MostViewed { excludes, .. } => *excludes,
    }
}

pub trait RankingSource: Send + Sync + 'static {
    fn name(&self) -> &'static str;

    fn kinds(&self) -> &'static [RankingKind];

    fn choices(&self, kind: RankingKind) -> RankingChoices;

    fn page<'a>(&'a self, ranking: &'a Ranking, cursor: Option<&'a Cursor>, demand: &'a mut Demand) -> BoxFuture<'a, Result<RankingFetch, RankingError>>;

    fn refuses_combination(&self, _ranking: &Ranking) -> Option<Unsupported> {
        None
    }

    fn check(&self, ranking: &Ranking) -> Result<(), Unsupported> {
        let kind = RankingKind::of(ranking);
        if !self.kinds().contains(&kind) {
            return Err(Unsupported::Kind(kind));
        }
        let choices = self.choices(kind);
        let refused = |choice| Unsupported::Choice(kind, choice);
        match ranking {
            Ranking::TradeVolume { session, .. } if !choices.sessions.contains(session) => return Err(refused("장 구분")),
            Ranking::VolumeSurge { baseline, .. } if !choices.baselines.contains(baseline) => return Err(refused("기준 기간")),
            Ranking::VolumeSurge { sort, .. } if !choices.surge_sorts.contains(sort) => return Err(refused("정렬 기준")),
            Ranking::Gainers { min_trade_amount, .. } | Ranking::Losers { min_trade_amount, .. } if !choices.min_trade_amounts.contains(min_trade_amount) => {
                return Err(refused("최소 거래대금"));
            }
            Ranking::InvestorNetBuy { investor, .. } if !choices.investors.contains(investor) => return Err(refused("투자자 구분")),
            Ranking::MostViewed { span, .. } if !choices.spans.contains(span) => return Err(refused("조회 기간")),
            _ => {}
        }
        let (venue, exclude_managed) = match ranking {
            Ranking::TradeAmount { venue, exclude_managed, .. }
            | Ranking::TradeVolume { venue, exclude_managed, .. }
            | Ranking::Turnover { venue, exclude_managed, .. }
            | Ranking::VolumeSurge { venue, exclude_managed, .. }
            | Ranking::Gainers { venue, exclude_managed, .. }
            | Ranking::Losers { venue, exclude_managed, .. }
            | Ranking::Expected { venue, exclude_managed, .. }
            | Ranking::BidAskBalance { venue, exclude_managed, .. }
            | Ranking::CreditRatio { venue, exclude_managed, .. } => (Some(venue), *exclude_managed),
            Ranking::ForeignStreak { venue, .. } | Ranking::Program { venue, .. } => (Some(venue), false),
            Ranking::InvestorNetBuy { .. } | Ranking::MostViewed { .. } => (None, false),
        };
        if venue.is_some_and(|venue| !choices.venues.contains(venue)) {
            return Err(refused("시장 구분"));
        }
        if exclude_managed && !choices.excludes_managed {
            return Err(refused("관리종목 제외"));
        }
        self.refuses_combination(ranking).map_or(Ok(()), Err)
    }

    fn query_key(&self, ranking: &Ranking) -> QueryKey {
        let mut body = serde_json::to_value(ranking).expect("순위 요청은 언제나 직렬화된다");
        if let Value::Object(fields) = &mut body {
            fields.remove("excludes");
        }
        QueryKey { source: self.name(), body: body.to_string() }
    }
}

