use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use collector::kst::KstTime;
use collector::universe::{
    Entry, Morning, ReplaceReason, StockKind, UniverseError, UniverseFile, Written, collect_after_close, collect_morning, read_universe,
};
use domain::KstDate;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};
use server::symbols::MAX_LIST_PAGES;

type Pages = Vec<Vec<Value>>;

#[derive(Clone)]
enum Kiwoom {
    Listing { kospi: Pages, kosdaq: Pages },
    Failing,
    NeverEnding,
}

struct FakeKiwoom(Kiwoom);

impl Transport for FakeKiwoom {
    fn send(&self, request: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let reply = if request.api_id.as_str() == "au10001" {
            ok(json!({"token": "tok", "expires_dt": "20991231000000", "return_code": 0, "return_msg": "정상"}), None)
        } else {
            assert_eq!(request.api_id.as_str(), "ka10099");
            let market: Value = serde_json::from_str(request.body.expose()).unwrap();
            let page_number: usize = request.cont.as_ref().map_or(0, |cont| cont.as_str().parse().unwrap());
            self.listing_page(market["mrkt_tp"].as_str().unwrap(), page_number)
        };
        Box::pin(async move { reply })
    }
}

impl FakeKiwoom {
    fn listing_page(&self, market: &str, page_number: usize) -> Result<HttpResponse, TransportError> {
        let pages = match (&self.0, market) {
            (Kiwoom::Failing, _) => return Err(TransportError::refused()),
            (Kiwoom::NeverEnding, _) => return ok(json!({"list": [], "return_code": 0, "return_msg": "정상"}), Some(&(page_number + 1).to_string())),
            (Kiwoom::Listing { kospi, .. }, "0") => kospi,
            (Kiwoom::Listing { kosdaq, .. }, "10") => kosdaq,
            (_, other) => panic!("모르는 mrkt_tp {other}"),
        };
        let next = (page_number + 1 < pages.len()).then(|| (page_number + 1).to_string());
        ok(json!({"list": pages[page_number], "return_code": 0, "return_msg": "정상"}), next.as_deref())
    }
}

fn ok(body: Value, next_key: Option<&str>) -> Result<HttpResponse, TransportError> {
    Ok(HttpResponse { status: 200, next_key: next_key.map(str::to_owned), body: body.to_string() })
}

fn rest(kiwoom: Kiwoom) -> KiwoomRest {
    let clock = Clock::fake(kst(KstDate::new(2026, 11, 18).unwrap(), 7, 20, 0));
    let auth = KiwoomAuth::new(Secret::new("key".into()), Secret::new("secret".into()), None);
    KiwoomRest::with_send_spacing(Arc::new(FakeKiwoom(kiwoom)), auth, clock, Duration::ZERO)
}

fn row(code: &str, name: &str, market_code: &str, audit_info: &str) -> Value {
    json!({"code": code, "name": name, "marketCode": market_code, "companyClassName": "", "nxtEnable": "N", "regDay": "20000101", "auditInfo": audit_info, "listCount": "100"})
}

fn plain(code: &str, name: &str) -> Value {
    row(code, name, "0", "정상")
}

fn fillers(count: usize) -> Vec<Value> {
    (0..count).map(|index| plain(&format!("1{index:04}0"), &format!("가상{index}"))).collect()
}

fn listing(kospi: Vec<Value>) -> Kiwoom {
    Kiwoom::Listing { kospi: kospi.chunks(40).map(<[Value]>::to_vec).collect(), kosdaq: vec![Vec::new()] }
}

fn at(date: u32) -> KstTime {
    KstTime { date, ms_of_day: (7 * 60 + 20) * 60 * 1000 }
}

async fn morning_outcome(data: &Path, date: u32, kiwoom: Kiwoom) -> Result<Morning, UniverseError> {
    collect_morning(&rest(kiwoom), data, date, at(date)).await
}

async fn morning(data: &Path, date: u32, kiwoom: Kiwoom) -> Result<UniverseFile, UniverseError> {
    morning_outcome(data, date, kiwoom).await.map(|outcome| outcome.file)
}

fn entry<'a>(file: &'a UniverseFile, code: &str) -> &'a Entry {
    file.stocks.iter().find(|entry| entry.code == code).unwrap_or_else(|| panic!("{code}가 목록에 없다"))
}

fn codes(file: &UniverseFile) -> Vec<&str> {
    file.stocks.iter().map(|entry| entry.code.as_str()).collect()
}

