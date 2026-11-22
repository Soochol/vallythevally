mod common;

use account_server::fake_idp::Fault;
use account_server::{AccountOptions, Accounts, BlockedIdentities, Provider};
use common::*;
use serde_json::json;
use std::sync::Arc;

const THIRTY_DAYS: i64 = 30 * 24 * 60 * 60;
const DAY: i64 = 24 * 60 * 60;

fn session_cookie_line(browser: &Browser) -> String {
    let lines: Vec<_> = browser.set_cookies.iter().filter(|line| line.contains("vally_session=") && !line.contains("vally_session=;")).collect();
    assert_eq!(lines.len(), 1, "세션 쿠키는 한 번 둔다: {:?}", browser.set_cookies);
    lines[0].clone()
}

async fn callback_response(harness: &Harness, browser: &mut Browser, provider: &str) -> reqwest::Response {
    let start = browser.get(&format!("{}/v1/session/{provider}/start", harness.base)).await;
    let authorize = location(&start);
    let idp = browser.get(authorize.as_str()).await;
    let callback = location(&idp);
    browser.get(&format!("{}{}?{}", harness.base, callback.path(), callback.query().unwrap())).await
}

async fn sign_in(harness: &Harness, provider: &str) -> Browser {
    let mut browser = harness.browser();
    let response = callback_response(harness, &mut browser, provider).await;
    assert_eq!(location(&response).as_str(), format!("{}/", harness.base));
    browser
}

async fn sign_in_as(harness: &Harness, provider: &str, subject: &str) -> Browser {
    harness.idp.set_subject(subject);
    sign_in(harness, provider).await
}

fn error_landing(harness: &Harness, reason: &str) -> String {
    format!("{}/?login=error&reason={reason}", harness.base)
}

async fn status_of(harness: &Harness, browser: &mut Browser) -> u16 {
    browser.get(&format!("{}/v1/session", harness.base)).await.status().as_u16()
}

fn cookie_header(browser: &Browser) -> String {
    browser.cookies.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join("; ")
}

async fn post_json(harness: &Harness, browser: &Browser, path: &str, origin: Option<&str>, content_type: &str) -> reqwest::Response {
    let mut request = harness.http.post(format!("{}{path}", harness.base)).header("cookie", cookie_header(browser)).header("content-type", content_type).body("{}");
    if let Some(origin) = origin {
        request = request.header("origin", origin);
    }
    request.send().await.unwrap()
}

async fn delete_account(harness: &Harness, browser: &Browser, origin: Option<&str>, content_type: &str) -> reqwest::Response {
    let mut request = harness.http.delete(format!("{}/v1/account", harness.base)).header("cookie", cookie_header(browser)).header("content-type", content_type).body("{}");
    if let Some(origin) = origin {
        request = request.header("origin", origin);
    }
    request.send().await.unwrap()
}

async fn stored_last_used(harness: &Harness) -> i64 {
    sqlx::query_scalar("SELECT last_used_at FROM sessions").fetch_one(&harness.pool).await.unwrap()
}

#[tokio::test]
async fn browser_login_sets_a_session_cookie_and_lands_on_the_public_root() {
    for provider in ["google", "naver"] {
        let harness = Harness::start().await;
        let mut browser = harness.browser();
        let response = callback_response(&harness, &mut browser, provider).await;
        assert_eq!(location(&response).as_str(), format!("{}/", harness.base));
        let cookie = session_cookie_line(&browser);
        assert!(cookie.starts_with("vally_session="), "{cookie}");
        for attribute in ["HttpOnly", "SameSite=Lax", "Path=/"] {
            assert!(cookie.contains(attribute), "{cookie}");
        }
        assert!(!cookie.contains("Secure") && !cookie.contains("__Host-"), "{cookie}");
        let session: serde_json::Value = browser.get(&format!("{}/v1/session", harness.base)).await.json().await.unwrap();
        assert_eq!(session["provider"], provider);
        assert_eq!(session.as_object().unwrap().len(), 2, "최소 정보만 돌려준다");
        assert_eq!(harness.count("sessions").await, 1);
    }
}

