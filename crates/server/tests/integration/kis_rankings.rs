use crate::support;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use domain::{KstDate, KstTime};
use futures::future::BoxFuture;
use server::api::{self, Excludes, MinTradeAmount, NetDirection, Ranking, RankingFigures, RankingInvestor, RankingMarket, SurgeBaseline, SurgeSort, TradeUnit, TradingSession, Venue, ViewSpan};
use server::clock::{Clock, kst};
use server::config::{KisCredentials, Secret};
use server::kis::api::KisApiId;
use server::kis::auth::KisAuth;
use server::kis::rankings::KisRankings;
use server::kis::rest::KisRest;
use server::kis::token_file::{Saved, SavedToken, TokenFile, credential_id};
use server::kis::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::market_source::Priority;
use server::market_source::rankings::{Demand, RankedRow, RankingError, RankingKind, RankingSource, Unsupported};
use server::rankings::KiwoomRankings;

const APP_KEY: &str = "FAKE-KIS-APPKEY-rankings-1";
const APP_SECRET: &str = "FAKE-KIS-SECRET-rankings-1";
const TOKEN: &str = "FAKE-KIS-TOKEN-rankings";
const KEEP_ALL: Excludes = Excludes { etf_etn: false, preferred: false };

fn fixture(name: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/kis/rankings").join(name)).unwrap().trim().to_owned()
}

fn friday_morning() -> KstTime {
    kst(KstDate::new(2026, 11, 20).unwrap(), 9, 30, 0)
}

#[derive(Clone)]
struct Sent {
    path: &'static str,
    query: Vec<(String, String)>,
}

impl Sent {
    fn get(&self, name: &str) -> &str {
        self.query.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str()).unwrap_or_else(|| panic!("{name}이 없다: {:?}", self.query))
    }
}

type Handler = dyn Fn(&Sent) -> HttpResponse + Send + Sync;

struct FakeKis {
    sent: Mutex<Vec<Sent>>,
    handler: Box<Handler>,
}

impl FakeKis {
    fn sent_to(&self, api: KisApiId) -> Vec<Sent> {
        self.sent.lock().unwrap().iter().filter(|s| s.path == api.path()).cloned().collect()
    }

    fn total(&self) -> usize {
        self.sent.lock().unwrap().len()
    }
}

impl Transport for FakeKis {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let sent = Sent { path: req.path, query: req.query.iter().map(|(n, v)| (n.to_string(), v.clone())).collect() };
        let response = (self.handler)(&sent);
        self.sent.lock().unwrap().push(sent);
        Box::pin(async move { Ok(response) })
    }
}

fn ok(body: impl Into<String>) -> HttpResponse {
    HttpResponse { status: 200, tr_cont: None, body: body.into() }
}

