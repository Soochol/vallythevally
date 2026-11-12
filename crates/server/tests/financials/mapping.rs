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

#[tokio::test]
async fn explicit_listing_notice_shares_company_collection_and_preserves_separate_dps_identity() {
    let fake = verified_source().await;
    let dir = tempdir();
    let store = Store::open(&dir.path().join("financials.db")).await.unwrap();
    let service = Financials::new(Some(fake.client()),store.clone(),clock());
    run_update(&service,&[("005930",false),("005935",true)]).await;
    let common = service.read("005930").await.security.unwrap();
    let preferred = service.read("005935").await.security.unwrap();
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
    let common = service.read("005930").await;
    let preferred = service.read("005935").await;
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
    let saved = settled_stock(&restarted,"005935",true).await;
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
    assert_eq!(fake.client().resolve("005935",true).await.unwrap_err(),Interrupt::Failure(Failure::InvalidResponse));
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
        assert_eq!(fake.client().resolve("005935",true).await.unwrap_err(),Interrupt::Failure(Failure::InvalidResponse));
    }
    fake.state.lock().unwrap().notice = Some(NOTICE.into());
    fake.state.lock().unwrap().kind_responses.insert("005930".into(),json!({"error":"synthetic"}));
    assert_eq!(fake.client().resolve("005935",true).await.unwrap_err(),Interrupt::Failure(Failure::InvalidResponse));
}

async fn unrecognized_notice_retries_in_the_next_update(body: String) {
    for already_collected in [false,true] {
        let fake = verified_source().await;
        let dir = tempdir();
        let store = Store::open(&dir.path().join("financials.db")).await.unwrap();
        let service = Financials::new(Some(fake.client()),store.clone(),clock());
        let previous = if already_collected { Some(settled(&service).await.collection) } else { None };
        fake.state.lock().unwrap().notice = Some(body.clone());
        let failed = settled_stock(&service,"005935",true).await;
        assert_eq!(failed.status,"failed");
        assert_eq!(failed.failure,Some(Failure::InvalidResponse));
        assert!(failed.reason.is_none());
        assert!(store.security("005935").await.unwrap().is_none());
        assert_eq!(fake.count("notice"),1);
        if let Some(previous) = &previous {
            assert_eq!(serde_json::to_value(store.collection(CORP).await.unwrap()).unwrap(),serde_json::to_value(previous).unwrap());
            assert_eq!(settled(&service).await.status,"ready");
        }
        fake.state.lock().unwrap().notice = Some(NOTICE.into());
        assert_eq!(settled_stock(&service,"000001",false).await.status,"ready");
        assert_eq!(store.collection("00000002").await.unwrap().reports.len(),4);
        let recovered = settled_stock(&service,"005935",true).await;
        assert_eq!(recovered.status,"ready");
        assert_eq!(fake.count("notice"),2);
        assert_eq!(recovered.security.as_ref().unwrap().company.corp_code,CORP);
        assert!(recovered.security.unwrap().share_class.is_none());
        assert!(store.security("005935").await.unwrap().is_some());
        if let Some(previous) = previous {
            assert_saved_report_fetches(&serde_json::to_value(recovered.collection).unwrap(),&serde_json::to_value(previous).unwrap());
        }
    }
}

#[tokio::test]
async fn pre_error_notice_is_retryable_and_preserves_companies_until_the_next_update() {
    unrecognized_notice_retries_in_the_next_update("<HTML><PRE>페이지 오류: 일시적으로 서비스를 이용할 수 없습니다.</PRE></HTML>".into()).await;
}

#[tokio::test]
async fn unsupported_notice_layout_is_retryable_and_preserves_companies_until_the_next_update() {
    unrecognized_notice_retries_in_the_next_update(NOTICE.replace("<PRE","<BODY><PRE").replace("</PRE>","</PRE></BODY>")).await;
}