fn universe_files(data: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(data.join("universe")).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
    names.sort();
    names
}

#[tokio::test(start_paused = true)]
async fn common_preferred_and_spac_stay_while_etf_reit_etn_and_unknown_market_codes_go() {
    let data = tempfile::tempdir().unwrap();
    let kiwoom = Kiwoom::Listing {
        kospi: vec![
            vec![plain("005930", "삼성전자"), plain("005935", "삼성전자우"), row("0000D0", "ETF종목", "8", "정상")],
            vec![row("0030R0", "리츠종목", "6", "정상"), row("088980", "ETN종목", "60", "정상"), row("123450", "모르는종목", "77", "정상")],
            vec![row("000150", "두산", "0", "관리종목"), row("000250", "투자경고주", "0", "투자경고|단기과열"), row("000350", "정지주", "0", "거래정지")],
        ],
        kosdaq: vec![vec![row("247540", "에코프로비엠", "10", "정상"), row("12345K", "가나스팩", "10", "정상")], vec![row("03481K", "코스닥우선", "10", "정상")]],
    };
    let file = morning(data.path(), 20261118, kiwoom).await.unwrap();

    assert_eq!(codes(&file), ["000150", "000250", "000350", "005930", "005935", "03481K", "12345K", "247540"]);
    assert_eq!(entry(&file, "005930").kind, StockKind::Common);
    assert_eq!(entry(&file, "005935").kind, StockKind::Preferred);
    assert_eq!(entry(&file, "03481K").kind, StockKind::Preferred);
    assert_eq!(entry(&file, "12345K").kind, StockKind::Spac);
    assert_eq!(file.warnings.len(), 1);
    assert!(file.warnings[0].contains("77") && file.warnings[0].contains("123450"), "{:?}", file.warnings);

    assert!(!entry(&file, "000350").registered);
    assert_eq!(entry(&file, "000350").status, ["거래정지"]);
    for registered in ["000150", "000250"] {
        assert!(entry(&file, registered).registered, "{registered}");
    }
    assert_eq!(entry(&file, "000250").status, ["투자경고", "단기과열"]);
    let registrable: Vec<&str> = file.registrable().map(|entry| entry.code.as_str()).collect();
    assert_eq!(registrable, ["000150", "000250", "005930", "005935", "03481K", "12345K", "247540"]);

    assert!(file.replaced.is_none());
    assert_eq!(read_universe(data.path(), 20261118).unwrap(), file);
    assert_eq!(universe_files(data.path()), ["20261118.json"]);
}

#[tokio::test(start_paused = true)]
async fn the_file_names_all_five_kinds_of_change_against_the_previous_list() {
    let data = tempfile::tempdir().unwrap();
    let mut yesterday = fillers(100);
    yesterday.extend([plain("200010", "곧폐지"), plain("200020", "옛이름"), plain("200030", "정지될주"), row("200040", "풀릴주", "0", "거래정지")]);
    morning(data.path(), 20261117, listing(yesterday)).await.unwrap();

    let mut today = fillers(100);
    today.extend([plain("300010", "신규상장"), plain("200020", "새이름"), row("200030", "정지될주", "0", "거래정지"), plain("200040", "풀릴주")]);
    let file = morning(data.path(), 20261118, listing(today)).await.unwrap();

    assert!(file.replaced.is_none());
    let pairs = |named: &[collector::universe::Named]| named.iter().map(|n| (n.code.clone(), n.name.clone())).collect::<Vec<_>>();
    assert_eq!(pairs(&file.diff.added), [("300010".to_owned(), "신규상장".to_owned())]);
    assert_eq!(pairs(&file.diff.removed), [("200010".to_owned(), "곧폐지".to_owned())]);
    assert_eq!(file.diff.renamed.len(), 1);
    let renamed = &file.diff.renamed[0];
    assert_eq!((renamed.code.as_str(), renamed.from.as_str(), renamed.to.as_str()), ("200020", "옛이름", "새이름"));
    assert_eq!(pairs(&file.diff.halt_started), [("200030".to_owned(), "정지될주".to_owned())]);
    assert_eq!(pairs(&file.diff.halt_lifted), [("200040".to_owned(), "풀릴주".to_owned())]);
    assert_eq!(read_universe(data.path(), 20261118).unwrap().diff, file.diff);
}

