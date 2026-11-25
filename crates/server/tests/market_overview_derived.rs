mod support;

use std::collections::HashMap;
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, KstTime, Ohlcv, Price, StockCode, Symbol, SymbolInfo, SymbolKind, TimeOfDay, Volume};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::api::{ExcludeKind, Market};
use server::app::{ApplicationInputs, application};
use server::clock::Clock;
use server::config::Secret;
use server::db::AppDb;
use server::http::{AppState, router};
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomStream;
use server::kiwoom::wire::{MillionWon, ScreenerListing};
use server::market_overview::derived::{DerivedInputs, StockCatalog, TodayOverlay, attribution_of, derive_market_snapshot, histogram_of, ma_thrust_of, venue_share_of};
use server::market_overview::{MarketOverviewPhase, MarketOverviewScope};
use server::screener::store::{DayBar, ListedMeta, Store, Write};
use server::shared_data::{Broker, DataKind, Header, IndexRow, Loaded, SnapshotBody, SnapshotRow, SourceKey, write_snapshot};
use server::symbols::{Directory, SymbolDirectory};
use support::ScriptedTransport;
use tower::ServiceExt;

const AS_OF: i64 = 1_794_186_000;

fn day(y: i32, m: u8, d: u8) -> KstDate {
    KstDate::new(y, m, d).unwrap()
}

fn at(d: KstDate, h: u32, m: u32, s: u32) -> KstTime {
    KstTime::from_kst_civil(d, TimeOfDay::hms(h, m, s).unwrap())
}

fn row(code: &str, day_str: &str, current_won: u64, base_won: u64, traded_million_won: u64) -> SnapshotRow {
    SnapshotRow {
        code: code.to_owned(),
        day: day_str.to_owned(),
        current_won,
        base_won,
        open_won: base_won,
        high_won: current_won.max(base_won),
        low_won: current_won.min(base_won),
        volume: 10_000,
        traded_million_won,
        traded_at: Some(AS_OF),
    }
}

fn write_board(dir: &Path, kind: DataKind, obs_day: KstDate, as_of: i64, stocks: Vec<SnapshotRow>, indices: Vec<IndexRow>) {
    let requested = stocks.len() as u32;
    let header = Header::new(kind, obs_day, as_of, as_of, vec![SourceKey { key_name: "rest-01".into(), broker: Broker::Kiwoom }]);
    write_snapshot(dir, header, SnapshotBody { closing: false, requested, missing: 0, stocks, indices }).unwrap();
}

fn price_won(won: u64) -> Price {
    Price::from_centi(won * 100).unwrap()
}

fn trading_days_ending(last: KstDate, count: usize) -> Vec<KstDate> {
    let mut days = Vec::with_capacity(count);
    let mut cursor = last;
    while days.len() < count {
        if !matches!(cursor.weekday(), domain::Weekday::Sat | domain::Weekday::Sun) {
            days.push(cursor);
        }
        cursor = KstDate::from_days_since_epoch(cursor.days_since_epoch() - 1);
    }
    days.reverse();
    days
}

struct Harness {
    fake: ScriptedTransport,
    state: Arc<AppState>,
    app: Router,
    shared: PathBuf,
    store_path: PathBuf,
    _tmp: tempfile::TempDir,
}