fn serving(api: KisApiId, file: &'static str) -> impl Fn(&Sent) -> HttpResponse + Send + Sync + 'static {
    move |sent| if sent.path == api.path() { ok(fixture(file)) } else { ok(r#"{"output":[]}"#) }
}

struct Rig {
    source: KisRankings,
    transport: Arc<FakeKis>,
    _dir: tempfile::TempDir,
}

fn rig_at(now: KstTime, handler: impl Fn(&Sent) -> HttpResponse + Send + Sync + 'static) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("state/vallythevally/kis-token.json");
    TokenFile::new(path.clone())
        .save(&Saved {
            credential: Some(credential_id(APP_KEY)),
            token: Some(SavedToken { value: TOKEN.into(), expires_at: now.unix() + 86_400, issued_at: now.unix() - 3600 }),
            last_request_at: now.unix() - 3600,
            disconnected: None,
        })
        .unwrap();
    let transport = Arc::new(FakeKis { sent: Mutex::default(), handler: Box::new(handler) });
    let clock = Clock::fake(now);
    let transport_dyn: Arc<dyn Transport> = transport.clone();
    let credentials = KisCredentials { app_key: Secret::new(APP_KEY.into()), app_secret: Secret::new(APP_SECRET.into()) };
    let auth = KisAuth::new(credentials, path, transport_dyn.clone(), clock.clone());
    Rig { source: KisRankings::new(KisRest::new(transport_dyn, auth), clock), transport, _dir: dir }
}

fn rig(handler: impl Fn(&Sent) -> HttpResponse + Send + Sync + 'static) -> Rig {
    rig_at(friday_morning(), handler)
}

fn demand() -> Demand {
    Demand::new(tokio::sync::watch::channel(Priority::Screen).1)
}

async fn rows(source: &dyn RankingSource, ranking: Ranking) -> Result<Vec<RankedRow>, RankingError> {
    source.page(&ranking, None, &mut demand()).await.map(|fetched| {
        assert!(fetched.next.is_none() && !fetched.continues_without_cursor, "한투 순위는 한 쪽으로 끝난다");
        fetched.rows
    })
}

fn assert_unsupported(result: Result<Vec<RankedRow>, RankingError>, kind: RankingKind, choice: Option<&'static str>) {
    let want = match choice {
        Some(choice) => Unsupported::Choice(kind, choice),
        None => Unsupported::Kind(kind),
    };
    assert!(matches!(&result, Err(RankingError::Unsupported(got)) if *got == want), "{result:?}");
}

fn trade_amount(market: RankingMarket, venue: Venue) -> Ranking {
    Ranking::TradeAmount { market, venue, excludes: KEEP_ALL, exclude_managed: false }
}

fn gainers(include_limit: bool, min_trade_amount: MinTradeAmount) -> Ranking {
    Ranking::Gainers { market: RankingMarket::All, venue: Venue::Krx, include_limit, min_trade_amount, excludes: KEEP_ALL, exclude_managed: false }
}

fn investor_net_buy(investor: RankingInvestor, unit: TradeUnit) -> Ranking {
    Ranking::InvestorNetBuy { market: RankingMarket::Kospi, investor, direction: NetDirection::NetBuy, unit, excludes: KEEP_ALL }
}

fn most_viewed(span: ViewSpan) -> Ranking {
    Ranking::MostViewed { span, excludes: KEEP_ALL }
}

#[tokio::test(start_paused = true)]
async fn trade_amount_for_kospi_in_the_combined_market_goes_out_once_and_its_rows_keep_their_order() {
    let rig = rig(serving(KisApiId::VolumeRank, "volume_rank.json"));
    let found = rows(&rig.source, trade_amount(RankingMarket::Kospi, Venue::Combined)).await.unwrap();
    let sent = rig.transport.sent_to(KisApiId::VolumeRank);
    assert_eq!(sent.len(), 1);
    assert_eq!(rig.transport.total(), 1, "토큰 파일을 쓰므로 순위 한 번만 나간다");
    assert_eq!((sent[0].get("FID_BLNG_CLS_CODE"), sent[0].get("FID_COND_MRKT_DIV_CODE"), sent[0].get("FID_INPUT_ISCD")), ("3", "UN", "0001"));
    assert_eq!(KisApiId::VolumeRank.tr_id(), "FHPST01710000");
    let codes: Vec<_> = found.iter().map(|row| row.code.as_str().to_owned()).collect();
    assert_eq!(codes, ["005930", "000660", "086520"]);
    assert_eq!(found[0].name, "삼성전자");
    assert_eq!((found[0].price, found[0].change_rate), (Some(api::Won(71_000)), Some(api::Percent(1.43))));
    assert_eq!(found[0].figures, RankingFigures::TradeAmount { trade_amount: api::Won(1_065_000_000_000), volume: api::Shares(15_000_000), places_gained: None });
}

#[tokio::test(start_paused = true)]
async fn the_other_volume_rank_kinds_pick_their_own_belonging_code_and_columns() {
    let rig = rig(serving(KisApiId::VolumeRank, "volume_rank.json"));
    let volume = rows(&rig.source, Ranking::TradeVolume { market: RankingMarket::All, venue: Venue::Krx, session: TradingSession::Regular, excludes: KEEP_ALL, exclude_managed: true }).await.unwrap();
    let turnover = rows(&rig.source, Ranking::Turnover { market: RankingMarket::Kosdaq, venue: Venue::Nxt, excludes: KEEP_ALL, exclude_managed: false }).await.unwrap();
    let surge = rows(
        &rig.source,
        Ranking::VolumeSurge { market: RankingMarket::All, venue: Venue::Combined, baseline: SurgeBaseline::PreviousDay, sort: SurgeSort::SurgeRate, excludes: KEEP_ALL, exclude_managed: false },
    )
    .await
    .unwrap();
    let sent = rig.transport.sent_to(KisApiId::VolumeRank);
    let belongings: Vec<_> = sent.iter().map(|s| s.get("FID_BLNG_CLS_CODE")).collect();
    assert_eq!(belongings, ["0", "2", "1"]);
    assert_eq!((sent[0].get("FID_COND_MRKT_DIV_CODE"), sent[0].get("FID_TRGT_EXLS_CLS_CODE")), ("J", "0100000000"), "관리종목 제외는 대상 제외 칸의 두 번째 자리다");
    assert_eq!((sent[1].get("FID_COND_MRKT_DIV_CODE"), sent[1].get("FID_INPUT_ISCD"), sent[1].get("FID_TRGT_EXLS_CLS_CODE")), ("NX", "1001", "0000000000"));
    match &volume[0].figures {
        RankingFigures::TradeVolume { volume, previous_day_volume_rate: Some(rate) } => assert_eq!((volume.0, rate.0), (15_000_000, 125.0)),
        other => panic!("{other:?}"),
    }
    assert!(matches!(volume[2].figures, RankingFigures::TradeVolume { previous_day_volume_rate: None, .. }), "전일 거래량 0이면 비율을 비운다");
    assert_eq!(turnover[1].figures, RankingFigures::Turnover { turnover_rate: api::Percent(0.41), volume: api::Shares(3_000_000) });
    assert_eq!(surge[0].figures, RankingFigures::VolumeSurge { surge_rate: api::Percent(150.0), surge_volume: api::Shares(5_000_000), volume: api::Shares(15_000_000) });
}

#[tokio::test(start_paused = true)]
async fn after_hours_volume_comes_from_the_overtime_rank_and_pre_market_is_refused_without_a_request() {
    let rig = rig(serving(KisApiId::OvertimeVolume, "overtime.json"));
    let after = Ranking::TradeVolume { market: RankingMarket::Kospi, venue: Venue::Krx, session: TradingSession::AfterHours, excludes: KEEP_ALL, exclude_managed: false };
    let found = rows(&rig.source, after).await.unwrap();
    let sent = rig.transport.sent_to(KisApiId::OvertimeVolume);
    assert_eq!((sent.len(), KisApiId::OvertimeVolume.tr_id()), (1, "FHPST02350000"));
    assert_eq!((sent[0].get("FID_COND_MRKT_DIV_CODE"), sent[0].get("FID_RANK_SORT_CLS_CODE"), sent[0].get("FID_INPUT_ISCD")), ("J", "2", "0001"));
    assert_eq!((found[0].price, found[0].change_rate), (Some(api::Won(70_500)), Some(api::Percent(-0.70))));
    assert_eq!(found[0].figures, RankingFigures::TradeVolume { volume: api::Shares(123_456), previous_day_volume_rate: None });
    let before = rig.transport.total();
    let pre = Ranking::TradeVolume { market: RankingMarket::All, venue: Venue::Krx, session: TradingSession::PreMarket, excludes: KEEP_ALL, exclude_managed: false };
    assert_unsupported(rows(&rig.source, pre).await, RankingKind::TradeVolume, Some("장 구분"));
    assert_eq!(rig.transport.total(), before);
}

#[tokio::test(start_paused = true)]
async fn the_minimum_trade_amount_of_gainers_rides_in_the_volume_condition_slot() {
    let rig = rig(serving(KisApiId::Fluctuation, "fluctuation.json"));
    rows(&rig.source, gainers(true, MinTradeAmount::AtLeast1Billion)).await.unwrap();
    rows(&rig.source, gainers(true, MinTradeAmount::Any)).await.unwrap();
    let sent = rig.transport.sent_to(KisApiId::Fluctuation);
    assert_eq!(KisApiId::Fluctuation.tr_id(), "FHPST01700000");
    assert_eq!((sent[0].get("FID_VOL_CNT"), sent[1].get("FID_VOL_CNT")), ("1000000000", ""));
    assert_eq!((sent[0].get("FID_COND_MRKT_DIV_CODE"), sent[0].get("FID_COND_SCR_DIV_CODE")), ("J", "20170"));
}

#[tokio::test(start_paused = true)]
async fn gainers_and_losers_differ_in_the_sort_code_and_a_limit_row_is_dropped_unless_asked_for() {
    let rig = rig(|sent| if sent.get("FID_RANK_SORT_CLS_CODE") == "1" { ok(fixture("fluctuation_falling.json")) } else { ok(fixture("fluctuation.json")) });
    let with_limit = rows(&rig.source, gainers(true, MinTradeAmount::Any)).await.unwrap();
    let without_limit = rows(&rig.source, gainers(false, MinTradeAmount::Any)).await.unwrap();
    let losers = |include_limit| Ranking::Losers { market: RankingMarket::All, venue: Venue::Combined, include_limit, min_trade_amount: MinTradeAmount::Any, excludes: KEEP_ALL, exclude_managed: false };
    let falling_with_limit = rows(&rig.source, losers(true)).await.unwrap();
    let falling_without_limit = rows(&rig.source, losers(false)).await.unwrap();
    let sent = rig.transport.sent_to(KisApiId::Fluctuation);
    assert_eq!(sent.iter().map(|s| s.get("FID_RANK_SORT_CLS_CODE")).collect::<Vec<_>>(), ["0", "0", "1", "1"]);
    assert_eq!(sent[2].get("FID_COND_MRKT_DIV_CODE"), "J", "통합은 J로 본다");
    assert_eq!((with_limit.len(), without_limit.len(), falling_with_limit.len(), falling_without_limit.len()), (2, 1, 2, 1));
    assert_eq!(without_limit[0].code.as_str(), "247540");
    assert_eq!(with_limit[0].figures, RankingFigures::Movers { price_change: api::Won(30_000), volume: api::Shares(1_200_000) });
    assert_eq!(falling_with_limit[0].figures, RankingFigures::Movers { price_change: api::Won(-30_000), volume: api::Shares(1_200_000) });
}

#[tokio::test(start_paused = true)]
async fn expected_executions_ask_for_the_before_open_list_in_the_morning_and_the_close_list_after_noon() {
    let morning = rig_at(friday_morning(), serving(KisApiId::ExpectedUpDown, "expected.json"));
    let afternoon = rig_at(kst(KstDate::new(2026, 11, 20).unwrap(), 15, 25, 0), serving(KisApiId::ExpectedUpDown, "expected.json"));
    let expected = |sort| Ranking::Expected { market: RankingMarket::All, venue: Venue::Combined, sort, excludes: KEEP_ALL, exclude_managed: false };
    let found = rows(&morning.source, expected(api::ExpectedSort::Gainers)).await.unwrap();
    rows(&afternoon.source, expected(api::ExpectedSort::Losers)).await.unwrap();
    let (before, close) = (morning.transport.sent_to(KisApiId::ExpectedUpDown), afternoon.transport.sent_to(KisApiId::ExpectedUpDown));
    assert_eq!(KisApiId::ExpectedUpDown.tr_id(), "FHPST01820000");
    assert_eq!((before[0].get("FID_RANK_SORT_CLS_CODE"), before[0].get("FID_MKOP_CLS_CODE")), ("0", "0"));
    assert_eq!((close[0].get("FID_RANK_SORT_CLS_CODE"), close[0].get("FID_MKOP_CLS_CODE")), ("3", "1"));
    assert_eq!(found[0].figures, RankingFigures::Expected { expected_price: api::Won(72_000), expected_change_rate: api::Percent(1.41), expected_volume: api::Shares(54_321) });
    assert_eq!((found[0].price, found[0].change_rate), (None, None));
}

#[tokio::test(start_paused = true)]
async fn net_buying_by_a_bank_is_refused_without_a_request_and_by_foreigners_goes_to_the_investor_total() {
    let rig = rig(serving(KisApiId::InvestorTotal, "investor.json"));
    assert_unsupported(rows(&rig.source, investor_net_buy(RankingInvestor::Bank, TradeUnit::Amount)).await, RankingKind::InvestorNetBuy, Some("투자자 구분"));
    assert_eq!(rig.transport.total(), 0, "받지 않는 투자자 구분은 transport 요청 없이 닫는다");
    let amount = rows(&rig.source, investor_net_buy(RankingInvestor::Foreign, TradeUnit::Amount)).await.unwrap();
    let quantity = rows(&rig.source, investor_net_buy(RankingInvestor::Institution, TradeUnit::Quantity)).await.unwrap();
    let others = rows(&rig.source, investor_net_buy(RankingInvestor::OtherCorporation, TradeUnit::Amount)).await.unwrap();
    let sent = rig.transport.sent_to(KisApiId::InvestorTotal);
    assert_eq!(KisApiId::InvestorTotal.tr_id(), "FHPTJ04400000");
    assert_eq!((sent[0].get("FID_ETC_CLS_CODE"), sent[0].get("FID_DIV_CLS_CODE"), sent[0].get("FID_RANK_SORT_CLS_CODE")), ("1", "1", "0"));
    assert_eq!((sent[0].get("FID_COND_MRKT_DIV_CODE"), sent[0].get("FID_COND_SCR_DIV_CODE"), sent[0].get("FID_INPUT_ISCD")), ("V", "16449", "0001"));
    assert_eq!((sent[1].get("FID_ETC_CLS_CODE"), sent[1].get("FID_DIV_CLS_CODE")), ("2", "0"));
    assert_eq!(sent[2].get("FID_ETC_CLS_CODE"), "3");
    assert_eq!(amount[0].figures, RankingFigures::NetAmounts { net: api::Won(85_200_000_000), buy: api::Won(0), sell: api::Won(0) });
    assert_eq!(quantity[0].figures, RankingFigures::NetQuantities { net: api::Shares(-300), buy: api::Shares(0), sell: api::Shares(0) });
    assert_eq!(others[0].figures, RankingFigures::NetAmounts { net: api::Won(1_050_000_000), buy: api::Won(0), sell: api::Won(0) });
    assert_eq!((amount[0].price, amount[0].change_rate), (Some(api::Won(71_000)), Some(api::Percent(1.43))), "한투는 현재가와 등락률도 함께 준다");
}

#[tokio::test(start_paused = true)]
async fn the_most_viewed_span_of_thirty_seconds_is_refused_and_today_goes_to_the_hts_top_view() {
    let rig = rig(serving(KisApiId::HtsTopView, "top_view.json"));
    for span in [ViewSpan::Seconds30, ViewSpan::Minute1, ViewSpan::Minutes10, ViewSpan::Hour1] {
        assert_unsupported(rows(&rig.source, most_viewed(span)).await, RankingKind::MostViewed, Some("조회 기간"));
    }
    assert_eq!(rig.transport.total(), 0);
    let found = rows(&rig.source, most_viewed(ViewSpan::Today)).await.unwrap();
    let sent = rig.transport.sent_to(KisApiId::HtsTopView);
    assert_eq!((sent.len(), KisApiId::HtsTopView.tr_id(), sent[0].query.len()), (1, "HHMCM000100C0", 0));
    assert_eq!(found.iter().map(|row| row.code.as_str()).collect::<Vec<_>>(), ["000660", "005930"]);
}

#[tokio::test(start_paused = true)]
async fn bid_ask_balance_and_credit_ratio_read_their_own_columns() {
    let rig = rig(|sent| if sent.path == KisApiId::QuoteBalance.path() { ok(fixture("balance.json")) } else { ok(fixture("credit.json")) });
    let balance = rows(&rig.source, Ranking::BidAskBalance { market: api::Market::Kosdaq, venue: Venue::Krx, sort: api::BalanceSort::BuyRatio, excludes: KEEP_ALL, exclude_managed: true }).await.unwrap();
    let credit = rows(&rig.source, Ranking::CreditRatio { market: RankingMarket::Kospi, venue: Venue::Krx, excludes: KEEP_ALL, exclude_managed: false }).await.unwrap();
    let (balance_sent, credit_sent) = (rig.transport.sent_to(KisApiId::QuoteBalance), rig.transport.sent_to(KisApiId::CreditBalance));
    assert_eq!((KisApiId::QuoteBalance.tr_id(), KisApiId::CreditBalance.tr_id()), ("FHPST01720000", "FHKST17010000"));
    assert_eq!((balance_sent[0].get("FID_RANK_SORT_CLS_CODE"), balance_sent[0].get("FID_INPUT_ISCD"), balance_sent[0].get("FID_TRGT_EXLS_CLS_CODE")), ("2", "1001", "0100000000"));
    assert_eq!((credit_sent[0].get("FID_COND_SCR_DIV_CODE"), credit_sent[0].get("FID_INPUT_ISCD"), credit_sent[0].get("FID_OPTION")), ("11701", "0001", "2"));
    assert_eq!(
        balance[0].figures,
        RankingFigures::BidAskBalance { total_sell_remaining: api::Shares(400_000), total_buy_remaining: api::Shares(900_000), net_buy_remaining: api::Shares(500_000), buy_ratio: api::Percent(69.23) }
    );
    assert_eq!(credit[0].figures, RankingFigures::CreditRatio { credit_ratio: api::Percent(0.85), volume: api::Shares(15_000_000) });
}

#[tokio::test(start_paused = true)]
async fn the_kis_kinds_leave_out_foreign_streaks_and_program_net_buying_while_kiwoom_has_all_thirteen() {
    let rig = rig(|_| ok("{}"));
    let kis = rig.source.kinds();
    assert_eq!(kis.len(), 11);
    assert!(!kis.contains(&RankingKind::ForeignStreak) && !kis.contains(&RankingKind::Program));
    let streak = Ranking::ForeignStreak { market: RankingMarket::All, venue: Venue::Krx, direction: NetDirection::NetBuy, excludes: KEEP_ALL };
    let program = Ranking::Program { market: api::Market::Kospi, venue: Venue::Krx, direction: NetDirection::NetBuy, excludes: KEEP_ALL };
    assert_unsupported(rows(&rig.source, streak).await, RankingKind::ForeignStreak, None);
    assert_unsupported(rows(&rig.source, program).await, RankingKind::Program, None);
    assert_eq!(rig.transport.total(), 0);

    let fake = support::ScriptedTransport::new();
    let clock = Clock::fake(friday_morning());
    let auth = server::kiwoom::auth::KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
    let kiwoom = KiwoomRankings::new(server::kiwoom::rest::KiwoomRest::new(fake.transport(), auth, clock));
    assert_eq!(kiwoom.kinds(), RankingKind::ALL);
}

#[tokio::test(start_paused = true)]
async fn the_boundary_lists_the_choices_each_kind_takes_and_kis_takes_one_surge_baseline() {
    let rig = rig(|_| ok("{}"));
    let surge = rig.source.choices(RankingKind::VolumeSurge);
    assert_eq!((surge.baselines, surge.surge_sorts), (vec![SurgeBaseline::PreviousDay], vec![SurgeSort::SurgeRate]));
    assert_eq!(rig.source.choices(RankingKind::MostViewed).spans, vec![ViewSpan::Today]);
    assert_eq!(rig.source.choices(RankingKind::InvestorNetBuy).investors, vec![RankingInvestor::Foreign, RankingInvestor::Institution, RankingInvestor::OtherCorporation]);
    assert!(!rig.source.choices(RankingKind::TradeVolume).sessions.contains(&TradingSession::PreMarket));
    assert!(rig.source.choices(RankingKind::TradeVolume).sessions.contains(&TradingSession::AfterHours));
    assert!(!rig.source.choices(RankingKind::CreditRatio).excludes_managed);

    let fake = support::ScriptedTransport::new();
    let auth = server::kiwoom::auth::KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
    let kiwoom = KiwoomRankings::new(server::kiwoom::rest::KiwoomRest::new(fake.transport(), auth, Clock::fake(friday_morning())));
    let all = kiwoom.choices(RankingKind::VolumeSurge);
    assert_eq!(all.baselines.len(), 4);
    assert_eq!(kiwoom.choices(RankingKind::MostViewed).spans.len(), 5);
}

fn every_ranking_with_each_choice() -> Vec<Ranking> {
    let mut all = Vec::new();
    for market in [RankingMarket::All, RankingMarket::Kospi] {
        for venue in [Venue::Combined, Venue::Krx, Venue::Nxt] {
            for exclude_managed in [false, true] {
                all.push(Ranking::TradeAmount { market, venue, excludes: KEEP_ALL, exclude_managed });
                all.push(Ranking::Turnover { market, venue, excludes: KEEP_ALL, exclude_managed });
                all.push(Ranking::CreditRatio { market, venue, excludes: KEEP_ALL, exclude_managed });
                all.push(Ranking::Expected { market, venue, sort: api::ExpectedSort::Losers, excludes: KEEP_ALL, exclude_managed });
                for session in [TradingSession::All, TradingSession::Regular, TradingSession::PreMarket, TradingSession::AfterHours] {
                    all.push(Ranking::TradeVolume { market, venue, session, excludes: KEEP_ALL, exclude_managed });
                }
                for baseline in [SurgeBaseline::PreviousDay, SurgeBaseline::Minutes1, SurgeBaseline::Minutes5, SurgeBaseline::Minutes10] {
                    for sort in [SurgeSort::SurgeVolume, SurgeSort::SurgeRate, SurgeSort::DropRate] {
                        all.push(Ranking::VolumeSurge { market, venue, baseline, sort, excludes: KEEP_ALL, exclude_managed });
                    }
                }
                for min_trade_amount in [MinTradeAmount::Any, MinTradeAmount::AtLeast100Million, MinTradeAmount::AtLeast10Billion] {
                    all.push(Ranking::Gainers { market, venue, include_limit: true, min_trade_amount, excludes: KEEP_ALL, exclude_managed });
                    all.push(Ranking::Losers { market, venue, include_limit: false, min_trade_amount, excludes: KEEP_ALL, exclude_managed });
                }
                all.push(Ranking::BidAskBalance { market: api::Market::Kospi, venue, sort: api::BalanceSort::NetSellRemaining, excludes: KEEP_ALL, exclude_managed });
                all.push(Ranking::ForeignStreak { market, venue, direction: NetDirection::NetSell, excludes: KEEP_ALL });
                all.push(Ranking::Program { market: api::Market::Kosdaq, venue, direction: NetDirection::NetSell, excludes: KEEP_ALL });
            }
        }
        for investor in [
            RankingInvestor::Foreign,
            RankingInvestor::ForeignFirm,
            RankingInvestor::FinancialInvestment,
            RankingInvestor::InvestmentTrust,
            RankingInvestor::OtherFinancial,
            RankingInvestor::Bank,
            RankingInvestor::Insurance,
            RankingInvestor::PensionFund,
            RankingInvestor::State,
            RankingInvestor::OtherCorporation,
            RankingInvestor::Institution,
        ] {
            for unit in [TradeUnit::Amount, TradeUnit::Quantity] {
                all.push(Ranking::InvestorNetBuy { market, investor, direction: NetDirection::NetSell, unit, excludes: KEEP_ALL });
            }
        }
    }
    for span in [ViewSpan::Seconds30, ViewSpan::Minute1, ViewSpan::Minutes10, ViewSpan::Hour1, ViewSpan::Today] {
        all.push(most_viewed(span));
    }
    all
}

#[tokio::test(start_paused = true)]
async fn what_the_boundary_says_it_takes_is_exactly_what_the_request_builder_sends() {
    let rig = rig(|_| ok(r#"{"rt_cd":"0","msg_cd":"MCA00000","msg1":"ok","output":[],"output1":[],"output2":[]}"#));
    let mut taken = 0;
    for ranking in every_ranking_with_each_choice() {
        let before = rig.transport.total();
        let result = rows(&rig.source, ranking).await;
        match rig.source.check(&ranking) {
            Ok(()) => {
                assert!(result.is_ok(), "{ranking:?}: {result:?}");
                assert_eq!(rig.transport.total(), before + 1, "{ranking:?}");
                taken += 1;
            }
            Err(unsupported) => {
                assert!(matches!(&result, Err(RankingError::Unsupported(got)) if *got == unsupported), "{ranking:?}: {result:?}");
                assert_eq!(rig.transport.total(), before, "받지 않는 요청은 보내지 않는다: {ranking:?}");
            }
        }
    }
    assert!(taken > 100, "{taken}");
}

#[tokio::test(start_paused = true)]
async fn a_page_whose_rows_are_all_unreadable_is_a_protocol_failure_and_some_unreadable_rows_are_skipped() {
    let rig = rig(|sent| {
        if sent.get("FID_BLNG_CLS_CODE") == "3" {
            ok(fixture("unreadable.json"))
        } else {
            ok(fixture("volume_rank.json").replacen(r#""mksc_shrn_iscd":"000660""#, r#""mksc_shrn_iscd":"???""#, 1))
        }
    });
    let all_bad = rows(&rig.source, trade_amount(RankingMarket::All, Venue::Combined)).await;
    assert!(matches!(&all_bad, Err(RankingError::Source(server::market_source::SourceError::Failed(failure))) if failure.reason == api::ApiErrorReason::Protocol), "{all_bad:?}");
    let some_bad = rows(&rig.source, Ranking::Turnover { market: RankingMarket::All, venue: Venue::Combined, excludes: KEEP_ALL, exclude_managed: false }).await.unwrap();
    assert_eq!(some_bad.iter().map(|row| row.code.as_str()).collect::<Vec<_>>(), ["005930", "086520"]);
}

#[tokio::test(start_paused = true)]
async fn requests_that_differ_only_in_what_they_hide_share_a_cache_key_and_the_sources_do_not() {
    let rig = rig(|_| ok("{}"));
    let shown = trade_amount(RankingMarket::All, Venue::Combined);
    let hidden = Ranking::TradeAmount { market: RankingMarket::All, venue: Venue::Combined, excludes: Excludes { etf_etn: true, preferred: true }, exclude_managed: false };
    let managed = Ranking::TradeAmount { market: RankingMarket::All, venue: Venue::Combined, excludes: KEEP_ALL, exclude_managed: true };
    assert_eq!(rig.source.query_key(&shown), rig.source.query_key(&hidden));
    assert_ne!(rig.source.query_key(&shown), rig.source.query_key(&managed));
    let fake = support::ScriptedTransport::new();
    let auth = server::kiwoom::auth::KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
    let kiwoom = KiwoomRankings::new(server::kiwoom::rest::KiwoomRest::new(fake.transport(), auth, Clock::fake(friday_morning())));
    assert_ne!(rig.source.query_key(&shown), kiwoom.query_key(&shown));
}

#[test]
fn a_refused_request_closes_as_the_unsupported_by_source_reason() {
    let failure = Unsupported::Choice(RankingKind::InvestorNetBuy, "투자자 구분").into_failure();
    assert_eq!((failure.code, failure.reason), (api::ApiErrorCode::BadRequest, api::ApiErrorReason::UnsupportedBySource));
    assert!(failure.message.contains("투자자별 순매수 순위") && failure.message.contains("투자자 구분"), "{}", failure.message);
    assert!(Unsupported::Kind(RankingKind::Program).into_failure().message.contains("프로그램 순매수 순위"));
}

#[tokio::test(start_paused = true)]
async fn expected_executions_and_after_hours_volume_refuse_the_managed_filter_they_cannot_send() {
    let rig = rig(|_| ok("{}"));
    let expected = Ranking::Expected { market: RankingMarket::All, venue: Venue::Krx, sort: api::ExpectedSort::Gainers, excludes: KEEP_ALL, exclude_managed: true };
    assert!(!rig.source.choices(RankingKind::Expected).excludes_managed);
    assert_unsupported(rows(&rig.source, expected).await, RankingKind::Expected, Some("관리종목 제외"));
    let after_hours = Ranking::TradeVolume { market: RankingMarket::All, venue: Venue::Krx, session: TradingSession::AfterHours, excludes: KEEP_ALL, exclude_managed: true };
    assert_unsupported(rows(&rig.source, after_hours).await, RankingKind::TradeVolume, Some("관리종목 제외"));
    let regular = Ranking::TradeVolume { market: RankingMarket::All, venue: Venue::Krx, session: TradingSession::Regular, excludes: KEEP_ALL, exclude_managed: true };
    assert!(rig.source.check(&regular).is_ok(), "정규장 거래량은 관리종목 제외를 보낸다");
    assert_eq!(rig.transport.total(), 0);
}

#[tokio::test(start_paused = true)]
async fn a_page_of_only_limit_rows_is_an_empty_page_when_limit_rows_are_left_out() {
    let only_limit = r#"{"rt_cd":"0","msg_cd":"MCA00000","msg1":"ok","output":[{"stck_shrn_iscd":"086520","hts_kor_isnm":"에코프로","stck_prpr":"130000","prdy_vrss":"30000","prdy_vrss_sign":"1","prdy_ctrt":"30.00","acml_vol":"1200000"}]}"#;
    let rig = rig(move |_| ok(only_limit));
    assert!(rows(&rig.source, gainers(false, MinTradeAmount::Any)).await.unwrap().is_empty());
    assert_eq!(rows(&rig.source, gainers(true, MinTradeAmount::Any)).await.unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_null_column_or_a_non_object_row_costs_only_that_row() {
    let body = fixture("volume_rank.json").replacen(r#""prdy_vol":"12000000""#, r#""prdy_vol":null"#, 1).replacen(r#""stck_prpr":"201000""#, r#""stck_prpr":null"#, 1).replacen(r#"{"hts_kor_isnm":"에코프로""#, r#"7,{"hts_kor_isnm":"에코프로""#, 1);
    let rig = rig(move |_| ok(body.clone()));
    let amount = rows(&rig.source, trade_amount(RankingMarket::All, Venue::Combined)).await.unwrap();
    assert_eq!(amount.iter().map(|row| row.code.as_str()).collect::<Vec<_>>(), ["005930", "086520"], "가격이 null인 행과 객체가 아닌 행만 빠진다");
    let volume = rows(&rig.source, Ranking::TradeVolume { market: RankingMarket::All, venue: Venue::Combined, session: TradingSession::All, excludes: KEEP_ALL, exclude_managed: false }).await.unwrap();
    assert!(matches!(volume[0].figures, RankingFigures::TradeVolume { previous_day_volume_rate: None, .. }), "null인 칸은 비운다");
}

#[tokio::test(start_paused = true)]
async fn a_mover_row_without_a_readable_change_sign_is_dropped_not_read_as_rising() {
    let body = r#"{"rt_cd":"0","msg_cd":"MCA00000","msg1":"ok","output":[{"stck_shrn_iscd":"086520","hts_kor_isnm":"에코프로","stck_prpr":"70000","prdy_vrss":"30000","prdy_vrss_sign":null,"prdy_ctrt":"-30.00","acml_vol":"1200000"},{"stck_shrn_iscd":"247540","hts_kor_isnm":"에코프로비엠","stck_prpr":"230000","prdy_vrss":"20000","prdy_vrss_sign":"5","prdy_ctrt":"-8.00","acml_vol":"800000"}]}"#;
    let rig = rig(move |_| ok(body));
    let losers = |include_limit| Ranking::Losers { market: RankingMarket::All, venue: Venue::Krx, include_limit, min_trade_amount: MinTradeAmount::Any, excludes: KEEP_ALL, exclude_managed: false };
    for include_limit in [false, true] {
        let found = rows(&rig.source, losers(include_limit)).await.unwrap();
        assert_eq!(found.iter().map(|row| row.code.as_str()).collect::<Vec<_>>(), ["247540"], "include_limit={include_limit}");
        assert_eq!(found[0].figures, RankingFigures::Movers { price_change: api::Won(-20_000), volume: api::Shares(800_000) });
    }
}