#[tokio::test]
async fn an_https_public_address_gets_the_host_prefixed_secure_cookie() {
    let harness = Harness::start_configured(AccountOptions::default(), Some("https://vally.example.test")).await;
    let mut browser = harness.browser();
    let response = callback_response(&harness, &mut browser, "google").await;
    assert_eq!(location(&response).as_str(), "https://vally.example.test/");
    let cookie = session_cookie_line(&browser);
    assert!(cookie.starts_with("__Host-vally_session="), "{cookie}");
    for attribute in ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"] {
        assert!(cookie.contains(attribute), "{cookie}");
    }
    assert!(!cookie.contains("Domain"), "{cookie}");
    assert_eq!(status_of(&harness, &mut browser).await, 200);
}

#[tokio::test]
async fn a_callback_carrying_only_another_logins_flow_cookie_makes_no_session() {
    let harness = Harness::start().await;
    let mut owner = harness.browser();
    let start = owner.get(&format!("{}/v1/session/google/start", harness.base)).await;
    let idp = owner.get(location(&start).as_str()).await;
    let callback = location(&idp);
    let mut stranger = harness.browser();
    let _ = stranger.get(&format!("{}/v1/session/google/start", harness.base)).await;
    let response = stranger.get(&format!("{}{}?{}", harness.base, callback.path(), callback.query().unwrap())).await;
    assert_eq!(response.status(), 400);
    assert_eq!(harness.count("sessions").await, 0);
    assert!(!stranger.set_cookies.iter().any(|line| line.contains("vally_session")));
}

#[tokio::test]
async fn idp_cancel_and_idp_failure_land_on_the_error_address_without_a_session() {
    let harness = Harness::start().await;
    harness.idp.cancel_next_authorization();
    let mut cancelled = harness.browser();
    let response = callback_response(&harness, &mut cancelled, "google").await;
    assert_eq!(location(&response).as_str(), error_landing(&harness, "cancelled"));
    harness.idp.set_fault(Fault::WrongAudience);
    let mut failed = harness.browser();
    let response = callback_response(&harness, &mut failed, "google").await;
    assert_eq!(location(&response).as_str(), error_landing(&harness, "idp_failed"));
    assert_eq!(harness.count("sessions").await, 0);
    for browser in [&mut cancelled, &mut failed] {
        assert!(!browser.set_cookies.iter().any(|line| line.starts_with("vally_session=") && !line.starts_with("vally_session=;")));
        assert_eq!(status_of(&harness, browser).await, 401);
    }
}

#[tokio::test]
async fn the_same_provider_and_subject_is_one_account_and_providers_stay_apart() {
    let harness = Harness::start().await;
    harness.idp.set_subject("shared-subject");
    sign_in(&harness, "google").await;
    sign_in(&harness, "google").await;
    assert_eq!(harness.count("accounts").await, 1);
    assert_eq!(harness.count("sessions").await, 2);
    sign_in(&harness, "naver").await;
    assert_eq!(harness.count("accounts").await, 2);
}

#[tokio::test]
async fn a_session_expires_after_thirty_idle_days_and_use_pushes_the_expiry_out() {
    let harness = Harness::start().await;
    let mut kept = sign_in(&harness, "google").await;
    let mut idle = sign_in(&harness, "google").await;
    harness.clock.advance(THIRTY_DAYS - DAY);
    assert_eq!(status_of(&harness, &mut kept).await, 200);
    harness.clock.advance(THIRTY_DAYS - DAY);
    assert_eq!(status_of(&harness, &mut kept).await, 200);
    assert_eq!(status_of(&harness, &mut idle).await, 401);
    harness.clock.advance(THIRTY_DAYS + DAY);
    assert_eq!(status_of(&harness, &mut kept).await, 401);
}

