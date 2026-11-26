use crate::support;

use std::collections::{BTreeMap, HashMap};
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, KstTime, Ohlcv, Price, StockCode, Symbol, SymbolInfo, SymbolKind, TimeOfDay, Volume};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::api::{
    BalanceSort, ExcludeKind, Excludes, Market, NetDirection, Percent, Ranking, RankingFigures, RankingInvestor, RankingMarket, Shares, SymbolCode,
    TradeUnit, Venue, Won,
};
use server::app::{ApplicationInputs, application};
use server::clock::Clock;
use server::config::Secret;
use server::financials::model::{Collection, Company, Security};
use server::financials::store::{SecurityDisclosures, Store as FinancialStore};
use server::http::{AppState, router};
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomStream;
use server::kiwoom::wire::{MillionWon, ScreenerListing};
use server::kiwoom_themes::{StoredCatalog, StoredTheme};
use server::market_overview::disclosures::{build_disclosure_radar, classify_report};
use server::market_overview::pro::{ProInputs, derive_pro_card};
use server::market_overview::rrg::{classify_quadrant, rrg_trajectory_of};
use server::market_overview::session_dna::{active_window_at, build_session_dna};
use server::market_overview::{
    MarketOverviewContext, MarketOverviewDisclosureCategory, MarketOverviewPart, MarketOverviewPhase, MarketOverviewRrgQuadrant, MarketOverviewScope,
    MarketOverviewSector, MarketOverviewSectorsCard, MarketOverviewSessionWindowId, Sample, SampleValue,
};
use server::market_overview::derived::StockCatalog;
use server::market_source::rankings::condition_key;
use server::screener::store::{DayBar, ListedMeta, Write};
use server::shared_data::{
    Broker, CardValue, ConditionEntry, ConditionState, DataKind, Header, IndexRow, Loaded, MadeCard, OverviewBody, RankingsPartBody, ReceivedRanking,
    SAMPLES_FOLDER, SharedRankingRow, SnapshotBody, SnapshotRow, SourceKey, ThemeEntry, ThemesBody, part_path, write_snapshot, write_snapshot_at,
};
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

fn snap_row(code: &str, day_str: &str, current_won: u64, base_won: u64, traded_million_won: u64) -> SnapshotRow {
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

fn write_snap(dir: &Path, kind: DataKind, obs_day: KstDate, as_of: i64, stocks: Vec<SnapshotRow>, indices: Vec<IndexRow>) {
    let requested = stocks.len() as u32;
    let header = Header::new(kind, obs_day, as_of, as_of, vec![SourceKey { key_name: "rest-01".into(), broker: Broker::Kiwoom }]);
    write_snapshot(dir, header, SnapshotBody { closing: false, requested, missing: 0, stocks, indices }).unwrap();
}

fn write_themes(dir: &Path, obs_day: KstDate, as_of: i64, themes: Vec<ThemeEntry>) {
    let header = Header::new(DataKind::KiwoomThemes, obs_day, as_of, as_of, vec![SourceKey { key_name: "rest-01".into(), broker: Broker::Kiwoom }]);
    write_snapshot(dir, header, ThemesBody { themes }).unwrap();
}

fn write_overview_sectors(dir: &Path, obs_day: KstDate, as_of: i64, kospi: Vec<MarketOverviewSector>, kosdaq: Vec<MarketOverviewSector>) {
    let make_card = |market: Market, sectors: Vec<MarketOverviewSector>| MadeCard {
        market,
        key_name: "rest-01".into(),
        made_at: as_of,
        card: CardValue::Sectors {
            value: MarketOverviewSectorsCard {
                context: MarketOverviewContext {
                    market,
                    phase: MarketOverviewPhase::Regular,
                    received_at: Some(server::api::UnixSeconds(as_of)),
                    source: server::api::Broker::Kiwoom,
                },
                sectors: MarketOverviewPart::Ok { value: sectors },
                flows: MarketOverviewPart::Ok { value: vec![] },
            },
        },
    };
    let body = OverviewBody::from_cards([make_card(Market::Kospi, kospi), make_card(Market::Kosdaq, kosdaq)]);
    let header = Header::new(DataKind::MarketOverview, obs_day, as_of, as_of, vec![SourceKey { key_name: "rest-01".into(), broker: Broker::Kiwoom }]);
    write_snapshot(dir, header, body).unwrap();
}

fn write_samples_file(dir: &Path, obs_day: KstDate, samples: &[Sample]) {
    let folder = dir.join(SAMPLES_FOLDER);
    std::fs::create_dir_all(&folder).unwrap();
    let mut text = String::new();
    for sample in samples {
        text.push_str(&serde_json::to_string(sample).unwrap());
        text.push('\n');
    }
    std::fs::write(folder.join(format!("{}.jsonl", obs_day.yyyymmdd())), text).unwrap();
}

fn write_rankings_part(dir: &Path, obs_day: KstDate, as_of: i64, entries: Vec<ConditionEntry>) {
    let header = Header::new(DataKind::Rankings, obs_day, as_of, as_of, vec![SourceKey { key_name: "rest-01".into(), broker: Broker::Kiwoom }]);
    let path = part_path(dir, &obs_day.yyyymmdd(), "rest-01");
    write_snapshot_at(path, header, RankingsPartBody { period_secs: 10, pages: 1, conditions: entries }).unwrap();
}

fn ranking_entry(ranking: &Ranking, as_of: i64, rows: Vec<SharedRankingRow>) -> ConditionEntry {
    ConditionEntry {
        key: condition_key(ranking),
        state: ConditionState::Ready,
        last: Some(ReceivedRanking {
            rows,
            pages: 1,
            end: true,
            limited: false,
            received_at: as_of,
            broker: Broker::Kiwoom,
            page_rows: vec![],
        }),
    }
}

fn disclosure_map(report_nm: &str, rcept_no: &str, rcept_dt: &str, flr_nm: &str, rm: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("report_nm".into(), report_nm.into()),
        ("rcept_no".into(), rcept_no.into()),
        ("rcept_dt".into(), rcept_dt.into()),
        ("flr_nm".into(), flr_nm.into()),
        ("rm".into(), rm.into()),
    ])
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

