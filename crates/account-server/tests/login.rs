mod common;

use common::*;
use account_server::{Clock, PublicUrl, Secret, IdpUrl, router};
use account_server::fake_idp::Fault;
use std::sync::Arc;
use url::Url;

async fn round_trip(provider: &str) {
    let harness = Harness::start().await;
    harness.idp.set_email(EMAIL);
    let completed = harness.login(provider, "a").await;
    assert_eq!(completed.state, connector_state("a"));
    let response = harness.exchange(&completed.code, &completed.verifier).await;
    assert_eq!(response.status(), 200);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["account"]["provider"], provider);
    let token = body["token"].as_str().unwrap();
    let me: serde_json::Value = harness.me(token).await.json().await.unwrap();
    assert_eq!(me["id"], body["account"]["id"]);
    assert_eq!(me["provider"], provider);
    assert_eq!(me["createdAt"], START_TIME);
}

#[tokio::test]
async fn me_reports_the_subject_the_provider_gave_at_login() {
    for provider in ["google", "naver"] {
        let harness = Harness::start().await;
        harness.idp.set_subject("subject-for-me");
        let (token, _) = harness.token_for(provider, "a").await;
        let me: serde_json::Value = harness.me(&token).await.json().await.unwrap();
        assert_eq!(me["provider"], provider);
        assert_eq!(me["subject"], "subject-for-me");
    }
}

#[tokio::test]
async fn google_login_reaches_the_connector_and_yields_a_token() {
    round_trip("google").await;
}

#[tokio::test]
async fn naver_login_reaches_the_connector_and_yields_a_token() {
    round_trip("naver").await;
}

#[tokio::test]
async fn google_asks_for_openid_scope_only_and_binds_a_nonce() {
    let harness = Harness::start().await;
    harness.login("google", "a").await;
    let requests = harness.idp.authorize_requests("google");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["scope"], "openid");
    assert_eq!(requests[0]["response_type"], "code");
    assert!(requests[0]["nonce"].len() >= 32);
    assert_eq!(requests[0]["redirect_uri"], format!("{}/v1/auth/google/callback", harness.base));
}

#[tokio::test]
async fn google_asks_to_pick_an_account_and_naver_is_left_alone() {
    let harness = Harness::start().await;
    harness.login("google", "a").await;
    harness.login("naver", "b").await;
    assert_eq!(harness.idp.authorize_requests("google")[0]["prompt"], "select_account");
    assert!(!harness.idp.authorize_requests("naver")[0].contains_key("prompt"));
}

#[tokio::test]
async fn identity_is_provider_and_subject_and_nothing_else_is_stored() {
    let harness = Harness::start().await;
    harness.idp.set_email(EMAIL);
    harness.idp.set_subject("shared-subject");
    let (_, first) = harness.token_for("google", "a").await;
    let (_, again) = harness.token_for("google", "b").await;
    let (token, other_provider) = harness.token_for("naver", "c").await;
    assert_eq!(first["id"], again["id"]);
    assert_ne!(first["id"], other_provider["id"]);
    assert_eq!(harness.count("accounts").await, 2);
    assert_eq!(harness.count("identities").await, 2);
    let dump = harness.dump().await;
    assert!(!contains(&dump, EMAIL));
    assert!(!contains(&dump, "Fake Person"));
    assert!(!contains(&dump, "fake-google-access"));
    assert!(!contains(&dump, "fake-naver-access"));
    assert!(!contains(&dump, &token));
    assert!(!contains(&dump, GOOGLE_SECRET));
    assert!(!contains(&dump, NAVER_SECRET));
    assert!(contains(&dump, "shared-subject"));
}

