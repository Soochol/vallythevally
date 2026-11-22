#![allow(dead_code)]
use account_server::fake_idp::{ClientCredentials, FakeIdp};
use account_server::{
    AccountConfig, AccountOptions, Accounts, GoogleConfig, IdpUrl, ManualClock, NaverConfig, PublicUrl, Secret, UnixSeconds, open_database,
};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::sync::Arc;
use url::Url;

pub const GOOGLE_ID: &str = "google-client-id.test";
pub const GOOGLE_SECRET: &str = "google-secret-must-not-leak-7f3a";
pub const NAVER_ID: &str = "naver-client-id-test";
pub const NAVER_SECRET: &str = "naver-secret-must-not-leak-91bc";
pub const EMAIL: &str = "private.person@mail-leak.test";
pub const START_TIME: i64 = 1_800_000_000;

pub fn credentials(id: &str, secret: &str) -> ClientCredentials {
    ClientCredentials { id: id.into(), secret: secret.into() }
}

pub fn challenge_of(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn connector_state(label: &str) -> String {
    format!("connector-state-{label}-0123456789")
}

pub fn verifier(label: &str) -> String {
    format!("verifier-{label}-abcdefghijklmnopqrstuvwxyz0123456789")
}

pub struct Browser {
    pub http: reqwest::Client,
    pub account_origin: String,
    pub cookies: std::collections::BTreeMap<String, String>,
    pub set_cookies: Vec<String>,
    pub seen: Vec<String>,
}

impl Browser {
    pub fn new(account_origin: &str) -> Self {
        let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        Self { http, account_origin: account_origin.to_owned(), cookies: Default::default(), set_cookies: Vec::new(), seen: Vec::new() }
    }

    pub async fn get(&mut self, url: &str) -> reqwest::Response {
        let mut request = self.http.get(url);
        if !self.cookies.is_empty() && url.starts_with(&self.account_origin) {
            let line: Vec<String> = self.cookies.iter().map(|(name, value)| format!("{name}={value}")).collect();
            request = request.header("cookie", line.join("; "));
        }
        let response = request.send().await.unwrap();
        if url.starts_with(&self.account_origin) {
            for value in response.headers().get_all("set-cookie") {
                let line = value.to_str().unwrap();
                self.set_cookies.push(line.to_owned());
                let (name, cookie_value) = line.split(';').next().unwrap().split_once('=').unwrap();
                if cookie_value.is_empty() {
                    self.cookies.remove(name);
                } else {
                    self.cookies.insert(name.to_owned(), cookie_value.to_owned());
                }
            }
        }
        for (name, value) in response.headers() {
            self.seen.push(format!("{name}: {}", value.to_str().unwrap_or_default()));
        }
        response
    }
}

pub fn location(response: &reqwest::Response) -> Url {
    assert_eq!(response.status(), 302, "리다이렉트여야 한다");
    Url::parse(response.headers()["location"].to_str().unwrap()).unwrap()
}

pub struct Harness {
    pub clock: Arc<ManualClock>,
    pub idp: Arc<FakeIdp>,
    pub base: String,
    pub pool: SqlitePool,
    pub dir: tempfile::TempDir,
    pub connector_port: u16,
    pub http: reqwest::Client,
}

pub struct Completed {
    pub code: String,
    pub state: String,
    pub verifier: String,
}

pub struct Redirected {
    pub query: std::collections::HashMap<String, String>,
}

impl Harness {
    pub async fn start() -> Self {
        Self::start_with_limit(10_000).await
    }

    pub async fn start_with_limit(pending_login_limit: u32) -> Self {
        Self::start_with_options(AccountOptions { pending_login_limit, ..AccountOptions::default() }).await
    }

    pub async fn start_with_options(options: AccountOptions) -> Self {
        Self::start_configured(options, None).await
    }

    pub async fn start_configured(options: AccountOptions, public_origin: Option<&str>) -> Self {
        let clock = Arc::new(ManualClock::new(UnixSeconds(START_TIME)));
        let idp = Arc::new(FakeIdp::start(credentials(GOOGLE_ID, GOOGLE_SECRET), credentials(NAVER_ID, NAVER_SECRET), clock.clone()).await);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let config = test_config(public_origin.unwrap_or(&base), &idp);
        let dir = tempfile::tempdir().unwrap();
        let pool = open_database(&dir.path().join("account.db")).await.unwrap();
        let app = Accounts::new(config, options, pool.clone(), clock.clone()).router();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let connector = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let connector_port = connector.local_addr().unwrap().port();
        let receiver = axum::Router::new().route("/auth/complete", axum::routing::get(|| async { "connector" }));
        tokio::spawn(async move {
            axum::serve(connector, receiver).await.unwrap();
        });
        let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        Self { clock, idp, base, pool, dir, connector_port, http }
    }

    pub fn browser(&self) -> Browser {
        Browser::new(&self.base)
    }

    pub fn start_url(&self, provider: &str, label: &str) -> String {
        self.start_url_with(provider, &self.connector_port.to_string(), &connector_state(label), &challenge_of(&verifier(label)), "S256")
    }

    pub fn start_url_with(&self, provider: &str, port: &str, state: &str, challenge: &str, method: &str) -> String {
        format!(
            "{}/v1/auth/{provider}/start?port={port}&state={state}&code_challenge={challenge}&code_challenge_method={method}",
            self.base
        )
    }

    pub async fn idp_callback_url(&self, browser: &mut Browser, provider: &str, label: &str) -> String {
        let start = browser.get(&self.start_url(provider, label)).await;
        let authorize = location(&start);
        let idp = browser.get(authorize.as_str()).await;
        location(&idp).to_string()
    }

    pub async fn finish(&self, browser: &mut Browser, callback: &str, label: &str) -> Redirected {
        let response = browser.get(callback).await;
        let target = location(&response);
        assert_eq!(target.scheme(), "http");
        assert_eq!(target.host_str(), Some("127.0.0.1"));
        assert_eq!(target.port(), Some(self.connector_port));
        assert_eq!(target.path(), "/auth/complete");
        let query: std::collections::HashMap<String, String> = target.query_pairs().into_owned().collect();
        assert_eq!(query["state"], connector_state(label));
        let delivered = browser.get(target.as_str()).await;
        assert_eq!(delivered.status(), 200);
        Redirected { query }
    }

    pub async fn login(&self, provider: &str, label: &str) -> Completed {
        let mut browser = self.browser();
        let callback = self.idp_callback_url(&mut browser, provider, label).await;
        let redirected = self.finish(&mut browser, &callback, label).await;
        Completed { code: redirected.query["code"].clone(), state: redirected.query["state"].clone(), verifier: verifier(label) }
    }

    pub async fn exchange(&self, code: &str, verifier: &str) -> reqwest::Response {
        self.http
            .post(format!("{}/v1/auth/token", self.base))
            .json(&serde_json::json!({"code": code, "codeVerifier": verifier}))
            .send()
            .await
            .unwrap()
    }

    pub async fn token_for(&self, provider: &str, label: &str) -> (String, serde_json::Value) {
        let completed = self.login(provider, label).await;
        let response = self.exchange(&completed.code, &completed.verifier).await;
        assert_eq!(response.status(), 200);
        let body: serde_json::Value = response.json().await.unwrap();
        (body["token"].as_str().unwrap().to_owned(), body["account"].clone())
    }

    pub async fn me(&self, token: &str) -> reqwest::Response {
        self.http.get(format!("{}/v1/me", self.base)).bearer_auth(token).send().await.unwrap()
    }

    pub async fn count(&self, table: &str) -> i64 {
        let sql: &'static str = match table {
            "accounts" => "SELECT COUNT(*) FROM accounts",
            "identities" => "SELECT COUNT(*) FROM identities",
            "pending_logins" => "SELECT COUNT(*) FROM pending_logins",
            "auth_codes" => "SELECT COUNT(*) FROM auth_codes",
            "connector_tokens" => "SELECT COUNT(*) FROM connector_tokens",
            "sessions" => "SELECT COUNT(*) FROM sessions",
            "setup_documents" => "SELECT COUNT(*) FROM setup_documents",
            other => panic!("모르는 표 {other}"),
        };
        sqlx::query_scalar(sql).fetch_one(&self.pool).await.unwrap()
    }

    pub async fn dump(&self) -> Vec<u8> {
        let path = self.dir.path().join("dump.db");
        let _ = std::fs::remove_file(&path);
        sqlx::query("VACUUM INTO ?").bind(path.to_str().unwrap()).execute(&self.pool).await.unwrap();
        std::fs::read(path).unwrap()
    }
}

