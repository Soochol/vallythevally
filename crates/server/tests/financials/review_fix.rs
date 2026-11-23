use super::*;
use super::discovery::{COMMON, COMPANY, ENTRY, STOCK, search, source};
use super::mapping::tempdir;

fn annual_calls(fake: &Fake, endpoint: &str) -> usize {
    fake.state.lock().unwrap().calls.iter().filter(|(name,params)| name == endpoint && params.get("corp_code").is_some_and(|corp| corp == COMPANY)
        && params.get("bsns_year").is_some_and(|year| year == "2015") && params.get("reprt_code").is_some_and(|code| code == "11011")).count()
}

#[tokio::test]
async fn partial_first_page_is_a_retryable_source_failure_and_preserves_existing_companies() {
    for collected in [false,true] {
        for broken in [
            search(&format!("{ENTRY}{}",ENTRY.replace("class=\"img\"","class=\"changed-result\"")),2),
            search(ENTRY,2),
            search(&format!("{ENTRY}<div class=\"changed-result\">missing result</div>"),1),
        ] {
            let fake = source().await;
            let dir = tempdir();
            let store = Store::open(&dir.path().join("financials.db")).await.unwrap();
            let service = Financials::new(Some(fake.client()),store.clone(),clock());
            let previous = if collected { Some(settled_stock(&service,COMMON,false).await.collection) } else { None };
            fake.state.lock().unwrap().discovery_search = Some(broken);
            let failed = settled_stock(&service,STOCK,true).await;
            assert_eq!(failed.state,ReadState::Failed);
            assert_eq!(failed.failure,Some(Failure::InvalidResponse));
            assert!(failed.reason.is_none());
            assert!(store.security(STOCK).await.unwrap().is_none());
            assert_eq!(fake.count("search"),1);
            assert_eq!(fake.count("contents"),0);
            fake.state.lock().unwrap().discovery_search = Some(search(ENTRY,1));
            assert_eq!(settled_stock(&service,"000001",false).await.state,ReadState::Ready);
            if let Some(previous) = &previous { assert_eq!(serde_json::to_value(store.collection(COMPANY).await.unwrap()).unwrap(),serde_json::to_value(previous).unwrap()); }
            let recovered = settled_stock(&service,STOCK,true).await;
            assert_eq!(recovered.state,ReadState::Ready);
            assert_eq!(fake.count("search"),2);
            assert_eq!(fake.count("contents"),1);
            assert!(recovered.security.unwrap().share_class.is_none());
        }
    }
}

#[tokio::test]
async fn complete_first_page_uses_latest_of_fifteen_without_fetching_another_page() {
    let fake = source().await;
    let mut entries = String::new();
    for index in 0..14 {
        entries.push_str(&ENTRY.replace("20260917000117",&format!("20260917000{index:03}")).replace("20260917000264",&format!("20260917001{index:03}")).replace("16:42",&format!("16:{index:02}")));
    }
    entries.push_str(ENTRY);
    fake.state.lock().unwrap().discovery_search = Some(search(&entries,35));
    let security = fake.client().resolve(STOCK,true).await.unwrap().unwrap();
    let evidence: Value = serde_json::from_str(&security.evidence).unwrap();
    assert_eq!(evidence["document"],"20260917000264");
    for invalid in [search(&entries,14),search(&format!("{entries}{ENTRY}"),35),search(ENTRY,35)] {
        fake.state.lock().unwrap().discovery_search = Some(invalid);
        assert_eq!(fake.client().resolve(STOCK,true).await.unwrap_err(),Interrupt::Failure(Failure::InvalidResponse));
    }
    fake.state.lock().unwrap().discovery_search = Some("<section class=\"paging-group\"><div class=\"info\"><em>0</em></div></section>검색결과가 없습니다.".into());
    assert!(fake.client().resolve(STOCK,true).await.unwrap().is_none());
    assert_eq!(fake.count("contents"),1);
    assert!(fake.state.lock().unwrap().calls.iter().filter(|(name,_)| name == "search").all(|(_,params)| params["pageIndex"] == "1" && params["currentPageSize"] == "15"));
}

