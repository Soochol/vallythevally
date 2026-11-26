use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, Market, Symbol, SymbolInfo, SymbolKind};
use futures::future::BoxFuture;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::api::{HeatmapTheme, HeatmapThemes, Revision, SymbolCode};
use server::app::{ApplicationInputs, application};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::db::AppDb;
use server::heatmap_board::board_within;
use server::heatmap_flow::flow_within;
use server::http::{AppState, router};
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomStream;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::shared_data::{Broker, DataKind, FeedWriter, Header, IndexRow, MinuteBar, MinuteInstrument, MinuteVenue, SnapshotBody, SnapshotRow, SourceKey, ThemeEntry, ThemesBody, minute_path, write_snapshot};
use server::symbols::{Directory, SymbolDirectory};
use tower::ServiceExt;

fn day() -> KstDate {
    KstDate::new(2026, 11, 19).unwrap()
}

fn unix(h: u32, m: u32, s: u32) -> i64 {
    kst(day(), h, m, s).unix()
}

#[derive(Clone, Default)]
struct Kiwoom {
    calls: Arc<Mutex<Vec<(String, String)>>>,
}

impl Kiwoom {
    fn calls_of(&self, api_id: &str) -> Vec<String> {
        self.calls.lock().unwrap().iter().filter(|(api, _)| api == api_id).map(|(_, code)| code.clone()).collect()
    }

