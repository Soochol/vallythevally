use std::path::PathBuf;
use std::sync::Arc;

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, Market, Symbol, SymbolInfo, SymbolKind};
use futures::future::BoxFuture;
use http_body_util::BodyExt;
use serde_json::Value;
use server::app::{ApplicationInputs, application};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::db::AppDb;
use server::http::router;
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
        state.shared_data.enable(shared.clone());
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

fn valid_minute() -> QuoteMinute {
    let ladder = Ladder { asks: vec![LevelQty(10_100, 100)], bids: vec![LevelQty(9_900, 50)] };
    let venue = VenueQuote { close: ladder.clone(), peak: ladder.clone(), price_max: ladder };
    QuoteMinute { minute: 9 * 60, close_sec: 9 * 3600 + 50, single_price: false, combined: venue, krx: VenueQuote::default(), nxt: VenueQuote::default() }
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
