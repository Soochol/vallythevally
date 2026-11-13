use super::*;
use super::mapping::tempdir;

pub(super) const STOCK: &str = "005387";
pub(super) const COMMON: &str = "005380";
pub(super) const COMPANY: &str = "00164742";
pub(super) const ENTRY: &str = r#"<dt class="img"><strong class="name"><a>현대자동차</a></strong><span class="subject"><a onclick="openDisclsViewer('20260917000117', '20260917000264');return false;"><b>변경</b><b>상장</b> 주식소각</a></span><em class="date">2026-09-17  16:42</em></dt>"#;
const CONTENTS: &str = r#"<html><head><script>parent.setPath('','https://kind.krx.co.kr/external/2026/09/17/000117/20260917000264/68155.htm','/external/2026/09/17/000117/20260917000264/68155','03','11');</script></head></html>"#;

pub(super) fn search(entries: &str, total: usize) -> String {
    format!("<section class=\"total-search\"><dl>{entries}</dl></section><section class=\"paging-group\"><div class=\"info\"><em>{total}</em></div></section>")
}

fn notice_body() -> String {
    mapping::NOTICE.replace("삼성전자","현대자동차").replace("KR7005930003","KR7005380001").replace("KR7005931001","KR7005382007")
        .replace("A005930","A005380").replace("A005935","A005387").replace("1우선주","2우선주")
}

pub(super) async fn source() -> Fake {
    let fake = Fake::start().await;
    let directory = fake_directory(&fake.state).replace("</result>",&format!("<list><corp_code>{COMPANY}</corp_code><corp_name>현대자동차</corp_name><stock_code>{COMMON}</stock_code></list></result>"));
    {
        let mut state = fake.state.lock().unwrap();
        state.notice = Some(notice_body());
        state.directory = Some(directory);
        state.discovery_search = Some(search(ENTRY,1));
        state.discovery_contents = Some(CONTENTS.into());
        state.kind_responses.insert(COMMON.into(),json!([{"repisusrtcd2":COMMON,"repisusrtcd":"A005380","repisucd":"KR7005380001","secugrpId":"ST","fssunqno":COMPANY,"comabbrv":"현대자동차"}]));
        state.preferred_dividend = true;
    }
    fake
}

#[tokio::test]
async fn discovers_unlisted_preferred_preserves_provenance_and_shares_company_but_not_dps_identity() {
    let fake = source().await;
    let dir = tempdir();
    let store = Store::open(&dir.path().join("financials.db")).await.unwrap();
    let service = Financials::new(Some(fake.client()),store.clone(),clock());
    run_update(&service,&[(COMMON,false),(STOCK,true)]).await;
    let common = service.read(COMMON).await;
    let preferred = service.read(STOCK).await;
    assert_eq!(preferred.state,ReadState::Ready);
    let security = preferred.security.unwrap();
    assert_eq!(security.company.corp_code,COMPANY);
    assert!(security.share_class.is_none());
    assert_eq!(security.share_class_reason.as_deref(),Some("preferred_issue_class_unverified"));
    let evidence: Value = serde_json::from_str(&security.evidence).unwrap();
    for (field, value) in [("stock_code",STOCK),("corp_code",COMPANY),("isin","KR7005382007"),("issue_class","2우선주"),("common_stock_code",COMMON),("common_isin","KR7005380001"),("issuer","현대자동차(주)"),("receipt","20260917000117"),("document","20260917000264")] {
        assert_eq!(evidence[field],value);
    }
    for field in ["search_sha256","contents_sha256","source_sha256"] { assert_eq!(evidence[field].as_str().unwrap().len(),64); }
    assert!(evidence["observed_at"].as_str().unwrap().ends_with("+09:00"));
    assert!(evidence["search_url"].as_str().unwrap().contains("fromData=2015-01-01"));
    assert_eq!(evidence["company_response"]["fssunqno"],COMPANY);
    assert_eq!(serde_json::to_value(common.collection).unwrap(),serde_json::to_value(&preferred.collection).unwrap());
    assert_eq!(fake.count("fnlttSinglAcntAll.json"),4);
    assert_eq!(fake.count("alotMatter.json"),1);
    let dividends = preferred.collection.reports["2015/11011"].dividends.data.as_ref().unwrap();
    assert_eq!(dividends[0].share_class.as_deref(),Some("보통주"));
    assert!(dividends[1].share_class.is_none());
    assert_eq!(dividends[2].share_class.as_deref(),Some("우선주"));
    fake.state.lock().unwrap().discovery_failure = Some(("search".into(),StatusCode::BAD_GATEWAY));
    let restarted = Financials::new(Some(fake.client()),store,clock());
    assert_eq!(settled_stock(&restarted,STOCK,true).await.security.unwrap().evidence,security.evidence);
    assert_eq!(fake.count("search"),1);
    let state = fake.state.lock().unwrap();
    let params = &state.calls.iter().find(|(name,_)| name == "search").unwrap().1;
    assert_eq!(params["kwd"],"005387 변경상장");
    assert_eq!(params["srchFd"],"2");
}

