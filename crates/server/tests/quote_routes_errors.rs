use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, Market, Symbol, SymbolInfo, SymbolKind};
use futures::future::BoxFuture;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{Adapters, ApplicationInputs, StartOptions, StreamSource, application, start_with};
use server::clock::{Clock, kst};
use server::config::{Config, Secret};
use server::db::AppDb;
use server::http::router;
use server::instance::InstanceLock;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::{Access, KiwoomRest};
use server::kiwoom::stream::KiwoomStream;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::shared_data::{ClosedQuotes, Ladder, LevelQty, QuoteMinute, VenueQuote, closed_day_dir, write_closed_quotes};
use server::symbols::{Directory, SymbolDirectory};
use tower::ServiceExt;

const CODE: &str = "005930";
const MONDAY: &str = "20261123";

#[derive(Clone, Default)]
struct UnusedKiwoom;

impl Transport for UnusedKiwoom {
    fn send(&self, _: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        Box::pin(async { Err(TransportError::refused()) })
    }
}

struct Harness {
    app: Router,
    shared: PathBuf,
    _tmp: tempfile::TempDir,
}

impl Harness {
    async fn start() -> Harness {
        let clock = Clock::frozen(kst(KstDate::new(2026, 11, 24).unwrap(), 10, 1, 30));
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(Arc::new(UnusedKiwoom), auth, clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        symbols.replace(Directory::build(vec![SymbolInfo {
            symbol: Symbol::parse(CODE).unwrap(),
            name: CODE.to_owned(),
            kind: SymbolKind::Common,
            market: Market::Kospi,
            nxt_enabled: true,
        }]));
        let tmp = tempfile::tempdir().unwrap();
        let db = AppDb::open(&tmp.path().join("db.sqlite")).await.unwrap();
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = server::screener::store::Store::open(&tmp.path().join("screener.duckdb")).unwrap();
        let state = application(ApplicationInputs {
            rest: rest.clone(),
            clock,
            symbols,
            db,
            screener_store: store,
            stream: (stream, events),
            static_dir: tmp.path().to_owned(),
            screener_update_on_connect: false,
        });
        rest.set_access(Access::Open);
        let shared = tmp.path().join("shared");
        state.collector_paths.configure(server::shared_data::CollectorPaths::shared_only(shared.clone()));
        Harness { app: router(state), shared, _tmp: tmp }
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let request = Request::builder().uri(path).body(Body::empty()).unwrap();
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("{path}: {e}: {}", String::from_utf8_lossy(&bytes))))
    }
}

fn minute_with(ask: i64, bid: i64) -> QuoteMinute {
    let ladder = Ladder { asks: vec![LevelQty(10_100, ask)], bids: vec![LevelQty(9_900, bid)] };
    let venue = VenueQuote { close: ladder.clone(), peak: ladder.clone(), price_max: ladder };
    QuoteMinute { minute: 9 * 60, close_sec: 9 * 3600 + 50, single_price: false, combined: venue, krx: VenueQuote::default(), nxt: VenueQuote::default() }
}

fn valid_minute() -> QuoteMinute {
    minute_with(100, 50)
}

fn server_vars(work: &Path, hoga: &Path, shared: Option<&Path>) -> BTreeMap<String, String> {
    let show = |path: PathBuf| path.display().to_string();
    let mut vars: BTreeMap<String, String> = [
        ("VALLY_LOCK_PATH", show(work.join("run/server.lock"))),
        ("VALLY_TOKEN_PATH", show(work.join("run/token.json"))),
        ("VALLY_KIWOOM_KEY_PATH", show(work.join("run/kiwoom-key.json"))),
        ("VALLY_ACCOUNT_STATE_PATH", show(work.join("run/account.json"))),
        ("VALLY_DB_PATH", show(work.join("data/vally.db"))),
        ("VALLY_SCREENER_DB_PATH", show(work.join("data/screener.duckdb"))),
        ("VALLY_STATIC_DIR", show(work.join("dist"))),
        ("VALLY_COLLECTOR_TELEGRAM", show(work.join("data/no-telegram.json"))),
        ("VALLY_BIND", "127.0.0.1:0".to_owned()),
        ("VALLY_LOG", "server=warn".to_owned()),
        ("VALLY_KIWOOM_BASE_URL", "http://127.0.0.1:1".to_owned()),
        ("VALLY_KIWOOM_WS_URL", "ws://127.0.0.1:1".to_owned()),
        ("VALLY_PUBLIC_IP_URL", "http://127.0.0.1:1".to_owned()),
        ("VALLY_SCREENER_UPDATE_ON_START", "off".to_owned()),
        ("VALLY_CLOCK_START", "20261124100130".to_owned()),
        ("VALLY_HOGA_DATA_DIR", hoga.display().to_string()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    if let Some(dir) = shared {
        vars.insert("VALLY_SHARED_DATA_DIR".into(), dir.display().to_string());
        vars.insert("VALLY_SHARED_DATA_POLL_MILLIS".into(), "3600000".into());
    }
    vars
}

async fn get_json(app: &Router, host: &str, path: &str) -> (u16, Value) {
    let request = Request::builder().uri(path).header("host", host).body(Body::empty()).unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("{path}: {e}: {}", String::from_utf8_lossy(&bytes))))
}