impl Harness {
    async fn start(clock_at: KstTime, listed: Vec<ScreenerListing>, bars: Vec<Write>) -> Harness {
        let fake = ScriptedTransport::new();
        let clock = Clock::fake(clock_at);
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(fake.transport(), auth, clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        let symbol_infos: Vec<SymbolInfo> = listed
            .iter()
            .map(|item| SymbolInfo {
                symbol: Symbol::Stock(item.code),
                name: item.name.clone(),
                kind: if item.excludable_as.contains(&ExcludeKind::Etf) {
                    SymbolKind::Etf
                } else if item.excludable_as.contains(&ExcludeKind::Etn) {
                    SymbolKind::Etn
                } else {
                    SymbolKind::Common
                },
                market: match item.market {
                    Market::Kospi => domain::Market::Kospi,
                    Market::Kosdaq => domain::Market::Kosdaq,
                },
                nxt_enabled: true,
            })
            .collect();
        symbols.replace(Directory::build(symbol_infos).with_screener_listing(listed.clone()));
        let tmp = tempfile::tempdir().unwrap();
        let db = AppDb::open(&tmp.path().join("db.sqlite")).await.unwrap();
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store_path = tmp.path().join("screener.duckdb");
        let store = Store::open(&store_path).unwrap();
        if !listed.is_empty() {
            store.replace_listing(&listed).unwrap();
        }
        if !bars.is_empty() {
            store.write(&bars).unwrap();
        }
        let state = application(ApplicationInputs {
            rest: rest.clone(),
            clock: clock.clone(),
            symbols,
            db,
            screener_store: store,
            stream: (stream, events),
            static_dir: tmp.path().to_owned(),
            screener_update_on_connect: false,
        });
        rest.set_access(Access::Open);
        let shared = tmp.path().join("shared");
        state.shared_data.enable(shared.clone());
        let app = router(state.clone());
        Harness { fake, state, app, shared, store_path, _tmp: tmp }
    }

    async fn poll(&self) {
        self.state.shared_data.poll_once(&self.shared).await;
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let response = self.app.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status().as_u16();
        let body = serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
        (status, body)
    }

    fn broker_calls(&self) -> usize {
        self.fake.calls().len()
    }
}

fn listing(code: &str, name: &str, market: Market, shares: u64, excludable_as: Vec<ExcludeKind>) -> ScreenerListing {
    ScreenerListing {
        code: StockCode::parse(code).unwrap(),
        name: name.to_owned(),
        listed_on: Some(day(2020, 1, 2)),
        excludable_as,
        market,
        listed_shares: NonZeroU64::new(shares),
    }
}

fn bar_series(code: &str, days: &[KstDate], closes_won: &[u64]) -> Write {
    let bars = days
        .iter()
        .zip(closes_won)
        .map(|(&bar_day, &won)| {
            let price = price_won(won);
            DayBar { day: bar_day, ohlcv: Ohlcv::try_new(price, price, price, price, Volume(1_000)).unwrap(), traded: MillionWon(10) }
        })
        .collect();
    Write::Replace { code: StockCode::parse(code).unwrap(), bars }
}

#[test]
fn histogram_places_every_boundary_into_nine_buckets_and_skips_zero_base() {
    let rows = [
        row("000001", "20261109", 8_900, 10_000, 10),
        row("000002", "20261109", 9_000, 10_000, 10),
        row("000003", "20261109", 9_400, 10_000, 10),
        row("000004", "20261109", 9_700, 10_000, 10),
        row("000005", "20261109", 9_900, 10_000, 10),
        row("000006", "20261109", 10_000, 10_000, 10),
        row("000007", "20261109", 10_100, 10_000, 10),
        row("000008", "20261109", 10_300, 10_000, 10),
        row("000009", "20261109", 10_700, 10_000, 10),
        row("000010", "20261109", 11_000, 10_000, 10),
        row("000011", "20261109", 5_000, 0, 10),
    ];
    let refs: Vec<&SnapshotRow> = rows.iter().collect();
    let buckets = histogram_of(&refs);
    assert_eq!(buckets.len(), 9);
    let counts: Vec<u32> = buckets.iter().map(|b| b.count).collect();
    assert_eq!(counts, [2, 1, 1, 1, 1, 1, 1, 1, 1]);
    let total_share: f64 = buckets.iter().map(|b| b.share_pct).sum();
    assert!((total_share - 100.0).abs() < 1e-9);
    assert_eq!(buckets[0].label, "≤-10%");
    assert_eq!(buckets[4].label, "-0.5~+0.5%");
    assert_eq!(buckets[8].label, "≥+10%");
}

#[test]
fn venue_share_computes_exact_eok_and_ratios() {
    let krx = [row("005930", "20261109", 50_000, 50_000, 7_500), row("000660", "20261109", 100_000, 100_000, 2_500)];
    let nxt = [row("005930", "20261109", 50_000, 50_000, 2_500)];
    let krx_refs: Vec<&SnapshotRow> = krx.iter().collect();
    let nxt_refs: Vec<&SnapshotRow> = nxt.iter().collect();
    let share = venue_share_of(&krx_refs, &nxt_refs);
    assert!((share.krx_trade_value_eok - 100.0).abs() < 1e-9);
    assert!((share.nxt_trade_value_eok - 25.0).abs() < 1e-9);
    assert!((share.krx_ratio_pct - 80.0).abs() < 1e-9);
    assert!((share.nxt_ratio_pct - 20.0).abs() < 1e-9);
}

#[test]
fn attribution_matches_hand_calculated_points_and_top_two_concentration() {
    let rows = [
        row("005930", "20261109", 110, 100, 100),
        row("000660", "20261109", 105, 100, 100),
        row("035420", "20261109", 95, 100, 100),
    ];
    let refs: Vec<&SnapshotRow> = rows.iter().collect();
    let mut shares = HashMap::new();
    shares.insert(StockCode::parse("005930").unwrap(), 1_000_000);
    shares.insert(StockCode::parse("000660").unwrap(), 1_000_000);
    shares.insert(StockCode::parse("035420").unwrap(), 1_000_000);
    let mut names = HashMap::new();
    names.insert(StockCode::parse("005930").unwrap(), "삼성전자".to_owned());
    names.insert(StockCode::parse("000660").unwrap(), "SK하이닉스".to_owned());
    names.insert(StockCode::parse("035420").unwrap(), "NAVER".to_owned());
    let index_base = 3_000.0;
    let index_level = 3_100.0;
    let index_change_rate = (index_level - index_base) / index_base * 100.0;
    let attr = attribution_of(Market::Kospi, index_level, index_change_rate, &refs, &shares, &names).unwrap();
    assert_eq!(attr.market, Market::Kospi);
    assert!((attr.index_change_points - 100.0).abs() < 1e-9);
    assert_eq!(attr.top_positive.len(), 2);
    assert_eq!(attr.top_negative.len(), 1);
    assert_eq!(attr.top_positive[0].code.0, "005930");
    assert!((attr.top_positive[0].points - 100.0).abs() < 1e-9);
    assert!((attr.top_positive[0].cap_delta_eok - 0.1).abs() < 1e-9);
    assert_eq!(attr.top_positive[1].code.0, "000660");
    assert!((attr.top_positive[1].points - 50.0).abs() < 1e-9);
    assert_eq!(attr.top_negative[0].code.0, "035420");
    assert!((attr.top_negative[0].points + 50.0).abs() < 1e-9);
    let sum_points: f64 = attr.top_positive.iter().chain(&attr.top_negative).map(|r| r.points).sum();
    assert!((sum_points - attr.index_change_points).abs() < 1e-9);
    assert!((attr.top_two_concentration_pct - 75.0).abs() < 1e-9);
}

#[test]
fn ma_thrust_computes_exact_percentages_and_history_with_today_append() {
    let last_bar_day = day(2026, 11, 6);
    let today_day = day(2026, 11, 9);
    let days = trading_days_ending(last_bar_day, 20);
    let c1 = StockCode::parse("005930").unwrap();
    let c2 = StockCode::parse("000660").unwrap();
    let mut closes = HashMap::new();
    let mut s1 = vec![price_won(100); 220];
    s1[0] = price_won(110);
    let mut s2 = vec![price_won(100); 220];
    s2[0] = price_won(90);
    closes.insert(c1, s1);
    closes.insert(c2, s2);
    let mut today_prices = HashMap::new();
    today_prices.insert(c1, price_won(120));
    today_prices.insert(c2, price_won(120));
    let thrust = ma_thrust_of(&closes, &today_prices, Some(last_bar_day), &days, TodayOverlay::Append(today_day)).unwrap();
    assert_eq!(thrust.total_stocks, 2);
    assert_eq!(thrust.as_of.map(|d| d.0), Some(today_day));
    assert!((thrust.above_5_pct - 100.0).abs() < 1e-9);
    assert!((thrust.above_20_pct - 100.0).abs() < 1e-9);
    assert!((thrust.above_60_pct - 100.0).abs() < 1e-9);
    assert!((thrust.above_200_pct - 100.0).abs() < 1e-9);
    assert_eq!(thrust.history_20d.len(), 20);
    assert_eq!(thrust.history_20d.last().unwrap().date.0, today_day);
    assert!((thrust.history_20d.last().unwrap().above_20_pct - 100.0).abs() < 1e-9);
    assert_eq!(thrust.history_20d[18].date.0, last_bar_day);
    assert!((thrust.history_20d[18].above_20_pct - 50.0).abs() < 1e-9);
}

#[tokio::test]
async fn derived_endpoint_serves_all_four_parts_scopes_properly_and_makes_zero_broker_calls() {
    let bar_last = day(2026, 11, 6);
    let today = day(2026, 11, 9);
    let days = trading_days_ending(bar_last, 220);
    let listed = vec![
        listing("005930", "삼성전자", Market::Kospi, 2_000_000, vec![]),
        listing("000660", "SK하이닉스", Market::Kospi, 1_000_000, vec![]),
        listing("069500", "KODEX 200", Market::Kospi, 500_000, vec![ExcludeKind::Etf]),
        listing("247540", "에코프로비엠", Market::Kosdaq, 1_000_000, vec![]),
    ];
    let flat_100 = vec![100u64; 220];
    let mut rising_100 = vec![100u64; 220];
    *rising_100.last_mut().unwrap() = 110;
    let mut falling_100 = vec![100u64; 220];
    *falling_100.last_mut().unwrap() = 90;
    let bars = vec![
        bar_series("005930", &days, &rising_100),
        bar_series("000660", &days, &falling_100),
        bar_series("069500", &days, &rising_100),
        bar_series("247540", &days, &flat_100),
    ];
    let h = Harness::start(at(today, 10, 0, 0), listed, bars).await;
    let indices = vec![
        IndexRow { code: "001".into(), name: "코스피".into(), level: 2_600.0, change_rate: 4.0, trade_million_won: 0 },
        IndexRow { code: "101".into(), name: "코스닥".into(), level: 840.0, change_rate: 5.0, trade_million_won: 0 },
    ];
    write_board(
        &h.shared,
        DataKind::SnapshotCombined,
        today,
        AS_OF,
        vec![
            row("005930", "20261109", 110, 100, 6_000),
            row("000660", "20261109", 95, 100, 4_000),
            row("069500", "20261109", 120, 100, 2_000),
            row("247540", "20261109", 105, 100, 3_000),
        ],
        indices,
    );
    write_board(
        &h.shared,
        DataKind::SnapshotKrx,
        today,
        AS_OF,
        vec![
            row("005930", "20261109", 110, 100, 5_000),
            row("000660", "20261109", 95, 100, 3_000),
            row("247540", "20261109", 105, 100, 2_000),
        ],
        vec![],
    );
    write_board(
        &h.shared,
        DataKind::SnapshotNxt,
        today,
        AS_OF,
        vec![
            row("005930", "20261109", 110, 100, 1_500),
            row("247540", "20261109", 105, 100, 500),
        ],
        vec![],
    );
    h.poll().await;

    let (status, all) = h.get("/api/market-overview/derived").await;
    assert_eq!(status, 200, "{all}");
    assert_eq!(all["scope"], "all");
    assert_eq!(all["phase"], "regular");
    assert_eq!(all["receivedAt"], AS_OF);
    let hist_all: u64 = all["histogram"]["value"].as_array().unwrap().iter().map(|b| b["count"].as_u64().unwrap()).sum();
    assert_eq!(hist_all, 3, "ETF 069500 is excluded from breadth histogram: {all}");
    assert_eq!(all["venueShare"]["status"], "ok");
    assert!((all["venueShare"]["value"]["krxTradeValueEok"].as_f64().unwrap() - 100.0).abs() < 1e-9);
    assert!((all["venueShare"]["value"]["nxtTradeValueEok"].as_f64().unwrap() - 20.0).abs() < 1e-9);
    let krx_pct = all["venueShare"]["value"]["krxRatioPct"].as_f64().unwrap();
    let nxt_pct = all["venueShare"]["value"]["nxtRatioPct"].as_f64().unwrap();
    assert!((krx_pct + nxt_pct - 100.0).abs() < 1e-9);
    assert_eq!(all["attribution"]["status"], "ok");
    assert_eq!(all["attribution"]["value"]["market"], "kospi");
    assert_eq!(all["attribution"]["value"]["topPositive"][0]["code"], "005930");
    assert_eq!(all["attribution"]["value"]["topNegative"][0]["code"], "000660");
    assert_eq!(all["maThrust"]["status"], "ok");
    assert_eq!(all["maThrust"]["value"]["totalStocks"], 3);
    assert_eq!(all["maThrust"]["value"]["asOf"], "2026-11-09");
    assert_eq!(all["maThrust"]["value"]["history20d"].as_array().unwrap().len(), 20);
    assert!((all["maThrust"]["value"]["above20Pct"].as_f64().unwrap() - 200.0 / 3.0).abs() < 1e-6);

    let (status, kospi) = h.get("/api/market-overview/derived?scope=kospi").await;
    assert_eq!(status, 200, "{kospi}");
    assert_eq!(kospi["scope"], "kospi");
    let hist_kospi: u64 = kospi["histogram"]["value"].as_array().unwrap().iter().map(|b| b["count"].as_u64().unwrap()).sum();
    assert_eq!(hist_kospi, 2);
    assert_eq!(kospi["maThrust"]["value"]["totalStocks"], 2);
    assert!((kospi["maThrust"]["value"]["above20Pct"].as_f64().unwrap() - 50.0).abs() < 1e-9);
    assert!((kospi["venueShare"]["value"]["krxTradeValueEok"].as_f64().unwrap() - 80.0).abs() < 1e-9);
    assert!((kospi["venueShare"]["value"]["nxtTradeValueEok"].as_f64().unwrap() - 15.0).abs() < 1e-9);

    let (status, kosdaq) = h.get("/api/market-overview/derived?scope=kosdaq").await;
    assert_eq!(status, 200, "{kosdaq}");
    assert_eq!(kosdaq["scope"], "kosdaq");
    let hist_kosdaq: u64 = kosdaq["histogram"]["value"].as_array().unwrap().iter().map(|b| b["count"].as_u64().unwrap()).sum();
    assert_eq!(hist_kosdaq, 1);
    assert_eq!(kosdaq["attribution"]["value"]["market"], "kosdaq");
    assert_eq!(kosdaq["attribution"]["value"]["topPositive"][0]["code"], "247540");
    assert_eq!(kosdaq["maThrust"]["value"]["totalStocks"], 1);
    assert!((kosdaq["maThrust"]["value"]["above20Pct"].as_f64().unwrap() - 100.0).abs() < 1e-9);
    assert!((kosdaq["venueShare"]["value"]["krxTradeValueEok"].as_f64().unwrap() - 20.0).abs() < 1e-9);
    assert!((kosdaq["venueShare"]["value"]["nxtTradeValueEok"].as_f64().unwrap() - 5.0).abs() < 1e-9);

    let (bad_status, bad_body) = h.get("/api/market-overview/derived?scope=unknown").await;
    assert_eq!((bad_status, bad_body["error"]["code"].as_str()), (400, Some("bad_request")));
    assert_eq!(h.broker_calls(), 0);
    let _ = &h.store_path;
}

#[tokio::test]
async fn missing_nxt_snapshot_and_empty_bar_store_degrade_per_part_without_broker_calls() {
    let today = day(2026, 11, 9);
    let listed = vec![listing("005930", "삼성전자", Market::Kospi, 1_000_000, vec![])];
    let h = Harness::start(at(today, 10, 0, 0), listed, vec![]).await;
    write_board(
        &h.shared,
        DataKind::SnapshotCombined,
        today,
        AS_OF,
        vec![row("005930", "20261109", 105, 100, 1_000)],
        vec![IndexRow { code: "001".into(), name: "코스피".into(), level: 2_600.0, change_rate: 1.0, trade_million_won: 0 }],
    );
    write_board(
        &h.shared,
        DataKind::SnapshotKrx,
        today,
        AS_OF,
        vec![row("005930", "20261109", 105, 100, 1_000)],
        vec![],
    );
    h.poll().await;

    let (status, body) = h.get("/api/market-overview/derived?scope=all").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["histogram"]["status"], "ok");
    assert_eq!(body["attribution"]["status"], "ok");
    assert_eq!(body["venueShare"]["status"], "failed");
    assert_eq!(body["venueShare"]["error"]["code"], "not_prepared");
    assert_eq!(body["maThrust"]["status"], "failed");
    assert_eq!(body["maThrust"]["error"]["code"], "not_prepared");
    assert_eq!(h.broker_calls(), 0);
}