pub fn test_config(base: &str, idp: &FakeIdp) -> AccountConfig {
    let endpoint = |path: &str| IdpUrl::parse(&idp.url(path)).unwrap();
    AccountConfig {
        public_url: PublicUrl::parse(base).unwrap(),
        google: GoogleConfig {
            client_id: GOOGLE_ID.into(),
            client_secret: Secret::new(GOOGLE_SECRET),
            authorize_url: endpoint("/google/authorize"),
            token_url: endpoint("/google/token"),
        },
        naver: NaverConfig {
            client_id: NAVER_ID.into(),
            client_secret: Secret::new(NAVER_SECRET),
            authorize_url: endpoint("/naver/authorize"),
            token_url: endpoint("/naver/token"),
            profile_url: endpoint("/naver/profile"),
        },
    }
}

pub fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle.as_bytes())
}

pub async fn assert_connector_error(harness: &Harness, provider: &str, expected: &str) {
    let mut browser = harness.browser();
    let callback = harness.idp_callback_url(&mut browser, provider, "e").await;
    let redirected = harness.finish_error(&mut browser, &callback).await;
    assert_eq!(redirected.query["error"], expected);
    assert!(!redirected.query.contains_key("code"));
}

impl Harness {
    pub async fn finish_error(&self, browser: &mut Browser, callback: &str) -> Redirected {
        let target = location(&browser.get(callback).await);
        assert_eq!(target.host_str(), Some("127.0.0.1"));
        assert_eq!(target.path(), "/auth/complete");
        let query: std::collections::HashMap<String, String> = target.query_pairs().into_owned().collect();
        assert_eq!(query["state"], connector_state("e"));
        Redirected { query }
    }
}

