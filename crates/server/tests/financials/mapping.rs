use super::*;

pub(super) const NOTICE: &str = r#"<HTML><HEAD><meta charset="UTF-8"/></HEAD><PRE CLASS="fontA">
◎ 삼성전자(주) 변경상장(주식소각)
① 상장종목
   - 삼성전자보통주
   - 삼성전자1우선주
② 주식의 종류와 수(변경전 → 변경후)
   ▶ 기명식 보통주 100주 → 90주
   ▶ 기명식 1우선주 20주 → 18주
③ 1주의 금액 : 100원
④ 발행일(소각일) : 2026년04월02일
⑤ 배당기산일 : 2026년01월01일
⑥ 결산일 : 12월 말일
⑦ 변경상장일 : 2026년04월14일
⑧ 변경사유 : 주식소각
⑨ 코드
   ▶ 업종코드 : 03-26-04
   ▶ 보통주 표준코드 : KR7005930003 (단축코드:A005930)
   ▶ 1우선주 표준코드 : KR7005931001 (단축코드:A005935)
</PRE></HTML>"#;

fn common_rows() -> Value {
    json!([{"repisusrtcd2":"005930","repisusrtcd":"A005930","repisucd":"KR7005930003","secugrpId":"ST","fssunqno":CORP}])
}

async fn verified_source() -> Fake {
    let fake = Fake::start().await;
    {
        let mut state = fake.state.lock().unwrap();
        state.notice = Some(NOTICE.into());
        state.kind_responses.insert("005930".into(),common_rows());
        state.preferred_dividend = true;
    }
    fake
}

pub(super) fn tempdir() -> tempfile::TempDir {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp");
    std::fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}