#[tokio::test]
async fn empty_shared_boards_fail_all_parts_cleanly_with_null_received_at() {
    let today = day(2026, 11, 9);
    let h = Harness::start(at(today, 10, 0, 0), vec![], vec![]).await;
    let (status, body) = h.get("/api/market-overview/derived?scope=all").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["receivedAt"], json!(null));
    assert_eq!(body["histogram"]["status"], "failed");
    assert_eq!(body["venueShare"]["status"], "failed");
    assert_eq!(body["attribution"]["status"], "failed");
    assert_eq!(body["maThrust"]["status"], "failed");
    assert_eq!(h.broker_calls(), 0);
}

struct SyntheticFixture {
    combined: Loaded<SnapshotBody>,
    krx: Loaded<SnapshotBody>,
    nxt: Loaded<SnapshotBody>,
    catalog: StockCatalog,
    closes: HashMap<StockCode, Vec<Price>>,
    last_day: KstDate,
    trading_days: Vec<KstDate>,
}

fn synthetic_2600_fixture() -> SyntheticFixture {
    let last_day = day(2026, 11, 6);
    let today = day(2026, 11, 9);
    let trading_days = trading_days_ending(last_day, 20);
    let mut listed = Vec::with_capacity(2_600);
    let mut combined_rows = Vec::with_capacity(2_600);
    let mut krx_rows = Vec::with_capacity(2_600);
    let mut nxt_rows = Vec::with_capacity(800);
    let mut closes = HashMap::with_capacity(2_600);
    for idx in 0..2_600u32 {
        let code_str = format!("{:06}", 100_000 + idx);
        let code = StockCode::parse(&code_str).unwrap();
        let market = if idx < 900 { Market::Kospi } else { Market::Kosdaq };
        listed.push(ListedMeta {
            code,
            name: format!("종목{idx:04}"),
            market,
            listed_shares: NonZeroU64::new(10_000_000 + u64::from(idx) * 1_000),
            is_etf_etn: false,
        });
        let base = 10_000 + u64::from(idx % 500) * 100;
        let delta_pct = (idx as i64 % 25) - 12;
        let current = ((base as i64 * (100 + delta_pct)) / 100).max(100) as u64;
        combined_rows.push(row(&code_str, "20261109", current, base, 500 + u64::from(idx)));
        krx_rows.push(row(&code_str, "20261109", current, base, 400 + u64::from(idx)));
        if idx < 800 {
            nxt_rows.push(row(&code_str, "20261109", current, base, 100 + u64::from(idx)));
        }
        let series: Vec<Price> = (0..220u64).map(|offset| price_won(base + ((offset + u64::from(idx)) % 15) * 10)).collect();
        closes.insert(code, series);
    }
    let catalog = StockCatalog::from_listed(&listed);
    let indices = vec![
        IndexRow { code: "001".into(), name: "코스피".into(), level: 2_650.0, change_rate: 1.2, trade_million_won: 0 },
        IndexRow { code: "101".into(), name: "코스닥".into(), level: 850.0, change_rate: 0.8, trade_million_won: 0 },
    ];
    let make_loaded = |kind: DataKind, stocks: Vec<SnapshotRow>, idxs: Vec<IndexRow>| Loaded {
        header: Header::new(kind, today, AS_OF, AS_OF, vec![SourceKey { key_name: "rest-01".into(), broker: Broker::Kiwoom }]),
        body: SnapshotBody { closing: false, requested: stocks.len() as u32, missing: 0, stocks, indices: idxs },
    };
    SyntheticFixture {
        combined: make_loaded(DataKind::SnapshotCombined, combined_rows, indices),
        krx: make_loaded(DataKind::SnapshotKrx, krx_rows, vec![]),
        nxt: make_loaded(DataKind::SnapshotNxt, nxt_rows, vec![]),
        catalog,
        closes,
        last_day,
        trading_days,
    }
}

