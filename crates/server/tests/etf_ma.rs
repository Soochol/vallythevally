use std::sync::Arc;

use axum::{Router, body::Body, http::Request};
use domain::{KstDate, KstTime, TimeOfDay};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::app::{ApplicationInputs, application};
use server::clock::Clock;
use server::config::Secret;
use server::db::AppDb;
use server::screener::store::{DayBar, Store, Write};
use server::kiwoom::wire::MillionWon;
use domain::{Ohlcv, Price, StockCode, Volume};
use server::http::router;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::stream::KiwoomStream;
use server::symbols::{Directory, SymbolDirectory};
use tower::ServiceExt;

mod support;
use support::ScriptedTransport;


struct Harness {
    app: Router,
    _tmp: tempfile::TempDir,
}

const RISING_FIFTY: &str = "005930";
const SHAPED: &str = "000660";
const SIXTY_ONLY: &str = "042700";
const FALLING: &str = "036930";
const STALE: &str = "039030";
const ABSENT: &str = "240810";

fn first_day() -> KstDate {
    KstDate::new(2026, 1, 1).unwrap()
}

fn bars(closes: &[u64], last_day: KstDate) -> Vec<DayBar> {
    let count = closes.len() as i64;
    closes
        .iter()
        .enumerate()
        .map(|(i, close)| {
            let price = Price::from_centi(close * 100).unwrap();
            let ohlcv = Ohlcv::try_new(price, price, price, price, Volume(1)).unwrap();
            DayBar { day: KstDate::from_days_since_epoch(last_day.days_since_epoch() - (count - 1 - i as i64)), ohlcv, traded: MillionWon(1) }
        })
        .collect()
}

fn write(store: &Store, code: &str, closes: &[u64], last_day: KstDate) {
    store.write(&[Write::Replace { code: StockCode::parse(code).unwrap(), bars: bars(closes, last_day) }]).unwrap();
}

fn repeated(parts: &[(u64, usize)]) -> Vec<u64> {
    parts.iter().flat_map(|(close, count)| std::iter::repeat_n(*close, *count)).collect()
}

fn seeded_store(path: &std::path::Path) -> Store {
    let store = Store::open(path).unwrap();
    let latest = KstDate::new(2026, 11, 18).unwrap();
    write(&store, SHAPED, &repeated(&[(100, 70), (300, 40), (200, 20)]), latest);
    write(&store, SIXTY_ONLY, &(1..=60).collect::<Vec<u64>>(), latest);
    write(&store, FALLING, &(1..=130).rev().collect::<Vec<u64>>(), latest);
    write(&store, RISING_FIFTY, &(1..=130).collect::<Vec<u64>>(), latest);
    write(&store, STALE, &(1..=130).collect::<Vec<u64>>(), first_day());
    store
}

impl Harness {
    async fn start(seed: impl FnOnce(&std::path::Path) -> Store) -> Harness {
        let clock = Clock::fake(KstTime::from_kst_civil(KstDate::new(2026, 11, 19).unwrap(), TimeOfDay::MIDNIGHT));
        let auth = KiwoomAuth::new(Secret::new("FAKE_KEY".into()), Secret::new("FAKE_SECRET".into()), None);
        let rest = KiwoomRest::new(ScriptedTransport::new().transport(), auth, clock.clone());
        let symbols = Arc::new(SymbolDirectory::default());
        symbols.replace(Directory::build(Vec::new()));
        let tmp = tempfile::tempdir().unwrap();
        let db = AppDb::open(&tmp.path().join("db.sqlite")).await.unwrap();
        let (stream, _desired) = KiwoomStream::detached();
        let (_events, events) = tokio::sync::mpsc::channel(1);
        let store = seed(&tmp.path().join("screener.duckdb"));
        let state = application(ApplicationInputs { rest, clock, symbols, db, screener_store: store, stream: (stream, events), static_dir: tmp.path().to_owned(), screener_update_on_connect: false });
        Harness { app: router(state), _tmp: tmp }
    }

    async fn ok(&self, path: &str) -> Value {
        let response = self.app.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status().as_u16(), 200);
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }

    async fn holding_ma(&self, code: &str) -> Value {
        let detail = self.ok("/api/etf/funds/091160").await;
        detail["holdings"].as_array().unwrap().iter().find(|h| h["code"] == code).unwrap()["ma"].clone()
    }
}

#[tokio::test]
async fn states_match_hand_computed_averages() {
    let h = Harness::start(seeded_store).await;
    assert_eq!(h.holding_ma(SHAPED).await, json!({"ma20": "equal", "ma60": "below", "ma120": "above"}));
    assert_eq!(h.holding_ma(RISING_FIFTY).await, json!({"ma20": "above", "ma60": "above", "ma120": "above"}));
    assert_eq!(h.holding_ma(FALLING).await, json!({"ma20": "below", "ma60": "below", "ma120": "below"}));
}

#[tokio::test]
async fn a_stock_with_sixty_bars_has_no_ma120() {
    let h = Harness::start(seeded_store).await;
    assert_eq!(h.holding_ma(SIXTY_ONLY).await, json!({"ma20": "above", "ma60": "above", "ma120": null}));
}

#[tokio::test]
async fn a_stock_missing_from_the_store_has_no_states() {
    let h = Harness::start(seeded_store).await;
    assert_eq!(h.holding_ma(ABSENT).await, json!({"ma20": null, "ma60": null, "ma120": null}));
}

#[tokio::test]
async fn a_stock_without_the_latest_bar_has_no_states() {
    let h = Harness::start(seeded_store).await;
    assert_eq!(h.holding_ma(STALE).await, json!({"ma20": null, "ma60": null, "ma120": null}));
}

#[tokio::test]
async fn the_base_date_is_the_latest_stored_bar() {
    let h = Harness::start(seeded_store).await;
    assert_eq!(h.ok("/api/etf/funds/091160").await["maAsOf"], json!("2026-11-18"));
    let stock = h.ok(&format!("/api/etf/stocks/{SHAPED}")).await;
    assert_eq!(stock["maAsOf"], json!("2026-11-18"));
    assert_eq!(stock["ma"], json!({"ma20": "equal", "ma60": "below", "ma120": "above"}));
}

#[tokio::test]
async fn an_empty_store_gives_no_states_and_no_base_date() {
    let h = Harness::start(|path| Store::open(path).unwrap()).await;
    let detail = h.ok("/api/etf/funds/091160").await;
    assert_eq!(detail["maAsOf"], Value::Null);
    assert_eq!(h.holding_ma(SHAPED).await, json!({"ma20": null, "ma60": null, "ma120": null}));
}