struct Harness {
    fake: ScriptedTransport,
    state: Arc<AppState>,
    app: Router,
    shared: PathBuf,
    financial_db: PathBuf,
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
        let db = crate::support::template_db::open_app_db(&tmp.path().join("db.sqlite")).await;
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = crate::support::template_db::open_screener_store(&tmp.path().join("screener.duckdb"));
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
        let financial_db = tmp.path().join("financials.sqlite");
        let app = router(state.clone());
        Harness { fake, state, app, shared, financial_db, _tmp: tmp }
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

#[test]
fn rrg_trajectory_handles_all_four_quadrants_and_zero_std_dev_without_nan() {
    let dates = trading_days_ending(day(2026, 11, 9), 20);
    let bench = vec![100.0; 20];

    let flat = rrg_trajectory_of(&dates, &bench, &bench);
    assert_eq!(flat.len(), 5);
    for pt in &flat {
        assert!((pt.rs_ratio - 100.0).abs() < 1e-9);
        assert!((pt.rs_momentum - 100.0).abs() < 1e-9);
        assert!(pt.rs_ratio.is_finite() && pt.rs_momentum.is_finite());
    }

    let mut leading_idx = vec![100.0; 20];
    leading_idx[17] = 102.0;
    leading_idx[18] = 106.0;
    leading_idx[19] = 115.0;
    let leading = rrg_trajectory_of(&dates, &leading_idx, &bench);
    let last_l = leading.last().unwrap();
    assert_eq!(classify_quadrant(last_l.rs_ratio, last_l.rs_momentum), MarketOverviewRrgQuadrant::Leading);

    let mut weakening_idx = vec![100.0; 20];
    weakening_idx[14] = 110.0;
    weakening_idx[15] = 118.0;
    weakening_idx[16] = 122.0;
    weakening_idx[17] = 123.0;
    weakening_idx[18] = 121.0;
    weakening_idx[19] = 118.0;
    let weakening = rrg_trajectory_of(&dates, &weakening_idx, &bench);
    let last_w = weakening.last().unwrap();
    assert_eq!(classify_quadrant(last_w.rs_ratio, last_w.rs_momentum), MarketOverviewRrgQuadrant::Weakening);

    let mut lagging_idx = vec![100.0; 20];
    lagging_idx[17] = 98.0;
    lagging_idx[18] = 94.0;
    lagging_idx[19] = 85.0;
    let lagging = rrg_trajectory_of(&dates, &lagging_idx, &bench);
    let last_g = lagging.last().unwrap();
    assert_eq!(classify_quadrant(last_g.rs_ratio, last_g.rs_momentum), MarketOverviewRrgQuadrant::Lagging);

    let mut improving_idx = vec![100.0; 20];
    improving_idx[14] = 90.0;
    improving_idx[15] = 82.0;
    improving_idx[16] = 78.0;
    improving_idx[17] = 77.0;
    improving_idx[18] = 79.0;
    improving_idx[19] = 83.0;
    let improving = rrg_trajectory_of(&dates, &improving_idx, &bench);
    let last_i = improving.last().unwrap();
    assert_eq!(classify_quadrant(last_i.rs_ratio, last_i.rs_momentum), MarketOverviewRrgQuadrant::Improving);
}

#[test]
fn session_dna_windows_and_per_market_deltas_are_exact() {
    let today = day(2026, 11, 9);
    assert_eq!(active_window_at(at(today, 7, 59, 59)), None);
    assert_eq!(active_window_at(at(today, 8, 15, 0)), Some(MarketOverviewSessionWindowId::NxtPre));
    assert_eq!(active_window_at(at(today, 8, 55, 0)), None);
    assert_eq!(active_window_at(at(today, 9, 10, 0)), Some(MarketOverviewSessionWindowId::KrxOpen));
    assert_eq!(active_window_at(at(today, 11, 30, 0)), Some(MarketOverviewSessionWindowId::KrxMid));
    assert_eq!(active_window_at(at(today, 14, 45, 0)), Some(MarketOverviewSessionWindowId::KrxClose));
    assert_eq!(active_window_at(at(today, 16, 0, 0)), Some(MarketOverviewSessionWindowId::NxtMain));
    assert_eq!(active_window_at(at(today, 19, 0, 0)), Some(MarketOverviewSessionWindowId::NxtLate));
    assert_eq!(active_window_at(at(today, 20, 0, 0)), None);
    assert_eq!(active_window_at(at(day(2026, 11, 14), 10, 0, 0)), None);

    let samples = vec![
        Sample {
            at: at(today, 9, 5, 0).unix(),
            received_at: AS_OF,
            market: Market::Kospi,
            value: SampleValue::Investors { individual_eok: -100, foreign_eok: 60, institution_eok: 40 },
        },
        Sample {
            at: at(today, 9, 20, 0).unix(),
            received_at: AS_OF,
            market: Market::Kospi,
            value: SampleValue::Investors { individual_eok: -150, foreign_eok: 100, institution_eok: 50 },
        },
        Sample {
            at: at(today, 11, 0, 0).unix(),
            received_at: AS_OF,
            market: Market::Kospi,
            value: SampleValue::Investors { individual_eok: -250, foreign_eok: 180, institution_eok: 70 },
        },
        Sample {
            at: at(today, 11, 0, 0).unix(),
            received_at: AS_OF,
            market: Market::Kospi,
            value: SampleValue::Program { arbitrage_million_won: Some(1_000), non_arbitrage_million_won: Some(4_000), total_million_won: 5_000 },
        },
        Sample {
            at: at(today, 15, 0, 0).unix(),
            received_at: AS_OF,
            market: Market::Kospi,
            value: SampleValue::Program { arbitrage_million_won: Some(1_000), non_arbitrage_million_won: Some(2_000), total_million_won: 3_000 },
        },
        Sample {
            at: at(today, 9, 25, 0).unix(),
            received_at: AS_OF,
            market: Market::Kosdaq,
            value: SampleValue::Investors { individual_eok: -30, foreign_eok: 20, institution_eok: 10 },
        },
    ];
    let catalog = StockCatalog::default();
    let dna = build_session_dna(at(today, 15, 10, 0), MarketOverviewScope::All, &samples, None, None, &catalog).unwrap();
    assert_eq!(dna.active_window, Some(MarketOverviewSessionWindowId::KrxClose));
    assert_eq!(dna.windows.len(), 6);
    assert_eq!(dna.windows[0].label, "NXT 프리");
    assert_eq!(dna.windows[1].label, "장초반");
    assert!((dna.windows[1].foreign_delta_eok - 120.0).abs() < 1e-9);
    assert!((dna.windows[1].institution_delta_eok - 60.0).abs() < 1e-9);
    assert!((dna.windows[1].individual_delta_eok + 180.0).abs() < 1e-9);
    assert_eq!(dna.windows[1].sample_count, 3);
    assert!((dna.windows[2].foreign_delta_eok - 80.0).abs() < 1e-9);
    assert!((dna.windows[2].program_delta_eok - 50.0).abs() < 1e-9);
    assert!((dna.windows[3].program_delta_eok + 20.0).abs() < 1e-9);

    let kosdaq = build_session_dna(at(today, 15, 10, 0), MarketOverviewScope::Kosdaq, &samples, None, None, &catalog).unwrap();
    assert!((kosdaq.windows[1].foreign_delta_eok - 20.0).abs() < 1e-9);
    assert!((kosdaq.windows[2].foreign_delta_eok).abs() < 1e-9);
}

#[test]
fn disclosure_classifier_and_radar_filter_sort_dedupe_and_cap() {
    assert_eq!(classify_report("단일판매ㆍ공급계약체결"), Some(MarketOverviewDisclosureCategory::Contract));
    assert_eq!(classify_report("자기주식취득결정"), Some(MarketOverviewDisclosureCategory::Shareholder));
    assert_eq!(classify_report("연결재무제표기준영업(잠정)실적"), Some(MarketOverviewDisclosureCategory::Earnings));
    assert_eq!(classify_report("유상증자결정"), Some(MarketOverviewDisclosureCategory::Capital));
    assert_eq!(classify_report("임원ㆍ주요주주특정증권등소유상황보고서"), None);

    let mut records = Vec::new();
    let mut list = Vec::new();
    for i in 0..35u32 {
        list.push(disclosure_map(
            "단일판매ㆍ공급계약체결",
            &format!("20261109{:06}", i + 1),
            "20261109",
            "삼성전자",
            "유",
        ));
    }
    list.push(disclosure_map("단일판매ㆍ공급계약체결", "20261109000035", "20261109", "삼성전자", "유"));
    list.push(disclosure_map("기타경영사항(자율공시)", "20261109000099", "20261109", "삼성전자", "유"));
    records.push(SecurityDisclosures {
        stock_code: "005930".into(),
        company_name: "삼성전자".into(),
        disclosures: list,
    });
    let catalog = StockCatalog::from_listed(&[ListedMeta {
        code: StockCode::parse("005930").unwrap(),
        name: "삼성전자".into(),
        market: Market::Kospi,
        listed_shares: NonZeroU64::new(1_000_000),
        is_etf_etn: false,
    }]);
    let mut rates = HashMap::new();
    rates.insert(StockCode::parse("005930").unwrap(), 3.25);
    let radar = build_disclosure_radar(Some(&records), MarketOverviewScope::Kospi, &catalog, &rates).unwrap();
    assert_eq!(radar.total_matched, 35);
    assert_eq!(radar.counts.contract, 35);
    assert_eq!(radar.items.len(), 30);
    assert_eq!(radar.items[0].receipt_no, "20261109000035");
    assert_eq!(radar.items[0].change_rate, Some(3.25));
}

#[tokio::test]
async fn pro_endpoint_serves_all_four_blocks_scopes_properly_and_makes_zero_broker_calls() {
    let bar_last = day(2026, 11, 6);
    let today = day(2026, 11, 9);
    let days = trading_days_ending(bar_last, 25);
    let listed = vec![
        listing("005930", "삼성전자", Market::Kospi, 2_000_000, vec![]),
        listing("000660", "SK하이닉스", Market::Kospi, 1_000_000, vec![]),
        listing("247540", "에코프로비엠", Market::Kosdaq, 1_000_000, vec![]),
    ];
    let mut s1 = vec![100u64; 25];
    s1[22] = 104;
    s1[23] = 108;
    s1[24] = 114;
    let mut s2 = vec![100u64; 25];
    s2[22] = 98;
    s2[23] = 95;
    s2[24] = 90;
    let s3 = vec![100u64; 25];
    let bars = vec![
        bar_series("005930", &days, &s1),
        bar_series("000660", &days, &s2),
        bar_series("247540", &days, &s3),
    ];
    let h = Harness::start(at(today, 10, 30, 0), listed, bars).await;

    write_snap(
        &h.shared,
        DataKind::SnapshotCombined,
        today,
        AS_OF,
        vec![
            snap_row("005930", "20261109", 120, 114, 6_000),
            snap_row("000660", "20261109", 88, 90, 4_000),
            snap_row("247540", "20261109", 106, 100, 3_000),
        ],
        vec![],
    );
    write_snap(
        &h.shared,
        DataKind::SnapshotKrx,
        today,
        AS_OF,
        vec![
            snap_row("005930", "20261109", 120, 114, 5_000),
            snap_row("247540", "20261109", 106, 100, 2_000),
        ],
        vec![],
    );
    write_snap(
        &h.shared,
        DataKind::SnapshotNxt,
        today,
        AS_OF,
        vec![
            snap_row("005930", "20261109", 120, 114, 1_000),
            snap_row("247540", "20261109", 106, 100, 500),
        ],
        vec![],
    );
    write_themes(
        &h.shared,
        today,
        AS_OF,
        vec![
            ThemeEntry { code: "T01".into(), name: "반도체".into(), members: vec!["005930".into()] },
            ThemeEntry { code: "T02".into(), name: "메모리조정".into(), members: vec!["000660".into()] },
            ThemeEntry { code: "T03".into(), name: "이차전지".into(), members: vec!["247540".into()] },
        ],
    );
    write_overview_sectors(
        &h.shared,
        today,
        AS_OF,
        vec![
            MarketOverviewSector { code: "013".into(), name: "전기전자".into(), level: 1000.0, change_rate: 2.5, trade_value_eok: 500.0 },
            MarketOverviewSector { code: "005".into(), name: "음식료".into(), level: 500.0, change_rate: -0.5, trade_value_eok: 100.0 },
        ],
        vec![
            MarketOverviewSector { code: "201".into(), name: "코스닥 IT".into(), level: 800.0, change_rate: 3.1, trade_value_eok: 300.0 },
        ],
    );
    write_samples_file(
        &h.shared,
        today,
        &[
            Sample {
                at: at(today, 9, 15, 0).unix(),
                received_at: AS_OF,
                market: Market::Kospi,
                value: SampleValue::Investors { individual_eok: -50, foreign_eok: 30, institution_eok: 20 },
            },
            Sample {
                at: at(today, 10, 15, 0).unix(),
                received_at: AS_OF,
                market: Market::Kosdaq,
                value: SampleValue::Investors { individual_eok: -20, foreign_eok: 15, institution_eok: 5 },
            },
        ],
    );

    let excludes = Excludes { etf_etn: false, preferred: false };
    let bid_ask_kospi = Ranking::BidAskBalance { market: Market::Kospi, venue: Venue::Combined, sort: BalanceSort::NetBuyRemaining, excludes, exclude_managed: false };
    let bid_ask_kosdaq = Ranking::BidAskBalance { market: Market::Kosdaq, venue: Venue::Combined, sort: BalanceSort::NetBuyRemaining, excludes, exclude_managed: false };
    let foreign_all = Ranking::InvestorNetBuy { market: RankingMarket::All, investor: RankingInvestor::Foreign, direction: NetDirection::NetBuy, unit: TradeUnit::Amount, excludes };
    let foreign_kosdaq = Ranking::InvestorNetBuy { market: RankingMarket::Kosdaq, investor: RankingInvestor::Foreign, direction: NetDirection::NetBuy, unit: TradeUnit::Amount, excludes };
    let program_kospi = Ranking::Program { market: Market::Kospi, venue: Venue::Combined, direction: NetDirection::NetBuy, excludes };
    let program_kosdaq = Ranking::Program { market: Market::Kosdaq, venue: Venue::Combined, direction: NetDirection::NetBuy, excludes };
    write_rankings_part(
        &h.shared,
        today,
        AS_OF,
        vec![
            ranking_entry(
                &bid_ask_kospi,
                AS_OF,
                vec![
                    SharedRankingRow {
                        code: SymbolCode("005930".into()),
                        name: "삼성전자".into(),
                        price: Some(Won(120)),
                        change_rate: None,
                        figures: RankingFigures::BidAskBalance {
                            total_sell_remaining: Shares(100_000),
                            total_buy_remaining: Shares(300_000),
                            net_buy_remaining: Shares(200_000),
                            buy_ratio: Percent(300.0),
                        },
                    },
                    SharedRankingRow {
                        code: SymbolCode("000660".into()),
                        name: "SK하이닉스".into(),
                        price: Some(Won(88)),
                        change_rate: Some(Percent(-2.22)),
                        figures: RankingFigures::BidAskBalance {
                            total_sell_remaining: Shares(200_000),
                            total_buy_remaining: Shares(100_000),
                            net_buy_remaining: Shares(-100_000),
                            buy_ratio: Percent(50.0),
                        },
                    },
                ],
            ),
            ranking_entry(
                &bid_ask_kosdaq,
                AS_OF,
                vec![SharedRankingRow {
                    code: SymbolCode("247540".into()),
                    name: "에코프로비엠".into(),
                    price: Some(Won(106)),
                    change_rate: Some(Percent(6.0)),
                    figures: RankingFigures::BidAskBalance {
                        total_sell_remaining: Shares(50_000),
                        total_buy_remaining: Shares(150_000),
                        net_buy_remaining: Shares(100_000),
                        buy_ratio: Percent(300.0),
                    },
                }],
            ),
            ranking_entry(
                &foreign_all,
                AS_OF,
                vec![SharedRankingRow {
                    code: SymbolCode("005930".into()),
                    name: "삼성전자".into(),
                    price: Some(Won(120)),
                    change_rate: None,
                    figures: RankingFigures::NetAmounts { net: Won(50_000_000_000), buy: Won(80_000_000_000), sell: Won(30_000_000_000) },
                }],
            ),
            ranking_entry(
                &foreign_kosdaq,
                AS_OF,
                vec![SharedRankingRow {
                    code: SymbolCode("247540".into()),
                    name: "에코프로비엠".into(),
                    price: Some(Won(106)),
                    change_rate: Some(Percent(6.0)),
                    figures: RankingFigures::NetAmounts { net: Won(12_000_000_000), buy: Won(15_000_000_000), sell: Won(3_000_000_000) },
                }],
            ),
            ranking_entry(
                &program_kospi,
                AS_OF,
                vec![SharedRankingRow {
                    code: SymbolCode("005930".into()),
                    name: "삼성전자".into(),
                    price: Some(Won(120)),
                    change_rate: Some(Percent(5.26)),
                    figures: RankingFigures::NetAmounts { net: Won(30_000_000_000), buy: Won(40_000_000_000), sell: Won(10_000_000_000) },
                }],
            ),
            ranking_entry(
                &program_kosdaq,
                AS_OF,
                vec![SharedRankingRow {
                    code: SymbolCode("247540".into()),
                    name: "에코프로비엠".into(),
                    price: Some(Won(106)),
                    change_rate: Some(Percent(6.0)),
                    figures: RankingFigures::NetAmounts { net: Won(8_000_000_000), buy: Won(10_000_000_000), sell: Won(2_000_000_000) },
                }],
            ),
        ],
    );

    let fin_store = FinancialStore::open(&h.financial_db).await.unwrap();
    fin_store
        .save_security(&Security {
            stock_code: "005930".into(),
            company: Company { corp_code: "00126380".into(), name: "삼성전자".into(), fiscal_month: Some(12) },
            share_class: None,
            share_class_reason: None,
            evidence: "test".into(),
        })
        .await
        .unwrap();
    fin_store
        .save_security(&Security {
            stock_code: "247540".into(),
            company: Company { corp_code: "01139266".into(), name: "에코프로비엠".into(), fiscal_month: Some(12) },
            share_class: None,
            share_class_reason: None,
            evidence: "test".into(),
        })
        .await
        .unwrap();
    fin_store
        .save(
            "00126380",
            &Collection {
                disclosures: vec![
                    disclosure_map("단일판매ㆍ공급계약체결", "20261109000101", "20261109", "삼성전자", "유"),
                    disclosure_map("자기주식취득결정", "20261108000050", "20261108", "삼성전자", "유"),
                    disclosure_map("임원ㆍ주요주주특정증권등소유상황보고서", "20261109000999", "20261109", "삼성전자", "유"),
                ],
                ..Collection::default()
            },
        )
        .await
        .unwrap();
    fin_store
        .save(
            "01139266",
            &Collection {
                disclosures: vec![disclosure_map("유상증자결정", "20261109000202", "20261109", "에코프로비엠", "코")],
                ..Collection::default()
            },
        )
        .await
        .unwrap();
    h.state.market_overview.set_financial_db_path(Some(h.financial_db.clone()));
    h.poll().await;

    let (status, all) = h.get("/api/market-overview/pro").await;
    assert_eq!(status, 200, "{all}");
    assert_eq!(all["scope"], "all");
    assert_eq!(all["phase"], "regular");
    assert_eq!(all["receivedAt"], AS_OF);

    assert_eq!(all["rrg"]["status"], "ok");
    let themes = all["rrg"]["value"]["themes"].as_array().unwrap();
    assert_eq!(themes.len(), 3);
    let t01 = themes.iter().find(|t| t["code"] == "T01").unwrap();
    assert_eq!(t01["points"].as_array().unwrap().len(), 5);
    assert_eq!(t01["quadrant"], "leading");
    assert_eq!(all["rrg"]["value"]["sectors"].as_array().unwrap().len(), 3);

    assert_eq!(all["sessionDna"]["status"], "ok");
    assert_eq!(all["sessionDna"]["value"]["activeWindow"], "krxMid");
    assert_eq!(all["sessionDna"]["value"]["windows"].as_array().unwrap().len(), 6);
    assert!((all["sessionDna"]["value"]["krxTradeValueEok"].as_f64().unwrap() - 70.0).abs() < 1e-9);
    assert!((all["sessionDna"]["value"]["nxtTradeValueEok"].as_f64().unwrap() - 15.0).abs() < 1e-9);

    assert_eq!(all["brokerBook"]["status"], "ok");
    assert_eq!(all["brokerBook"]["value"]["totalBidRemaining"], 550_000);
    assert_eq!(all["brokerBook"]["value"]["totalAskRemaining"], 350_000);
    assert_eq!(all["brokerBook"]["value"]["topBuyPressure"][0]["code"], "005930");
    assert!(all["brokerBook"]["value"]["topBuyPressure"][0]["changeRate"].as_f64().is_some());
    assert_eq!(all["brokerBook"]["value"]["topSellPressure"][0]["code"], "000660");
    assert_eq!(all["brokerBook"]["value"]["foreignLeaders"][0]["code"], "005930");
    assert!((all["brokerBook"]["value"]["foreignLeaders"][0]["netEok"].as_f64().unwrap() - 500.0).abs() < 1e-9);
    assert_eq!(all["brokerBook"]["value"]["programLeaders"][0]["code"], "005930");

    assert_eq!(all["disclosures"]["status"], "ok");
    assert_eq!(all["disclosures"]["value"]["totalMatched"], 3);
    assert_eq!(all["disclosures"]["value"]["counts"]["contract"], 1);
    assert_eq!(all["disclosures"]["value"]["counts"]["shareholder"], 1);
    assert_eq!(all["disclosures"]["value"]["counts"]["capital"], 1);
    assert_eq!(all["disclosures"]["value"]["items"][0]["receiptNo"], "20261109000202");

    let (status, kosdaq) = h.get("/api/market-overview/pro?scope=kosdaq").await;
    assert_eq!(status, 200, "{kosdaq}");
    assert_eq!(kosdaq["scope"], "kosdaq");
    assert_eq!(kosdaq["rrg"]["value"]["themes"].as_array().unwrap().len(), 1);
    assert_eq!(kosdaq["rrg"]["value"]["themes"][0]["code"], "T03");
    assert_eq!(kosdaq["brokerBook"]["value"]["totalBidRemaining"], 150_000);
    assert_eq!(kosdaq["brokerBook"]["value"]["foreignLeaders"][0]["code"], "247540");
    assert_eq!(kosdaq["disclosures"]["value"]["totalMatched"], 1);
    assert_eq!(kosdaq["disclosures"]["value"]["items"][0]["code"], "247540");

    let (bad_status, bad_body) = h.get("/api/market-overview/pro?scope=invalid").await;
    assert_eq!((bad_status, bad_body["error"]["code"].as_str()), (400, Some("bad_request")));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = h.app.clone();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let resp = reqwest::get(format!("http://{addr}/api/market-overview/pro?scope=kospi")).await.unwrap();
    assert_eq!(resp.status(), 200);
    let loopback_json: Value = resp.json().await.unwrap();
    assert_eq!(loopback_json["scope"], "kospi");
    assert_eq!(loopback_json["disclosures"]["value"]["totalMatched"], 2);
    server.abort();

    assert_eq!(h.broker_calls(), 0);
}

#[tokio::test]
async fn pro_endpoint_degrades_each_part_independently_and_returns_zero_broker_calls() {
    let today = day(2026, 11, 9);
    let h = Harness::start(at(today, 10, 0, 0), vec![], vec![]).await;

    let (status, empty) = h.get("/api/market-overview/pro").await;
    assert_eq!(status, 200, "{empty}");
    assert_eq!(empty["receivedAt"], json!(null));
    assert_eq!(empty["rrg"]["status"], "failed");
    assert_eq!(empty["sessionDna"]["status"], "failed");
    assert_eq!(empty["brokerBook"]["status"], "failed");
    assert_eq!(empty["disclosures"]["status"], "failed");

    write_snap(
        &h.shared,
        DataKind::SnapshotKrx,
        today,
        AS_OF,
        vec![snap_row("005930", "20261109", 105, 100, 1_000)],
        vec![],
    );
    h.poll().await;

    let (status, partial) = h.get("/api/market-overview/pro").await;
    assert_eq!(status, 200, "{partial}");
    assert_eq!(partial["sessionDna"]["status"], "ok");
    assert_eq!(partial["rrg"]["status"], "failed");
    assert_eq!(partial["brokerBook"]["status"], "failed");
    assert_eq!(partial["disclosures"]["status"], "failed");
    assert_eq!(h.broker_calls(), 0);
}

struct SyntheticProFixture {
    now: KstTime,
    combined: Loaded<SnapshotBody>,
    krx: Loaded<SnapshotBody>,
    nxt: Loaded<SnapshotBody>,
    themes_catalog: StoredCatalog,
    catalog: StockCatalog,
    closes: HashMap<StockCode, Vec<(KstDate, Price)>>,
    last_day: KstDate,
    trading_days: Vec<KstDate>,
    samples: Vec<Sample>,
    disclosures: Vec<SecurityDisclosures>,
}

fn synthetic_2600_pro_fixture() -> SyntheticProFixture {
    let last_day = day(2026, 11, 6);
    let today = day(2026, 11, 9);
    let all_days = trading_days_ending(last_day, 220);
    let trading_days = all_days[200..].to_vec();
    let mut listed = Vec::with_capacity(2_600);
    let mut combined_rows = Vec::with_capacity(2_600);
    let mut krx_rows = Vec::with_capacity(2_600);
    let mut nxt_rows = Vec::with_capacity(800);
    let mut closes = HashMap::with_capacity(2_600);
    let mut all_codes = Vec::with_capacity(2_600);
    for idx in 0..2_600u32 {
        let code_str = format!("{:06}", 100_000 + idx);
        let code = StockCode::parse(&code_str).unwrap();
        all_codes.push(code_str.clone());
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
        combined_rows.push(snap_row(&code_str, "20261109", current, base, 500 + u64::from(idx)));
        krx_rows.push(snap_row(&code_str, "20261109", current, base, 400 + u64::from(idx)));
        if idx < 800 {
            nxt_rows.push(snap_row(&code_str, "20261109", current, base, 100 + u64::from(idx)));
        }
        let series: Vec<(KstDate, Price)> = all_days
            .iter()
            .rev()
            .enumerate()
            .map(|(offset, &d)| (d, price_won(base + ((offset as u64 + u64::from(idx)) % 15) * 10)))
            .collect();
        closes.insert(code, series);
    }
    let mut themes = Vec::with_capacity(100);
    for t in 0..100usize {
        let members = (0..25).map(|m| all_codes[(t * 25 + m) % all_codes.len()].clone()).collect();
        themes.push(StoredTheme { code: format!("T{t:03}"), name: format!("테마{t:03}"), members });
    }
    let themes_catalog = StoredCatalog { date: "20261109".into(), collected_at: AS_OF, themes };
    let mut samples = Vec::with_capacity(300);
    for minute in 0..150u32 {
        let h = 9 + minute / 60;
        let m = minute % 60;
        for market in [Market::Kospi, Market::Kosdaq] {
            samples.push(Sample {
                at: at(today, h, m, 0).unix(),
                received_at: AS_OF,
                market,
                value: SampleValue::Investors {
                    individual_eok: -(minute as i64 * 2),
                    foreign_eok: minute as i64,
                    institution_eok: minute as i64,
                },
            });
        }
    }
    let mut disclosures = Vec::with_capacity(200);
    for (i, stock_code) in all_codes.iter().enumerate().take(200) {
        disclosures.push(SecurityDisclosures {
            stock_code: stock_code.clone(),
            company_name: format!("종목{i:04}"),
            disclosures: vec![
                disclosure_map("단일판매ㆍ공급계약체결", &format!("20261109{:06}", i + 1), "20261109", "회사", "유"),
                disclosure_map("임원ㆍ주요주주특정증권등소유상황보고서", &format!("20261108{:06}", i + 1), "20261108", "회사", "유"),
            ],
        });
    }
    let catalog = StockCatalog::from_listed(&listed);
    let make_loaded = |kind: DataKind, stocks: Vec<SnapshotRow>| Loaded {
        header: Header::new(kind, today, AS_OF, AS_OF, vec![SourceKey { key_name: "rest-01".into(), broker: Broker::Kiwoom }]),
        body: SnapshotBody { closing: false, requested: stocks.len() as u32, missing: 0, stocks, indices: vec![] },
    };
    SyntheticProFixture {
        now: at(today, 11, 30, 0),
        combined: make_loaded(DataKind::SnapshotCombined, combined_rows),
        krx: make_loaded(DataKind::SnapshotKrx, krx_rows),
        nxt: make_loaded(DataKind::SnapshotNxt, nxt_rows),
        themes_catalog,
        catalog,
        closes,
        last_day,
        trading_days,
        samples,
        disclosures,
    }
}

#[test]
fn derive_pro_card_over_2600_stocks_and_100_themes_is_correct_and_fast() {
    let f = synthetic_2600_pro_fixture();
    let started = Instant::now();
    let card = derive_pro_card(&ProInputs {
        now: f.now,
        scope: MarketOverviewScope::All,
        phase: MarketOverviewPhase::Regular,
        combined: Some(&f.combined),
        krx: Some(&f.krx),
        nxt: Some(&f.nxt),
        overview_board: None,
        intraday_themes: None,
        themes_catalog: Some(&f.themes_catalog),
        rankings: None,
        samples: &f.samples,
        disclosures: Some(&f.disclosures),
        catalog: &f.catalog,
        closes: &f.closes,
        latest_day: Some(f.last_day),
        trading_days: &f.trading_days,
    });
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    match card.rrg {
        MarketOverviewPart::Ok { value } => {
            assert_eq!(value.themes.len(), 12);
            assert!(value.themes.iter().all(|s| s.points.len() == 5));
        }
        MarketOverviewPart::Failed { error } => panic!("rrg failed: {error:?}"),
    }
    match card.session_dna {
        MarketOverviewPart::Ok { value } => assert_eq!(value.windows.len(), 6),
        MarketOverviewPart::Failed { error } => panic!("session_dna failed: {error:?}"),
    }
    match card.disclosures {
        MarketOverviewPart::Ok { value } => {
            assert_eq!(value.total_matched, 200);
            assert_eq!(value.items.len(), 30);
        }
        MarketOverviewPart::Failed { error } => panic!("disclosures failed: {error:?}"),
    }
    assert!(elapsed_ms < 250.0, "2,600-stock pro derivation took {elapsed_ms:.2} ms");
}

#[test]
#[ignore]
fn perf_derive_pro_card_2600_stocks_p95_under_25ms() {
    let f = synthetic_2600_pro_fixture();
    let iterations = 40;
    let mut samples_ms = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        let card = derive_pro_card(&ProInputs {
            now: f.now,
            scope: MarketOverviewScope::All,
            phase: MarketOverviewPhase::Regular,
            combined: Some(&f.combined),
            krx: Some(&f.krx),
            nxt: Some(&f.nxt),
            overview_board: None,
            intraday_themes: None,
            themes_catalog: Some(&f.themes_catalog),
            rankings: None,
            samples: &f.samples,
            disclosures: Some(&f.disclosures),
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
    println!("derive_pro_card(2600 stocks, 100 themes, 300 samples, 200 disclosures): p50={p50:.3}ms p95={p95:.3}ms max={max:.3}ms");
    assert!(p95 <= 25.0, "p95 {p95:.3}ms exceeded 25ms budget");
}

#[tokio::test]
async fn broker_book_rejects_stale_previous_day_rankings() {
    let yesterday = day(2026, 11, 6);
    let today = day(2026, 11, 9);
    let yesterday_ts = at(yesterday, 15, 30, 0).unix();
    let h = Harness::start(at(today, 8, 20, 0), vec![listing("005930", "삼성전자", Market::Kospi, 1_000_000, vec![])], vec![]).await;

    let excludes = Excludes { etf_etn: false, preferred: false };
    let bid_ask_kospi = Ranking::BidAskBalance {
        market: Market::Kospi,
        venue: Venue::Combined,
        sort: BalanceSort::NetBuyRemaining,
        excludes,
        exclude_managed: false,
    };
    write_rankings_part(
        &h.shared,
        yesterday,
        yesterday_ts,
        vec![ranking_entry(
            &bid_ask_kospi,
            yesterday_ts,
            vec![SharedRankingRow {
                code: SymbolCode("005930".into()),
                name: "삼성전자".into(),
                price: Some(Won(70_000)),
                change_rate: Some(Percent(2.5)),
                figures: RankingFigures::BidAskBalance {
                    total_sell_remaining: Shares(100_000),
                    total_buy_remaining: Shares(300_000),
                    net_buy_remaining: Shares(200_000),
                    buy_ratio: Percent(300.0),
                },
            }],
        )],
    );
    h.poll().await;

    let (status, body) = h.get("/api/market-overview/pro?scope=all").await;
    assert_eq!(status, 200);
    assert_eq!(body["brokerBook"]["status"], "failed");
}

#[tokio::test]
async fn session_dna_and_rrg_reject_stale_previous_day_snapshots_and_sectors() {
    let yesterday = day(2026, 11, 6);
    let today = day(2026, 11, 9);
    let yesterday_ts = at(yesterday, 15, 30, 0).unix();
    let today_ts = at(today, 8, 20, 0).unix();
    let days = trading_days_ending(today, 20);
    let listed = vec![listing("005930", "삼성전자", Market::Kospi, 1_000_000, vec![])];
    let bars = vec![bar_series("005930", &days, &[70_000; 20])];
    let h = Harness::start(at(today, 8, 20, 0), listed, bars).await;

    write_snap(&h.shared, DataKind::SnapshotCombined, yesterday, yesterday_ts, vec![snap_row("005930", "20261106", 76_300, 70_000, 850_000)], vec![]);
    write_snap(&h.shared, DataKind::SnapshotKrx, yesterday, yesterday_ts, vec![snap_row("005930", "20261106", 70_000, 68_300, 850_000)], vec![]);
    write_snap(&h.shared, DataKind::SnapshotNxt, today, today_ts, vec![snap_row("005930", "20261109", 71_000, 70_000, 5_000)], vec![]);
    write_themes(&h.shared, today, today_ts, vec![ThemeEntry { code: "T01".into(), name: "반도체".into(), members: vec!["005930".into()] }]);
    write_overview_sectors(
        &h.shared,
        yesterday,
        yesterday_ts,
        vec![MarketOverviewSector { code: "013".into(), name: "전기전자".into(), level: 1000.0, change_rate: 9.0, trade_value_eok: 500.0 }],
        vec![],
    );
    h.poll().await;

    let (status, body) = h.get("/api/market-overview/pro?scope=all").await;
    assert_eq!(status, 200);
    assert!((body["sessionDna"]["value"]["krxTradeValueEok"].as_f64().unwrap() - 0.0).abs() < 1e-9);
    assert!((body["sessionDna"]["value"]["nxtTradeValueEok"].as_f64().unwrap() - 50.0).abs() < 1e-9);
    assert!(body["rrg"]["value"]["sectors"].as_array().unwrap().is_empty());
    assert!((body["rrg"]["value"]["themes"][0]["changeRate"].as_f64().unwrap() - 0.0).abs() < 1e-9);

    let h_all_stale = Harness::start(at(today, 8, 15, 0), vec![], vec![]).await;
    write_snap(&h_all_stale.shared, DataKind::SnapshotKrx, yesterday, yesterday_ts, vec![snap_row("005930", "20261106", 105, 100, 5_000)], vec![]);
    write_snap(&h_all_stale.shared, DataKind::SnapshotNxt, yesterday, yesterday_ts, vec![snap_row("005930", "20261106", 105, 100, 1_000)], vec![]);
    h_all_stale.poll().await;

    let (status_stale, body_stale) = h_all_stale.get("/api/market-overview/pro").await;
    assert_eq!(status_stale, 200);
    assert_eq!(body_stale["sessionDna"]["status"], "failed");
}

#[tokio::test]
async fn zero_current_won_in_combined_snapshot_is_excluded_from_live_rates() {
    let last_day = day(2026, 11, 6);
    let today = day(2026, 11, 9);
    let days = trading_days_ending(last_day, 20);
    let listed = vec![
        listing("005930", "삼성전자", Market::Kospi, 1_000_000, vec![]),
        listing("000660", "SK하이닉스", Market::Kospi, 1_000_000, vec![]),
    ];
    let bars = vec![
        bar_series("005930", &days, &[70_000; 20]),
        bar_series("000660", &days, &[100_000; 20]),
    ];
    let h = Harness::start(at(today, 8, 55, 0), listed, bars).await;

    write_snap(
        &h.shared,
        DataKind::SnapshotCombined,
        today,
        at(today, 8, 55, 0).unix(),
        vec![
            snap_row("005930", "20261109", 0, 70_000, 0),
            snap_row("000660", "20261109", 101_000, 100_000, 1_000),
        ],
        vec![],
    );
    write_themes(
        &h.shared,
        today,
        at(today, 8, 55, 0).unix(),
        vec![ThemeEntry { code: "T01".into(), name: "단일종목".into(), members: vec!["005930".into()] }],
    );

    let fin_store = FinancialStore::open(&h.financial_db).await.unwrap();
    fin_store
        .save_security(&Security {
            stock_code: "005930".into(),
            company: Company { corp_code: "00126380".into(), name: "삼성전자".into(), fiscal_month: Some(12) },
            share_class: None,
            share_class_reason: None,
            evidence: "test".into(),
        })
        .await
        .unwrap();
    fin_store
        .save(
            "00126380",
            &Collection {
                disclosures: vec![disclosure_map("단일판매ㆍ공급계약체결", "20261109000101", "20261109", "삼성전자", "유")],
                ..Collection::default()
            },
        )
        .await
        .unwrap();
    h.state.market_overview.set_financial_db_path(Some(h.financial_db.clone()));
    h.poll().await;

    let (status, body) = h.get("/api/market-overview/pro?scope=all").await;
    assert_eq!(status, 200);
    let theme_rate = body["rrg"]["value"]["themes"][0]["changeRate"].as_f64().unwrap();
    assert!((theme_rate - 0.0).abs() < 1e-9);
    assert!(body["disclosures"]["value"]["items"][0]["changeRate"].is_null());
}

#[tokio::test]
async fn rrg_interior_halt_gap_does_not_shift_pre_halt_returns_onto_halted_dates() {
    let last_day = day(2026, 11, 20);
    let today = day(2026, 11, 23);
    let days = trading_days_ending(last_day, 20);
    let listed = vec![
        listing("005930", "삼성전자", Market::Kospi, 1_000_000, vec![]),
        listing("000660", "SK하이닉스", Market::Kospi, 1_000_000, vec![]),
    ];

    let mut halted_days = Vec::new();
    let mut halted_closes = Vec::new();
    for (idx, &d) in days.iter().enumerate() {
        if idx == 16 || idx == 17 {
            continue;
        }
        halted_days.push(d);
        halted_closes.push(if idx >= 15 { 150 } else { 100 });
    }
    let h = Harness::start(
        at(today, 10, 0, 0),
        listed,
        vec![bar_series("005930", &days, &[100u64; 20]), bar_series("000660", &halted_days, &halted_closes)],
    )
    .await;
    write_snap(
        &h.shared,
        DataKind::SnapshotCombined,
        today,
        at(today, 10, 0, 0).unix(),
        vec![
            snap_row("005930", "20261123", 100, 100, 1_000),
            snap_row("000660", "20261123", 150, 150, 1_000),
        ],
        vec![],
    );
    write_themes(
        &h.shared,
        today,
        at(today, 10, 0, 0).unix(),
        vec![ThemeEntry { code: "T_GAP".into(), name: "정지갭".into(), members: vec!["000660".into()] }],
    );
    h.poll().await;

    let (status, body) = h.get("/api/market-overview/pro?scope=all").await;
    assert_eq!(status, 200);
    let points = body["rrg"]["value"]["themes"][0]["points"].as_array().unwrap();
    let nov17 = points.iter().find(|pt| pt["date"] == "2026-11-17").unwrap()["rsRatio"].as_f64().unwrap();
    let nov18 = points.iter().find(|pt| pt["date"] == "2026-11-18").unwrap()["rsRatio"].as_f64().unwrap();
    assert!(nov17 > 101.0);
    assert!(nov18 < nov17);
}

#[tokio::test]
async fn rrg_retains_theme_when_member_was_halted_on_latest_day_and_resumes_today() {
    let last_day = day(2026, 11, 20);
    let today = day(2026, 11, 23);
    let days = trading_days_ending(last_day, 20);
    let listed = vec![
        listing("005930", "삼성전자", Market::Kospi, 1_000_000, vec![]),
        listing("035420", "NAVER", Market::Kospi, 1_000_000, vec![]),
    ];
    let h = Harness::start(
        at(today, 10, 0, 0),
        listed,
        vec![bar_series("005930", &days, &[100u64; 20]), bar_series("035420", &days[..19], &[100u64; 19])],
    )
    .await;
    write_snap(
        &h.shared,
        DataKind::SnapshotCombined,
        today,
        at(today, 10, 0, 0).unix(),
        vec![
            snap_row("005930", "20261123", 100, 100, 1_000),
            snap_row("035420", "20261123", 120, 100, 1_000),
        ],
        vec![],
    );
    write_themes(
        &h.shared,
        today,
        at(today, 10, 0, 0).unix(),
        vec![ThemeEntry { code: "T_RESUME".into(), name: "정지해제".into(), members: vec!["035420".into()] }],
    );
    h.poll().await;

    let (status, body) = h.get("/api/market-overview/pro?scope=all").await;
    assert_eq!(status, 200);
    assert_eq!(body["rrg"]["status"], "ok");
    let themes = body["rrg"]["value"]["themes"].as_array().unwrap();
    assert_eq!(themes.len(), 1);
    assert_eq!(themes[0]["code"], "T_RESUME");
    assert!((themes[0]["changeRate"].as_f64().unwrap() - 20.0).abs() < 1e-6);
}

#[test]
fn session_dna_assigns_1530_regular_close_sample_to_krx_close_window() {
    let today = day(2026, 11, 9);
    let close_mark = at(today, 15, 30, 0);
    assert_eq!(active_window_at(close_mark), Some(MarketOverviewSessionWindowId::KrxClose));
    assert_eq!(active_window_at(at(today, 15, 31, 0)), Some(MarketOverviewSessionWindowId::NxtMain));

    let samples = vec![
        Sample {
            at: at(today, 15, 29, 0).unix(),
            received_at: close_mark.unix(),
            market: Market::Kospi,
            value: SampleValue::Investors { individual_eok: -100, foreign_eok: 100, institution_eok: 0 },
        },
        Sample {
            at: close_mark.unix(),
            received_at: close_mark.unix(),
            market: Market::Kospi,
            value: SampleValue::Investors { individual_eok: -350, foreign_eok: 350, institution_eok: 0 },
        },
    ];
    let dna = build_session_dna(at(today, 15, 35, 0), MarketOverviewScope::Kospi, &samples, None, None, &StockCatalog::default()).unwrap();
    let krx_close = dna.windows.iter().find(|w| w.id == MarketOverviewSessionWindowId::KrxClose).unwrap();
    let nxt_main = dna.windows.iter().find(|w| w.id == MarketOverviewSessionWindowId::NxtMain).unwrap();
    assert!((krx_close.foreign_delta_eok - 350.0).abs() < 1e-9);
    assert_eq!(krx_close.sample_count, 2);
    assert!((nxt_main.foreign_delta_eok - 0.0).abs() < 1e-9);
    assert_eq!(nxt_main.sample_count, 0);
}

#[test]
fn disclosure_classifier_marks_rights_plus_bonus_issue_as_capital() {
    assert_eq!(classify_report("유무상증자결정"), Some(MarketOverviewDisclosureCategory::Capital));
    assert_eq!(classify_report("무상증자결정"), Some(MarketOverviewDisclosureCategory::Shareholder));
}

#[tokio::test]
async fn weekend_pro_endpoint_retains_latest_friday_closing_boards() {
    let friday = day(2026, 11, 6);
    let saturday = day(2026, 11, 7);
    let friday_ts = at(friday, 15, 30, 0).unix();
    let listed = vec![listing("005930", "삼성전자", Market::Kospi, 1_000_000, vec![])];
    let h = Harness::start(at(saturday, 12, 0, 0), listed, vec![]).await;

    write_snap(&h.shared, DataKind::SnapshotKrx, friday, friday_ts, vec![snap_row("005930", "20261106", 70_000, 69_000, 5_000)], vec![]);
    write_overview_sectors(
        &h.shared,
        friday,
        friday_ts,
        vec![MarketOverviewSector { code: "013".into(), name: "전기전자".into(), level: 1000.0, change_rate: 1.5, trade_value_eok: 500.0 }],
        vec![],
    );
    h.poll().await;

    let (status, body) = h.get("/api/market-overview/pro?scope=all").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["sessionDna"]["status"], "ok");
    assert!((body["sessionDna"]["value"]["krxTradeValueEok"].as_f64().unwrap() - 50.0).abs() < 1e-9);
    assert_eq!(body["rrg"]["status"], "ok");
    assert_eq!(body["rrg"]["value"]["sectors"].as_array().unwrap().len(), 1);
}