#[tokio::test(start_paused = true)]
async fn a_list_that_shrank_more_than_three_percent_is_replaced_by_the_latest_list() {
    let data = tempfile::tempdir().unwrap();
    let yesterday = morning(data.path(), 20261117, listing(fillers(100))).await.unwrap();

    let file = morning(data.path(), 20261118, listing(fillers(96))).await.unwrap();

    let replaced = file.replaced.as_ref().expect("대체됨");
    assert_eq!((replaced.reason, replaced.source_date), (ReplaceReason::Shrunk, 20261117));
    assert!(replaced.detail.contains("100") && replaced.detail.contains("96"), "{}", replaced.detail);
    assert_eq!(file.stocks, yesterday.stocks);
    assert_eq!(read_universe(data.path(), 20261118).unwrap(), file);
    let rejected: Value = serde_json::from_slice(&std::fs::read(data.path().join("universe/20261118.rejected.json")).unwrap()).unwrap();
    assert_eq!(rejected["reason"], "shrunk");
    assert_eq!(rejected["stocks"].as_array().unwrap().len(), 96);
    assert_eq!(rejected["previous_count"], 100);
}

#[tokio::test(start_paused = true)]
async fn a_list_that_shrank_exactly_three_percent_is_kept() {
    let data = tempfile::tempdir().unwrap();
    morning(data.path(), 20261117, listing(fillers(100))).await.unwrap();

    let file = morning(data.path(), 20261118, listing(fillers(97))).await.unwrap();

    assert!(file.replaced.is_none());
    assert_eq!(file.stocks.len(), 97);
    assert_eq!(file.diff.removed.len(), 3);
    assert_eq!(universe_files(data.path()), ["20261117.json", "20261118.json"]);
}

#[tokio::test(start_paused = true)]
async fn a_failed_fetch_is_replaced_by_the_latest_list_and_a_first_day_failure_is_an_error() {
    let data = tempfile::tempdir().unwrap();
    let first_day = morning(data.path(), 20261117, Kiwoom::Failing).await;
    let Err(UniverseError::NoFallback { reason, .. }) = first_day else { panic!("{first_day:?}") };
    assert_eq!(reason, ReplaceReason::FetchFailed);
    assert_eq!(universe_files(data.path()), ["20261117.rejected.json"]);

    let yesterday = morning(data.path(), 20261116, listing(fillers(100))).await.unwrap();
    let file = morning(data.path(), 20261118, Kiwoom::Failing).await.unwrap();

    let replaced = file.replaced.as_ref().unwrap();
    assert_eq!((replaced.reason, replaced.source_date), (ReplaceReason::FetchFailed, 20261116));
    assert_eq!(file.stocks, yesterday.stocks);
    assert!(universe_files(data.path()).contains(&"20261118.rejected.json".to_owned()));
}

#[tokio::test(start_paused = true)]
async fn a_list_cut_off_at_the_page_limit_is_replaced_by_the_latest_list() {
    let data = tempfile::tempdir().unwrap();
    let yesterday = morning(data.path(), 20261117, listing(fillers(100))).await.unwrap();

    let endless: Pages = (0..MAX_LIST_PAGES + 5).map(|_| fillers(40)).collect();
    let file = morning(data.path(), 20261118, Kiwoom::Listing { kospi: endless, kosdaq: vec![Vec::new()] }).await.unwrap();

    let replaced = file.replaced.as_ref().unwrap();
    assert_eq!(replaced.reason, ReplaceReason::CutOff);
    assert_eq!(file.stocks, yesterday.stocks);
    let rejected: Value = serde_json::from_slice(&std::fs::read(data.path().join("universe/20261118.rejected.json")).unwrap()).unwrap();
    assert_eq!(rejected["reason"], "cut_off");

    let never_ending = morning(data.path(), 20261119, Kiwoom::NeverEnding).await.unwrap();
    assert_eq!(never_ending.replaced.unwrap().reason, ReplaceReason::CutOff);
}