    fn total(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

fn minute_row(time: &str, close: u64) -> Value {
    json!({"cntr_tm": time, "open_pric": close.to_string(), "high_pric": close.to_string(), "low_pric": close.to_string(), "cur_prc": close.to_string(), "trde_qty": "10"})
}

impl Transport for Kiwoom {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let reply = |body: Value| {
            let response = HttpResponse { status: 200, next_key: None, body: body.to_string() };
            Box::pin(async move { Ok(response) }) as BoxFuture<'static, _>
        };
        let api_id = req.api_id.as_str().to_owned();
        if api_id == "au10001" {
            return reply(json!({"return_code": 0, "token": "fake-token", "expires_dt": "20991231000000"}));
        }
        let body: Value = serde_json::from_str(req.body.expose()).unwrap();
        let code = body["stk_cd"].as_str().unwrap_or("").split('_').next().unwrap().to_owned();
        self.calls.lock().unwrap().push((api_id.clone(), code));
        match api_id.as_str() {
            "ka10080" => {
                let rows = [("20261119090300", 10_500), ("20261119090000", 10_500), ("20261118153000", 10_000)].map(|(time, close)| minute_row(time, close));
                reply(json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다", "stk_min_pole_chart_qry": rows}))
            }
            "ka90001" => reply(json!({"return_code": 0, "thema_grp": []})),
            _ => reply(json!({"return_code": 0})),
        }
    }
}

struct Harness {
    state: Arc<AppState>,
    app: Router,
    kiwoom: Kiwoom,
    shared: PathBuf,
    _tmp: tempfile::TempDir,
}

const LISTED: [(&str, &str, bool); 5] = [("005930", "삼성전자", true), ("000660", "SK하이닉스", true), ("042700", "한미반도체", false), ("069500", "KODEX 200", false), ("035420", "NAVER", true)];

impl Harness {
    async fn start(shared: bool) -> Harness {
        let clock = Clock::fake(kst(day(), 10, 1, 0));
        let kiwoom = Kiwoom::default();
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(Arc::new(kiwoom.clone()), auth, clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        let info = |(code, name, nxt_enabled): &(&str, &str, bool)| SymbolInfo { symbol: Symbol::parse(code).unwrap(), name: (*name).to_owned(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled: *nxt_enabled };
        symbols.replace(Directory::build(LISTED.iter().map(info).collect()));
        let tmp = tempfile::tempdir().unwrap();
        let db = AppDb::open(&tmp.path().join("db.sqlite")).await.unwrap();
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = server::screener::store::Store::open(&tmp.path().join("screener.duckdb")).unwrap();
        let state = application(ApplicationInputs { rest: rest.clone(), clock: clock.clone(), symbols, db, screener_store: store, stream: (stream, events), static_dir: tmp.path().to_owned(), screener_update_on_connect: false });
        rest.set_access(Access::Open);
        let shared_dir = tmp.path().join("shared");
        if shared {
            state.shared_data.enable(shared_dir.clone());
        }
        Harness { app: router(state.clone()), state, kiwoom, shared: shared_dir, _tmp: tmp }
    }

    async fn poll(&self) {
        self.state.shared_data.poll_once(&self.shared).await;
    }

    async fn send(&self, method: &str, uri: &str, body: Option<Value>) -> (u16, Value) {
        let request = Request::builder().method(method).uri(uri).header("content-type", "application/json");
        let request = request.body(body.map_or_else(Body::empty, |b| Body::from(b.to_string()))).unwrap();
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        (status, serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap())
    }

    async fn themes(&self, themes: Value) {
        let (status, body) = self.send("PUT", "/api/heatmap/themes", Some(json!({"themes": themes, "revision": 1}))).await;
        assert_eq!(status, 200, "{body}");
    }

    async fn ok(&self, uri: &str) -> Value {
        let (status, body) = self.send("GET", uri, None).await;
        assert_eq!(status, 200, "{uri}: {body}");
        body
    }
}

fn sources() -> Vec<SourceKey> {
    vec![SourceKey { key_name: "rest-01".into(), broker: Broker::Kiwoom }]
}

fn row(code: &str, current: u64, base: u64, traded_million: u64) -> SnapshotRow {
    SnapshotRow { code: code.into(), day: "20261119".into(), current_won: current, base_won: base, open_won: base, high_won: current.max(base), low_won: current.min(base), volume: 100, traded_million_won: traded_million, traded_at: Some(unix(9, 59, 0)) }
}

fn kospi() -> IndexRow {
    IndexRow { code: "001".into(), name: "코스피".into(), level: 2_650.0, change_rate: 1.0, trade_million_won: 0 }
}

fn write_board(dir: &Path, kind: DataKind, as_of: i64, stocks: Vec<SnapshotRow>, indices: Vec<IndexRow>) {
    let requested = stocks.len() as u32;
    write_snapshot(dir, Header::new(kind, day(), as_of, as_of, sources()), SnapshotBody { closing: false, requested, missing: 0, stocks, indices }).unwrap();
}

fn write_boards(dir: &Path) {
    write_board(dir, DataKind::SnapshotKrx, unix(10, 0, 0), vec![row("005930", 51_000, 50_000, 5_000), row("000660", 109_000, 100_000, 50), row("042700", 99_000, 100_000, 30)], vec![kospi()]);
    write_board(dir, DataKind::SnapshotCombined, unix(10, 0, 30), vec![row("005930", 51_000, 50_000, 5_000), row("000660", 109_000, 100_000, 50), row("042700", 98_000, 100_000, 30)], vec![kospi()]);
    write_board(dir, DataKind::SnapshotNxt, unix(10, 0, 45), vec![row("005930", 51_500, 50_000, 700)], vec![kospi()]);
}

fn bar(symbol: &str, venue: Option<MinuteVenue>, minute: u16, close: f64, value: i64, first_sec: u32, last_sec: u32) -> MinuteBar {
    let instrument = if venue.is_some() { MinuteInstrument::Stock } else { MinuteInstrument::Index };
    MinuteBar { symbol: symbol.into(), instrument, venue, minute, open: close, high: close, low: close, close, volume: 10, value, trades: 1, first_sec, last_sec }
}

fn write_minutes(dir: &Path, key: &str, bars: &[MinuteBar]) {
    let header = Header::new(DataKind::Minute, day(), unix(10, 0, 0), unix(10, 0, 0), sources());
    let mut writer = FeedWriter::open_at(&minute_path(dir, "20261119", key), header).unwrap();
    for bar in bars {
        writer.append(bar).unwrap();
    }
    writer.sync().unwrap();
}

fn krx(symbol: &str, minute: u16, close: f64, value: i64, first_sec: u32, last_sec: u32) -> MinuteBar {
    bar(symbol, Some(MinuteVenue::Krx), minute, close, value, first_sec, last_sec)
}

fn write_two_key_minutes(dir: &Path) {
    write_minutes(
        dir,
        "collect-01",
        &[
            krx("005930", 540, 50_500.0, 1_000_000, 32_400, 32_430),
            krx("005930", 544, 51_000.0, 2_000_000, 32_640, 32_680),
            krx("005930", 545, 51_500.0, 500_000, 32_700, 32_710),
            krx("000660", 541, 101_000.0, 10_000_000, 32_460, 32_490),
            bar("001", None, 541, 2_680.0, 0, 32_460, 32_490),
            bar("005930", Some(MinuteVenue::Nxt), 541, 51_500.0, 700_000, 32_460, 32_490),
            bar("042700", Some(MinuteVenue::Combined), 541, 99_000.0, 1_000_000, 32_460, 32_490),
        ],
    );
    write_minutes(dir, "collect-02", &[krx("005930", 545, 52_000.0, 700_000, 32_720, 32_740), krx("000660", 546, 98_000.0, 5_000_000, 32_760, 32_790)]);
}

fn rounded(rate: f64) -> f64 {
    (rate * 10_000.0).round() / 10_000.0
}

fn query(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
}

fn chip_theme() -> Value {
    json!([{"id": "CHIP", "name": "반도체", "symbols": ["005930", "000660", "042700", "999990"]}])
}

#[tokio::test]
async fn the_board_reads_each_venues_snapshot_and_never_calls_kiwoom() {
    let h = Harness::start(true).await;
    h.themes(chip_theme()).await;
    write_boards(&h.shared);
    h.poll().await;

    let krx = h.ok("/api/heatmap/board?venue=krx").await;
    let chip = &krx["themes"][0];
    let weighted = rounded((2.0 * 5_000.0 + 9.0 * 50.0 - 1.0 * 30.0) / 5_080.0);
    assert_eq!(chip["summary"], json!({"weightedRate": weighted, "tradedMillionWon": 5_080, "rising": 2, "flat": 0, "falling": 1, "leader": "000660"}));
    assert_eq!(
        chip["members"],
        json!([
            {"symbol": "005930", "name": "삼성전자", "changeRate": 2.0, "tradedMillionWon": 5_000},
            {"symbol": "000660", "name": "SK하이닉스", "changeRate": 9.0, "tradedMillionWon": 50},
            {"symbol": "042700", "name": "한미반도체", "changeRate": -1.0, "tradedMillionWon": 30},
        ])
    );
    assert_eq!(chip["missing"], json!(["999990"]));
    assert_eq!(krx["asOf"], unix(10, 0, 0));

    let nxt = h.ok("/api/heatmap/board?venue=nxt").await;
    let members = &nxt["themes"][0]["members"];
    assert_eq!(members[0], json!({"symbol": "005930", "name": "삼성전자", "changeRate": 3.0, "tradedMillionWon": 700}), "NXT 종목은 NXT 판에서");
    assert_eq!(members[1], json!({"symbol": "042700", "name": "한미반도체", "changeRate": -2.0, "tradedMillionWon": 30}), "NXT 비대상은 통합 판에서");
    assert_eq!(nxt["themes"][0]["missing"], json!(["000660", "999990"]), "NXT 판에 없는 NXT 종목은 빠진 것");
    assert_eq!(nxt["asOf"], unix(10, 0, 45));

    let combined = h.ok("/api/heatmap/board").await;
    assert_eq!(combined["asOf"], unix(10, 0, 30));
    assert_eq!(h.kiwoom.total(), 0);
}

#[tokio::test]
async fn the_kiwoom_source_board_reads_the_shared_theme_file_and_the_server_does_not_collect_it() {
    let h = Harness::start(true).await;
    write_boards(&h.shared);
    let themes = ThemesBody { themes: vec![ThemeEntry { code: "319".into(), name: "조선".into(), members: vec!["005930".into(), "000660".into()] }] };
    write_snapshot(&h.shared, Header::new(DataKind::KiwoomThemes, day(), unix(8, 31, 0), unix(8, 31, 0), sources()), themes).unwrap();
    h.poll().await;
    server::kiwoom_themes::start_collection(h.state.clone(), h.shared.join("local-catalog"));
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;

    let board = h.ok("/api/heatmap/board?source=kiwoom&venue=krx").await;
    assert_eq!(board["catalog"], json!({"date": "2026-11-19", "collectedAt": unix(8, 31, 0), "themes": 1, "state": "ready"}));
    assert_eq!(board["themes"][0]["id"], "kiwoom-319");
    assert_eq!(board["themes"][0]["members"].as_array().unwrap().len(), 2);
    assert_eq!(h.kiwoom.total(), 0, "08:30이 지난 10시에도 서버는 테마를 받지 않는다");
}

#[tokio::test]
async fn without_the_variable_the_server_still_collects_the_themes_itself() {
    let h = Harness::start(false).await;
    server::kiwoom_themes::start_collection(h.state.clone(), h._tmp.path().join("catalog"));
    for _ in 0..100 {
        tokio::task::yield_now().await;
        if !h.kiwoom.calls_of("ka90001").is_empty() {
            break;
        }
    }
    assert!(!h.kiwoom.calls_of("ka90001").is_empty());
}

#[tokio::test]
async fn the_public_entry_functions_read_only_the_shared_data() {
    let h = Harness::start(true).await;
    write_boards(&h.shared);
    write_two_key_minutes(&h.shared);
    h.poll().await;
    let mine = HeatmapThemes { themes: vec![HeatmapTheme { id: "CHIP".into(), name: "반도체".into(), symbols: ["005930", "000660", "IDX:001"].map(|c| SymbolCode(c.into())).to_vec() }], revision: Revision(0) };
    let Ok(board) = board_within(&h.state, &query(&[("venue", "krx")]), mine).await else { panic!("보드를 만들지 못했다") };
    assert_eq!(board.themes[0].members.len(), 3);
    let index = &board.themes[0].members[2];
    assert_eq!((index.symbol.0.as_str(), index.change_rate, index.traded_million_won), ("IDX:001", 1.0, None), "지수 멤버는 스냅샷의 지수 행에서");
    assert_eq!(board.as_of, Some(server::api::UnixSeconds(unix(10, 0, 0))));

    let allowed: HashSet<Symbol> = ["005930", "000660", "035420"].iter().map(|c| Symbol::parse(c).unwrap()).collect();
    let Ok(series) = flow_within(&h.state, &query(&[("symbols", "005930,000660,035420,042700"), ("venue", "krx")]), &allowed).await else { panic!("흐름을 만들지 못했다") };
    assert_eq!(series.used.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(), ["005930", "000660"]);
    assert_eq!(series.not_collected, vec![SymbolCode("035420".into())], "분봉이 없는 종목은 채우지 않고 알린다");
    assert_eq!(series.not_in_themes, vec![SymbolCode("042700".into())]);
    assert_eq!(h.kiwoom.total(), 0);
}

#[tokio::test]
async fn the_flow_is_computed_from_trade_sums_across_two_key_files_and_grows_with_the_files() {
    let h = Harness::start(true).await;
    write_boards(&h.shared);
    write_two_key_minutes(&h.shared);
    h.poll().await;

    let flow = h.ok("/api/heatmap/flow?symbols=005930,000660&venue=krx").await;
    let first = (2.0 * 3_000_000.0 + 1.0 * 10_000_000.0) / 13_000_000.0;
    let second = (4.0 * 4_200_000.0 - 2.0 * 15_000_000.0) / 19_200_000.0;
    assert_eq!(flow["points"], json!([{"t": unix(9, 0, 0), "rate": rounded(first)}, {"t": unix(9, 5, 0), "rate": rounded(second)}]));
    assert_eq!(flow["used"], json!(["005930", "000660"]));
    assert_eq!((flow["missing"].clone(), flow["notCollected"].clone()), (json!([]), json!([])));
    assert_eq!(flow["asOf"], unix(9, 6, 30), "읽은 줄의 가장 늦은 시각");

    write_minutes(&h.shared, "collect-01", &[krx("005930", 550, 53_000.0, 1_000_000, 32_995, 33_020)]);
    let before = h.ok("/api/heatmap/flow?symbols=005930,000660&venue=krx").await;
    assert_eq!(before["points"], flow["points"], "다음 폴링 전에는 그대로");
    h.poll().await;
    let grown = h.ok("/api/heatmap/flow?symbols=005930,000660&venue=krx").await;
    let third = (6.0 * 5_200_000.0 - 2.0 * 15_000_000.0) / 20_200_000.0;
    assert_eq!(grown["points"][2], json!({"t": unix(9, 10, 0), "rate": rounded(third)}));
    assert_eq!(grown["asOf"], unix(9, 10, 20));
    assert_eq!(h.kiwoom.total(), 0);
}

#[tokio::test]
async fn nxt_requests_use_the_nxt_series_and_base_and_non_nxt_symbols_fall_back_to_combined() {
    let h = Harness::start(true).await;
    write_boards(&h.shared);
    write_two_key_minutes(&h.shared);
    h.poll().await;

    let flow = h.ok("/api/heatmap/flow?symbols=005930&venue=nxt").await;
    assert_eq!(flow["points"], json!([{"t": unix(9, 0, 0), "rate": 3.0}]));
    let fallback = h.ok("/api/heatmap/flow?symbols=042700&venue=nxt").await;
    assert_eq!(fallback["points"], json!([{"t": unix(9, 0, 0), "rate": -1.0}]), "통합 계열 99,000 대 통합 판의 기준가 100,000");
    let index = h.ok("/api/heatmap/flow?symbols=IDX:001").await;
    assert_eq!(index["points"], json!([{"t": unix(9, 0, 0), "rate": rounded((268_000.0 / 262_376.0 - 1.0) * 100.0)}]), "지수의 기준은 행의 수준과 등락률로 거꾸로 구한다");
    assert_eq!(h.kiwoom.total(), 0);
}

#[tokio::test]
async fn the_operator_listener_fills_only_the_symbols_without_collected_minutes_from_kiwoom() {
    let h = Harness::start(true).await;
    write_boards(&h.shared);
    write_two_key_minutes(&h.shared);
    h.poll().await;

    let flow = h.ok("/api/heatmap/flow?symbols=005930,035420&venue=krx").await;
    assert_eq!(h.kiwoom.calls_of("ka10080"), ["035420"]);
    assert_eq!(h.kiwoom.total(), 1);
    assert_eq!((flow["used"].clone(), flow["notCollected"].clone(), flow["missing"].clone()), (json!(["005930", "035420"]), json!([]), json!([])));
    let first = (2.0 * 3_000_000.0 + 5.0 * 210_000.0) / 3_210_000.0;
    let second = (4.0 * 4_200_000.0 + 5.0 * 210_000.0) / 4_410_000.0;
    assert_eq!(flow["points"], json!([{"t": unix(9, 0, 0), "rate": rounded(first)}, {"t": unix(9, 5, 0), "rate": rounded(second)}]), "키움으로 채운 종목의 가중치도 같은 단위다");
}

#[tokio::test]
async fn a_symbol_never_collected_stays_out_of_the_flow_without_failing_it() {
    let h = Harness::start(true).await;
    write_boards(&h.shared);
    h.poll().await;
    let allowed: HashSet<Symbol> = [Symbol::parse("069500").unwrap()].into();
    let Ok(series) = flow_within(&h.state, &query(&[("symbols", "069500")]), &allowed).await else { panic!("분봉이 없어도 실패가 아니다") };
    assert_eq!((series.points.len(), series.used.len(), series.missing.len()), (0, 0, 0));
    assert_eq!(series.not_collected, vec![SymbolCode("069500".into())]);
    assert_eq!(series.as_of, None);
}

fn write_yesterdays_krx_board(dir: &Path) {
    let yesterday = day().add_days(-1);
    let stocks = vec![SnapshotRow { day: yesterday.yyyymmdd(), ..row("005930", 50_000, 48_000, 5_000) }];
    let body = SnapshotBody { closing: true, requested: 1, missing: 0, stocks, indices: Vec::new() };
    write_snapshot(dir, Header::new(DataKind::SnapshotKrx, yesterday, unix(15, 30, 0) - 86_400, unix(15, 30, 0) - 86_400, sources()), body).unwrap();
}

#[tokio::test]
async fn a_snapshot_of_another_day_never_supplies_todays_previous_close() {
    let h = Harness::start(true).await;
    write_yesterdays_krx_board(&h.shared);
    write_board(&h.shared, DataKind::SnapshotCombined, unix(10, 0, 30), vec![row("005930", 51_000, 50_000, 5_000)], vec![kospi()]);
    write_two_key_minutes(&h.shared);
    h.poll().await;

    let flow = h.ok("/api/heatmap/flow?symbols=005930,IDX:001&venue=krx").await;
    assert_eq!((flow["used"].clone(), flow["missing"].clone()), (json!(["IDX:001"]), json!(["005930"])), "어제 판의 기준가 48,000으로 5.2083%를 내지 않는다");
    assert_eq!(flow["points"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn the_board_keeps_showing_the_last_snapshot_with_its_own_as_of_until_the_next_days_first_one() {
    let h = Harness::start(true).await;
    h.themes(chip_theme()).await;
    write_boards(&h.shared);
    h.poll().await;

    for (days_later, hour) in [(1, 7), (3, 12)] {
        let target = kst(day().add_days(days_later), hour, 0, 0).unix();
        h.state.clock.jump(target - h.state.clock.now().unix());
        let board = h.ok("/api/heatmap/board?venue=krx").await;
        assert_eq!(board["asOf"], unix(10, 0, 0), "{days_later}일 뒤 {hour}시에도 마지막 판의 기준 시각");
        assert_eq!(board["themes"][0]["members"][0], json!({"symbol": "005930", "name": "삼성전자", "changeRate": 2.0, "tradedMillionWon": 5_000}));
    }
    assert_eq!(h.kiwoom.total(), 0);
}