#[tokio::test]
async fn valid_conflicting_notices_remain_mapping_absence_rather_than_source_failure() {
    for body in [NOTICE.replace("삼성전자(주)","다른회사(주)"),NOTICE.replace("A005935","A005939")] {
        let fake = verified_source().await;
        fake.state.lock().unwrap().notice = Some(body);
        let dir = tempdir();
        let store = Store::open(&dir.path().join("financials.db")).await.unwrap();
        let service = Financials::new(Some(fake.client()),store.clone(),clock());
        let snapshot = settled_stock(&service,"005935",true).await;
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
            let service = Financials::new(Some(fake.client()),store.clone(),clock());
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
            let failed = settled_stock(&service,"005935",true).await;
            assert_eq!(failed.status,"failed");
            assert_eq!(failed.failure,Some(failure));
            assert!(store.security("005935").await.unwrap().is_none());
            assert_eq!(fake.count("notice"),if failure == Failure::InvalidResponse { 1 } else { 3 });
            let before = fake.count("notice");
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
            let previous = if already_collected {
                let store = Store::open(&dir.path().join("run/financials.db")).await.unwrap();
                let service = Financials::new(Some(fake.client()), store, clock());
                Some(serde_json::to_value(settled(&service).await.collection).unwrap())
            } else { None };
            {
                let mut state = fake.state.lock().unwrap();
                state.notice_status = notice_status;
                state.notice = Some(body.clone());
            }
            http_start(&client, &base).await;
            http_settled(&client, &base).await;
            let response = client.get(format!("{base}/api/symbols/005935/financial-source")).send().await.unwrap();
            let snapshot: Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
            assert_eq!(snapshot["status"],"failed");
            assert_eq!(snapshot["failure"],expected_failure);
            assert_eq!(tokio::time::timeout(Duration::from_secs(1),client.get(&price).send()).await.unwrap().unwrap().status(),StatusCode::OK);
            if let Some(previous) = previous { assert_saved_report_fetches(&http_snapshot(&client,&base).await["collection"], &previous); }
            assert!(!server.stop().await.contains(KEY));
        }
    }
}

fn integrated_receipt(year: i32, code: &str, corrected: bool) -> String {
    let original = match code {
        "11013"=>format!("{year}0515000001"), "11012"=>format!("{year}0815000001"),
        "11014"=>format!("{year}1115000001"), _=>format!("{}0331000001",year+1),
    };
    if corrected { format!("{}2", &original[..13]) } else { original }
}

fn integrated_statement(year: i32, code: &str, corrected: bool) -> (Vec<BTreeMap<String,String>>, String) {
    let index=REPORT_CODES.iter().position(|c|*c==code).unwrap();
    let end=KstDate::new(year,(index as u8+1)*3,1).unwrap().last_of_month().to_string();
    let start=format!("{year}-01-01");
    let quarter=if code=="11011" {start.clone()} else {format!("{year}-{:02}-01",index*3+1)};
    let receipt=integrated_receipt(year,code,corrected);
    let mut rows=Vec::new();
    for (section,id,current,cumulative) in [
        ("IS","ifrs-full_Revenue",if corrected { ["150","150","150","1200"][index] } else { ["100","100","100","1000"][index] },Some(if corrected { ["150","250","350","1200"][index] } else { ["100","200","300","1000"][index] })),
        ("IS","dart_OperatingIncomeLoss",["-10","-10","-10","-100"][index],Some(["-10","-20","-30","-100"][index])),
        ("IS","ifrs-full_ProfitLossAttributableToOwnersOfParent",["10","20","30","100"][index],Some(["10","30","60","100"][index])),
        ("CF","ifrs-full_CashFlowsFromUsedInInvestingActivities",["-100","-200","-300","-400"][index],Some(["-100","-200","-300","-400"][index])),
        ("BS","ifrs-full_Liabilities","200",None),
        ("BS","ifrs-full_Equity","400",None),
        ("BS","ifrs-full_EquityAttributableToOwnersOfParent","500",None),
    ] {
        let mut row=account(section,id,current);
        row.insert("bsns_year".into(),year.to_string());row.insert("reprt_code".into(),code.into());row.insert("rcept_no".into(),receipt.clone());
        if let Some(value)=cumulative {row.insert("thstrm_add_amount".into(),value.into());} else {row.remove("thstrm_add_amount");}
        rows.push(row);
    }
    let contexts=format!("{}{}{}",context("q",&quarter,&end,"ConsolidatedMember"),context("cum",&start,&end,"ConsolidatedMember"),context("bs","",&end,"ConsolidatedMember"));
    let mut facts=format!("<g:DocumentReceiptNumber>{receipt}</g:DocumentReceiptNumber>");
    for row in &rows {
        let concept=row["account_id"].replace("ifrs-full_","ifrs:").replace("dart_","dart:");
        let current=match row["sj_div"].as_str() {"BS"=>"bs","CF"=>"cum",_=>"q"};
        facts.push_str(&format!("<{concept} contextRef=\"{current}\" unitRef=\"krw\">{}</{concept}>",row["thstrm_amount"]));
        if let Some(value)=row.get("thstrm_add_amount") {facts.push_str(&format!("<{concept} contextRef=\"cum\" unitRef=\"krw\">{value}</{concept}>"));}
    }
    let xml=instance(&contexts,&facts).replace("xmlns:g=", "xmlns:dart=\"http://dart.fss.or.kr/ifrs/2025\" xmlns:g=");
    (rows,xml)
}