#[tokio::test]
async fn a_session_dies_ninety_days_after_creation_however_often_it_is_used() {
    let harness = Harness::start().await;
    let mut browser = sign_in(&harness, "google").await;
    for _ in 0..3 {
        harness.clock.advance(THIRTY_DAYS - DAY);
        assert_eq!(status_of(&harness, &mut browser).await, 200);
    }
    harness.clock.advance(THIRTY_DAYS - DAY);
    assert_eq!(status_of(&harness, &mut browser).await, 401);
}

#[tokio::test]
async fn last_use_is_written_only_when_more_than_an_hour_old() {
    let harness = Harness::start().await;
    let mut browser = sign_in(&harness, "google").await;
    for _ in 0..5 {
        harness.clock.advance(600);
        assert_eq!(status_of(&harness, &mut browser).await, 200);
    }
    assert_eq!(stored_last_used(&harness).await, START_TIME);
    harness.clock.advance(3600);
    assert_eq!(status_of(&harness, &mut browser).await, 200);
    assert_eq!(stored_last_used(&harness).await, START_TIME + 3000 + 3600);
}

#[tokio::test]
async fn logout_revokes_the_session_and_clears_the_cookie() {
    let harness = Harness::start().await;
    let mut browser = sign_in(&harness, "google").await;
    let stale = cookie_header(&browser);
    let response = post_json(&harness, &browser, "/v1/session/logout", Some(&harness.base), "application/json").await;
    assert_eq!(response.status(), 204);
    let cleared = response.headers()["set-cookie"].to_str().unwrap();
    assert!(cleared.starts_with("vally_session=;") && cleared.contains("Max-Age=0"), "{cleared}");
    let again = harness.http.get(format!("{}/v1/session", harness.base)).header("cookie", stale).send().await.unwrap();
    assert_eq!(again.status(), 401);
    assert_eq!(harness.count("sessions").await, 0);
    assert_eq!(status_of(&harness, &mut browser).await, 401);
}

#[tokio::test]
async fn logout_and_account_deletion_need_the_public_origin_and_a_json_body() {
    let harness = Harness::start().await;
    let mut browser = sign_in(&harness, "google").await;
    let other = format!("{}.evil.test", harness.base);
    let origins: [Option<&str>; 4] = [None, Some("null"), Some(&other), Some(&format!("{}/", harness.base))];
    for origin in origins {
        assert_eq!(post_json(&harness, &browser, "/v1/session/logout", origin, "application/json").await.status(), 403, "{origin:?}");
        assert_eq!(delete_account(&harness, &browser, origin, "application/json").await.status(), 403, "{origin:?}");
    }
    for content_type in ["text/plain", "application/x-www-form-urlencoded", "application/jsonx"] {
        assert_eq!(post_json(&harness, &browser, "/v1/session/logout", Some(&harness.base), content_type).await.status(), 415, "{content_type}");
        assert_eq!(delete_account(&harness, &browser, Some(&harness.base), content_type).await.status(), 415, "{content_type}");
    }
    assert_eq!(status_of(&harness, &mut browser).await, 200);
    assert_eq!(harness.count("accounts").await, 1);
    let charset = post_json(&harness, &browser, "/v1/session/logout", Some(&harness.base), "Application/JSON; charset=utf-8").await;
    assert_eq!(charset.status(), 204);
}

