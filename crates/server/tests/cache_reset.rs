//! 07:45 비우기와 진행 중인 키움 조회의 경합(PR #13 리뷰 R1).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use domain::{KstDate, Market, Period, SeriesKey, Symbol, SymbolInfo, SymbolKind};
use futures::future::BoxFuture;
use serde_json::json;
use server::bars::BarService;
use server::clock::{Clock, kst};
use server::config::Secret;
use server::kiwoom::api::ApiId;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::symbols::{Directory, SymbolDirectory};
use tokio::sync::{Notify, Semaphore};

fn ok(body: serde_json::Value) -> Result<HttpResponse, TransportError> {
    Ok(HttpResponse { status: 200, next_key: None, body: body.to_string() })
}

/// 첫 차트 요청은 종가 100원, 그 뒤는 200원. 응답은 `gate`가 열릴 때까지 붙잡아 둔다.
struct HeldChart {
    sent: Arc<Notify>,
    gate: Arc<Semaphore>,
    count: Arc<AtomicUsize>,
}

impl Transport for HeldChart {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        if req.api_id == ApiId::Au10001 {
            return Box::pin(async { ok(json!({"return_code": 0, "token": "fake-token", "expires_dt": "20991231000000"})) });
        }
        let n = self.count.fetch_add(1, Ordering::SeqCst) + 1;
        let price = if n == 1 { "100" } else { "200" };
        let (sent, gate) = (self.sent.clone(), self.gate.clone());
        Box::pin(async move {
            sent.notify_one();
            gate.acquire().await.unwrap().forget();
            ok(json!({"return_code": 0, "stk_dt_pole_chart_qry": [
                {"dt": "20261106", "open_pric": price, "high_pric": price, "low_pric": price, "cur_prc": price, "trde_qty": "1"}
            ]}))
        })
    }
}

#[tokio::test(start_paused = true)]
async fn reopening_right_after_the_daily_reset_does_not_reuse_the_pre_reset_response() {
    let sent = Arc::new(Notify::new());
    let gate = Arc::new(Semaphore::new(0));
    let count = Arc::new(AtomicUsize::new(0));
    let clock = Clock::fake(kst(KstDate::new(2026, 11, 9).unwrap(), 7, 44, 59));
    let transport = HeldChart { sent: sent.clone(), gate: gate.clone(), count: count.clone() };
    let rest = KiwoomRest::new(Arc::new(transport), KiwoomAuth::new(Secret::new("k".into()), Secret::new("s".into())), clock.clone());
    let symbol = Symbol::parse("005930").unwrap();
    let symbols = Arc::new(SymbolDirectory::default());
    symbols.replace(Directory::build(vec![SymbolInfo { symbol, name: "삼성전자".into(), kind: SymbolKind::Common, market: Market::Kospi }]));
    let bars = Arc::new(BarService::new(rest, symbols, clock.clone()));
    let key = SeriesKey { symbol, period: Period::Day };

    let before_reset = tokio::spawn({
        let bars = bars.clone();
        async move { bars.page(key, None, 1).await.unwrap() }
    });
    sent.notified().await;
    clock.jump(1);
    bars.clear_all();
    let after_reset = tokio::spawn({
        let bars = bars.clone();
        async move { bars.page(key, None, 1).await.unwrap() }
    });
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    gate.add_permits(2);

    let close = |p: &server::bars::BarPage| p.bars[0].ohlcv.close().centi();
    let (before_reset, after_reset) = (before_reset.await.unwrap(), after_reset.await.unwrap());
    assert_eq!(close(&before_reset), 10000, "비우기 전 요청은 자기 응답을 받는다");
    assert_eq!(count.load(Ordering::SeqCst), 2, "비운 뒤의 요청은 비우기 전 조회와 합쳐지지 않고 새로 보낸다");
    assert_eq!(close(&after_reset), 20000, "새 시리즈는 비운 뒤 받은 값을 쓴다");
    let cached = bars.page(key, Some(after_reset.bars[0].bucket.start().plus_secs(1)), 1).await.unwrap();
    assert_eq!(close(&cached), 20000, "새 캐시에 비우기 전 가격이 남지 않는다");
    assert_eq!(count.load(Ordering::SeqCst), 2);
}