pub(super) fn integrated_response(endpoint: &str, params: &BTreeMap<String,String>, corrections: &std::collections::BTreeSet<(i32, String)>) -> Response {
    match endpoint {
        "list.json"=>{
            let mut rows = Vec::new();
            for year in 2015..=2017 {
                for code in REPORT_CODES {
                    if year > 2016 && !corrections.contains(&(year, code.into())) { continue; }
                    for corrected in [false, true] {
                        if corrected && !corrections.contains(&(year, code.into())) { continue; }
                        let receipt = integrated_receipt(year, code, corrected);
                        let (name, month) = match code { "11013" => ("분기보고서", 3), "11012" => ("반기보고서", 6), "11014" => ("분기보고서", 9), _ => ("사업보고서", 12) };
                        rows.push(json!({"corp_code":CORP,"rcept_no":receipt,"rcept_dt":&receipt[..8],"report_nm":format!("{}{name} ({year}.{month:02})", if corrected { "[기재정정]" } else { "" })}));
                    }
                }
            }
            axum::Json(json!({"status":"000","page_no":1,"total_page":1,"list":rows})).into_response()
        }
        "fnlttSinglAcntAll.json"=>{
            let year=params["bsns_year"].parse::<i32>().unwrap();
            if !(2015..=2017).contains(&year) || (year > 2016 && !corrections.contains(&(year, params["reprt_code"].clone()))) {return axum::Json(json!({"status":"013"})).into_response();}
            axum::Json(json!({"status":"000","list":integrated_statement(year,&params["reprt_code"],corrections.contains(&(year, params["reprt_code"].clone()))).0})).into_response()
        }
        "fnlttXbrl.xml"=>{
            let (year,code,corrected)=(2015..=2017).flat_map(|year|REPORT_CODES.into_iter().flat_map(move |code|[false,true].map(move |corrected|(year,code,corrected)))).find(|(year,code,corrected)|integrated_receipt(*year,code,*corrected)==params["rcept_no"]).unwrap();
            zipped("integrated.xbrl",&integrated_statement(year,code,corrected).1).into_response()
        }
        "alotMatter.json"=>{
            let year=params["bsns_year"].parse::<i32>().unwrap();
            if !(2015..=2017).contains(&year) || (year > 2016 && !corrections.contains(&(year, "11011".into()))) {return axum::Json(json!({"status":"013"})).into_response();}
            let rows:Vec<_>=[("보통주","10"),("우선주","7")].map(|(class,value)|json!({"corp_code":CORP,"stlm_dt":format!("{year}-12-31"),"rcept_no":integrated_receipt(year,"11011",corrections.contains(&(year, "11011".into()))),"se":"주당 현금배당금(원)","stock_knd":class,"thstrm":value})).into_iter().collect();
            axum::Json(json!({"status":"000","list":rows})).into_response()
        }
        _=>unreachable!(),
    }
}