#[tokio::test]
async fn conflicting_document_or_receipt_identity_never_persists_provenance() {
    for other in [
        ENTRY.replace("20260917000117","20250917000117").replace("2026-09-17","2025-09-17"),
        ENTRY.replace("20260917000264","20260917000265").replace("16:42","16:41"),
    ] {
        let fake = source().await;
        fake.state.lock().unwrap().discovery_search = Some(search(&format!("{ENTRY}{other}"),2));
        let dir = tempdir();
        let store = Store::open(&dir.path().join("financials.db")).await.unwrap();
        let service = Financials::new(Some(fake.client()),store.clone(),clock());
        let snapshot = settled_stock(&service,STOCK,true).await;
        assert_eq!(snapshot.state,ReadState::Unsupported);
        assert_eq!(snapshot.reason,Some(UnsupportedReason::CompanyMappingUnverified));
        assert!(snapshot.failure.is_none());
        assert!(store.security(STOCK).await.unwrap().is_none());
        assert_eq!(fake.count("contents"),0);
        assert_eq!(fake.count("company.json"),0);
    }
}

#[tokio::test]
async fn repeated_manual_start_during_mapping_coalesces_and_preserves_other_company() {
    for source_failure in [false,true] {
        let fake = source().await;
        let dir = tempdir();
        let path = dir.path().join("run/financials.db");
        let store = Store::open(&path).await.unwrap();
        let yesterday = Clock::fake(kst(KstDate::new(2015,12,31).unwrap(),12,0,0));
        let service = Financials::new(Some(fake.client()),store.clone(),yesterday);
        let before = settled_stock(&service,COMMON,false).await.collection;
        let other = settled(&service).await.collection;
        drop(service);
        let collector = collector::Collector::open(&fake,dir.path(),"20160101120000",&[(STOCK,true),(COMMON,false),("005930",false)]).await;
        let stock_path = format!("/api/symbols/{STOCK}/financial-source");
        {
            let mut state = fake.state.lock().unwrap();
            state.discovery_paused = Some("search".into());
            state.stream_paused_report = Some("11013".into());
        }
        let manual = collector.start().await;
        fake.wait_for_call("search", 1).await;
        assert_eq!(tokio::time::timeout(Duration::from_secs(1),collector.get(&format!("/api/symbols/{COMMON}/financial-source"))).await.unwrap()["status"],"ready");
        assert_eq!(collector.start().await["id"],manual["id"]);
        let accepted = tokio::time::timeout(Duration::from_secs(3),collector.get(&stock_path)).await.unwrap();
        assert_eq!(accepted["status"],"not_collected");
        assert_eq!(accepted["collection"]["refresh_version"],0);
        assert!(accepted["security"].is_null());
        {
            let mut state = fake.state.lock().unwrap();
            state.statement_amounts.insert(COMPANY.into(),"175".into());
            state.correction = true;
            state.discovery_paused = None;
            if source_failure { state.failures.insert("fnlttSinglAcntAll.json/2015/11011".into(),"900".into()); }
        }
        let saved_other = tokio::time::timeout(Duration::from_secs(1),collector.snapshot()).await.unwrap();
        assert_eq!(saved_other["collection"]["reports"],serde_json::to_value(&other.reports).unwrap());
        assert_eq!(store.collection(COMPANY).await.unwrap().reports["2015/11011"].statement.refresh_version,before.refresh_version);
        fake.wait_for_call("statement_stream", 1).await;
        fake.state.lock().unwrap().stream_paused_report = None;
        collector.finished(&fake).await;
        let result = collector.get(&stock_path).await;
        let collection = store.collection(COMPANY).await.unwrap();
        assert_eq!(collection.refresh_version,before.refresh_version + 1);
        assert_eq!(collection.disclosure_version,collection.refresh_version);
        assert_eq!(annual_calls(&fake,"fnlttSinglAcntAll.json"),if source_failure { 4 } else { 2 });
        assert_eq!(annual_calls(&fake,"alotMatter.json"),2);
        let annual = &collection.reports["2015/11011"].statement;
        if source_failure {
            assert_eq!(result["status"],"partial_failure");
            assert_eq!(annual.failure,Some(Failure::Remote));
            assert_eq!(annual.refresh_version,before.refresh_version);
            assert_eq!(annual.data.as_ref().unwrap().accounts[0].fields["thstrm_amount"],"100");
        } else {
            assert_eq!(result["status"],"ready");
            assert_eq!(annual.refresh_version,collection.refresh_version);
            assert_eq!(annual.data.as_ref().unwrap().accounts[0].fields["thstrm_amount"],"175");
            for code in ["11013","11012","11014","11011"] { assert_eq!(collection.reports[&format!("2015/{code}")].statement.refresh_version,collection.refresh_version); }
            assert_eq!(collection.reports["2015/11011"].dividends.refresh_version,collection.refresh_version);
        }
    }
}
