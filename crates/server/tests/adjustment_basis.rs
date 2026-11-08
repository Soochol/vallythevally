//! 주식 분봉의 수정주가 기준일은 시리즈의 오늘로 고정된다(PR #15 리뷰 R1, review-w4 W4-04).
//! 실제 키움 응답(알테오젠 196170 통합 60분봉, 2026-11-09 실측)을 원본 `BarService`에 다시 넣는다.

use std::sync::{Arc, Mutex};

use domain::{Feed, KstDate, Market, Period, SeriesKey, Symbol, SymbolInfo, SymbolKind, Venue};
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::bars::BarService;
use server::clock::{Clock, kst};
use server::config::Secret;
use server::kiwoom::api::ApiId;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::symbols::{Directory, SymbolDirectory};

fn fixture(name: &str) -> String {
    let path = format!("{}/tests/fixtures/kiwoom/{name}.json", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// (`base_dt`, 연속조회 키)마다 실측한 응답 하나. 실측하지 않은 조합을 물으면 테스트가 멈춘다.
struct Recorded {
    /// 보낸 차트 조회의 `base_dt`.
    base_dts: Arc<Mutex<Vec<String>>>,
}

impl Transport for Recorded {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let reply = |body: String, next: Option<&str>| {
            let r = HttpResponse { status: 200, next_key: next.map(str::to_owned), body };
            Box::pin(async move { Ok(r) }) as BoxFuture<'static, _>
        };
        if req.api_id == ApiId::Au10001 {
            return reply(json!({"return_code": 0, "token": "fake-token", "expires_dt": "20991231000000"}).to_string(), None);
        }
        let body: Value = serde_json::from_str(req.body.expose()).unwrap();
        let base = body["base_dt"].as_str().unwrap().to_owned();
        let cont = req.cont.as_ref().map(|c| c.as_str().to_owned());
        self.base_dts.lock().unwrap().push(base.clone());
        match (base.as_str(), cont.as_deref()) {
            ("20261109", None) => reply(fixture("ka10080_196170_AL_60_today_p1"), Some("today-p2")),
            ("20261109", Some("today-p2")) => reply(fixture("ka10080_196170_AL_60_today_p2"), Some("today-p3")),
            ("20260716", None) => reply(fixture("ka10080_196170_AL_60_base_20260716"), Some("base-20260716-p2")),
            other => panic!("실측하지 않은 조회: {other:?}"),
        }
    }
}

#[tokio::test(start_paused = true)]
async fn stale_continuation_keeps_alteogen_minutes_on_todays_adjustment_basis() {
    let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 2, 39, 0));
    let base_dts = Arc::new(Mutex::new(Vec::new()));
    let rest = KiwoomRest::new(Arc::new(Recorded { base_dts: base_dts.clone() }), KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into())), clock.clone());
    let symbol = Symbol::parse("196170").unwrap();
    let symbols = Arc::new(SymbolDirectory::default());
    symbols.replace(Directory::build(vec![SymbolInfo { symbol, name: "알테오젠".into(), kind: SymbolKind::Common, market: Market::Kosdaq, nxt_enabled: true }]));
    let bars = BarService::new(rest, symbols, clock.clone());
    let key = SeriesKey { feed: Feed::new(symbol, Some(Venue::Combined)).unwrap(), period: Period::M60 };
    let won = |b: &domain::ConfirmedBar| (b.ohlcv.open().centi() / 100, b.ohlcv.close().centi() / 100);

    let first = bars.page(key, None, 900).await.unwrap();
    assert_eq!(won(&first.bars[0]), (211_997, 212_767), "07-16 15:00 봉, 오늘 기준");
    let held = Some(first.bars.last().unwrap().bucket.start().plus_secs(1));

    // 8분마다 칸이 캐시를 읽는다. 시리즈는 남고 연속조회 키만 15분을 넘겨 묵는다.
    clock.jump(8 * 60);
    bars.page(key, held, 1).await.unwrap();
    clock.jump(8 * 60);
    bars.evict_idle();
    assert_eq!(bars.series_count(), 1);

    let older = bars.page(key, first.next_before, 200).await.unwrap();
    let cached = bars.page(key, held, 900).await.unwrap();

    assert_eq!(won(&cached.bars[0]), (211_997, 212_767), "이미 보낸 07-16 15:00 봉이 수정 전 가격으로 바뀌지 않는다");
    assert_eq!(cached.bars.len(), first.bars.len());
    assert_eq!(cached.bars.iter().zip(&first.bars).filter(|(a, b)| a != b).count(), 0, "이미 보낸 봉의 가격이 바뀌지 않는다");
    let newest_older = older.bars.last().unwrap();
    assert_eq!(won(newest_older).1, 211_997, "07-16 14:00 종가가 다음 봉 시가와 이어진다");
    assert!(base_dts.lock().unwrap().iter().all(|b| b == "20261109"), "{:?}", base_dts.lock().unwrap());
}