#[tokio::test]
async fn the_collector_folder_is_read_when_the_shared_folder_is_off() {
    let tmp = tempfile::tempdir().unwrap();
    let hoga = tmp.path().join("hoga");
    let hoga_shared = hoga.join("shared");
    write_closed_quotes(&closed_day_dir(&hoga_shared, MONDAY), MONDAY, CODE, &ClosedQuotes { minutes: vec![minute_with(100, 50)], gaps: Vec::new() }).unwrap();

    let work_hoga_only = tmp.path().join("work-hoga-only");
    let (config_only, _) = Config::from_values(server_vars(&work_hoga_only, &hoga, None)).unwrap();
    let lock_only = InstanceLock::acquire(&config_only.lock_path).unwrap();
    let (_tx_only, rx_only) = tokio::sync::mpsc::channel(4);
    let adapters_only = Adapters { kiwoom: Arc::new(UnusedKiwoom), kis: None, kis_feed: None, stream: StreamSource::Detached(rx_only), kiwoom_spacing: None };
    let started_only = start_with(&config_only, &lock_only, adapters_only, StartOptions { public_listener: None, frozen_clock: true }).await.unwrap();
    assert!(!started_only.state.shared_data.is_enabled());
    let host_only = format!("127.0.0.1:{}", started_only.listener.local_addr().unwrap().port());

    let totals_path = format!("/api/symbols/{CODE}/quote-totals?period=1m&from=2026-11-23&to=2026-11-23");
    let depth_path = format!("/api/symbols/{CODE}/quote-depth?period=1m&from=2026-11-23&to=2026-11-23");

    let (status, body) = get_json(&started_only.router, &host_only, &totals_path).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["days"][0]["state"], "closed");
    assert_eq!((body["points"][0]["ask"].as_i64(), body["points"][0]["bid"].as_i64()), (Some(100), Some(50)));

    let (status, body) = get_json(&started_only.router, &host_only, &depth_path).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["days"][0]["state"], "closed");
    assert_eq!(body["points"][0]["asks"], json!([[10_100, 100]]));
    assert_eq!(body["points"][0]["bids"], json!([[9_900, 50]]));

    let shared_primary = tmp.path().join("shared-primary");
    write_closed_quotes(&closed_day_dir(&shared_primary, MONDAY), MONDAY, CODE, &ClosedQuotes { minutes: vec![minute_with(777, 333)], gaps: Vec::new() }).unwrap();
    let work_both = tmp.path().join("work-both");
    let (config_both, _) = Config::from_values(server_vars(&work_both, &hoga, Some(&shared_primary))).unwrap();
    let lock_both = InstanceLock::acquire(&config_both.lock_path).unwrap();
    let (_tx_both, rx_both) = tokio::sync::mpsc::channel(4);
    let adapters_both = Adapters { kiwoom: Arc::new(UnusedKiwoom), kis: None, kis_feed: None, stream: StreamSource::Detached(rx_both), kiwoom_spacing: None };
    let started_both = start_with(&config_both, &lock_both, adapters_both, StartOptions { public_listener: None, frozen_clock: true }).await.unwrap();
    assert!(started_both.state.shared_data.is_enabled());
    let host_both = format!("127.0.0.1:{}", started_both.listener.local_addr().unwrap().port());

    let (status, body) = get_json(&started_both.router, &host_both, &totals_path).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!((body["points"][0]["ask"].as_i64(), body["points"][0]["bid"].as_i64()), (Some(777), Some(333)));

    let (status, body) = get_json(&started_both.router, &host_both, &depth_path).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["points"][0]["asks"], json!([[10_100, 777]]));
    assert_eq!(body["points"][0]["bids"], json!([[9_900, 333]]));
}

#[tokio::test]
async fn a_broken_file_answers_a_fixed_message_and_is_read_again() {
    let harness = Harness::start().await;
    let day_dir = closed_day_dir(&harness.shared, MONDAY);
    std::fs::create_dir_all(&day_dir).unwrap();
    std::fs::write(day_dir.join(format!("{CODE}.json.gz")), b"broken gzip payload").unwrap();

    let paths = [
        format!("/api/symbols/{CODE}/quote-totals?period=1m&from=2026-11-23&to=2026-11-23"),
        format!("/api/symbols/{CODE}/quote-depth?period=1m&from=2026-11-23&to=2026-11-23"),
    ];
    for path in &paths {
        let (status, body) = harness.get(path).await;
        assert_eq!((status, body["error"]["code"].as_str()), (500, Some("internal")), "{path}: {body}");
        let message = body["error"]["message"].as_str().unwrap();
        assert_eq!(message, "분 호가를 읽지 못했습니다", "{path}: {body}");
        assert!(!message.contains(CODE) && !message.contains('/') && !message.contains(':'), "{path}: {message}");
    }

    write_closed_quotes(&day_dir, MONDAY, CODE, &ClosedQuotes { minutes: vec![valid_minute()], gaps: Vec::new() }).unwrap();

    for path in &paths {
        let (status, body) = harness.get(path).await;
        assert_eq!(status, 200, "{path}: {body}");
        assert_eq!(body["days"][0]["state"], "closed", "{path}: {body}");
        assert!(!body["points"].as_array().unwrap().is_empty(), "{path}: {body}");
    }
}