#[tokio::test(start_paused = true)]
async fn the_after_close_list_leaves_only_a_diff_and_never_touches_the_day_file() {
    let data = tempfile::tempdir().unwrap();
    let mut morning_rows = fillers(100);
    morning_rows.push(plain("200010", "오전종목"));
    let day_file = morning(data.path(), 20261118, listing(morning_rows)).await.unwrap();
    let day_bytes = std::fs::read(data.path().join("universe/20261118.json")).unwrap();

    let mut evening_rows = fillers(100);
    evening_rows.push(plain("300010", "오후신규"));
    let after = collect_after_close(&rest(listing(evening_rows)), data.path(), 20261118, KstTime { date: 20261118, ms_of_day: (20 * 60 + 10) * 60 * 1000 }).await.unwrap();

    assert_eq!((after.morning_count, after.after_close_count), (day_file.stocks.len(), 101));
    assert_eq!(after.diff.added[0].code, "300010");
    assert_eq!(after.diff.removed[0].code, "200010");
    assert_eq!(std::fs::read(data.path().join("universe/20261118.json")).unwrap(), day_bytes);
    assert_eq!(universe_files(data.path()), ["20261118.after.json", "20261118.json"]);
    let written: Value = serde_json::from_slice(&std::fs::read(data.path().join("universe/20261118.after.json")).unwrap()).unwrap();
    assert_eq!(written["diff"]["added"][0]["code"], "300010");
    assert_eq!(written["fetched_at"], "2026-11-18T20:10:00+09:00");

    let failed = collect_after_close(&rest(Kiwoom::Failing), data.path(), 20261118, at(20261118)).await;
    assert!(matches!(failed, Err(UniverseError::AfterCloseFetch { .. })), "{failed:?}");
    assert_eq!(std::fs::read(data.path().join("universe/20261118.json")).unwrap(), day_bytes);
}

#[tokio::test(start_paused = true)]
async fn the_after_close_list_needs_the_morning_list() {
    let data = tempfile::tempdir().unwrap();
    let result = collect_after_close(&rest(listing(fillers(5))), data.path(), 20261118, at(20261118)).await;
    assert!(matches!(result, Err(UniverseError::NoMorningList { date: 20261118, .. })), "{result:?}");
}

fn with_new_stock(count: usize) -> Kiwoom {
    let mut rows = fillers(count);
    rows.push(plain("300010", "신규상장"));
    listing(rows)
}

#[tokio::test(start_paused = true)]
async fn same_day_rerun_with_failure_keeps_the_good_list() {
    let data = tempfile::tempdir().unwrap();
    morning(data.path(), 20261117, listing(fillers(100))).await.unwrap();
    let good = morning(data.path(), 20261118, with_new_stock(100)).await.unwrap();
    let good_bytes = std::fs::read(data.path().join("universe/20261118.json")).unwrap();

    let rerun = morning_outcome(data.path(), 20261118, Kiwoom::Failing).await.unwrap();

    assert!(matches!(rerun.written, Written::LeftAsIs { reason: ReplaceReason::FetchFailed, .. }), "{:?}", rerun.written);
    assert_eq!(rerun.file, good);
    assert!(codes(&read_universe(data.path(), 20261118).unwrap()).contains(&"300010"));
    assert_eq!(std::fs::read(data.path().join("universe/20261118.json")).unwrap(), good_bytes);
    assert!(universe_files(data.path()).contains(&"20261118.rejected.json".to_owned()));
}

#[tokio::test(start_paused = true)]
async fn same_day_rerun_rejected_by_check_keeps_the_good_list() {
    let data = tempfile::tempdir().unwrap();
    morning(data.path(), 20261117, listing(fillers(100))).await.unwrap();
    let good = morning(data.path(), 20261118, with_new_stock(100)).await.unwrap();

    let rerun = morning_outcome(data.path(), 20261118, listing(fillers(90))).await.unwrap();

    assert!(matches!(rerun.written, Written::LeftAsIs { reason: ReplaceReason::Shrunk, .. }), "{:?}", rerun.written);
    assert_eq!(read_universe(data.path(), 20261118).unwrap(), good);
    assert!(good.replaced.is_none());
}

#[tokio::test(start_paused = true)]
async fn unreadable_latest_file_is_skipped_for_an_older_one() {
    let data = tempfile::tempdir().unwrap();
    let oldest = morning(data.path(), 20261116, listing(fillers(100))).await.unwrap();
    morning(data.path(), 20261117, listing(fillers(100))).await.unwrap();
    let broken = data.path().join("universe/20261117.json");
    std::fs::write(&broken, "{not json").unwrap();

    let first = morning_outcome(data.path(), 20261118, with_new_stock(100)).await.unwrap();
    let second = morning_outcome(data.path(), 20261119, listing(fillers(100))).await.unwrap();

    assert!(matches!(first.written, Written::NewList));
    assert_eq!(first.skipped.len(), 1);
    assert_eq!(first.skipped[0].date, 20261117);
    assert!(first.skipped[0].cause.contains("20261117.json"), "{}", first.skipped[0].cause);
    assert_eq!(first.file.diff.added[0].code, "300010");
    assert_eq!(first.file.diff.removed.len(), 0);
    assert!(second.skipped.is_empty(), "{:?}", second.skipped);
    assert_eq!(second.file.diff.added.len(), 0);
    assert_eq!(read_universe(data.path(), 20261118).unwrap(), first.file);
    assert_eq!(read_universe(data.path(), 20261119).unwrap(), second.file);
    assert_eq!(std::fs::read(&broken).unwrap(), b"{not json");
    assert_eq!(oldest.stocks.len(), 100);
}