#[tokio::test]
async fn invalid_start_inputs_never_reach_the_idp() {
    let harness = Harness::start().await;
    let state = connector_state("a");
    let challenge = challenge_of(&verifier("a"));
    let bad = [
        harness.start_url_with("google", "80", &state, &challenge, "S256"),
        harness.start_url_with("google", "1023", &state, &challenge, "S256"),
        harness.start_url_with("google", "99999", &state, &challenge, "S256"),
        harness.start_url_with("google", "abc", &state, &challenge, "S256"),
        harness.start_url_with("google", "8080", &state, &challenge, "plain"),
        harness.start_url_with("google", "8080", "short", &challenge, "S256"),
        harness.start_url_with("google", "8080", "state%40evil.test%2f%2f%2f%2f%2f%2f", &challenge, "S256"),
        harness.start_url_with("google", "8080", &state, "tooshort", "S256"),
        format!("{}/v1/auth/google/start", harness.base),
    ];
    let mut browser = harness.browser();
    for url in bad {
        let response = browser.get(&url).await;
        assert_eq!(response.status(), 400, "{url}");
        assert!(response.headers().get("location").is_none());
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["code"], "invalid_request");
    }
    let unknown = browser.get(&harness.start_url("github", "a")).await;
    assert_eq!(unknown.status(), 404);
    assert!(harness.idp.authorize_requests("google").is_empty());
    assert_eq!(harness.count("pending_logins").await, 0);
    let edge = browser.get(&harness.start_url_with("naver", "65535", &state, &challenge, "S256")).await;
    assert_eq!(edge.status(), 302);
}

#[tokio::test]
async fn the_connector_redirect_host_is_always_loopback() {
    let harness = Harness::start().await;
    for (provider, port) in [("google", "1024"), ("naver", "65535")] {
        let mut browser = harness.browser();
        let start = harness.start_url_with(provider, port, &connector_state("p"), &challenge_of(&verifier("p")), "S256");
        let authorize = location(&browser.get(&start).await);
        let callback = location(&browser.get(authorize.as_str()).await);
        let target = location(&browser.get(callback.as_str()).await);
        assert_eq!(target.host_str(), Some("127.0.0.1"));
        assert_eq!(target.port(), Some(port.parse().unwrap()));
        assert_eq!(target.path(), "/auth/complete");
    }
}

#[tokio::test]
async fn callback_without_the_matching_browser_never_reaches_the_connector() {
    let harness = Harness::start().await;

    let mut victim = harness.browser();
    let callback = harness.idp_callback_url(&mut victim, "google", "a").await;

    let mut no_cookie = harness.browser();
    let response = no_cookie.get(&callback).await;
    assert_eq!(response.status(), 400);
    assert!(response.headers().get("location").is_none());

    let mut other = harness.browser();
    let _ = other.get(&harness.start_url("google", "b")).await;
    assert_eq!(other.cookies.len(), 1);
    let response = other.get(&callback).await;
    assert_eq!(response.status(), 400);
    assert!(response.headers().get("location").is_none());

    let mut wrong_state = harness.browser();
    wrong_state.get(&harness.start_url("google", "c")).await;
    let swapped = callback.replace("state=", "state=x");
    let response = wrong_state.get(&swapped).await;
    assert_eq!(response.status(), 400);
    assert!(response.headers().get("location").is_none());

    let mut wrong_provider = victim;
    let response = wrong_provider.get(&callback.replace("/google/", "/naver/")).await;
    assert_eq!(response.status(), 400);
    assert_eq!(harness.count("auth_codes").await, 0);
}

#[tokio::test]
async fn an_expired_pending_login_is_not_completed() {
    let harness = Harness::start().await;
    let mut browser = harness.browser();
    let callback = harness.idp_callback_url(&mut browser, "naver", "a").await;
    harness.clock.advance(601);
    let response = browser.get(&callback).await;
    assert_eq!(response.status(), 400);
    assert!(response.headers().get("location").is_none());
    assert_eq!(harness.count("auth_codes").await, 0);
}

#[tokio::test]
async fn a_pending_login_completes_once() {
    let harness = Harness::start().await;
    let mut browser = harness.browser();
    let callback = harness.idp_callback_url(&mut browser, "google", "a").await;
    harness.finish(&mut browser, &callback, "a").await;
    let replay = browser.get(&callback).await;
    assert_eq!(replay.status(), 400);
}

async fn assert_grant_rejected(response: reqwest::Response) {
    assert_eq!(response.status(), 400);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["code"], "invalid_grant");
}