#[tokio::test]
async fn deleting_the_account_by_session_removes_sessions_tokens_and_setup_documents() {
    let harness = Harness::start().await;
    harness.idp.set_subject("leaver");
    let (token, _) = harness.token_for("google", "c").await;
    let pushed = harness
        .http
        .post(format!("{}/v1/setup/push", harness.base))
        .bearer_auth(&token)
        .json(&json!({"documents": [{"kind": "watchlists", "id": "main", "revision": 1, "deleted": false, "body": {"lists": []}}]}))
        .send()
        .await
        .unwrap();
    assert_eq!(pushed.status(), 200);
    let mut browser = sign_in(&harness, "google").await;
    let mut bystander = sign_in_as(&harness, "google", "stays").await;
    assert_eq!(harness.count("setup_documents").await, 1);
    let response = delete_account(&harness, &browser, Some(&harness.base), "application/json").await;
    assert_eq!(response.status(), 204);
    assert_eq!(harness.count("accounts").await, 1);
    assert_eq!(harness.count("identities").await, 1);
    assert_eq!(harness.count("sessions").await, 1);
    assert_eq!(harness.count("connector_tokens").await, 0);
    assert_eq!(harness.count("setup_documents").await, 0);
    assert_eq!(status_of(&harness, &mut browser).await, 401);
    assert_eq!(harness.me(&token).await.status(), 401);
    assert_eq!(status_of(&harness, &mut bystander).await, 200);
}

#[tokio::test]
async fn the_connector_token_can_still_delete_the_account() {
    let harness = Harness::start().await;
    let (token, _) = harness.token_for("google", "a").await;
    let response = harness.http.delete(format!("{}/v1/account", harness.base)).bearer_auth(&token).send().await.unwrap();
    assert_eq!(response.status(), 204);
    assert_eq!(harness.count("accounts").await, 0);
}

#[tokio::test]
async fn the_account_cap_refuses_new_accounts_but_not_existing_ones() {
    let harness = Harness::start_with_options(AccountOptions { max_accounts: 2, ..AccountOptions::default() }).await;
    sign_in_as(&harness, "google", "one").await;
    sign_in_as(&harness, "naver", "two").await;
    harness.idp.set_subject("three");
    let mut third = harness.browser();
    let response = callback_response(&harness, &mut third, "google").await;
    assert_eq!(location(&response).as_str(), error_landing(&harness, "account_limit"));
    assert_eq!(harness.count("accounts").await, 2);
    assert_eq!(harness.count("sessions").await, 2);
    sign_in_as(&harness, "google", "one").await;
    assert_eq!(harness.count("accounts").await, 2);
    assert_eq!(harness.count("sessions").await, 3);
    harness.idp.set_subject("four");
    let mut connector = harness.browser();
    let callback = harness.idp_callback_url(&mut connector, "google", "e").await;
    let refused = harness.finish_error(&mut connector, &callback).await;
    assert_eq!(refused.query["error"], "account_limit");
    assert_eq!(harness.count("accounts").await, 2);
}

#[tokio::test]
async fn concurrent_sign_ups_just_under_the_cap_never_exceed_it() {
    let harness = Arc::new(Harness::start_with_options(AccountOptions { max_accounts: 3, ..AccountOptions::default() }).await);
    sign_in_as(&harness, "google", "existing-a").await;
    sign_in_as(&harness, "google", "existing-b").await;
    let mut pending = Vec::new();
    for index in 0..6 {
        harness.idp.set_subject(&format!("newcomer-{index}"));
        let mut browser = harness.browser();
        let start = browser.get(&format!("{}/v1/session/google/start", harness.base)).await;
        let idp = browser.get(location(&start).as_str()).await;
        let callback = location(&idp);
        pending.push((browser, format!("{}{}?{}", harness.base, callback.path(), callback.query().unwrap())));
    }
    let landings = futures_join(pending).await;
    let admitted = landings.iter().filter(|landing| landing.as_str() == format!("{}/", harness.base)).count();
    assert_eq!(admitted, 1, "{landings:?}");
    assert!(landings.iter().filter(|landing| landing.contains("reason=account_limit")).count() == 5);
    assert_eq!(harness.count("accounts").await, 3);
}

async fn futures_join(pending: Vec<(Browser, String)>) -> Vec<String> {
    let tasks: Vec<_> = pending
        .into_iter()
        .map(|(mut browser, url)| tokio::spawn(async move { location(&browser.get(&url).await).to_string() }))
        .collect();
    let mut landings = Vec::new();
    for task in tasks {
        landings.push(task.await.unwrap());
    }
    landings
}