#[tokio::test(start_paused = true)]
async fn unreadable_latest_file_sets_the_shrink_baseline_to_the_older_one() {
    let data = tempfile::tempdir().unwrap();
    morning(data.path(), 20261116, listing(fillers(100))).await.unwrap();
    morning(data.path(), 20261117, listing(fillers(100))).await.unwrap();
    std::fs::write(data.path().join("universe/20261117.json"), "{not json").unwrap();

    let outcome = morning_outcome(data.path(), 20261118, listing(fillers(96))).await.unwrap();

    let Written::ReplacementList = outcome.written else { panic!("{:?}", outcome.written) };
    assert_eq!(outcome.file.replaced.unwrap().source_date, 20261116);
    assert_eq!(outcome.skipped.len(), 1);
}

#[tokio::test(start_paused = true)]
async fn good_rerun_removes_that_days_rejected_file() {
    let data = tempfile::tempdir().unwrap();
    morning(data.path(), 20261117, listing(fillers(100))).await.unwrap();
    morning(data.path(), 20261118, Kiwoom::Failing).await.unwrap();
    assert!(universe_files(data.path()).contains(&"20261118.rejected.json".to_owned()));

    let rerun = morning_outcome(data.path(), 20261118, with_new_stock(100)).await.unwrap();

    assert!(matches!(rerun.written, Written::NewList));
    assert!(rerun.warnings.is_empty());
    assert_eq!(universe_files(data.path()), ["20261117.json", "20261118.json"]);
}

#[tokio::test(start_paused = true)]
async fn a_rejected_file_that_cannot_be_removed_is_a_warning_not_an_error() {
    let data = tempfile::tempdir().unwrap();
    morning(data.path(), 20261117, listing(fillers(100))).await.unwrap();
    std::fs::create_dir(data.path().join("universe/20261118.rejected.json")).unwrap();

    let outcome = morning_outcome(data.path(), 20261118, with_new_stock(100)).await.unwrap();

    assert!(matches!(outcome.written, Written::NewList));
    assert_eq!(outcome.warnings.len(), 1);
    assert!(outcome.warnings[0].contains("rejected.json"), "{:?}", outcome.warnings);
    assert_eq!(read_universe(data.path(), 20261118).unwrap(), outcome.file);
}