async fn integrated_page(client: &reqwest::Client, base: &str, stock: &str, period: &str) -> Value {
    let response=client.get(format!("{base}/api/symbols/{stock}/financials?period={period}")).send().await.unwrap();
    assert_eq!(response.status(),StatusCode::OK);
    serde_json::from_slice(&response.bytes().await.unwrap()).unwrap()
}

fn integrated_point<'a>(page: &'a Value, metric: &str) -> &'a Value {
    page["series"].as_array().unwrap().iter().find(|s|s["metric"]==metric).unwrap()["points"].as_array().unwrap().iter().find(|p|p["businessYear"]==2016 && p["reportCode"]=="11011").unwrap()
}

#[tokio::test]
async fn preferred_mapping_calculations_and_quarter_year_prices_work_together() {
    let fake=verified_source().await;
    {let mut state=fake.state.lock().unwrap();state.integrated_financials=true;state.delayed=true;}
    let kiwoom=common::FakeKiwoom::start().await;
    let dir=tempdir();
    let server=process(&fake,&kiwoom,dir.path(),"20171231120000");
    let base=format!("http://{}",server.addr().await);
    let client=reqwest::Client::new();
    let prices:Vec<_>=["005930","005935"].into_iter().flat_map(|stock|["Q","Y"].map(|period|format!("{base}/api/bars?symbol={stock}&period={period}&limit=5"))).collect();
    for url in &prices {assert_eq!(client.get(url).send().await.unwrap().status(),StatusCode::OK);}
    assert_eq!(integrated_page(&client,&base,"005930","Y").await["status"],"not_collected");
    http_start(&client, &base).await;
    http_settled(&client, &base).await;
    let preferred=integrated_page(&client,&base,"005935","Y").await;
    assert_eq!(preferred["corpCode"],CORP);assert_eq!(preferred["status"],"ready");
    assert_eq!(preferred["shareClassReason"],"preferred_issue_class_unverified");
    for url in &prices {assert_eq!(tokio::time::timeout(Duration::from_secs(1),client.get(url).send()).await.unwrap().unwrap().status(),StatusCode::OK);}
    let mut ready=None;
    for _ in 0..2000 {
        let page=integrated_page(&client,&base,"005935","Y").await;
        if page["status"]!="collecting" {ready=Some(page);break;}
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let preferred=ready.expect("integrated collection must settle");assert_eq!(preferred["status"],"ready");
    let common=integrated_page(&client,&base,"005930","Y").await;assert_eq!(common["status"],"ready");
    let quarter=integrated_page(&client,&base,"005935","Q").await;
    for (metric,annual,quarterly) in [("revenue",1000.0,700.0),("operating_income",-100.0,-70.0),("owner_roe",20.0,20.0),("investing_cash_flow",-400.0,-100.0),("debt_ratio",50.0,50.0)] {
        let p=integrated_point(&preferred,metric);assert_eq!(p["value"],annual);assert_eq!(p["status"],"available");
        assert_eq!(p,integrated_point(&common,metric));assert_eq!(integrated_point(&quarter,metric)["value"],quarterly);
        assert!(p["priceBucket"].is_number());assert_eq!(p["basis"],"CFS");
        assert!(p["inputs"].as_array().unwrap().iter().all(|i|i["sourceFile"]=="integrated.xbrl"));
    }
    assert_eq!(integrated_point(&common,"dps")["value"],10.0);
    assert_eq!(integrated_point(&preferred,"dps")["reason"],"share_class_unverified");assert_eq!(integrated_point(&preferred,"dps")["value"],Value::Null);
    assert_eq!(integrated_point(&quarter,"dps")["reason"],"annual_only");
    assert_eq!(preferred["series"].as_array().unwrap().len(),6);
    assert_eq!(fake.count("fnlttSinglAcntAll.json"),16);assert_eq!(fake.count("alotMatter.json"),3);assert_eq!(fake.count("notice"),1);
    for url in &prices {assert_eq!(client.get(url).send().await.unwrap().status(),StatusCode::OK);}
    assert!(!server.stop().await.contains(KEY));
}