#[tokio::test]
async fn rejects_changed_issuer_codes_classes_duplicates_and_unrelated_text() {
    let fake = source().await;
    let notice = notice_body();
    for changed in [
        notice.replace("현대자동차(주)","다른회사(주)"),
        notice.replace("- 현대자동차2우선주","- 다른회사2우선주"),
        notice.replace("A005387","A005389"),
        notice.replace("2우선주 표준코드","3우선주 표준코드"),
        notice.replace("2우선주","종류불명"),
        notice.replace("기명식 2우선주","기명식 3우선주"),
        notice.replace("KR7005382007","KR7005380001"),
        notice.replace("⑨ 코드","⑨ 코드\n⑨ 코드"),
        notice.replace("</HTML>",&notice[notice.find("<PRE").unwrap()..]),
        notice.replace("▶ 2우선주 표준코드 : KR7005382007 (단축코드:A005387)","▶ 2우선주 표준코드 : KR7005383005 (단축코드:A005389)").replace("③ 1주의 금액","참고 KR7005382007 A005387\n③ 1주의 금액"),
        notice.replace("▶ 업종코드", "▶ 2우선주 표준코드 : KR7005382007 (단축코드:A005387)\n▶ 업종코드"),
    ] {
        fake.state.lock().unwrap().notice = Some(changed);
        assert!(fake.client().resolve(STOCK,true).await.unwrap().is_none());
    }
    assert_eq!(fake.count("company.json"),0);
}

#[tokio::test]
async fn exact_common_company_chain_is_required_and_direct_results_keep_precedence() {
    let fake = source().await;
    let good = fake.state.lock().unwrap().kind_responses[COMMON].clone();
    let mut cases = vec![json!([]),json!([good[0].clone(),good[0].clone()])];
    for (key, value) in [("fssunqno","00000002"),("repisusrtcd2","005385"),("repisusrtcd","A005385"),("repisucd","KR7005382007"),("secugrpId","EF"),("comabbrv","다른회사")] {
        let mut changed = good.clone();
        changed[0][key] = value.into();
        cases.push(changed);
    }
    for changed in cases {
        fake.state.lock().unwrap().kind_responses.insert(COMMON.into(),changed);
        assert!(fake.client().resolve(STOCK,true).await.unwrap().is_none());
    }
    fake.state.lock().unwrap().kind_responses.insert(COMMON.into(),good);
    let directory = fake_directory(&fake.state);
    for changed in [directory.replace(COMPANY,"00000003"),directory.replace("</result>",&format!("<list><corp_code>{COMPANY}</corp_code><stock_code>{COMMON}</stock_code></list></result>"))] {
        fake.state.lock().unwrap().directory = Some(changed);
        assert!(fake.client().resolve(STOCK,true).await.unwrap().is_none());
    }
    fake.state.lock().unwrap().directory = Some(directory);
    fake.state.lock().unwrap().company_code = Some("00000002".into());
    assert_eq!(fake.client().resolve(STOCK,true).await.unwrap_err(),Interrupt::Failure(Failure::InvalidResponse));
    let count = fake.count("search");
    for (code, preferred) in [(STOCK,false),("A005387",true)] {
        assert!(fake.client().resolve(code,preferred).await.unwrap().is_none());
    }
    for rows in [json!([{"repisusrtcd2":COMMON,"secugrpId":"ST","fssunqno":COMPANY}]),json!([{},{}])] {
        fake.state.lock().unwrap().kind_responses.insert(STOCK.into(),rows);
        assert!(fake.client().resolve(STOCK,true).await.unwrap().is_none());
    }
    assert_eq!(fake.count("search"),count);
}