#[tokio::test]
async fn a_one_time_code_works_once_with_the_right_verifier_in_time() {
    let harness = Harness::start().await;

    let used = harness.login("google", "a").await;
    harness.clock.advance(59);
    assert_eq!(harness.exchange(&used.code, &used.verifier).await.status(), 200);
    assert_grant_rejected(harness.exchange(&used.code, &used.verifier).await).await;

    let guessed = harness.login("google", "b").await;
    assert_grant_rejected(harness.exchange(&guessed.code, &verifier("other")).await).await;
    assert_grant_rejected(harness.exchange(&guessed.code, &guessed.verifier).await).await;

    let late = harness.login("naver", "c").await;
    harness.clock.advance(61);
    assert_grant_rejected(harness.exchange(&late.code, &late.verifier).await).await;

    assert_grant_rejected(harness.exchange("never-issued", &used.verifier).await).await;
    let malformed = harness.http.post(format!("{}/v1/auth/token", harness.base)).body("nope").send().await.unwrap();
    assert_eq!(malformed.status(), 400);
    assert_eq!(harness.count("connector_tokens").await, 1);
}

#[tokio::test]
async fn bad_id_tokens_do_not_log_anyone_in() {
    let harness = Harness::start().await;
    for fault in [Fault::WrongAudience, Fault::ExtraAudience, Fault::WrongIssuer, Fault::WrongNonce, Fault::ExpiredIdToken, Fault::TokenExchangeRejected] {
        harness.idp.set_fault(fault);
        assert_connector_error(&harness, "google", "idp_failed").await;
    }
    assert_eq!(harness.count("accounts").await, 0);
    assert_eq!(harness.count("auth_codes").await, 0);
}

#[tokio::test]
async fn naver_failures_do_not_log_anyone_in() {
    let harness = Harness::start().await;
    for fault in [Fault::ProfileFailure, Fault::TokenExchangeRejected] {
        harness.idp.set_fault(fault);
        assert_connector_error(&harness, "naver", "idp_failed").await;
    }
    assert_eq!(harness.count("accounts").await, 0);
}

#[tokio::test]
async fn cancelling_at_the_idp_returns_an_error_to_the_connector() {
    let harness = Harness::start().await;
    for provider in ["google", "naver"] {
        harness.idp.cancel_next_authorization();
        assert_connector_error(&harness, provider, "cancelled").await;
    }
    assert_eq!(harness.count("accounts").await, 0);
}

#[tokio::test]
async fn tokens_are_stored_hashed_revoked_and_expire_after_90_idle_days() {
    let harness = Harness::start().await;
    let day = 24 * 60 * 60;

    let (revoked, _) = harness.token_for("google", "a").await;
    assert_eq!(harness.me(&revoked).await.status(), 200);
    let logout = harness.http.delete(format!("{}/v1/auth/token", harness.base)).bearer_auth(&revoked).send().await.unwrap();
    assert_eq!(logout.status(), 204);
    assert_eq!(harness.me(&revoked).await.status(), 401);
    assert!(!contains(&harness.dump().await, &revoked));

    harness.idp.set_subject("subject-2");
    let (kept, _) = harness.token_for("google", "b").await;
    harness.clock.advance(60 * day);
    assert_eq!(harness.me(&kept).await.status(), 200);
    harness.clock.advance(60 * day);
    assert_eq!(harness.me(&kept).await.status(), 200);

    harness.clock.advance(90 * day + 1);
    let expired = harness.me(&kept).await;
    assert_eq!(expired.status(), 401);
    let body: serde_json::Value = expired.json().await.unwrap();
    assert_eq!(body["code"], "unauthorized");

    for header in [None, Some("Bearer short"), Some("Basic abc")] {
        let mut request = harness.http.get(format!("{}/v1/me", harness.base));
        if let Some(value) = header {
            request = request.header("authorization", value);
        }
        assert_eq!(request.send().await.unwrap().status(), 401);
    }
}