async fn serve_again(harness: &Harness, options: AccountOptions) -> Harness {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let accounts = Accounts::new(test_config(&base, &harness.idp), options, harness.pool.clone(), harness.clock.clone());
    tokio::spawn(async move {
        axum::serve(listener, accounts.router()).await.unwrap();
    });
    Harness { base, clock: harness.clock.clone(), idp: harness.idp.clone(), pool: harness.pool.clone(), dir: tempfile::tempdir().unwrap(), connector_port: harness.connector_port, http: harness.http.clone() }
}

#[tokio::test]
async fn blocked_identities_cannot_log_in_and_lose_their_sessions() {
    let harness = Harness::start().await;
    let mut doomed = sign_in_as(&harness, "google", "bad").await;
    let mut innocent = sign_in_as(&harness, "google", "good").await;
    let same_subject_other_provider = sign_in_as(&harness, "naver", "bad").await;
    let blocked = BlockedIdentities::new([(Provider::Google, "bad".to_owned())]);
    let restarted = serve_again(&harness, AccountOptions { blocked, ..AccountOptions::default() }).await;
    for (browser, expected) in [(&mut doomed, 401), (&mut innocent, 200)] {
        let response = restarted.http.get(format!("{}/v1/session", restarted.base)).header("cookie", cookie_header(browser)).send().await.unwrap();
        assert_eq!(response.status(), expected);
    }
    let naver = restarted.http.get(format!("{}/v1/session", restarted.base)).header("cookie", cookie_header(&same_subject_other_provider)).send().await.unwrap();
    assert_eq!(naver.status(), 200);
    let sessions_before = harness.count("sessions").await;
    restarted.idp.set_subject("bad");
    let mut attempt = restarted.browser();
    let response = callback_response(&restarted, &mut attempt, "google").await;
    assert_eq!(location(&response).as_str(), error_landing(&restarted, "blocked"));
    assert_eq!(harness.count("sessions").await, sessions_before);
    let mut connector = restarted.browser();
    let callback = restarted.idp_callback_url(&mut connector, "google", "e").await;
    assert_eq!(restarted.finish_error(&mut connector, &callback).await.query["error"], "blocked");
    let deleted = restarted
        .http
        .delete(format!("{}/v1/account", restarted.base))
        .header("cookie", cookie_header(&doomed))
        .header("origin", &restarted.base)
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), 401);
}

#[tokio::test]
async fn starting_a_browser_login_counts_against_the_pending_login_limit() {
    let harness = Harness::start_with_limit(1).await;
    let mut first = harness.browser();
    assert_eq!(first.get(&format!("{}/v1/session/google/start", harness.base)).await.status(), 302);
    let mut second = harness.browser();
    assert_eq!(second.get(&format!("{}/v1/session/google/start", harness.base)).await.status(), 503);
    assert_eq!(harness.count("pending_logins").await, 1);
}