#[tokio::test]
async fn search_and_document_identity_are_unambiguous_and_source_errors_are_retryable() {
    let fake = source().await;
    let newer_unsupported = ENTRY.replace("주식소각","주식병합").replace("20260917000117","20261017000117").replace("20260917000264","20261017000264").replace("2026-09-17","2026-10-17");
    for body in [search(&format!("{ENTRY}{newer_unsupported}"),2),search(&format!("{ENTRY}{ENTRY}"),2),search(&format!("{ENTRY}{}",ENTRY.replace("20260917000264","20260917000265")),2),search(&ENTRY.replace("변경</b><b>상장</b> 주식소각","변경</b><b>상장</b> 알 수 없음"),1)] {
        fake.state.lock().unwrap().discovery_search = Some(body);
        assert!(fake.client().resolve(STOCK,true).await.unwrap().is_none());
    }
    for body in ["".into(),"<html>페이지 오류</html>".into(),search("",1),search(ENTRY,0),search(&ENTRY.replace("20260917000117","bad"),1)] {
        fake.state.lock().unwrap().discovery_search = Some(body);
        assert_eq!(fake.client().resolve(STOCK,true).await.unwrap_err(),Interrupt::Failure(Failure::InvalidResponse));
    }
    fake.state.lock().unwrap().discovery_search = Some(search(ENTRY,1));
    for body in [CONTENTS.replace("20260917000264/68155","20260917000265/68155"),CONTENTS.replace("/000117/","/000118/"),CONTENTS.repeat(2)] {
        fake.state.lock().unwrap().discovery_contents = Some(body);
        assert!(fake.client().resolve(STOCK,true).await.unwrap().is_none());
    }
    for body in [String::new(),CONTENTS.replace("https://kind.krx.co.kr","https://untrusted.invalid")] {
        fake.state.lock().unwrap().discovery_contents = Some(body);
        assert_eq!(fake.client().resolve(STOCK,true).await.unwrap_err(),Interrupt::Failure(Failure::InvalidResponse));
    }
    assert_eq!(fake.count("company.json"),0);
}

#[tokio::test]
async fn first_and_mid_discovery_failures_retry_in_the_next_update_and_preserve_other_companies() {
    for collected in [false,true] {
        for stage in ["search","contents","notice"] {
            for failure in [Failure::Remote,Failure::Network,Failure::InvalidResponse] {
                let fake = source().await;
                let dir = tempdir();
                let store = Store::open(&dir.path().join("financials.db")).await.unwrap();
                let service = Financials::new(Some(fake.client()),store.clone(),clock());
                let previous = if collected { Some(settled_stock(&service,COMMON,false).await.collection) } else { None };
                {
                    let mut state = fake.state.lock().unwrap();
                    if stage == "notice" {
                        match failure {
                            Failure::Remote => state.notice_status = Some(StatusCode::BAD_GATEWAY),
                            Failure::Network => state.notice_network_failure = true,
                            _ => state.notice = Some("<HTML><PRE>일시적인 오류</PRE></HTML>".into()),
                        }
                    } else {
                        match failure {
                            Failure::Remote => state.discovery_failure = Some((stage.into(),StatusCode::BAD_GATEWAY)),
                            Failure::Network => state.discovery_network = Some(stage.into()),
                            _ if stage == "search" => state.discovery_search = Some("페이지 오류".into()),
                            _ => state.discovery_contents = Some("페이지 오류".into()),
                        }
                    }
                }
                let snapshot = settled_stock(&service,STOCK,true).await;
                assert_eq!(snapshot.state,ReadState::Failed);
                assert_eq!(snapshot.failure,Some(failure));
                assert!(store.security(STOCK).await.unwrap().is_none());
                let before = fake.count(stage);
                assert_eq!(before,if failure == Failure::InvalidResponse { 1 } else { 3 });
                assert_eq!(settled_stock(&service,"000001",false).await.state,ReadState::Ready);
                if let Some(previous) = &previous {
                    assert_eq!(serde_json::to_value(store.collection(COMPANY).await.unwrap()).unwrap(),serde_json::to_value(previous).unwrap());
                    assert_eq!(settled_stock(&service,COMMON,false).await.state,ReadState::Ready);
                }
                {
                    let mut state = fake.state.lock().unwrap();
                    state.discovery_failure = None;
                    state.discovery_network = None;
                    state.notice_status = None;
                    state.notice_network_failure = false;
                    state.notice = Some(notice_body());
                    state.discovery_search = Some(search(ENTRY,1));
                    state.discovery_contents = Some(CONTENTS.into());
                }
                let recovered = settled_stock(&service,STOCK,true).await;
                assert_eq!(recovered.state,ReadState::Ready);
                assert_eq!(fake.count(stage),before+1);
                assert_eq!(recovered.security.unwrap().company.corp_code,COMPANY);
            }
        }
    }
}