#[tokio::test]
async fn deleting_an_account_removes_identity_and_every_token() {
    let harness = Harness::start().await;
    harness.idp.set_subject("leaving");
    let (first, account) = harness.token_for("google", "a").await;
    let (second, _) = harness.token_for("google", "b").await;
    harness.idp.set_subject("staying");
    let (stayer, _) = harness.token_for("google", "c").await;

    let deleted = harness.http.delete(format!("{}/v1/account", harness.base)).bearer_auth(&first).send().await.unwrap();
    assert_eq!(deleted.status(), 204);
    assert_eq!(harness.me(&first).await.status(), 401);
    assert_eq!(harness.me(&second).await.status(), 401);
    assert_eq!(harness.me(&stayer).await.status(), 200);
    assert_eq!(harness.count("identities").await, 1);
    assert_eq!(harness.count("connector_tokens").await, 1);
    assert_eq!(harness.count("accounts").await, 1);

    harness.idp.set_subject("leaving");
    let (_, reborn) = harness.token_for("google", "d").await;
    assert_ne!(reborn["id"], account["id"]);
}

#[tokio::test]
async fn responses_use_one_error_shape_and_no_cors() {
    let harness = Harness::start().await;
    let missing = harness.http.get(format!("{}/v1/nothing", harness.base)).header("origin", "https://evil.test").send().await.unwrap();
    assert_eq!(missing.status(), 404);
    assert!(missing.headers().get("access-control-allow-origin").is_none());
    let body: serde_json::Value = missing.json().await.unwrap();
    assert!(body["code"].is_string() && body["message"].is_string());

    let wrong_method = harness.http.post(format!("{}/v1/me", harness.base)).send().await.unwrap();
    assert_eq!(wrong_method.status(), 405);
    let preflight = harness
        .http
        .request(reqwest::Method::OPTIONS, format!("{}/v1/me", harness.base))
        .header("origin", "https://evil.test")
        .header("access-control-request-method", "GET")
        .send()
        .await
        .unwrap();
    assert!(preflight.headers().get("access-control-allow-origin").is_none());
    let unauthorized = harness.http.get(format!("{}/v1/me", harness.base)).send().await.unwrap();
    assert_eq!(unauthorized.headers()["cache-control"], "no-store");
}

#[tokio::test]
async fn the_login_cookie_uses_the_host_prefix_on_https_and_none_on_loopback_http() {
    let harness = Harness::start().await;
    let mut config = test_config(&harness.base, &harness.idp);
    config.public_url = PublicUrl::parse("https://accounts.example.test").unwrap();
    let app = router(config, harness.pool.clone(), harness.clock.clone() as Arc<dyn Clock>);
    let request = axum::http::Request::builder()
        .uri(format!(
            "/v1/auth/google/start?port=4000&state={}&code_challenge={}&code_challenge_method=S256",
            connector_state("a"),
            challenge_of(&verifier("a"))
        ))
        .body(axum::body::Body::empty())
        .unwrap();
    let response = tower::ServiceExt::oneshot(app, request).await.unwrap();
    assert_eq!(response.status(), 302);
    let cookie = response.headers()["set-cookie"].to_str().unwrap();
    let authorize = response.headers()["location"].to_str().unwrap();
    let idp_state = Url::parse(authorize).unwrap().query_pairs().find(|(name, _)| name == "state").unwrap().1.into_owned();
    assert!(cookie.starts_with(&format!("__Host-vally_login_{idp_state}=")), "{cookie}");
    for required in ["Secure", "Path=/", "HttpOnly", "SameSite=Lax"] {
        assert!(cookie.contains(required), "{cookie}");
    }
    assert!(!cookie.contains("Domain"));
    assert!(authorize.contains("redirect_uri=https%3A%2F%2Faccounts.example.test%2Fv1%2Fauth%2Fgoogle%2Fcallback"));

    let mut browser = harness.browser();
    let start = browser.get(&harness.start_url("google", "a")).await;
    let cookie = start.headers()["set-cookie"].to_str().unwrap();
    let idp_state = location(&start).query_pairs().find(|(name, _)| name == "state").unwrap().1.into_owned();
    assert!(cookie.starts_with(&format!("vally_login_{idp_state}=")), "{cookie}");
    assert!(!cookie.contains("Secure"));
}

