use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use domain::{Feed, IndexCode, KstDate, KstTime, Period, SeriesKey, StockCode, SymbolKind, TimeOfDay, Venue, Weekday};
use futures::future::BoxFuture;
use server::bars::BarService;
use server::clock::{Clock, kst};
use server::config::{KisCredentials, Secret};
use server::kis::api::KisApiId;
use server::kis::auth::KisAuth;
use server::kis::market_rest::{DayValues, KisMarket, MINUTE_PAGE_BUDGET, SUPPORTED_FEATURES, multi_price_day_rows};
use server::kis::master::{MasterDownload, MasterError, MasterMarket};
use server::kis::rest::KisRest;
use server::kis::token_file::{Saved, SavedToken, TokenFile, credential_id};
use server::kis::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::market_source::{Cursor, MarketFeature, MarketSource, MergeScope, Priority, SourceError};
use server::symbols::SymbolDirectory;

const APP_KEY: &str = "FAKE-KIS-APPKEY-market-1";
const APP_SECRET: &str = "FAKE-KIS-SECRET-market-1";
const TOKEN: &str = "FAKE-KIS-TOKEN-market";

fn fixture(name: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/kis/rest").join(name)).unwrap().trim().to_owned()
}

fn friday_evening() -> KstTime {
    kst(KstDate::new(2026, 11, 20).unwrap(), 21, 0, 0)
}

fn friday_morning() -> KstTime {
    kst(KstDate::new(2026, 11, 20).unwrap(), 9, 30, 0)
}

#[derive(Clone)]
struct Sent {
    path: &'static str,
    query: Vec<(String, String)>,
    tr_cont: Option<String>,
}

impl Sent {
    fn get(&self, name: &str) -> &str {
        self.query.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str()).unwrap_or_else(|| panic!("{name}이 없다: {:?}", self.query))
    }
}

type Handler = dyn Fn(&Sent) -> HttpResponse + Send + Sync;

struct FakeKis {
    sent: Mutex<Vec<Sent>>,
    handler: Box<Handler>,
}

impl FakeKis {
    fn new(handler: impl Fn(&Sent) -> HttpResponse + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(FakeKis { sent: Mutex::default(), handler: Box::new(handler) })
    }

    fn sent_to(&self, api: KisApiId) -> Vec<Sent> {
        self.sent.lock().unwrap().iter().filter(|s| s.path == api.path()).cloned().collect()
    }

    fn count(&self, apis: &[KisApiId]) -> usize {
        apis.iter().map(|api| self.sent_to(*api).len()).sum()
    }
}

impl Transport for FakeKis {
    fn send(&self, req: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let sent = Sent {
            path: req.path,
            query: req.query.iter().map(|(n, v)| (n.to_string(), v.clone())).collect(),
            tr_cont: req.header("tr_cont").map(str::to_owned).filter(|v| !v.is_empty()),
        };
        let response = (self.handler)(&sent);
        self.sent.lock().unwrap().push(sent);
        Box::pin(async move { Ok(response) })
    }
}

fn ok(body: impl Into<String>) -> HttpResponse {
    HttpResponse { status: 200, tr_cont: None, body: body.into() }
}

fn ok_more(body: impl Into<String>, more: bool) -> HttpResponse {
    HttpResponse { status: 200, tr_cont: Some(if more { "M" } else { "D" }.into()), body: body.into() }
}

#[derive(Default)]
struct FakeMaster {
    files: Mutex<Option<Result<[Vec<u8>; 2], MasterError>>>,
}

impl FakeMaster {
    fn serving(kospi: &[Vec<u8>], kosdaq: &[Vec<u8>]) -> Arc<Self> {
        let master = FakeMaster::default();
        master.set(kospi, kosdaq);
        Arc::new(master)
    }

    fn set(&self, kospi: &[Vec<u8>], kosdaq: &[Vec<u8>]) {
        *self.files.lock().unwrap() = Some(Ok([archive(kospi), archive(kosdaq)]));
    }

    fn fail(&self) {
        *self.files.lock().unwrap() = Some(Err(MasterError::Download(MasterMarket::Kospi, "HTTP 503".into())));
    }
}

impl MasterDownload for FakeMaster {
    fn download(&self, market: MasterMarket) -> BoxFuture<'static, Result<Vec<u8>, MasterError>> {
        let result = match self.files.lock().unwrap().as_ref().expect("파일을 정했다") {
            Ok(files) => Ok(files[usize::from(market == MasterMarket::Kosdaq)].clone()),
            Err(e) => Err(e.clone()),
        };
        Box::pin(async move { result })
    }
}

const KOSPI_TAIL_CHARS: usize = 227;
const KOSDAQ_TAIL_CHARS: usize = 221;

fn master_line(market: MasterMarket, code: &str, name: &str, group: &str) -> Vec<u8> {
    let tail_chars = if market == MasterMarket::Kospi { KOSPI_TAIL_CHARS } else { KOSDAQ_TAIL_CHARS };
    let text = format!("{code:<9}{:<12}{name}{group:<width$}", "KR7000000000", width = tail_chars);
    let (bytes, _, lost) = encoding_rs::EUC_KR.encode(&text);
    assert!(!lost);
    bytes.into_owned()
}

fn archive(lines: &[Vec<u8>]) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut out);
    zip.start_file("kospi_code.mst", zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)).unwrap();
    for line in lines {
        zip.write_all(line).unwrap();
        zip.write_all(b"\r\n").unwrap();
    }
    zip.finish().unwrap();
    out.into_inner()
}

fn synthetic_master() -> Arc<FakeMaster> {
    let kospi = |code, name, group| master_line(MasterMarket::Kospi, code, name, group);
    let kosdaq = |code, name, group| master_line(MasterMarket::Kosdaq, code, name, group);
    FakeMaster::serving(
        &[
            kospi("005930", "삼성전자", "ST"),
            kospi("005935", "삼성전자우", "ST"),
            kospi("000660", "SK하이닉스", "ST"),
            kospi("069500", "KODEX 200", "EF"),
            kospi("Q500061", "가상 ETN", "EN"),
            kospi("900110", "가상 외국주", "FS"),
        ],
        &[kosdaq("247540", "에코프로비엠", "ST"), kosdaq("086520", "에코프로", "ST")],
    )
}