pub(super) async fn settled_stock(service: &Arc<Financials>, stock: &str, preferred: bool) -> server::financials::model::Snapshot {
    for _ in 0..300 {
        let snapshot = service.open(stock,preferred,false).await;
        if snapshot.status != "collecting" { return snapshot; }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("collection did not settle for {stock}");
}

#[tokio::test]
async fn explicit_listing_notice_shares_company_collection_and_preserves_separate_dps_identity() {
    let fake = verified_source().await;
    let dir = tempdir();
    let store = Store::open(&dir.path().join("financials.db")).await.unwrap();
    let service = Financials::new(Some(fake.client()),store.clone(),clock());
    let (common, preferred) = tokio::join!(service.open("005930",false,false),service.open("005935",true,false));
    let common = common.security.unwrap();
    let preferred = preferred.security.unwrap();
    assert_eq!(common.company.corp_code,preferred.company.corp_code);
    assert_eq!(preferred.stock_code,"005935");
    assert_eq!(common.share_class.as_deref(),Some("보통주"));
    assert!(preferred.share_class.is_none());
    assert_eq!(preferred.share_class_reason.as_deref(),Some("preferred_issue_class_unverified"));
    let evidence: Value = serde_json::from_str(&preferred.evidence).unwrap();
    assert_eq!(evidence["corp_code"],CORP);
    assert_eq!(evidence["stock_code"],"005935");
    assert_eq!(evidence["isin"],"KR7005931001");
    assert_eq!(evidence["issue_class"],"1우선주");
    assert_eq!(evidence["common_stock_code"],"005930");
    assert_eq!(evidence["common_isin"],"KR7005930003");
    assert_eq!(evidence["observed_at"],"2026-11-11T14:01:58Z");
    assert!(evidence["source_url"].as_str().unwrap().ends_with("/20260409000536/68155.htm"));
    let common = settled(&service).await;
    let preferred = settled_stock(&service,"005935",true).await;
    assert_eq!(common.status,"ready");
    assert_eq!(preferred.status,"ready");
    assert_eq!(serde_json::to_value(&common.collection).unwrap(),serde_json::to_value(&preferred.collection).unwrap());
    assert_eq!(fake.count("fnlttSinglAcntAll.json"),4);
    assert_eq!(fake.count("alotMatter.json"),1);
    let dividends = preferred.collection.reports["2015/11011"].dividends.data.as_ref().unwrap();
    assert_eq!(dividends[0].share_class.as_deref(),Some("보통주"));
    assert_eq!(dividends[0].fields["thstrm"],"0");
    assert!(dividends[1].share_class.is_none());
    assert!(dividends[1].share_class_reason.is_some());
    assert_eq!(dividends[2].share_class.as_deref(),Some("우선주"));
    assert_eq!(dividends[2].fields["thstrm"],"7");
    fake.state.lock().unwrap().notice_status = Some(StatusCode::NOT_FOUND);
    let before = fake.count("notice");
    let restarted = Financials::new(Some(fake.client()),store,clock());
    let saved = restarted.open("005935",true,false).await;
    assert_eq!(saved.status,"ready");
    assert_eq!(saved.security.unwrap().evidence,preferred.security.unwrap().evidence);
    assert_eq!(fake.count("notice"),before);
}

#[tokio::test]
async fn listing_notice_requires_one_issuer_and_exact_class_code_pairs_in_the_code_section() {
    let fake = verified_source().await;
    for text in [
        NOTICE.replace("삼성전자(주)","다른회사(주)"),
        NOTICE.replace("- 삼성전자1우선주","- 다른회사1우선주"),
        NOTICE.replace("A005935","A005939"),
        NOTICE.replace("KR7005931001","KR7005932009"),
        NOTICE.replace("▶ 1우선주 표준코드","▶ 2우선주 표준코드"),
        NOTICE.replace("▶ 보통주 표준코드","▶ 우선주 표준코드"),
        NOTICE.replace("</HTML>",&NOTICE[NOTICE.find("<PRE").unwrap()..]),
        NOTICE.replace("</HTML>",&NOTICE[NOTICE.find("<PRE").unwrap()..].replace("삼성전자(주)","다른회사(주)")),
        NOTICE.replace("⑨ 코드","⑨ 코드\n⑨ 코드"),
        NOTICE.replace("(단축코드:A005935)","(단축코드:A005935)\n▶ 1우선주 표준코드 : KR7005931001 (단축코드:A005935)"),
        NOTICE.replace("▶ 1우선주 표준코드 : KR7005931001 (단축코드:A005935)","▶ 1우선주 표준코드 : KR7005932009 (단축코드:A005939)").replace("③ 1주의 금액", "참고: KR7005931001 (단축코드:A005935)\n③ 1주의 금액"),
    ] {
        fake.state.lock().unwrap().notice = Some(text);
        assert!(fake.client().resolve("005935",true).await.unwrap().is_none());
    }
    assert_eq!(fake.count("company.json"),0);
}

#[tokio::test]
async fn notice_link_rejects_empty_duplicate_different_company_code_isin_and_unknown_kind() {
    let fake = verified_source().await;
    let good = common_rows();
    let mut cases = vec![json!([]),json!([good[0].clone(),good[0].clone()])];
    for (field, value) in [("repisusrtcd2","005939"),("repisusrtcd","A005939"),("repisucd","KR7005931001"),("fssunqno","00000002"),("secugrpId","EF"),("secugrpId","")] {
        let mut changed = good.clone();
        changed[0][field] = value.into();
        cases.push(changed);
    }
    for rows in cases {
        fake.state.lock().unwrap().kind_responses.insert("005930".into(),rows);
        assert!(fake.client().resolve("005935",true).await.unwrap().is_none());
    }
    fake.state.lock().unwrap().kind_responses.insert("005930".into(),good);
    let directory = fake_directory(&fake.state);
    for changed in [directory.replace(CORP,"00000003"),directory.replace("</result>",&format!("<list><corp_code>{CORP}</corp_code><stock_code>005930</stock_code></list></result>"))] {
        fake.state.lock().unwrap().directory = Some(changed);
        assert!(fake.client().resolve("005935",true).await.unwrap().is_none());
    }
    fake.state.lock().unwrap().directory = None;
    fake.state.lock().unwrap().company_code = Some("00000002".into());
    assert_eq!(fake.client().resolve("005935",true).await.unwrap_err(),Failure::InvalidResponse);
}

#[tokio::test]
async fn exact_input_and_product_kind_are_required_and_direct_duplicates_cannot_fall_back() {
    let fake = verified_source().await;
    for (code, preferred) in [("005939",true),("005935",false),("A005935",true)] {
        assert!(fake.client().resolve(code,preferred).await.unwrap().is_none());
    }
    assert_eq!(fake.count("notice"),0);
    for rows in [common_rows(),json!([{"repisusrtcd2":"005935","secugrpId":"ST","fssunqno":"00000002"}]),json!([{"repisusrtcd2":"005935","secugrpId":"ST","fssunqno":CORP},{"repisusrtcd2":"005935","secugrpId":"EF","fssunqno":"00000002"}])] {
        fake.state.lock().unwrap().kind_responses.insert("005935".into(),rows);
        assert!(fake.client().resolve("005935",true).await.unwrap().is_none());
    }
    assert_eq!(fake.count("notice"),0);
    let before = fake.count("kind");
    let directory = fake_directory(&fake.state);
    fake.state.lock().unwrap().directory = Some(directory.replace("</result>",&format!("<list><corp_code>{CORP}</corp_code><stock_code>005930</stock_code></list></result>")));
    assert!(fake.client().resolve("005930",false).await.unwrap().is_none());
    assert_eq!(fake.count("kind"),before);
}

#[tokio::test]
async fn broken_or_error_page_source_and_invalid_company_response_are_retryable_failures() {
    let fake = verified_source().await;
    for text in [
        "".into(), "<HTML><PRE>broken".into(), "<HTML><title>페이지 오류</title></HTML>".into(),
        "<HTML><PRE></PRE></HTML>".into(),
        "<HTML><PRE>페이지 오류: 일시적으로 서비스를 이용할 수 없습니다.</PRE></HTML>".into(),
        NOTICE.replace("<PRE","<BODY><PRE").replace("</PRE>","</PRE></BODY>"),
        NOTICE.replace("⑨ 코드","⑨ 다른회사 코드"),
        NOTICE.replace("① 상장종목","상장종목"),
        NOTICE.replace("   - 삼성전자1우선주\n",""),
        NOTICE.replace("   ▶ 1우선주 표준코드 : KR7005931001 (단축코드:A005935)\n",""),
        NOTICE.replace("</HTML>","<PRE>005935 005930</PRE></HTML>"),
        NOTICE.replace("</HTML>","<BODY>◎ 다른회사(주) 변경상장(주식소각)</BODY></HTML>"),
        NOTICE.replace("</PRE>","◎ 다른회사(주) 변경상장(주식소각)</PRE>"),
        NOTICE.replace("KR7005931001","알 수 없는 코드 형식"),
    ] {
        fake.state.lock().unwrap().notice = Some(text);
        assert_eq!(fake.client().resolve("005935",true).await.unwrap_err(),Failure::InvalidResponse);
    }
    fake.state.lock().unwrap().notice = Some(NOTICE.into());
    fake.state.lock().unwrap().kind_responses.insert("005930".into(),json!({"error":"synthetic"}));
    assert_eq!(fake.client().resolve("005935",true).await.unwrap_err(),Failure::InvalidResponse);
}

async fn unrecognized_notice_retries_after_sixty_seconds(body: String) {
    for already_collected in [false,true] {
        let fake = verified_source().await;
        let dir = tempdir();
        let store = Store::open(&dir.path().join("financials.db")).await.unwrap();
        let clock = clock();
        let service = Financials::new(Some(fake.client()),store.clone(),clock.clone());
        let previous = if already_collected { Some(settled(&service).await.collection) } else { None };
        fake.state.lock().unwrap().notice = Some(body.clone());
        let failed = service.open("005935",true,false).await;
        assert_eq!(failed.status,"failed");
        assert_eq!(failed.failure,Some(Failure::InvalidResponse));
        assert!(failed.reason.is_none());
        assert!(store.security("005935").await.unwrap().is_none());
        assert_eq!(fake.count("notice"),1);
        fake.state.lock().unwrap().notice = Some(NOTICE.into());
        for elapsed in [0,59] {
            clock.jump(elapsed);
            let waiting = service.open("005935",true,false).await;
            assert_eq!(waiting.status,"failed");
            assert_eq!(waiting.failure,Some(Failure::InvalidResponse));
            assert_eq!(fake.count("notice"),1);
            if let Some(previous) = &previous {
                assert_eq!(serde_json::to_value(store.collection(CORP).await.unwrap()).unwrap(),serde_json::to_value(previous).unwrap());
                assert_eq!(settled(&service).await.status,"ready");
            }
        }
        assert_eq!(settled_stock(&service,"000001",false).await.status,"ready");
        assert_eq!(store.collection("00000002").await.unwrap().reports.len(),4);
        clock.jump(2);
        let recovered = settled_stock(&service,"005935",true).await;
        assert_eq!(recovered.status,"ready");
        assert_eq!(fake.count("notice"),2);
        assert_eq!(recovered.security.as_ref().unwrap().company.corp_code,CORP);
        assert!(recovered.security.unwrap().share_class.is_none());
        assert!(store.security("005935").await.unwrap().is_some());
        if let Some(previous) = previous {
            assert_eq!(serde_json::to_value(recovered.collection).unwrap(),serde_json::to_value(previous).unwrap());
        }
    }
}

#[tokio::test]
async fn pre_error_notice_is_retryable_and_preserves_companies_through_the_retry_window() {
    unrecognized_notice_retries_after_sixty_seconds("<HTML><PRE>페이지 오류: 일시적으로 서비스를 이용할 수 없습니다.</PRE></HTML>".into()).await;
}

#[tokio::test]
async fn unsupported_notice_layout_is_retryable_and_preserves_companies_through_the_retry_window() {
    unrecognized_notice_retries_after_sixty_seconds(NOTICE.replace("<PRE","<BODY><PRE").replace("</PRE>","</PRE></BODY>")).await;
}

#[tokio::test]
async fn valid_conflicting_notices_remain_mapping_absence_rather_than_source_failure() {
    for body in [NOTICE.replace("삼성전자(주)","다른회사(주)"),NOTICE.replace("A005935","A005939")] {
        let fake = verified_source().await;
        fake.state.lock().unwrap().notice = Some(body);
        let dir = tempdir();
        let store = Store::open(&dir.path().join("financials.db")).await.unwrap();
        let service = Financials::new(Some(fake.client()),store.clone(),clock());
        let snapshot = service.open("005935",true,false).await;
        assert_eq!(snapshot.status,"unsupported");
        assert_eq!(snapshot.reason,Some("company_mapping_unverified"));
        assert!(snapshot.failure.is_none());
        assert!(store.security("005935").await.unwrap().is_none());
        assert_eq!(fake.count("company.json"),0);
    }
}

#[tokio::test]
async fn first_and_mid_notice_failures_retry_without_discarding_saved_company_or_blocking_other_companies() {
    for already_collected in [false,true] {
        for failure in [Failure::Remote,Failure::Network,Failure::InvalidResponse] {
            let fake = verified_source().await;
            let dir = tempdir();
            let store = Store::open(&dir.path().join("financials.db")).await.unwrap();
            let clock = clock();
            let service = Financials::new(Some(fake.client()),store.clone(),clock.clone());
            let previous = if already_collected { Some(settled(&service).await.collection) } else { None };
            {
                let mut state = fake.state.lock().unwrap();
                match failure {
                    Failure::Remote => state.notice_status = Some(StatusCode::NOT_FOUND),
                    Failure::Network => state.notice_network_failure = true,
                    Failure::InvalidResponse => state.notice = Some("<HTML><PRE>broken".into()),
                    _ => unreachable!(),
                }
            }
            let failed = service.open("005935",true,true).await;
            assert_eq!(failed.status,"failed");
            assert_eq!(failed.failure,Some(failure));
            assert!(store.security("005935").await.unwrap().is_none());
            let before = fake.count("notice");
            assert_eq!(service.open("005935",true,false).await.failure,Some(failure));
            assert_eq!(fake.count("notice"),before);
            if let Some(previous) = &previous {
                assert_eq!(serde_json::to_value(store.collection(CORP).await.unwrap()).unwrap(),serde_json::to_value(previous).unwrap());
                assert_eq!(settled(&service).await.status,"ready");
            }
            assert_eq!(settled_stock(&service,"000001",false).await.status,"ready");
            assert_eq!(store.collection("00000002").await.unwrap().reports.len(),4);
            {
                let mut state = fake.state.lock().unwrap();
                state.notice_status = None;
                state.notice_network_failure = false;
                state.notice = Some(NOTICE.into());
            }
            clock.jump(61);
            let recovered = settled_stock(&service,"005935",true).await;
            assert_eq!(recovered.status,"ready");
            assert_eq!(recovered.security.unwrap().company.corp_code,CORP);
            assert_eq!(fake.count("notice"),before + 1);
            assert!(store.security("005935").await.unwrap().is_some());
        }
    }
}

#[tokio::test]
async fn first_and_mid_preferred_source_failures_leave_real_price_api_usable() {
    let kiwoom = common::FakeKiwoom::start().await;
    let client = reqwest::Client::new();
    for (notice_status, body, expected_failure) in [
        (Some(StatusCode::NOT_FOUND),NOTICE.into(),"remote"),
        (None,"<HTML><PRE>페이지 오류: 일시적으로 서비스를 이용할 수 없습니다.</PRE></HTML>".into(),"invalid_response"),
        (None,NOTICE.replace("<PRE","<BODY><PRE").replace("</PRE>","</PRE></BODY>"),"invalid_response"),
    ] {
        for already_collected in [false,true] {
            let fake = verified_source().await;
            let dir = tempdir();
            let server = process(&fake,&kiwoom,dir.path(),"20151231120000");
            let base = format!("http://{}",server.addr().await);
            let price = format!("{base}/api/bars?symbol=005930&period=D&limit=5");
            assert_eq!(client.get(&price).send().await.unwrap().status(),StatusCode::OK);
            let previous = if already_collected { Some(http_settled(&client,&base).await["collection"].clone()) } else { None };
            {
                let mut state = fake.state.lock().unwrap();
                state.notice_status = notice_status;
                state.notice = Some(body.clone());
            }
            let response = client.get(format!("{base}/api/symbols/005935/financial-source")).send().await.unwrap();
            let snapshot: Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
            assert_eq!(snapshot["status"],"failed");
            assert_eq!(snapshot["failure"],expected_failure);
            assert_eq!(tokio::time::timeout(Duration::from_secs(1),client.get(&price).send()).await.unwrap().unwrap().status(),StatusCode::OK);
            if let Some(previous) = previous { assert_eq!(http_snapshot(&client,&base).await["collection"],previous); }
            assert!(!server.stop().await.contains(KEY));
        }
    }
}