#[test]
fn derive_market_snapshot_over_2600_stocks_is_correct_and_fast() {
    let f = synthetic_2600_fixture();
    let started = Instant::now();
    let card = derive_market_snapshot(&DerivedInputs {
        scope: MarketOverviewScope::All,
        phase: MarketOverviewPhase::Regular,
        combined: Some(&f.combined),
        krx: Some(&f.krx),
        nxt: Some(&f.nxt),
        overview_index: None,
        catalog: &f.catalog,
        closes: &f.closes,
        latest_day: Some(f.last_day),
        trading_days: &f.trading_days,
    });
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    match card.histogram {
        server::market_overview::MarketOverviewPart::Ok { value } => {
            let total: u32 = value.iter().map(|b| b.count).sum();
            assert_eq!(total, 2_600);
        }
        server::market_overview::MarketOverviewPart::Failed { error } => panic!("histogram failed: {error:?}"),
    }
    match card.ma_thrust {
        server::market_overview::MarketOverviewPart::Ok { value } => {
            assert_eq!(value.total_stocks, 2_600);
            assert_eq!(value.history_20d.len(), 20);
        }
        server::market_overview::MarketOverviewPart::Failed { error } => panic!("ma_thrust failed: {error:?}"),
    }
    assert!(elapsed_ms < 250.0, "2,600-stock debug derivation took {elapsed_ms:.2} ms");
}

#[test]
#[ignore]
fn perf_derive_market_snapshot_2600_stocks_p95_under_15ms() {
    let f = synthetic_2600_fixture();
    let iterations = 40;
    let mut samples_ms = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        let card = derive_market_snapshot(&DerivedInputs {
            scope: MarketOverviewScope::All,
            phase: MarketOverviewPhase::Regular,
            combined: Some(&f.combined),
            krx: Some(&f.krx),
            nxt: Some(&f.nxt),
            overview_index: None,
            catalog: &f.catalog,
            closes: &f.closes,
            latest_day: Some(f.last_day),
            trading_days: &f.trading_days,
        });
        std::hint::black_box(card);
        samples_ms.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    samples_ms.sort_by(f64::total_cmp);
    let p50 = samples_ms[iterations / 2];
    let p95 = samples_ms[(iterations * 95) / 100];
    let max = *samples_ms.last().unwrap();
    println!("derive_market_snapshot(2600 stocks): p50={p50:.3}ms p95={p95:.3}ms max={max:.3}ms");
    assert!(p95 <= 15.0, "p95 {p95:.3}ms exceeded 15ms budget");
}
