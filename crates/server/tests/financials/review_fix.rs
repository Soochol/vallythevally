use super::*;
use super::discovery::{COMMON, COMPANY, ENTRY, STOCK, search, source};
use super::mapping::{settled_stock, tempdir};

async fn until_call(fake: &Fake, endpoint: &str, count: usize) {
    tokio::time::timeout(Duration::from_secs(5),async {
        while fake.count(endpoint) < count { tokio::time::sleep(Duration::from_millis(5)).await; }
    }).await.unwrap();
}

fn annual_calls(fake: &Fake, endpoint: &str) -> usize {
    fake.state.lock().unwrap().calls.iter().filter(|(name,params)| name == endpoint && params.get("corp_code").is_some_and(|corp| corp == COMPANY)
        && params.get("bsns_year").is_some_and(|year| year == "2015") && params.get("reprt_code").is_some_and(|code| code == "11011")).count()
}

async fn finished(service: &Arc<Financials>, stock: &str, preferred: bool) -> server::financials::model::Snapshot {
    tokio::time::timeout(Duration::from_secs(20),async {
        loop {
            let snapshot = service.open(stock,preferred,false).await;
            if snapshot.status != "collecting" { break snapshot; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.unwrap()
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
            let clock = clock();
            let service = Financials::new(Some(fake.client()),store.clone(),clock.clone());
            let previous = if collected { Some(settled_stock(&service,COMMON,false).await.collection) } else { None };
            fake.state.lock().unwrap().discovery_search = Some(broken);
            let failed = service.open(STOCK,true,false).await;
            assert_eq!(failed.status,"failed");
            assert_eq!(failed.failure,Some(Failure::InvalidResponse));
            assert!(failed.reason.is_none());
            assert!(store.security(STOCK).await.unwrap().is_none());
            assert_eq!(fake.count("search"),1);
            assert_eq!(fake.count("contents"),0);
            let attempted = clock.now().unix();
            fake.state.lock().unwrap().discovery_search = Some(search(ENTRY,1));
            for elapsed in [0,59] {
                clock.jump(attempted + elapsed - clock.now().unix());
                assert_eq!(service.open(STOCK,true,false).await.failure,Some(Failure::InvalidResponse));
                assert_eq!(fake.count("search"),1);
            }
            assert_eq!(settled_stock(&service,"000001",false).await.status,"ready");
            if let Some(previous) = &previous { assert_eq!(serde_json::to_value(store.collection(COMPANY).await.unwrap()).unwrap(),serde_json::to_value(previous).unwrap()); }
            clock.jump(attempted + 61 - clock.now().unix());
            let recovered = settled_stock(&service,STOCK,true).await;
            assert_eq!(recovered.status,"ready");
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
        assert_eq!(fake.client().resolve(STOCK,true).await.unwrap_err(),Failure::InvalidResponse);
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
        let snapshot = service.open(STOCK,true,false).await;
        assert_eq!(snapshot.status,"unsupported");
        assert_eq!(snapshot.reason,Some("company_mapping_unverified"));
        assert!(snapshot.failure.is_none());
        assert!(store.security(STOCK).await.unwrap().is_none());
        assert_eq!(fake.count("contents"),0);
        assert_eq!(fake.count("company.json"),0);
    }
}

async fn http_stock(client: &reqwest::Client, base: &str, stock: &str) -> Value {
    let response = client.get(format!("{base}/api/symbols/{stock}/financial-source")).send().await.unwrap();
    assert_eq!(response.status(),StatusCode::OK);
    serde_json::from_slice(&response.bytes().await.unwrap()).unwrap()
}

async fn http_finished(client: &reqwest::Client, base: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(20),async {
        loop {
            let snapshot = http_stock(client,base,STOCK).await;
            if snapshot["status"] != "collecting" { break snapshot; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.unwrap()
}

#[tokio::test]
async fn delayed_manual_connection_follows_running_automatic_collection_and_preserves_price_and_other_company() {
    use std::os::unix::fs::PermissionsExt;
    for source_failure in [false,true] {
        let fake = source().await;
        let dir = tempdir();
        let path = dir.path().join("run/financials.db");
        let store = Store::open(&path).await.unwrap();
        std::fs::set_permissions(dir.path().join("run"),std::fs::Permissions::from_mode(0o700)).unwrap();
        let yesterday = Clock::fake(kst(KstDate::new(2015,12,31).unwrap(),12,0,0));
        let service = Financials::new(Some(fake.client()),store.clone(),yesterday);
        let before = settled_stock(&service,COMMON,false).await.collection;
        let other = settled(&service).await.collection;
        drop(service);
        let kiwoom = common::FakeKiwoom::start().await;
        let mut symbols = fake_kiwoom::fixture("ka10099_0");
        for (code,name) in [(STOCK,"현대차2우B"),(COMMON,"현대차")] {
            let mut row = symbols["list"].as_array().unwrap().iter().find(|row| row["code"] == "005935").unwrap().clone();
            row["code"] = code.into();
            row["name"] = name.into();
            symbols["list"].as_array_mut().unwrap().push(row);
        }
        kiwoom.seen.respond_with("ka10099",StatusCode::OK,symbols);
        let server = process(&fake,&kiwoom,dir.path(),"20160101120000");
        let base = format!("http://{}",server.addr().await);
        let client = reqwest::Client::new();
        let price = format!("{base}/api/bars?symbol=005930&period=D&limit=5");
        let response = client.get(&price).send().await.unwrap();
        let status = response.status();
        let body = response.bytes().await.unwrap();
        assert_eq!(status,StatusCode::OK,"{} {}",String::from_utf8_lossy(&body),server.logs());
        {
            let mut state = fake.state.lock().unwrap();
            state.discovery_paused = Some("search".into());
            state.stream_paused_report = Some("11013".into());
        }
        let manual = {
            let client = client.clone();
            let base = base.clone();
            tokio::spawn(async move { client.post(format!("{base}/api/symbols/{STOCK}/financial-source")).send().await.unwrap() })
        };
        until_call(&fake,"search",1).await;
        assert_eq!(tokio::time::timeout(Duration::from_secs(1),http_stock(&client,&base,COMMON)).await.unwrap()["status"],"collecting");
        until_call(&fake,"statement_stream",1).await;
        {
            let mut state = fake.state.lock().unwrap();
            state.statement_amounts.insert(COMPANY.into(),"175".into());
            state.discovery_paused = None;
            if source_failure { state.failures.insert("fnlttSinglAcntAll.json/2015/11011".into(),"020".into()); }
        }
        let response = tokio::time::timeout(Duration::from_secs(3),manual).await.unwrap().unwrap();
        let accepted: Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
        assert_eq!(accepted["status"],"collecting");
        assert_eq!(accepted["collection"]["refresh_version"],before.refresh_version);
        assert_eq!(tokio::time::timeout(Duration::from_secs(1),client.get(&price).send()).await.unwrap().unwrap().status(),StatusCode::OK);
        let saved_other = tokio::time::timeout(Duration::from_secs(1),http_stock(&client,&base,"005930")).await.unwrap();
        assert_eq!(saved_other["collection"]["reports"],serde_json::to_value(&other.reports).unwrap());
        assert_eq!(store.collection(COMPANY).await.unwrap().reports["2015/11011"].statement.refresh_version,before.refresh_version);
        fake.state.lock().unwrap().stream_paused_report = None;
        let result = http_finished(&client,&base).await;
        let collection = store.collection(COMPANY).await.unwrap();
        assert_eq!(collection.refresh_version,before.refresh_version + 1);
        assert_eq!(collection.disclosure_version,collection.refresh_version);
        assert_eq!(annual_calls(&fake,"fnlttSinglAcntAll.json"),2);
        assert_eq!(annual_calls(&fake,"alotMatter.json"),2);
        let annual = &collection.reports["2015/11011"].statement;
        if source_failure {
            assert_eq!(result["status"],"partial_failure");
            assert_eq!(annual.failure,Some(Failure::RateLimited));
            assert_eq!(annual.refresh_version,before.refresh_version);
            assert_eq!(annual.data.as_ref().unwrap().accounts[0].fields["thstrm_amount"],"100");
        } else {
            assert_eq!(result["status"],"ready");
            assert_eq!(annual.refresh_version,collection.refresh_version);
            assert_eq!(annual.data.as_ref().unwrap().accounts[0].fields["thstrm_amount"],"175");
            for code in ["11013","11012","11014","11011"] { assert_eq!(collection.reports[&format!("2015/{code}")].statement.refresh_version,collection.refresh_version); }
            assert_eq!(collection.reports["2015/11011"].dividends.refresh_version,collection.refresh_version);
        }
        assert_eq!(tokio::time::timeout(Duration::from_secs(1),client.get(&price).send()).await.unwrap().unwrap().status(),StatusCode::OK);
        assert!(!server.stop().await.contains(KEY));
    }
}

#[tokio::test]
async fn pending_manual_refresh_survives_active_collection_storage_failure_and_retries_without_losing_data() {
    use sqlx::Connection;
    let fake = source().await;
    let dir = tempdir();
    let path = dir.path().join("financials.db");
    let store = Store::open(&path).await.unwrap();
    let clock = clock();
    let service = Financials::new(Some(fake.client()),store.clone(),clock.clone());
    let before = settled_stock(&service,COMMON,false).await.collection;
    clock.jump(86400);
    {
        let mut state = fake.state.lock().unwrap();
        state.discovery_paused = Some("search".into());
        state.stream_paused_report = Some("11013".into());
    }
    let manual = { let service = service.clone(); tokio::spawn(async move { service.open(STOCK,true,true).await }) };
    until_call(&fake,"search",1).await;
    assert_eq!(service.open(COMMON,false,false).await.status,"collecting");
    until_call(&fake,"statement_stream",1).await;
    fake.state.lock().unwrap().discovery_paused = None;
    assert_eq!(tokio::time::timeout(Duration::from_secs(3),manual).await.unwrap().unwrap().status,"collecting");
    let mut connection = sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path)).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_pending_refresh BEFORE INSERT ON companies WHEN NEW.corp_code = '00164742' BEGIN SELECT RAISE(FAIL,'synthetic pending refresh failure'); END").execute(&mut connection).await.unwrap();
    fake.state.lock().unwrap().stream_paused_report = None;
    let failed = finished(&service,COMMON,false).await;
    assert_eq!(failed.failure,Some(Failure::Storage));
    assert_eq!(failed.collection.refresh_version,before.refresh_version);
    assert_eq!(serde_json::to_value(&failed.collection.reports).unwrap(),serde_json::to_value(&before.reports).unwrap());
    let attempted = failed.collection.last_attempt_at.unwrap();
    assert_eq!(settled_stock(&service,"000001",false).await.status,"ready");
    sqlx::query("DROP TRIGGER fail_pending_refresh").execute(&mut connection).await.unwrap();
    fake.state.lock().unwrap().statement_amounts.insert(COMPANY.into(),"175".into());
    for elapsed in [0,59] {
        clock.jump(attempted + elapsed - clock.now().unix());
        assert_eq!(service.open(STOCK,true,false).await.failure,Some(Failure::Storage));
        assert_eq!(annual_calls(&fake,"fnlttSinglAcntAll.json"),1);
    }
    clock.jump(2);
    let recovered = finished(&service,STOCK,true).await;
    assert_eq!(recovered.status,"ready");
    assert_eq!(recovered.collection.refresh_version,before.refresh_version + 1);
    let annual = &recovered.collection.reports["2015/11011"].statement;
    assert_eq!(annual.refresh_version,recovered.collection.refresh_version);
    assert_eq!(annual.data.as_ref().unwrap().accounts[0].fields["thstrm_amount"],"175");
    assert_eq!(annual_calls(&fake,"fnlttSinglAcntAll.json"),2);
    assert_eq!(serde_json::to_value(store.collection(COMPANY).await.unwrap()).unwrap(),serde_json::to_value(&recovered.collection).unwrap());
}