#[test]
fn configuration_rejects_unsafe_addresses_and_hides_secrets() {
    assert!(PublicUrl::parse("https://accounts.example.test").is_ok());
    assert!(PublicUrl::parse("http://127.0.0.1:8090").is_ok());
    for bad in ["http://accounts.example.test", "http://localhost:8090", "ftp://127.0.0.1", "https://a.test/path", "https://a.test/?q=1", "https://:pw@a.test", "https://user:pw@a.test", "nonsense"] {
        assert!(PublicUrl::parse(bad).is_err(), "{bad}");
    }
    assert!(IdpUrl::parse("http://example.test/token").is_err());
    assert!(IdpUrl::parse("http://127.0.0.1:9/token").is_ok());
    assert!(IdpUrl::parse("https://user:pw@idp.test/token").is_err());
    assert!(IdpUrl::parse("https://:pw@idp.test/token").is_err());
    assert_eq!(format!("{:?}", Secret::new("hunter2")), "Secret(***)");
}

#[test]
fn settings_read_names_defaults_and_env_files() {
    use account_server::settings::{Settings, parse_env_file};
    let file = "# 주석\nVALLY_ACCOUNT_PUBLIC_URL=\"https://accounts.example.test\"\nVALLY_ACCOUNT_GOOGLE_CLIENT_ID=g\nVALLY_ACCOUNT_GOOGLE_CLIENT_SECRET='gs'\nVALLY_ACCOUNT_NAVER_CLIENT_ID=n\nVALLY_ACCOUNT_NAVER_CLIENT_SECRET=ns\n";
    let mut values = parse_env_file(file);
    let settings = Settings::from_values(&values).unwrap();
    assert_eq!(settings.bind.to_string(), "127.0.0.1:8090");
    assert_eq!(settings.database_path.to_str(), Some("data/account.db"));
    assert_eq!(settings.config.google.client_secret.expose(), "gs");
    assert_eq!(settings.pending_login_limit, 10_000);
    values.insert("VALLY_ACCOUNT_PENDING_LOGIN_LIMIT".into(), "25".into());
    assert_eq!(Settings::from_values(&values).unwrap().pending_login_limit, 25);
    values.insert("VALLY_ACCOUNT_PENDING_LOGIN_LIMIT".into(), "many".into());
    assert!(Settings::from_values(&values).is_err());
    values.remove("VALLY_ACCOUNT_PENDING_LOGIN_LIMIT");
    values.remove("VALLY_ACCOUNT_NAVER_CLIENT_SECRET");
    let error = Settings::from_values(&values).err().unwrap();
    assert!(error.to_string().contains("VALLY_ACCOUNT_NAVER_CLIENT_SECRET"));
    assert!(!format!("{:?}", settings.config).contains("gs\""));
}

#[tokio::test]
async fn framework_rejections_use_the_json_error_shape() {
    let harness = Harness::start().await;
    let oversized = harness.http.post(format!("{}/v1/auth/token", harness.base)).body("x".repeat(5000)).send().await.unwrap();
    assert_eq!(oversized.status(), 413);
    let body: serde_json::Value = oversized.json().await.unwrap();
    assert!(body["code"].is_string() && body["message"].is_string());

    let bad_path = harness.http.get(format!("{}/v1/auth/%FF/start", harness.base)).send().await.unwrap();
    assert_eq!(bad_path.status(), 400);
    let body: serde_json::Value = bad_path.json().await.unwrap();
    assert!(body["code"].is_string() && body["message"].is_string());
}

fn idp_state_of(callback: &str) -> String {
    Url::parse(callback).unwrap().query_pairs().find(|(name, _)| name == "state").unwrap().1.into_owned()
}