struct Home {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

impl Home {
    fn holding_token(now: KstTime) -> Home {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state/vallythevally/kis-token.json");
        TokenFile::new(path.clone())
            .save(&Saved {
                credential: Some(credential_id(APP_KEY)),
                token: Some(SavedToken { value: TOKEN.into(), expires_at: now.unix() + 86_400, issued_at: now.unix() - 3600 }),
                last_request_at: now.unix() - 3600,
                disconnected: None,
            })
            .unwrap();
        Home { _dir: dir, path }
    }
}

struct Rig {
    market: Arc<KisMarket>,
    rest: KisRest,
    transport: Arc<FakeKis>,
    clock: Clock,
    _home: Home,
}

fn rig_at(now: KstTime, master: Arc<FakeMaster>, handler: impl Fn(&Sent) -> HttpResponse + Send + Sync + 'static) -> Rig {
    let home = Home::holding_token(now);
    let transport = FakeKis::new(handler);
    let clock = Clock::fake(now);
    let transport_dyn: Arc<dyn Transport> = transport.clone();
    let credentials = KisCredentials { app_key: Secret::new(APP_KEY.into()), app_secret: Secret::new(APP_SECRET.into()) };
    let auth = KisAuth::new(credentials, home.path.clone(), transport_dyn.clone(), clock.clone());
    let rest = KisRest::new(transport_dyn, auth);
    let market = Arc::new(KisMarket::new(rest.clone(), clock.clone(), master));
    Rig { market, rest, transport, clock, _home: home }
}

fn rig(handler: impl Fn(&Sent) -> HttpResponse + Send + Sync + 'static) -> Rig {
    rig_at(friday_evening(), synthetic_master(), handler)
}

fn code(text: &str) -> StockCode {
    StockCode::parse(text).unwrap()
}

fn samsung_key(venue: Venue, period: Period) -> SeriesKey {
    SeriesKey { feed: Feed::Stock(code("005930"), venue), period }
}

fn weekdays_back_from(end: KstDate, count: usize) -> Vec<KstDate> {
    let mut out = Vec::new();
    let mut day = end;
    while out.len() < count {
        if !matches!(day.weekday(), Weekday::Sat | Weekday::Sun) {
            out.push(day);
        }
        day = day.add_days(-1);
    }
    out
}

fn daily_row(day: KstDate, close: u64) -> String {
    format!(
        r#"{{"stck_bsop_date":"{}","stck_clpr":"{close}","stck_oprc":"{close}","stck_hgpr":"{}","stck_lwpr":"{}","acml_vol":"1000","acml_tr_pbmn":"1"}}"#,
        day.yyyymmdd(),
        close + 10,
        close - 10
    )
}

const HISTORY_DAYS: usize = 250;

fn daily_history(sent: &Sent) -> HttpResponse {
    let end = KstDate::parse_yyyymmdd(sent.get("FID_INPUT_DATE_2")).unwrap();
    let start = KstDate::parse_yyyymmdd(sent.get("FID_INPUT_DATE_1")).unwrap();
    let all = weekdays_back_from(friday_evening().kst_date(), HISTORY_DAYS);
    let rows: Vec<String> = all.iter().filter(|d| **d <= end && **d >= start).take(100).map(|d| daily_row(*d, 10_000 + (d.days_since_epoch() % 1000) as u64)).collect();
    ok(format!(r#"{{"rt_cd":"0","msg_cd":"MCA00000","output1":{{}},"output2":[{}]}}"#, rows.join(",")))
}

fn minute_row(day: KstDate, hour: u32, minute: u32, close: u64, volume: u64) -> String {
    format!(
        r#"{{"stck_bsop_date":"{}","stck_cntg_hour":"{hour:02}{minute:02}00","stck_prpr":"{close}","stck_oprc":"{close}","stck_hgpr":"{}","stck_lwpr":"{}","cntg_vol":"{volume}","acml_tr_pbmn":"1"}}"#,
        day.yyyymmdd(),
        close + 5,
        close - 5
    )
}

fn minute_body(rows: &[String]) -> HttpResponse {
    ok(format!(r#"{{"rt_cd":"0","msg_cd":"MCA00000","output1":{{}},"output2":[{}]}}"#, rows.join(",")))
}

async fn ready_directory(market: &KisMarket) -> Arc<SymbolDirectory> {
    let symbols = Arc::new(SymbolDirectory::default());
    let source: &dyn MarketSource = market;
    symbols.refresh(source, Priority::Screen).await.unwrap();
    symbols
}

#[tokio::test(start_paused = true)]
async fn a_synthetic_master_gives_seven_symbols_with_etf_etn_kinds_and_a_normalized_etn_code() {
    let rig = rig(|_| ok("{}"));
    let directory = rig.market.directory(Priority::Background).await.unwrap();
    let stocks: Vec<_> = directory.all().filter(|info| !matches!(info.kind, SymbolKind::Index)).collect();
    assert_eq!(stocks.len(), 7, "{stocks:?}");
    let kind_of = |text: &str| directory.get(domain::Symbol::Stock(code(text))).map(|info| (info.kind, info.market, info.nxt_enabled));
    assert_eq!(kind_of("005930"), Some((SymbolKind::Common, domain::Market::Kospi, false)));
    assert_eq!(kind_of("005935"), Some((SymbolKind::Preferred, domain::Market::Kospi, false)));
    assert_eq!(kind_of("069500"), Some((SymbolKind::Etf, domain::Market::Kospi, false)));
    assert_eq!(kind_of("500061"), Some((SymbolKind::Etn, domain::Market::Kospi, false)), "Q 접두를 뗀 코드다");
    assert_eq!(kind_of("247540"), Some((SymbolKind::Common, domain::Market::Kosdaq, false)));
    assert!(directory.get(domain::Symbol::Stock(code("900110"))).is_none(), "외국주는 넣지 않는다");
    assert_eq!(directory.get(domain::Symbol::Stock(code("005930"))).unwrap().name, "삼성전자", "cp949 이름을 읽는다");
}

thread_local! {
    static CAPTURED: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

struct CapturedLogs;

impl Write for CapturedLogs {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        CAPTURED.with(|logs| logs.borrow_mut().extend_from_slice(bytes));
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test(start_paused = true)]
async fn a_failed_or_short_master_keeps_the_previous_list_and_logs_a_warning() {
    let subscriber = tracing_subscriber::fmt().with_writer(|| CapturedLogs).with_ansi(false).with_max_level(tracing::Level::TRACE).finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let master = synthetic_master();
    let rig = rig_at(friday_evening(), master.clone(), |_| ok("{}"));
    let symbols = SymbolDirectory::default();
    let source: &dyn MarketSource = rig.market.as_ref();
    symbols.refresh(source, Priority::Background).await.unwrap();
    let before = symbols.updates().borrow().clone().unwrap();
    assert_eq!(before.len(), 9, "종목 7개와 지수 둘");
    assert!(rig.market.list_outage().is_none());

    master.fail();
    let failure = symbols.refresh(source, Priority::Background).await.unwrap_err();
    assert!(failure.retry_at().is_some(), "다시 받을 시각을 알린다");
    assert!(Arc::ptr_eq(&before, &symbols.updates().borrow().clone().unwrap()), "받기에 실패하면 이전 목록 그대로다");
    assert!(rig.market.list_outage().is_some());

    let short_line = b"005930 short line".to_vec();
    master.set(&[short_line], &[master_line(MasterMarket::Kosdaq, "247540", "에코프로비엠", "ST")]);
    assert!(symbols.refresh(source, Priority::Background).await.is_err());
    assert!(Arc::ptr_eq(&before, &symbols.updates().borrow().clone().unwrap()), "열이 모자라면 이전 목록 그대로다");

    master.set(&[master_line(MasterMarket::Kospi, "005930", "삼성전자", "ST")], &[master_line(MasterMarket::Kosdaq, "247540", "에코프로비엠", "ST")]);
    assert!(symbols.refresh(source, Priority::Background).await.is_err(), "종목 수가 절반 넘게 줄면 쓰지 않는다");
    assert!(Arc::ptr_eq(&before, &symbols.updates().borrow().clone().unwrap()));

    let logs = CAPTURED.with(|logs| String::from_utf8_lossy(&logs.borrow()).into_owned());
    assert_eq!(logs.matches("WARN").count(), 3, "{logs}");
    assert!(logs.contains("한투 종목 마스터를 쓰지 않습니다"), "{logs}");
}

#[tokio::test(start_paused = true)]
async fn two_hundred_fifty_daily_bars_take_three_requests_and_come_oldest_first() {
    let rig = rig(daily_history);
    let source: &dyn MarketSource = rig.market.as_ref();
    let key = samsung_key(Venue::Krx, Period::Day);
    let today = rig.clock.now().kst_date();
    let mut cursor: Option<Cursor> = None;
    let mut collected = Vec::new();
    loop {
        let page = source.chart_page(key, today, cursor.take(), Priority::Screen, MergeScope::Shared).await.unwrap();
        collected.splice(0..0, page.bars);
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(collected.len(), 250);
    assert!(collected.windows(2).all(|pair| pair[0].bucket.start() < pair[1].bucket.start()), "오름차순이다");
    let sent = rig.transport.sent_to(KisApiId::DailyChart);
    assert_eq!(sent.len(), 4, "100 + 100 + 50 + 끝을 알리는 빈 창");
    assert!(sent.iter().all(|s| s.get("FID_PERIOD_DIV_CODE") == "D" && s.get("FID_COND_MRKT_DIV_CODE") == "J" && s.get("FID_INPUT_ISCD") == "005930"));
    assert_eq!(sent[0].get("FID_INPUT_DATE_2"), today.yyyymmdd());
}

#[tokio::test(start_paused = true)]
async fn the_bar_service_gets_two_hundred_fifty_daily_bars_from_three_kis_requests() {
    let rig = rig(daily_history);
    let symbols = ready_directory(&rig.market).await;
    let market = Arc::try_unwrap(rig.market).ok().expect("한 곳에서만 쓴다");
    let transport = rig.transport.clone();
    let service = BarService::new(market, symbols, rig.clock.clone());
    let page = service.page(samsung_key(Venue::Krx, Period::Day), None, 250).await.unwrap();
    assert_eq!(page.bars.len(), 250);
    assert_eq!(transport.sent_to(KisApiId::DailyChart).len(), 3);
}

#[tokio::test(start_paused = true)]
async fn weekly_monthly_and_yearly_bars_use_their_period_codes_and_wider_windows() {
    let rig = rig(|sent| {
        let row = |date: &str| format!(r#"{{"stck_bsop_date":"{date}","stck_clpr":"100","stck_oprc":"90","stck_hgpr":"110","stck_lwpr":"80","acml_vol":"5"}}"#);
        ok(format!(r#"{{"rt_cd":"0","output2":[{},{}]}}"#, row("20261120"), row(match sent.get("FID_PERIOD_DIV_CODE") {
            "Y" => "20251230",
            "M" => "20261030",
            _ => "20261113",
        })))
    });
    let source: &dyn MarketSource = rig.market.as_ref();
    let today = rig.clock.now().kst_date();
    for (period, wire) in [(Period::Week, "W"), (Period::Month, "M"), (Period::Year, "Y")] {
        let page = source.chart_page(samsung_key(Venue::Combined, period), today, None, Priority::Screen, MergeScope::Shared).await.unwrap();
        assert_eq!(page.bars.len(), 2, "{period:?}");
        assert!(page.next.is_some(), "창에 봉이 있으면 더 이른 창을 이어 받는다");
        let sent = rig.transport.sent_to(KisApiId::DailyChart);
        let last = sent.last().unwrap();
        assert_eq!((last.get("FID_PERIOD_DIV_CODE"), last.get("FID_COND_MRKT_DIV_CODE")), (wire, "UN"));
    }
    let starts: Vec<_> = rig.transport.sent_to(KisApiId::DailyChart).iter().map(|s| KstDate::parse_yyyymmdd(s.get("FID_INPUT_DATE_1")).unwrap().days_since_epoch()).collect();
    assert!(starts[0] > starts[1] && starts[1] > starts[2], "주·월·연봉의 조회 창이 점점 넓다");
}

fn nxt_open_and_five_one_minute_bars(sent: &Sent) -> HttpResponse {
    let day = friday_morning().kst_date();
    match sent.path {
        path if path == KisApiId::TodayMinuteChart.path() => minute_body(&[
            minute_row(day, 9, 4, 101, 50),
            minute_row(day, 9, 3, 99, 40),
            minute_row(day, 9, 2, 96, 30),
            minute_row(day, 9, 1, 108, 20),
            minute_row(day, 9, 0, 103, 10),
            minute_row(day, 8, 9, 50, 7),
            minute_row(day, 8, 4, 40, 3),
            minute_row(day, 8, 0, 30, 1),
        ]),
        _ => minute_body(&[]),
    }
}

#[tokio::test(start_paused = true)]
async fn a_five_minute_request_is_built_from_one_minute_bars_with_summed_volume() {
    let rig = rig_at(friday_morning(), synthetic_master(), nxt_open_and_five_one_minute_bars);
    let source: &dyn MarketSource = rig.market.as_ref();
    let day = friday_morning().kst_date();
    let page = source.chart_page(samsung_key(Venue::Krx, Period::M5), day, None, Priority::Screen, MergeScope::Shared).await.unwrap();
    assert!(page.next.is_none(), "더 과거가 없다");
    let at = |h, m| KstTime::from_kst_civil(day, TimeOfDay::hms(h, m, 0).unwrap());
    let starts: Vec<_> = page.bars.iter().map(|b| b.bucket.start()).collect();
    assert_eq!(starts, [at(8, 0), at(8, 5), at(9, 0)], "NXT 08:00 구간 경계는 키움 5분봉 칸과 같은 Period::bucket이다");
    for bar in &page.bars {
        assert_eq!(bar.bucket, Period::M5.bucket(bar.bucket.start()));
    }
    let nine = page.bars.iter().find(|b| b.bucket.start() == at(9, 0)).unwrap().ohlcv;
    assert_eq!((nine.open().centi(), nine.high().centi(), nine.low().centi(), nine.close().centi(), nine.volume().0), (10_300, 11_300, 9_100, 10_100, 150));
    let eight = page.bars.iter().find(|b| b.bucket.start() == at(8, 0)).unwrap().ohlcv;
    assert_eq!((eight.open().centi(), eight.close().centi(), eight.volume().0), (3_000, 4_000, 4), "08:00~08:04 구간");
    assert_eq!(rig.transport.sent_to(KisApiId::TodayMinuteChart).len(), 1);
    let first = &rig.transport.sent_to(KisApiId::TodayMinuteChart)[0];
    assert_eq!((first.get("FID_INPUT_HOUR_1"), first.get("FID_COND_MRKT_DIV_CODE")), ("093000", "J"));
}

#[tokio::test(start_paused = true)]
async fn the_nxt_venue_and_the_combined_venue_use_their_own_market_codes_for_minute_bars() {
    let rig = rig_at(friday_morning(), synthetic_master(), nxt_open_and_five_one_minute_bars);
    let source: &dyn MarketSource = rig.market.as_ref();
    let day = friday_morning().kst_date();
    for (venue, wire) in [(Venue::Nxt, "NX"), (Venue::Combined, "UN")] {
        let page = source.chart_page(samsung_key(venue, Period::M1), day, None, Priority::Screen, MergeScope::Shared).await.unwrap();
        assert_eq!(page.bars.len(), 8);
        assert_eq!(rig.transport.sent_to(KisApiId::TodayMinuteChart).last().unwrap().get("FID_COND_MRKT_DIV_CODE"), wire);
    }
}

fn endless_minutes(sent: &Sent) -> HttpResponse {
    let today_text = friday_morning().kst_date().yyyymmdd();
    let bound_day = KstDate::parse_yyyymmdd(if sent.path == KisApiId::PastMinuteChart.path() { sent.get("FID_INPUT_DATE_1") } else { &today_text }).unwrap();
    let hour = sent.get("FID_INPUT_HOUR_1");
    let bound = (hour[0..2].parse::<u32>().unwrap() * 60 + hour[2..4].parse::<u32>().unwrap()) as i64;
    let size = if sent.path == KisApiId::PastMinuteChart.path() { 120 } else { 30 };
    let rows: Vec<String> = (0..size).map(|i| bound - i).filter(|m| *m >= 8 * 60).map(|m| minute_row(bound_day, (m / 60) as u32, (m % 60) as u32, 1_000 + m as u64, 1)).collect();
    minute_body(&rows)
}

#[tokio::test(start_paused = true)]
async fn a_first_minute_request_sends_at_most_twenty_pages_and_scrolling_back_sends_twenty_more() {
    let rig = rig_at(friday_morning(), synthetic_master(), endless_minutes);
    let source: &dyn MarketSource = rig.market.as_ref();
    let day = friday_morning().kst_date();
    let key = samsung_key(Venue::Krx, Period::M5);
    let both = [KisApiId::TodayMinuteChart, KisApiId::PastMinuteChart];

    let first = source.chart_page(key, day, None, Priority::Screen, MergeScope::Shared).await.unwrap();
    assert!(rig.transport.count(&both) <= MINUTE_PAGE_BUDGET, "{}쪽을 보냈다", rig.transport.count(&both));
    assert!(!first.bars.is_empty() && first.next.is_some());
    let sent_first = rig.transport.count(&both);

    let second = source.chart_page(key, day, first.next.clone(), Priority::Screen, MergeScope::Shared).await.unwrap();
    assert!(rig.transport.count(&both) - sent_first <= MINUTE_PAGE_BUDGET);
    assert!(second.bars.last().unwrap().bucket.start() < first.bars.first().unwrap().bucket.start(), "더 과거 봉이다");
    assert!(second.bars.iter().chain(&first.bars).all(|b| b.bucket == Period::M5.bucket(b.bucket.start())));
    let mut starts: Vec<_> = second.bars.iter().chain(&first.bars).map(|b| b.bucket.start()).collect();
    let all = starts.clone();
    starts.sort();
    starts.dedup();
    assert_eq!(starts, all, "두 쪽 사이에 겹치는 칸이나 빠진 순서가 없다");
}

#[tokio::test(start_paused = true)]
async fn minute_history_continues_into_earlier_days_with_the_past_minute_tr_and_skips_weekends() {
    let rig = rig_at(friday_morning(), synthetic_master(), |sent| {
        let thursday = KstDate::new(2026, 11, 19).unwrap();
        let monday = KstDate::new(2026, 11, 16).unwrap();
        let friday = friday_morning().kst_date();
        if sent.path == KisApiId::TodayMinuteChart.path() {
            return minute_body(&[minute_row(friday, 9, 1, 100, 1), minute_row(friday, 9, 0, 100, 1)]);
        }
        let asked = KstDate::parse_yyyymmdd(sent.get("FID_INPUT_DATE_1")).unwrap();
        if asked == thursday {
            minute_body(&[minute_row(thursday, 9, 0, 90, 1)])
        } else if asked == monday {
            minute_body(&[minute_row(monday, 9, 0, 80, 1)])
        } else {
            minute_body(&[])
        }
    });
    let source: &dyn MarketSource = rig.market.as_ref();
    let page = source.chart_page(samsung_key(Venue::Krx, Period::M1), friday_morning().kst_date(), None, Priority::Screen, MergeScope::Shared).await.unwrap();
    let days: Vec<_> = page.bars.iter().map(|b| b.bucket.start().kst_date().to_string()).collect();
    assert_eq!(days, ["2026-11-16", "2026-11-19", "2026-11-20", "2026-11-20"]);
    let asked: Vec<_> = rig.transport.sent_to(KisApiId::PastMinuteChart).iter().map(|s| s.get("FID_INPUT_DATE_1").to_owned()).collect();
    assert_eq!(&asked[..3], ["20261119", "20261118", "20261117"], "토·일은 묻지 않는다");
    assert!(asked.contains(&"20261116".to_owned()));
    assert!(page.next.is_none(), "빈 날이 이어지면 거기가 처음이다");
}

#[tokio::test(start_paused = true)]
async fn stock_info_fills_the_boundary_fields_of_the_synthetic_response() {
    let rig = rig(|_| ok(fixture("price.json")));
    let fundamentals = rig.market.fundamentals(code("005930"), Priority::Screen).await.unwrap().unwrap();
    assert_eq!(fundamentals.upper_limit_won, Some(91_000));
    assert_eq!(fundamentals.lower_limit_won, Some(49_000));
    assert_eq!((fundamentals.high_250_won, fundamentals.low_250_won), (Some(88_800), Some(51_000)), "52주 최고·최저가 같은 칸이다");
    assert_eq!(fundamentals.market_cap_won, Some(4_238_000 * 100_000_000), "억원을 원으로");
    assert_eq!((fundamentals.per, fundamentals.pbr), (Some(12.34), Some(1.23)));
    assert_eq!((fundamentals.eps_won, fundamentals.bps_won), (Some(5_421), Some(57_712)));
    assert_eq!(fundamentals.listed_shares, Some(5_969_782_550));
    assert_eq!(fundamentals.foreign_exhaustion_pct, Some(50.25));
    let summary = rig.market.day_summary(code("005930"), Venue::Nxt, Priority::Screen).await.unwrap();
    assert_eq!((summary.price_won, summary.base_won, summary.open_won, summary.high_won, summary.low_won), (Some(71_000), Some(70_000), Some(70_500), Some(71_500), Some(69_800)));
    assert_eq!((summary.volume, summary.trade_value_won), (Some(1_234_567), Some(87_654_321_000)));
    let sent = rig.transport.sent_to(KisApiId::CurrentPrice);
    assert_eq!((sent[0].get("FID_COND_MRKT_DIV_CODE"), sent[1].get("FID_COND_MRKT_DIV_CODE")), ("J", "NX"));

    let unknown = rig_at(friday_evening(), synthetic_master(), |_| ok(fixture("price_unknown.json")));
    assert_eq!(unknown.market.fundamentals(code("999999"), Priority::Screen).await.unwrap(), None);
}

#[tokio::test(start_paused = true)]
async fn many_quotes_go_out_in_chunks_of_thirty_and_come_back_per_requested_venue() {
    let rig = rig(|_| ok(fixture("multprice.json")));
    let rows = vec![(code("005930"), Venue::Krx), (code("000660"), Venue::Combined)];
    let quotes = rig.market.quotes(rows, Priority::Screen).await.unwrap();
    assert_eq!(quotes.len(), 2);
    assert_eq!((quotes[0].code, quotes[0].venue, quotes[0].price_centi, quotes[0].base_centi), (code("005930"), Venue::Krx, 7_100_000, 7_000_000));
    assert_eq!((quotes[1].venue, quotes[1].traded_million_won, quotes[1].volume.0), (Venue::Combined, Some(47_123), 234_567));
    let sent = rig.transport.sent_to(KisApiId::MultiPrice);
    assert_eq!(sent.len(), 1);
    assert_eq!((sent[0].get("FID_COND_MRKT_DIV_CODE_1"), sent[0].get("FID_INPUT_ISCD_1"), sent[0].get("FID_COND_MRKT_DIV_CODE_2"), sent[0].get("FID_INPUT_ISCD_2")), ("J", "005930", "UN", "000660"));

    let many: Vec<_> = (0..61).map(|i| (code(&format!("{:06}", 100_000 + i)), Venue::Krx)).collect();
    let rig = rig_at(friday_evening(), synthetic_master(), |_| ok(r#"{"rt_cd":"0","output":[]}"#));
    assert!(rig.market.quotes(many, Priority::Screen).await.unwrap().is_empty());
    assert_eq!(rig.transport.sent_to(KisApiId::MultiPrice).len(), 3, "30 + 30 + 1");
}

#[tokio::test(start_paused = true)]
async fn multi_price_day_rows_carry_open_high_low_and_name_the_field_they_cannot_read() {
    let rig = rig(|_| ok(fixture("multprice.json")));
    let wanted = [(code("005930"), Venue::Krx), (code("000660"), Venue::Krx)];
    let rows = multi_price_day_rows(&rig.rest, &wanted, Priority::Screen).await.unwrap();
    assert_eq!(rows.iter().map(|row| row.code).collect::<Vec<_>>(), [code("005930"), code("000660")]);
    assert_eq!(
        rows[0].values,
        Ok(DayValues { price_centi: 7_100_000, base_centi: 7_000_000, open_centi: 7_050_000, high_centi: 7_150_000, low_centi: 6_980_000, volume: 1_234_567, traded_won: 87_654_321_000 })
    );
    let quotes = rig.market.quotes(wanted.to_vec(), Priority::Screen).await.unwrap();
    assert_eq!((quotes[0].price_centi, quotes[0].base_centi, quotes[0].volume.0, quotes[0].traded_million_won), (7_100_000, 7_000_000, 1_234_567, Some(87_654)), "quotes()의 결과는 그대로다");

    let blank_open = r#"{"rt_cd":"0","output":[{"inter_shrn_iscd":"005930","inter2_prpr":"71000","inter2_sdpr":"70000","inter2_oprc":"","inter2_hgpr":"71500","inter2_lwpr":"69800","acml_vol":"1","acml_tr_pbmn":"1"}]}"#;
    let broken = rig_at(friday_evening(), synthetic_master(), move |_| ok(blank_open));
    let rows = multi_price_day_rows(&broken.rest, &wanted[..1], Priority::Screen).await.unwrap();
    assert_eq!(rows[0].values, Err("inter2_oprc을 읽을 수 없습니다".to_owned()));
}

#[tokio::test(start_paused = true)]
async fn the_first_screen_reads_the_order_book_the_tape_and_the_program_trades() {
    let rig = rig(|sent| match sent.path {
        path if path == KisApiId::OrderBook.path() => ok(fixture("book.json")),
        path if path == KisApiId::TodayTrades.path() => ok(fixture("trades.json")),
        _ => ok(fixture("program.json")),
    });
    let book = rig.market.order_book(code("005930"), Venue::Combined, Priority::Screen).await.unwrap();
    assert_eq!(book.asks.iter().map(|l| (l.price, l.quantity)).collect::<Vec<_>>(), [(71_100, 500), (71_200, 700)], "가격 없는 단은 빠진다");
    assert_eq!(book.bids.iter().map(|l| (l.price, l.quantity)).collect::<Vec<_>>(), [(71_000, 600), (70_900, 800)]);
    assert_eq!((book.total_ask_quantity, book.total_bid_quantity, book.after_hours_ask_quantity, book.after_hours_bid_quantity), (12_000, 15_000, Some(10), Some(20)));
    assert_eq!(book.book_time.as_deref(), Some("09:30:15"));

    let tape = rig.market.trades_page(code("005930"), Venue::Krx, None, Priority::Screen).await.unwrap();
    assert_eq!(tape.skipped, 1);
    assert_eq!(tape.rows.iter().map(|t| (t.time.as_str(), t.price, t.quantity)).collect::<Vec<_>>(), [("09:30:02", 71_100, 30), ("09:30:01", 71_000, -20)], "매도호가 이상은 매수, 매수호가 이하는 매도");
    assert_eq!(tape.next.as_ref().map(Cursor::as_str), Some("093001:2"));
    rig.market.trades_page(code("005930"), Venue::Krx, tape.next, Priority::Screen).await.unwrap();
    assert_eq!(rig.transport.sent_to(KisApiId::TodayTrades)[1].get("FID_INPUT_HOUR_1"), "093001");

    let program = rig.market.program_trades_page(code("005930"), friday_evening().kst_date(), None, Priority::Screen).await.unwrap();
    assert_eq!(program.skipped, 1);
    assert_eq!(
        program.rows,
        [server::api::ProgramTradePoint { time: "15:30:00".into(), price: Some(70_100), buy_quantity: 1_200, sell_quantity: 1_500, net_quantity: -300, buy_amount: 84_000_000, sell_amount: 105_000_000, net_amount: -21_000_000 }]
    );
    assert_eq!(rig.transport.sent_to(KisApiId::ProgramTrades)[0].get("FID_COND_MRKT_DIV_CODE"), "UN");
}

#[tokio::test(start_paused = true)]
async fn index_bars_use_the_index_trs_and_follow_the_continuation_header() {
    let rig = rig_at(friday_morning(), synthetic_master(), |sent| {
        let day = friday_morning().kst_date();
        if sent.path == KisApiId::IndexChart.path() {
            let row = |date: &str| format!(r#"{{"stck_bsop_date":"{date}","bstp_nmix_prpr":"2705.38","bstp_nmix_oprc":"2700.00","bstp_nmix_hgpr":"2710.10","bstp_nmix_lwpr":"2690.55","acml_vol":"300"}}"#);
            return ok_more(format!(r#"{{"rt_cd":"0","output2":[{},{}]}}"#, row("20261120"), row("20261119")), sent.tr_cont.is_none());
        }
        let row = |m: u32, close: &str| format!(r#"{{"stck_bsop_date":"{}","stck_cntg_hour":"09{m:02}00","bstp_nmix_prpr":"{close}","bstp_nmix_oprc":"{close}","bstp_nmix_hgpr":"{close}","bstp_nmix_lwpr":"{close}","cntg_vol":"1"}}"#, day.yyyymmdd());
        let rows = if sent.tr_cont.is_none() { vec![row(4, "2705.00"), row(3, "2704.00")] } else { vec![row(2, "2703.00"), row(1, "2702.00"), row(0, "2701.00")] };
        ok_more(format!(r#"{{"rt_cd":"0","output2":[{}]}}"#, rows.join(",")), sent.tr_cont.is_none())
    });
    let source: &dyn MarketSource = rig.market.as_ref();
    let day = friday_morning().kst_date();
    let key = |period| SeriesKey { feed: Feed::Index(IndexCode::KOSPI), period };

    let daily = source.chart_page(key(Period::Day), day, None, Priority::Screen, MergeScope::Shared).await.unwrap();
    assert_eq!(daily.bars.len(), 2);
    assert_eq!(daily.bars[1].ohlcv.close().centi(), 270_538);
    assert!(daily.next.is_some(), "연속조회 머리글이 더 있다고 알렸다");
    let more = source.chart_page(key(Period::Day), day, daily.next, Priority::Screen, MergeScope::Shared).await.unwrap();
    assert!(more.next.is_none());
    let sent = rig.transport.sent_to(KisApiId::IndexChart);
    assert_eq!((sent[0].get("FID_INPUT_ISCD"), sent[0].get("FID_COND_MRKT_DIV_CODE"), sent[1].tr_cont.as_deref()), ("0001", "U", Some("N")));

    let minutes = source.chart_page(key(Period::M5), day, None, Priority::Screen, MergeScope::Shared).await.unwrap();
    assert!(minutes.next.is_none());
    assert_eq!(minutes.bars.len(), 1);
    assert_eq!(minutes.bars[0].ohlcv.close().centi(), 270_500);
    assert_eq!((minutes.bars[0].ohlcv.open().centi(), minutes.bars[0].ohlcv.volume().0), (270_100, 5), "다음 쪽까지 이어 받아 09:00~09:04 다섯 분을 모은다");
    let sent = rig.transport.sent_to(KisApiId::IndexMinuteChart);
    assert_eq!((sent.len(), sent[0].get("FID_INPUT_HOUR_1"), sent[1].tr_cont.as_deref()), (2, "60", Some("N")));
}

#[tokio::test(start_paused = true)]
async fn the_kis_feature_set_has_no_rankings_overview_investors_or_screener_update() {
    let rig = rig(|_| ok("{}"));
    let features: Vec<MarketFeature> = rig.market.features().iter().collect();
    assert_eq!(features, SUPPORTED_FEATURES.to_vec());
    assert_eq!(features.len(), MarketFeature::ALL.len());
    let labels: Vec<_> = features.iter().map(|f| f.label()).collect();
    for absent in ["순위", "시장 개요", "투자자", "스크리너"] {
        assert!(!labels.iter().any(|label| label.contains(absent)), "{absent}: {labels:?}");
    }
}

#[tokio::test(start_paused = true)]
async fn a_halted_key_is_an_outage_and_the_calendar_quarter_is_not_asked_for() {
    let rig = rig(|_| ok("{}"));
    let source: &dyn MarketSource = rig.market.as_ref();
    assert!(source.outage().is_none());
    let quarter = source.chart_page(samsung_key(Venue::Krx, Period::Quarter), friday_evening().kst_date(), None, Priority::Screen, MergeScope::Shared).await;
    assert!(matches!(quarter, Err(SourceError::Malformed(_))));
    assert_eq!(rig.transport.count(&KisApiId::ALL), 0, "분기봉은 한투로 보내지 않는다");
}

#[tokio::test(start_paused = true)]
async fn a_symbol_jump_with_the_kis_source_reads_minute_and_daily_bars_and_never_answers_unknown_symbol() {
    let rig = rig(|sent| {
        let thursday = KstDate::new(2026, 11, 19).unwrap();
        if sent.path == KisApiId::DailyChart.path() {
            return daily_history(sent);
        }
        let asked_thursday = sent.path == KisApiId::PastMinuteChart.path() && sent.get("FID_INPUT_DATE_1") == thursday.yyyymmdd();
        if asked_thursday {
            minute_body(&[minute_row(thursday, 9, 2, 100, 1), minute_row(thursday, 9, 1, 100, 1), minute_row(thursday, 9, 0, 100, 1)])
        } else {
            minute_body(&[])
        }
    });
    let symbols = ready_directory(&rig.market).await;
    let market = Arc::try_unwrap(rig.market).ok().expect("한 곳에서만 쓴다");
    let service = BarService::new(market, symbols, rig.clock.clone());
    let page = service.jump_page(samsung_key(Venue::Krx, Period::M1), KstDate::new(2026, 11, 19).unwrap(), None, 3).await.expect("일봉을 주는 공급원이라 바로가기가 된다");
    assert_eq!(page.bars.len(), 3);
    assert!(page.unadjusted_days.is_empty(), "그날 일봉이 있어 수정 비율을 구했다");
    assert!(rig.transport.count(&[KisApiId::DailyChart]) > 0, "수정 비율을 위해 일봉을 받는다");
}

#[tokio::test(start_paused = true)]
async fn index_minutes_end_on_an_empty_page() {
    let rig = rig_at(friday_morning(), synthetic_master(), |sent| {
        let day = friday_morning().kst_date();
        let first = sent.tr_cont.is_none();
        let rows = if first { format!(r#"{{"stck_bsop_date":"{}","stck_cntg_hour":"090100","bstp_nmix_prpr":"2700.00","bstp_nmix_oprc":"2700.00","bstp_nmix_hgpr":"2700.00","bstp_nmix_lwpr":"2700.00","cntg_vol":"1"}}"#, day.yyyymmdd()) } else { String::new() };
        ok_more(format!(r#"{{"rt_cd":"0","output2":[{rows}]}}"#), true)
    });
    let source: &dyn MarketSource = rig.market.as_ref();
    let key = SeriesKey { feed: Feed::Index(IndexCode::KOSPI), period: Period::M60 };
    let page = source.chart_page(key, friday_morning().kst_date(), None, Priority::Screen, MergeScope::Shared).await.unwrap();
    assert_eq!(page.bars.len(), 1);
    assert!(page.next.is_none(), "빈 쪽 뒤에는 이어 받을 곳이 없다");
    assert_eq!(rig.transport.sent_to(KisApiId::IndexMinuteChart).len(), 2, "봉이 있는 쪽 하나와 빈 쪽 하나");
}

fn daily_history_of(dates: Vec<KstDate>) -> impl Fn(&Sent) -> HttpResponse + Send + Sync + 'static {
    move |sent| {
        let end = KstDate::parse_yyyymmdd(sent.get("FID_INPUT_DATE_2")).unwrap();
        let start = KstDate::parse_yyyymmdd(sent.get("FID_INPUT_DATE_1")).unwrap();
        let rows: Vec<String> = dates.iter().filter(|d| **d <= end && **d >= start).take(100).map(|d| daily_row(*d, 10_000)).collect();
        ok(format!(r#"{{"rt_cd":"0","msg_cd":"MCA00000","output1":{{}},"output2":[{}]}}"#, rows.join(",")))
    }
}

async fn read_all_daily(rig: &Rig) -> Vec<server::market_source::PeriodBar> {
    let source: &dyn MarketSource = rig.market.as_ref();
    let key = samsung_key(Venue::Krx, Period::Day);
    let today = rig.clock.now().kst_date();
    let mut cursor: Option<Cursor> = None;
    let mut collected = Vec::new();
    loop {
        let page = source.chart_page(key, today, cursor.take(), Priority::Screen, MergeScope::Shared).await.unwrap();
        collected.splice(0..0, page.bars);
        cursor = page.next;
        if cursor.is_none() {
            return collected;
        }
    }
}

#[tokio::test(start_paused = true)]
async fn daily_history_continues_past_a_window_with_fewer_than_a_page_of_rows() {
    let today = friday_evening().kst_date();
    let recent = weekdays_back_from(today, 40);
    let older = weekdays_back_from(today.add_days(-175), 35);
    let rig = rig(daily_history_of(recent.iter().chain(&older).copied().collect()));
    let collected = read_all_daily(&rig).await;
    assert_eq!(collected.len(), 75, "창 하나가 40행이어도 더 과거 창의 35행이 이어진다");
    assert!(collected.windows(2).all(|pair| pair[0].bucket.start() < pair[1].bucket.start()));
    assert_eq!(rig.transport.sent_to(KisApiId::DailyChart).len(), 3, "봉이 있는 창 둘과 빈 창 하나");
}

#[tokio::test(start_paused = true)]
async fn daily_history_ends_on_the_first_empty_window() {
    let today = friday_evening().kst_date();
    let rig = rig(daily_history_of(weekdays_back_from(today, 30)));
    let collected = read_all_daily(&rig).await;
    assert_eq!(collected.len(), 30);
    assert_eq!(rig.transport.sent_to(KisApiId::DailyChart).len(), 2, "봉이 있는 창 하나와 끝을 알리는 빈 창 하나");
}

#[tokio::test(start_paused = true)]
async fn daily_history_stops_when_a_window_does_not_reach_further_back_than_the_one_before() {
    let today = friday_evening().kst_date();
    let fixed_rows: Vec<String> = weekdays_back_from(today.add_days(-300), 5).into_iter().map(|day| daily_row(day, 10_000)).collect();
    let rig = rig(move |_| ok(format!(r#"{{"rt_cd":"0","msg_cd":"MCA00000","output1":{{}},"output2":[{}]}}"#, fixed_rows.join(","))));
    let collected = read_all_daily(&rig).await;
    assert_eq!(collected.len(), 5, "기간을 무시하는 응답이어도 같은 창을 끝없이 받지 않는다");
    assert!(rig.transport.sent_to(KisApiId::DailyChart).len() <= 3);
}

#[tokio::test(start_paused = true)]
async fn daily_history_reaches_a_stock_listed_before_nineteen_eighty() {
    let base = KstDate::new(1980, 1, 10).unwrap();
    let newer = weekdays_back_from(base, 15);
    let older = weekdays_back_from(KstDate::new(1979, 7, 13).unwrap(), 10);
    let rig = rig(daily_history_of(newer.iter().chain(&older).copied().collect()));
    let source: &dyn MarketSource = rig.market.as_ref();
    let key = samsung_key(Venue::Krx, Period::Day);
    let mut cursor: Option<Cursor> = None;
    let mut count = 0;
    loop {
        let page = source.chart_page(key, base, cursor.take(), Priority::Screen, MergeScope::Shared).await.unwrap();
        count += page.bars.len();
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(count, 25, "1980년 이전 창의 봉도 이어 받는다");
}

fn trade_row(hour: &str, quantity: u32) -> String {
    format!(r#"{{"stck_cntg_hour":"{hour}","stck_pbpr":"71000","askp":"71100","bidp":"71000","cnqn":"{quantity}"}}"#)
}

#[tokio::test(start_paused = true)]
async fn trades_tape_moves_past_a_second_with_more_prints_than_a_page() {
    let mut tape: Vec<(&str, String)> = Vec::new();
    tape.extend((0..2).map(|_| ("093002", trade_row("093002", 1))));
    tape.extend((0..45).map(|_| ("093001", trade_row("093001", 2))));
    tape.extend((0..3).map(|_| ("093000", trade_row("093000", 3))));
    let rig = rig(move |sent| {
        let asked = sent.get("FID_INPUT_HOUR_1");
        let rows: Vec<&str> = tape.iter().filter(|(hour, _)| *hour <= asked).map(|(_, row)| row.as_str()).take(30).collect();
        ok(format!(r#"{{"rt_cd":"0","msg_cd":"MCA00000","output1":{{}},"output2":[{}]}}"#, rows.join(",")))
    });
    let mut cursor: Option<Cursor> = None;
    let mut times = Vec::new();
    let mut skipped = 0;
    loop {
        let page = rig.market.trades_page(code("005930"), Venue::Krx, cursor.take(), Priority::Screen).await.unwrap();
        times.extend(page.rows.iter().map(|print| print.time.clone()));
        skipped += page.skipped;
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
    }
    assert!(times.iter().any(|time| time == "09:30:00"), "한 초에 45건이 있어도 그보다 이른 초의 체결에 닿는다: {times:?}");
    assert_eq!(times.iter().filter(|time| *time == "09:30:00").count(), 3);
    assert_eq!(skipped, 1, "건너뛴 초가 쪽에 남는다");
    let sent = rig.transport.sent_to(KisApiId::TodayTrades);
    let asked: Vec<&str> = sent.iter().map(|s| s.get("FID_INPUT_HOUR_1")).collect();
    for hour in ["200000", "093001", "093000"] {
        assert!(asked.iter().filter(|h| **h == hour).count() <= 2, "같은 쪽을 두 번 넘게 요청하지 않는다: {asked:?}");
    }
    assert!(asked.contains(&"093000"));
}

fn market_lines(market: MasterMarket, codes: &[&str]) -> Vec<Vec<u8>> {
    codes.iter().map(|code| master_line(market, code, "가상 종목", "ST")).collect()
}

#[tokio::test(start_paused = true)]
async fn a_market_file_losing_almost_all_rows_is_refused() {
    let _logs = tracing::subscriber::set_default(tracing_subscriber::fmt().with_writer(std::io::sink).with_max_level(tracing::Level::TRACE).finish());
    let kospi = market_lines(MasterMarket::Kospi, &["005930", "000660", "035420", "051910", "006400", "207940", "068270", "105560", "055550", "012330"]);
    let kosdaq = market_lines(MasterMarket::Kosdaq, &["247540", "086520", "035720", "091990"]);
    let master = FakeMaster::serving(&kospi, &kosdaq);
    let rig = rig_at(friday_evening(), master.clone(), |_| ok("{}"));
    let symbols = SymbolDirectory::default();
    let source: &dyn MarketSource = rig.market.as_ref();
    symbols.refresh(source, Priority::Background).await.unwrap();
    let before = symbols.updates().borrow().clone().unwrap();

    master.set(&kospi, &kosdaq[..1]);
    assert!(symbols.refresh(source, Priority::Background).await.is_err(), "합계는 절반 위여도 코스닥이 전 목록의 절반 아래면 받지 않는다");
    assert!(Arc::ptr_eq(&before, &symbols.updates().borrow().clone().unwrap()));
    assert!(rig.market.list_outage().is_some());

    master.set(&kospi, &kosdaq[..2]);
    symbols.refresh(source, Priority::Background).await.unwrap();
    assert!(!Arc::ptr_eq(&before, &symbols.updates().borrow().clone().unwrap()), "시장별로 절반 이상이면 받는다");
    assert!(rig.market.list_outage().is_none());
}
