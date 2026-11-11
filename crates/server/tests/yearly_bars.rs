use std::sync::Arc;

use domain::{Feed, KstDate, Market, Period, SeriesKey, Symbol, SymbolInfo, SymbolKind, Venue};
use fake_kiwoom::{APP_KEY, APP_SECRET, FakeKiwoom};
use serde_json::json;
use server::bars::BarService;
use server::clock::{Clock, kst};
use server::config::Secret;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::transport::ReqwestTransport;
use server::symbols::{Directory, SymbolDirectory};

#[tokio::test]
async fn yearly_stock_and_index_contracts_use_dedicated_trs_and_normalize_dates() {
    let fake = FakeKiwoom::start().await;
    let clock = Clock::fake(kst(KstDate::new(2026, 11, 11).unwrap(), 12, 0, 0));
    let rest = KiwoomRest::new(Arc::new(ReqwestTransport::new(fake.base_url()).unwrap()), KiwoomAuth::new(Secret::new(APP_KEY.into()), Secret::new(APP_SECRET.into()), None), clock.clone());
    let symbols = Arc::new(SymbolDirectory::default());
    let samsung = Symbol::parse("005930").unwrap();
    symbols.replace(Directory::build(vec![SymbolInfo { symbol: samsung, name: "삼성전자".into(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled: true }]));
    let bars = BarService::new(rest, symbols, clock);
    for (venue, wire) in [(Venue::Combined, "005930_AL"), (Venue::Krx, "005930"), (Venue::Nxt, "005930_NX")] {
        let key = SeriesKey { feed: Feed::new(samsung, Some(venue)).unwrap(), period: Period::Year };
        let page = bars.page(key, None, 10).await.unwrap();
        assert_eq!(page.bars.len(), 2);
        assert_eq!(page.bars[0].bucket.start().kst_date().yyyymmdd(), "20240101");
        assert_eq!(page.bars[1].ohlcv.close().centi(), 120000);
        assert_eq!(page.current.unwrap().bucket.start().kst_date().yyyymmdd(), "20260101");
        assert_eq!(page.current.unwrap().ohlcv.close().centi(), 150000);
        assert!(page.next_before.is_none());
        let calls = fake.calls();
        let call = calls.iter().find(|c| c.api_id == "ka10094" && c.body["stk_cd"] == wire).unwrap();
        assert_eq!(call.body, json!({"stk_cd": wire, "base_dt": "20261111", "upd_stkpc_tp": "1"}));
    }
    let key = SeriesKey { feed: Feed::new(Symbol::parse("IDX:001").unwrap(), None).unwrap(), period: Period::Year };
    let page = bars.page(key, None, 10).await.unwrap();
    assert_eq!(page.bars.len(), 2);
    assert_eq!(page.bars[1].ohlcv.close().centi(), 1200);
    assert_eq!(page.current.unwrap().ohlcv.close().centi(), 1500);
    let calls = fake.calls();
    let index = calls.iter().find(|c| c.api_id == "ka20019").unwrap();
    assert_eq!(index.body, json!({"inds_cd": "001", "base_dt": "20261111"}));
    assert!(calls.iter().all(|c| matches!(c.api_id.as_str(), "au10001" | "ka10094" | "ka20019")));
}