#[tokio::test]
async fn two_logins_in_one_browser_both_reach_the_connector_in_either_order() {
    for first_finished in ["a", "b"] {
        let harness = Harness::start().await;
        let mut browser = harness.browser();
        let callback_a = harness.idp_callback_url(&mut browser, "google", "a").await;
        let callback_b = harness.idp_callback_url(&mut browser, "naver", "b").await;
        assert_eq!(browser.cookies.len(), 2);
        let (first, second) = if first_finished == "a" { (("a", &callback_a), ("b", &callback_b)) } else { (("b", &callback_b), ("a", &callback_a)) };
        for (label, callback) in [first, second] {
            let redirected = harness.finish(&mut browser, callback, label).await;
            assert!(redirected.query.contains_key("code"), "{label}");
        }
        assert!(browser.cookies.is_empty());
    }
}

#[tokio::test]
async fn a_callback_clears_only_its_own_login_cookie() {
    let harness = Harness::start().await;
    let mut browser = harness.browser();
    let callback_a = harness.idp_callback_url(&mut browser, "google", "a").await;
    let _callback_b = harness.idp_callback_url(&mut browser, "google", "b").await;
    let before = browser.set_cookies.len();
    harness.finish(&mut browser, &callback_a, "a").await;
    let cleared = &browser.set_cookies[before..];
    assert_eq!(cleared.len(), 1);
    assert!(cleared[0].starts_with(&format!("vally_login_{}=;", idp_state_of(&callback_a))), "{}", cleared[0]);
    assert!(cleared[0].contains("Max-Age=0"));
    assert_eq!(browser.cookies.len(), 1);
}

async fn start_status(harness: &Harness, label: &str) -> reqwest::Response {
    harness.browser().get(&harness.start_url("google", label)).await
}

#[tokio::test]
async fn a_full_pending_login_table_turns_start_into_a_busy_page_without_side_effects() {
    let harness = Harness::start_with_limit(3).await;
    for label in ["a", "b", "c"] {
        let mut browser = harness.browser();
        let authorize = location(&browser.get(&harness.start_url("google", label)).await);
        browser.get(authorize.as_str()).await;
    }
    assert_eq!(harness.idp.authorize_requests("google").len(), 3);
    assert_eq!(harness.count("pending_logins").await, 3);

    let response = start_status(&harness, "d").await;
    assert_eq!(response.status(), 503);
    assert!(response.headers().contains_key("retry-after"));
    assert!(response.headers()["content-type"].to_str().unwrap().starts_with("text/html"));
    assert!(response.headers().get("location").is_none());
    assert!(response.headers().get("set-cookie").is_none());
    let body = response.text().await.unwrap();
    assert!(body.contains("로그인 요청이 많아"));
    assert_eq!(harness.idp.authorize_requests("google").len(), 3);
    assert_eq!(harness.count("pending_logins").await, 3);
}

#[tokio::test]
async fn expired_pending_logins_do_not_count_toward_the_limit() {
    let harness = Harness::start_with_limit(2).await;
    assert_eq!(start_status(&harness, "a").await.status(), 302);
    assert_eq!(start_status(&harness, "b").await.status(), 302);
    assert_eq!(start_status(&harness, "c").await.status(), 503);
    harness.clock.advance(601);
    assert_eq!(start_status(&harness, "d").await.status(), 302);
    assert_eq!(harness.count("pending_logins").await, 1);
}

#[tokio::test]
async fn concurrent_starts_never_push_pending_logins_past_the_limit() {
    let harness = Arc::new(Harness::start_with_limit(5).await);
    for label in ["a", "b", "c"] {
        assert_eq!(start_status(&harness, label).await.status(), 302);
    }
    let mut starts = tokio::task::JoinSet::new();
    for index in 0..20 {
        let harness = harness.clone();
        starts.spawn(async move { start_status(&harness, &format!("n{index}")).await.status().as_u16() });
    }
    let mut statuses = Vec::new();
    while let Some(status) = starts.join_next().await {
        statuses.push(status.unwrap());
    }
    assert_eq!(statuses.iter().filter(|status| **status == 302).count(), 2);
    assert_eq!(statuses.iter().filter(|status| **status == 503).count(), 18);
    assert_eq!(harness.count("pending_logins").await, 5);
}