async fn broken_today_lists() -> [(&'static str, Vec<u8>); 2] {
    let data = tempfile::tempdir().unwrap();
    morning(data.path(), 20261118, listing(fillers(100))).await.unwrap();
    let text = std::fs::read_to_string(data.path().join("universe/20261118.json")).unwrap();
    let other_version = text.replace("\"format_version\": 1", "\"format_version\": 2").into_bytes();
    [("깨진 JSON", b"{not json".to_vec()), ("다른 형식 버전", other_version)]
}

#[tokio::test(start_paused = true)]
async fn an_unreadable_today_list_is_moved_aside_and_the_day_goes_on_with_the_previous_list() {
    for (label, bytes) in broken_today_lists().await {
        for failing in [Kiwoom::Failing, listing(fillers(90))] {
            let data = tempfile::tempdir().unwrap();
            let yesterday = morning(data.path(), 20261117, listing(fillers(100))).await.unwrap();
            std::fs::write(data.path().join("universe/20261118.json"), &bytes).unwrap();

            let outcome = morning_outcome(data.path(), 20261118, failing).await.unwrap();

            assert!(matches!(outcome.written, Written::ReplacementList), "{label}: {:?}", outcome.written);
            assert_eq!(outcome.file.stocks, yesterday.stocks, "{label}");
            assert_eq!(outcome.file.replaced.as_ref().unwrap().source_date, 20261117, "{label}");
            let moved = outcome.moved_aside.as_ref().unwrap_or_else(|| panic!("{label}: 옮긴 파일이 결과에 없다"));
            let name = moved.path.file_name().unwrap().to_str().unwrap();
            assert!(name.starts_with("20261118.unreadable-") && name.ends_with(".json"), "{label}: {name}");
            assert_eq!(std::fs::read(&moved.path).unwrap(), bytes, "{label}: 깨진 파일은 내용 그대로 옆에 남는다");
            assert_eq!(outcome.skipped.iter().map(|file| file.date).collect::<Vec<_>>(), [20261118], "{label}");
            assert_eq!(read_universe(data.path(), 20261118).unwrap(), outcome.file, "{label}");
            assert!(universe_files(data.path()).contains(&"20261118.rejected.json".to_owned()), "{label}");

            let again = morning_outcome(data.path(), 20261118, Kiwoom::Failing).await.unwrap();
            assert!(matches!(again.written, Written::LeftAsIs { .. }) && again.moved_aside.is_none(), "{label}: 대체한 뒤 다시 돌려도 옮길 것이 없다");
        }
    }
}

#[tokio::test(start_paused = true)]
async fn an_unreadable_today_list_without_any_previous_list_still_fails() {
    for (label, bytes) in broken_today_lists().await {
        let data = tempfile::tempdir().unwrap();
        let today = data.path().join("universe/20261118.json");
        std::fs::create_dir_all(today.parent().unwrap()).unwrap();
        std::fs::write(&today, &bytes).unwrap();

        let failed = morning_outcome(data.path(), 20261118, Kiwoom::Failing).await;

        let Err(UniverseError::TodayListUnreadable { date, reason, .. }) = &failed else { panic!("{label}: {failed:?}") };
        assert_eq!((*date, *reason), (20261118, ReplaceReason::FetchFailed), "{label}");
        assert!(failed.unwrap_err().to_string().contains("20261118.json"), "{label}");
        assert_eq!(std::fs::read(&today).unwrap(), bytes, "{label}: 옮기지도 지우지도 않는다");
        assert_eq!(universe_files(data.path()), ["20261118.json", "20261118.rejected.json"], "{label}");

        let repaired = morning_outcome(data.path(), 20261118, listing(fillers(100))).await.unwrap();
        assert!(matches!(repaired.written, Written::NewList) && repaired.moved_aside.is_none(), "{label}: 정상 조회는 깨진 파일을 새 목록으로 바꾼다");
        assert_eq!(read_universe(data.path(), 20261118).unwrap(), repaired.file, "{label}");
    }
}

#[tokio::test(start_paused = true)]
async fn the_no_fallback_error_names_the_files_that_were_skipped() {
    let data = tempfile::tempdir().unwrap();
    morning(data.path(), 20261117, listing(fillers(100))).await.unwrap();
    std::fs::write(data.path().join("universe/20261117.json"), "{not json").unwrap();

    let failed = morning_outcome(data.path(), 20261118, Kiwoom::Failing).await.unwrap_err();

    let UniverseError::NoFallback { reason, skipped, .. } = &failed else { panic!("{failed:?}") };
    assert_eq!(*reason, ReplaceReason::FetchFailed);
    assert_eq!(skipped.len(), 1);
    assert_eq!(skipped[0].date, 20261117);
    assert!(skipped[0].cause.contains("20261117.json"), "{}", skipped[0].cause);
    assert!(failed.to_string().contains("20261117.json"), "{failed}");
}

#[tokio::test(start_paused = true)]
async fn a_rejected_file_that_cannot_be_written_is_a_warning_and_the_outcome_still_comes() {
    let data = tempfile::tempdir().unwrap();
    let yesterday = morning(data.path(), 20261117, listing(fillers(100))).await.unwrap();
    std::fs::create_dir(data.path().join("universe/20261118.rejected.json")).unwrap();

    let outcome = morning_outcome(data.path(), 20261118, Kiwoom::Failing).await.unwrap();

    assert!(matches!(outcome.written, Written::ReplacementList), "{:?}", outcome.written);
    assert_eq!(outcome.file.stocks, yesterday.stocks);
    assert_eq!(outcome.warnings.len(), 1);
    assert!(outcome.warnings[0].contains("rejected.json"), "{:?}", outcome.warnings);
    assert_eq!(read_universe(data.path(), 20261118).unwrap(), outcome.file);
}
