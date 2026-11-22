use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use domain::{Feed, KstDate, Market, Ohlcv, Period, Price, SeriesKey, StockCode, Symbol, SymbolInfo, SymbolKind, Venue, Volume};
use futures::future::BoxFuture;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

use super::*;
use crate::api;
use crate::app::{ApplicationInputs, application_with_source};
use crate::clock::{Clock, kst};
use crate::config::Secret;
use crate::db::AppDb;
use crate::http::router;
use crate::kiwoom::auth::KiwoomAuth;
use crate::kiwoom::rest::KiwoomRest;
use crate::kiwoom::rest::testing::{ApiId, FakeTransport, token};
use crate::kiwoom::stream::KiwoomStream;
use crate::symbols::{Directory, SymbolDirectory};
use crate::system_routes::SystemState;

struct StubSource {
    features: MarketFeatures,
    asked: Mutex<Vec<SeriesKey>>,
}

impl StubSource {
    fn new(features: MarketFeatures) -> Arc<Self> {
        Arc::new(StubSource { features, asked: Mutex::new(Vec::new()) })
    }

    fn asked(&self) -> Vec<SeriesKey> {
        self.asked.lock().unwrap().clone()
    }
}

fn day_bar(day: u8, close: u64) -> PeriodBar {
    let price = Price::from_centi(close * 100).unwrap();
    PeriodBar { bucket: Period::Day.bucket(kst(KstDate::new(2026, 11, day).unwrap(), 0, 0, 0)), ohlcv: Ohlcv::try_new(price, price, price, price, Volume(10)).unwrap() }
}

fn unsupported<T: Send + 'static>() -> BoxFuture<'static, Result<T, SourceError>> {
    Box::pin(async { Err(SourceError::UnknownSymbol) })
}

impl MarketSource for StubSource {
    fn features(&self) -> MarketFeatures {
        self.features
    }

    fn outage(&self) -> Option<SourceError> {
        None
    }

    fn list_outage(&self) -> Option<SourceError> {
        None
    }

    fn until_outage(&self) -> BoxFuture<'_, SourceError> {
        Box::pin(std::future::pending())
    }

    fn until_list_outage(&self) -> BoxFuture<'_, SourceError> {
        Box::pin(std::future::pending())
    }

    fn directory(&self, _: Priority) -> BoxFuture<'_, Result<Directory, SourceError>> {
        unsupported()
    }

    fn fundamentals(&self, _: StockCode, _: Priority) -> BoxFuture<'_, Result<Option<StockFundamentals>, SourceError>> {
        unsupported()
    }

    fn quotes(&self, _: Vec<(StockCode, Venue)>, _: Priority) -> BoxFuture<'_, Result<Vec<QuoteRow>, SourceError>> {
        unsupported()
    }

    fn day_summary(&self, _: StockCode, _: Venue, _: Priority) -> BoxFuture<'_, Result<DaySummary, SourceError>> {
        unsupported()
    }

    fn chart_page(&self, key: SeriesKey, _: KstDate, _: Option<Cursor>, _: Priority, _: MergeScope) -> BoxFuture<'_, Result<ChartPage, SourceError>> {
        self.asked.lock().unwrap().push(key);
        Box::pin(async { Ok(ChartPage { bars: vec![day_bar(5, 201), day_bar(6, 193)], next: None }) })
    }

    fn order_book(&self, _: StockCode, _: Venue, _: Priority) -> BoxFuture<'_, Result<OrderBookSnapshot, SourceError>> {
        unsupported()
    }

    fn trades_page(&self, _: StockCode, _: Venue, _: Option<Cursor>, _: Priority) -> BoxFuture<'_, Result<TapePage<api::TradePrint>, SourceError>> {
        unsupported()
    }

    fn program_trades_page(&self, _: StockCode, _: KstDate, _: Option<Cursor>, _: Priority) -> BoxFuture<'_, Result<TapePage<api::ProgramTradePoint>, SourceError>> {
        unsupported()
    }
}

struct Fixture {
    app: Router,
    kiwoom: Arc<FakeTransport>,
    _events: tokio::sync::mpsc::Sender<crate::kiwoom::stream::StreamEvent>,
    _dir: tempfile::TempDir,
}