#[tokio::test]
async fn the_library_finds_the_session_account_from_request_headers() {
    let harness = Harness::start().await;
    harness.idp.set_subject("library-subject");
    let browser = sign_in(&harness, "naver").await;
    let accounts = Accounts::new(test_config(&harness.base, &harness.idp), AccountOptions::default(), harness.pool.clone(), harness.clock.clone());
    let headers = |cookie: &str| {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("cookie", cookie.parse().unwrap());
        headers
    };
    let found = accounts.session_account(&headers(&cookie_header(&browser))).await.unwrap().expect("유효한 쿠키");
    assert_eq!(found.provider, Provider::Naver);
    assert_eq!(found.subject, "library-subject");
    let stored: String = sqlx::query_scalar("SELECT account_id FROM identities").fetch_one(&harness.pool).await.unwrap();
    assert_eq!(found.account_id, stored);

    assert!(accounts.session_account(&axum::http::HeaderMap::new()).await.unwrap().is_none());
    assert!(accounts.session_account(&headers("vally_session=garbage")).await.unwrap().is_none());
    assert!(accounts.session_account(&headers(&format!("vally_session={}", "A".repeat(43)))).await.unwrap().is_none());

    let write = json!({"documents": [{"kind": "watchlists", "id": "main", "revision": 1, "deleted": false, "body": {"lists": []}}]});
    let pushed = accounts.setup_push(&found.account_id, write.to_string().as_bytes()).await.unwrap();
    assert_eq!(serde_json::to_value(&pushed).unwrap()["results"][0]["status"], "accepted");
    assert_eq!(accounts.setup_summary(&found.account_id).await.unwrap().documents, 1);
    let changes = accounts.setup_changes(&found.account_id, 0, 100).await.unwrap();
    assert_eq!(changes.documents.len(), 1);
    assert!(accounts.setup_changes(&found.account_id, -1, 100).await.is_err());

    let revoked = cookie_header(&browser);
    let response = post_json(&harness, &browser, "/v1/session/logout", Some(&harness.base), "application/json").await;
    assert_eq!(response.status(), 204);
    assert!(accounts.session_account(&headers(&revoked)).await.unwrap().is_none());

    let mut expiring = sign_in(&harness, "google").await;
    let live = cookie_header(&expiring);
    assert!(accounts.session_account(&headers(&live)).await.unwrap().is_some());
    harness.clock.advance(THIRTY_DAYS + 1);
    assert!(accounts.session_account(&headers(&live)).await.unwrap().is_none());
    assert_eq!(status_of(&harness, &mut expiring).await, 401);
}

#[test]
fn settings_read_the_account_cap_and_the_blocked_identities() {
    use account_server::settings::{Settings, parse_env_file};
    let file = "VALLY_ACCOUNT_PUBLIC_URL=https://accounts.example.test\nVALLY_ACCOUNT_GOOGLE_CLIENT_ID=g\nVALLY_ACCOUNT_GOOGLE_CLIENT_SECRET=gs\nVALLY_ACCOUNT_NAVER_CLIENT_ID=n\nVALLY_ACCOUNT_NAVER_CLIENT_SECRET=ns\n";
    let mut values = parse_env_file(file);
    assert_eq!(Settings::from_values(&values).unwrap().max_accounts, 100);
    values.insert("VALLY_ACCOUNT_MAX_ACCOUNTS".into(), "7".into());
    values.insert("VALLY_ACCOUNT_BLOCKED_IDENTITIES".into(), "google:abc, naver:def".into());
    let options = Settings::from_values(&values).unwrap().account_options();
    assert_eq!(options.max_accounts, 7);
    assert_eq!(options.pending_login_limit, 10_000);
    values.insert("VALLY_ACCOUNT_BLOCKED_IDENTITIES".into(), "kakao:abc".into());
    assert!(Settings::from_values(&values).is_err());
    values.insert("VALLY_ACCOUNT_BLOCKED_IDENTITIES".into(), "google".into());
    assert!(Settings::from_values(&values).is_err());
    values.remove("VALLY_ACCOUNT_BLOCKED_IDENTITIES");
    values.insert("VALLY_ACCOUNT_MAX_ACCOUNTS".into(), "lots".into());
    assert!(Settings::from_values(&values).is_err());
}

#[tokio::test]
async fn a_blocked_identity_loses_its_connector_token_too() {
    let harness = Harness::start().await;
    harness.idp.set_subject("bad");
    let (bad_token, _) = harness.token_for("google", "a").await;
    harness.idp.set_subject("good");
    let (good_token, _) = harness.token_for("google", "b").await;
    let blocked = BlockedIdentities::new([(Provider::Google, "bad".to_owned())]);
    let restarted = serve_again(&harness, AccountOptions { blocked, ..AccountOptions::default() }).await;
    let push = json!({"documents": [{"kind": "watchlists", "id": "main", "revision": 1, "deleted": false, "body": {"lists": []}}]});
    for (token, expected) in [(&bad_token, 401), (&good_token, 200)] {
        assert_eq!(restarted.me(token).await.status(), expected);
        let pushed = restarted.http.post(format!("{}/v1/setup/push", restarted.base)).bearer_auth(token).json(&push).send().await.unwrap();
        assert_eq!(pushed.status(), expected);
    }
    let deleted = restarted.http.delete(format!("{}/v1/account", restarted.base)).bearer_auth(&bad_token).send().await.unwrap();
    assert_eq!(deleted.status(), 401);
    assert_eq!(harness.count("accounts").await, 2);
}