#[tokio::test]
async fn first_and_mid_discovery_failures_leave_price_requests_usable() {
    let kiwoom = common::ScriptedTransport::new();
    let mut symbols = common::support::fixture("ka10099_0");
    let mut preferred = symbols["list"].as_array().unwrap().iter().find(|row| row["code"] == "005935").unwrap().clone();
    preferred["code"] = STOCK.into();
    preferred["name"] = "현대차2우B".into();
    symbols["list"].as_array_mut().unwrap().push(preferred);
    kiwoom.respond_with("ka10099",200,symbols);
    let client = reqwest::Client::new();
    for collected in [false,true] {
        for stage in ["search","contents"] {
            let fake = source().await;
            let dir = tempdir();
            let server = process(&fake,&kiwoom,dir.path(),"20151231120000");
            let base = format!("http://{}",server.addr().await);
            let price = format!("{base}/api/bars?symbol=005930&period=D&limit=5");
            assert_eq!(client.get(&price).send().await.unwrap().status(),StatusCode::OK);
            let previous = if collected {
                let store = Store::open(&dir.path().join("run/financials.db")).await.unwrap();
                let service = Financials::new(Some(fake.client()), store, clock());
                Some(serde_json::to_value(settled(&service).await.collection).unwrap())
            } else { None };
            fake.state.lock().unwrap().discovery_failure = Some((stage.into(),StatusCode::BAD_GATEWAY));
            http_start(&client, &base).await;
            http_settled(&fake, &client, &base).await;
            let response = client.get(format!("{base}/api/symbols/{STOCK}/financial-source")).send().await.unwrap();
            let snapshot: Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
            assert_eq!(snapshot["status"],"failed");
            assert_eq!(snapshot["failure"],"remote");
            assert_eq!(tokio::time::timeout(Duration::from_secs(1),client.get(&price).send()).await.unwrap().unwrap().status(),StatusCode::OK);
            if let Some(previous) = previous { assert_saved_report_fetches(&http_snapshot(&client,&base).await["collection"], &previous); }
            assert!(!server.stop().await.contains(KEY));
        }
    }
}

#[tokio::test]
async fn stalled_discovery_does_not_hold_saved_company_data_or_update_status() {
    let fake = source().await;
    let dir = tempdir();
    let store = Store::open(&dir.path().join("financials.db")).await.unwrap();
    let service = Financials::new(Some(fake.client()),store,clock());
    let previous = settled_stock(&service,COMMON,false).await.collection;
    fake.state.lock().unwrap().discovery_paused = Some("search".into());
    service.start_update(vec![symbol(STOCK,true)]).await;
    fake.wait_for_call("search", 1).await;
    let saved = tokio::time::timeout(Duration::from_secs(1),service.read(COMMON)).await.unwrap();
    assert_eq!(serde_json::to_value(saved.collection).unwrap(),serde_json::to_value(previous).unwrap());
    let status = tokio::time::timeout(Duration::from_secs(1),service.update_status()).await.unwrap();
    assert_eq!(status.status,FinancialUpdateStatus::Planning);
}

#[tokio::test]
async fn selects_latest_notice_and_explicitly_identifies_multiple_preferred_classes() {
    let fake = source().await;
    let notice = notice_body()
        .replace("- 현대자동차2우선주","- 현대자동차1우선주\n   - 현대자동차2우선주(신형)\n   - 현대자동차3우선주(신형)")
        .replace("▶ 기명식 2우선주 20주 → 18주","▶ 기명식 1우선주 : 30주 → 27주\n   ▶ 기명식 2우선주 20주 → 18주\n   ▶ 기명식 3우선주 : 10주 → 9주")
        .replace("   ▶ 업종코드 : 03-26-04\n","")
        .replace("▶ 2우선주 표준코드", "▶ 1우선주 표준코드 : KR7005381009 (단축코드:A005385)\n   ▶ 2우선주 표준코드")
        .replace("</PRE>","   ▶ 3우선주 표준코드 : KR7005383005 (단축코드:A005389)\n   ▶ 업종코드 : 03-30-01\n</PRE>");
    let earlier = ENTRY.replace("20260917000117","20250917000117").replace("20260917000264","20250917000264").replace("2026-09-17","2025-09-17");
    {
        let mut state = fake.state.lock().unwrap();
        state.notice = Some(notice);
        state.discovery_search = Some(search(&format!("{earlier}{ENTRY}"),2));
    }
    for (stock, class) in [("005385","1우선주"),(STOCK,"2우선주"),("005389","3우선주")] {
        let security = fake.client().resolve(stock,true).await.unwrap().unwrap();
        let evidence: Value = serde_json::from_str(&security.evidence).unwrap();
        assert_eq!(evidence["issue_class"],class);
        assert_eq!(evidence["stock_code"],stock);
        assert!(security.share_class.is_none());
    }
    assert!(fake.state.lock().unwrap().calls.iter().filter(|(name,_)| name == "contents").all(|(_,params)| params["docNo"] == "20260917000264"));
    assert!(fake.client().resolve("00538K",true).await.unwrap().is_none());
}