async fn fixture(source: Arc<StubSource>) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let db = AppDb::open(&dir.path().join("vally.db")).await.unwrap();
    let kiwoom = Arc::new(FakeTransport::new(Duration::ZERO, |s| {
        assert_eq!(s.api_id, ApiId::Au10001, "시세 공급원을 바꿔 끼우면 키움 시세 요청은 없다");
        token(1)
    }));
    let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 0, 34, 0));
    let rest = KiwoomRest::new(Arc::new(kiwoom.clone()), KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into()), None), clock.clone());
    let symbols = Arc::new(SymbolDirectory::default());
    symbols.replace(Directory::build(vec![SymbolInfo { symbol: Symbol::parse("005930").unwrap(), name: "삼성전자".into(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled: true }]));
    let (stream, _desired) = KiwoomStream::detached();
    let (events, receiver) = tokio::sync::mpsc::channel(64);
    let screener_store = crate::screener::store::Store::open(&dir.path().join("screener.duckdb")).unwrap();
    let inputs = ApplicationInputs { rest, clock, symbols, db, screener_store, stream: (stream, receiver), static_dir: dir.path().to_owned(), screener_update_on_connect: false };
    let state = application_with_source(inputs, SystemState::unconfigured(), source);
    Fixture { app: router(state), kiwoom, _events: events, _dir: dir }
}

async fn json(app: &Router, uri: &str) -> (StatusCode, Value) {
    let response = app.clone().oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or_else(|_| panic!("{uri}: JSON이 아님: {}", String::from_utf8_lossy(&bytes))))
}

#[tokio::test]
async fn bars_come_from_the_injected_source_and_the_kiwoom_transport_sees_no_request() {
    let source = StubSource::new(MarketFeatures::ALL);
    let f = fixture(source.clone()).await;
    let (status, page) = json(&f.app, "/api/bars?symbol=005930&period=D").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let closes: Vec<f64> = page["bars"].as_array().unwrap().iter().map(|b| b["c"].as_f64().unwrap()).collect();
    assert_eq!(closes, [201.0, 193.0]);
    assert_eq!(source.asked(), [SeriesKey { feed: Feed::Stock(StockCode::parse("005930").unwrap(), Venue::Combined), period: Period::Day }]);
    assert!(f.kiwoom.sent().is_empty(), "키움 transport에는 요청이 0건이다: {:?}", f.kiwoom.sent());
}

#[tokio::test]
async fn a_source_without_minute_bars_answers_minute_requests_with_the_closed_reason_and_serves_other_periods() {
    let source = StubSource::new(MarketFeatures::ALL.without(MarketFeature::MinuteBars));
    let f = fixture(source.clone()).await;
    for period in ["1m", "5m"] {
        let (status, error) = json(&f.app, &format!("/api/bars?symbol=005930&period={period}")).await;
        assert_eq!((status, error["error"]["code"].as_str(), error["error"]["reason"].as_str()), (StatusCode::BAD_REQUEST, Some("bad_request"), Some("unsupported_by_source")), "{period}: {error}");
    }
    let (status, jump) = json(&f.app, "/api/bars/jump?symbol=005930&period=5m&date=2026-11-06").await;
    assert_eq!((status, jump["error"]["reason"].as_str()), (StatusCode::BAD_REQUEST, Some("unsupported_by_source")), "{jump}");
    assert!(source.asked().is_empty(), "분봉 요청은 공급원까지 가지 않는다");
    let (status, day) = json(&f.app, "/api/bars?symbol=005930&period=D").await;
    assert_eq!((status, day["bars"].as_array().map(Vec::len)), (StatusCode::OK, Some(2)), "{day}");
    let (status, week) = json(&f.app, "/api/bars?symbol=005930&period=W").await;
    assert_eq!(status, StatusCode::OK, "{week}");
    assert_eq!(json!(source.asked().iter().map(|k| k.period.as_wire()).collect::<Vec<_>>()), json!(["D", "W"]));
}

#[test]
fn features_report_what_a_source_can_do() {
    let without_minutes = MarketFeatures::ALL.without(MarketFeature::MinuteBars);
    assert!(!without_minutes.contains(MarketFeature::MinuteBars));
    assert_eq!(without_minutes.iter().count(), MarketFeature::ALL.len() - 1);
    let index_minutes = SeriesKey { feed: Feed::Index(domain::IndexCode::KOSPI), period: Period::M5 };
    assert_eq!(MarketFeatures::ALL.first_missing_for(index_minutes), None);
    assert_eq!(without_minutes.first_missing_for(index_minutes), Some(MarketFeature::MinuteBars));
    assert_eq!(MarketFeatures::NONE.first_missing_for(SeriesKey { feed: Feed::Index(domain::IndexCode::KOSPI), period: Period::Quarter }), Some(MarketFeature::IndexBars));
}