#[tokio::test]
async fn a_code_issued_before_a_block_cannot_be_exchanged_after_it() {
    let harness = Harness::start().await;
    harness.idp.set_subject("bad");
    let bad = harness.login("google", "a").await;
    harness.idp.set_subject("good");
    let good = harness.login("google", "b").await;
    let blocked = BlockedIdentities::new([(Provider::Google, "bad".to_owned())]);
    let restarted = serve_again(&harness, AccountOptions { blocked, ..AccountOptions::default() }).await;
    for _ in 0..2 {
        let refused = restarted.exchange(&bad.code, &bad.verifier).await;
        assert_eq!(refused.status(), 400);
        let body: serde_json::Value = refused.json().await.unwrap();
        assert_eq!(body["code"], "invalid_grant");
        assert_eq!(harness.count("connector_tokens").await, 0);
    }
    let accepted = restarted.exchange(&good.code, &good.verifier).await;
    assert_eq!(accepted.status(), 200);
    let body: serde_json::Value = accepted.json().await.unwrap();
    assert_eq!(restarted.me(body["token"].as_str().unwrap()).await.status(), 200);
    assert_eq!(harness.count("connector_tokens").await, 1);
}

#[tokio::test]
async fn blocked_lists_tolerate_spaces_and_reject_unreadable_entries() {
    let blocked = BlockedIdentities::parse_list("google: bad , naver :  worse ").unwrap();
    let harness = Harness::start_with_options(AccountOptions { blocked, ..AccountOptions::default() }).await;
    for (provider, subject) in [("google", "bad"), ("naver", "worse")] {
        harness.idp.set_subject(subject);
        let mut browser = harness.browser();
        let response = callback_response(&harness, &mut browser, provider).await;
        assert_eq!(location(&response).as_str(), error_landing(&harness, "blocked"), "{provider}:{subject}");
    }
    assert_eq!(harness.count("sessions").await, 0);
    for unreadable in ["google", "google:", "google:  ", "kakao:bad", ":bad"] {
        assert!(BlockedIdentities::parse_list(unreadable).is_err(), "{unreadable:?}");
    }
}

#[tokio::test]
async fn the_browser_router_takes_only_session_cookies() {
    let harness = Harness::start().await;
    harness.idp.set_subject("owner");
    let (token, _) = harness.token_for("google", "a").await;
    let browser = sign_in(&harness, "google").await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let accounts = Accounts::new(test_config(&harness.base, &harness.idp), AccountOptions::default(), harness.pool.clone(), harness.clock.clone());
    tokio::spawn(async move {
        axum::serve(listener, accounts.browser_router()).await.unwrap();
    });
    for path in ["/v1/me", "/v1/setup/summary", "/v1/auth/token", "/v1/auth/google/start"] {
        let response = harness.http.get(format!("{base}{path}")).bearer_auth(&token).send().await.unwrap();
        assert_eq!(response.status(), 404, "{path}");
    }
    let by_token = harness.http.delete(format!("{base}/v1/account")).bearer_auth(&token).send().await.unwrap();
    assert_eq!(by_token.status(), 401);
    assert_eq!(harness.count("accounts").await, 1);
    let by_session = harness
        .http
        .delete(format!("{base}/v1/account"))
        .header("cookie", cookie_header(&browser))
        .header("origin", &harness.base)
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(by_session.status(), 204);
    assert_eq!(harness.count("accounts").await, 0);
}
