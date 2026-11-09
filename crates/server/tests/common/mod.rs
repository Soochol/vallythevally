//! 통합 테스트용 가짜 키움 서버와 서버 프로세스. 실제 키움에는 절대 연결하지 않는다.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

pub const APP_KEY: &str = "FAKE-APPKEY-e2e-7f3a91c2";
pub const APP_SECRET: &str = "FAKE-SECRET-e2e-c0ffee42";
pub const TOKEN: &str = "FAKE-TOKEN-e2e-5eed1234";

#[derive(Default)]
pub struct Seen {
    pub requests: AtomicUsize,
    pub api_ids: Mutex<Vec<String>>,
    pub authorizations: Mutex<Vec<String>>,
    pub token_bodies: Mutex<Vec<Value>>,
    pub overrides: Mutex<std::collections::HashMap<String, (u16, Value)>>,
    pub rejected_tokens: Mutex<Vec<String>>,
}

pub struct FakeKiwoom {
    pub addr: SocketAddr,
    pub seen: Arc<Seen>,
}

impl FakeKiwoom {
    pub async fn start() -> FakeKiwoom {
        let seen = Arc::new(Seen::default());
        let app = Router::new()
            .route("/oauth2/token", post(handle))
            .route("/api/dostk/chart", post(handle))
            .route("/api/dostk/stkinfo", post(handle))
            .with_state(seen.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        FakeKiwoom { addr, seen }
    }

    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn respond_with(&self, api_id: &str, status: u16, body: Value) {
        self.seen.overrides.lock().unwrap().insert(api_id.to_owned(), (status, body));
    }

    pub fn reject_token(&self, token: &str) {
        self.seen.rejected_tokens.lock().unwrap().push(format!("Bearer {token}"));
    }

    pub fn issued(&self) -> usize {
        self.api_ids().iter().filter(|a| *a == "au10001").count()
    }

    pub fn api_ids(&self) -> Vec<String> {
        self.seen.api_ids.lock().unwrap().clone()
    }

    pub fn requests(&self) -> usize {
        self.seen.requests.load(Ordering::SeqCst)
    }
}

pub fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/kiwoom/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}

async fn handle(State(seen): State<Arc<Seen>>, headers: HeaderMap, body: String) -> Response {
    seen.requests.fetch_add(1, Ordering::SeqCst);
    let h = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    let api_id = h("api-id");
    seen.api_ids.lock().unwrap().push(api_id.clone());
    seen.authorizations.lock().unwrap().push(h("authorization"));
    let continuation = h("cont-yn") == "Y";
    if let Some((status, body)) = seen.overrides.lock().unwrap().get(&api_id).cloned() {
        let mut resp = (StatusCode::from_u16(status).unwrap(), body.to_string()).into_response();
        resp.headers_mut().insert("content-type", "application/json;charset=UTF-8".parse().unwrap());
        return resp;
    }
    if seen.rejected_tokens.lock().unwrap().contains(&h("authorization")) {
        return respond(serde_json::json!({"return_code": 3, "return_msg": "인증에 실패했습니다[8005:Token이 유효하지 않습니다]"}), true);
    }
    let name = match api_id.as_str() {
        "au10001" => {
            let body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let mut v = fixture("au10001_ok");
            v["token"] = token_for(body["appkey"].as_str().unwrap_or("")).into();
            seen.token_bodies.lock().unwrap().push(body);
            v["expires_dt"] = "20991231000000".into();
            return respond(v, false);
        }
        "ka10099" if body.contains("\"10\"") => "ka10099_10",
        "ka10099" => "ka10099_0",
        // 거래소는 stk_cd 접미사로 고른다(kiwoom.md 3·12·13절).
        "ka10081" if body.contains("_NX") => "ka10081_005930_NX",
        "ka10081" if body.contains("_AL") => "ka10081_005930_AL",
        "ka10081" => "ka10081_005930",
        "ka10080" if body.contains("005935_NX") => "ka10080_005935_NX_1",
        "ka10080" if body.contains("_NX") => "ka10080_005930_NX_1",
        "ka10080" => "ka10080_005930_3",
        "ka20005" => "ka20005_001_1",
        "ka10095" => "ka10095_synthetic",
        "ka10082" => "ka10082_005930_AL",
        "ka10083" => "ka10083_005930_AL",
        "ka20006" => "ka20006_001",
        "ka20007" => "ka20007_001",
        "ka20008" => "ka20008_001",
        _ => return (StatusCode::INTERNAL_SERVER_ERROR, "가짜 키움이 모르는 api-id").into_response(),
    };
    let mut v = fixture(name);
    if continuation {
        // 이어 받는 페이지는 행 없이 끝낸다. 고정 입력은 첫 페이지만 담고 있다.
        for (_, field) in v.as_object_mut().unwrap().iter_mut() {
            if let Value::Array(rows) = field {
                rows.clear();
            }
        }
    }
    respond(v, continuation)
}

fn respond(mut v: Value, last_page: bool) -> Response {
    let obj = v.as_object_mut().unwrap();
    let headers = obj.remove("_headers").unwrap_or(Value::Null);
    let status = obj.remove("_status").and_then(|s| s.as_u64()).unwrap_or(200) as u16;
    obj.retain(|k, _| !k.starts_with('_'));
    let (cont, next) = if last_page {
        ("N".to_owned(), String::new())
    } else {
        (
            headers["cont-yn"].as_str().unwrap_or("N").to_owned(),
            headers["next-key"].as_str().unwrap_or("").to_owned(),
        )
    };
    let mut resp = (StatusCode::from_u16(status).unwrap(), v.to_string()).into_response();
    resp.headers_mut().insert("content-type", "application/json;charset=UTF-8".parse().unwrap());
    resp.headers_mut().insert("cont-yn", cont.parse().unwrap());
    resp.headers_mut().insert("next-key", next.parse().unwrap());
    resp
}

pub fn token_for(app_key: &str) -> String {
    if app_key == APP_KEY { TOKEN.to_owned() } else { format!("FAKE-TOKEN-for-{app_key}") }
}

pub fn token_path(lock: &Path) -> std::path::PathBuf {
    lock.with_file_name("token.json")
}

pub struct Server {
    pub child: Child,
    pub logs: Arc<Mutex<String>>,
}

impl Server {
    /// 환경변수를 비우고 필요한 것만 넣어 서버를 띄운다. 사용자의 VALLY_* 와 XDG_RUNTIME_DIR이 새어 들지 않는다.
    /// DB는 잠금 파일 옆 `vally.db`다. 저장소의 `data/`에 쓰지 않는다.
    pub fn spawn(fake: &FakeKiwoom, lock: &Path, static_dir: &Path) -> Server {
        Server::spawn_with(fake, lock, static_dir, &[])
    }

    pub fn spawn_with(fake: &FakeKiwoom, lock: &Path, static_dir: &Path, overrides: &[(&str, &std::ffi::OsStr)]) -> Server {
        let db = lock.parent().expect("잠금 파일은 임시 디렉터리 안에 있다").join("vally.db");
        let mut child = Command::new(env!("CARGO_BIN_EXE_vally-server"))
            .env_clear()
            .env("VALLY_KIWOOM_APP_KEY", APP_KEY)
            .env("VALLY_KIWOOM_APP_SECRET", APP_SECRET)
            .env("VALLY_KIWOOM_BASE_URL", fake.base_url())
            .env("VALLY_LOCK_PATH", lock)
            .env("VALLY_DB_PATH", db)
            .env("VALLY_TOKEN_PATH", token_path(lock))
            .env("VALLY_BIND", "127.0.0.1:0")
            .env("VALLY_STATIC_DIR", static_dir)
            .env("VALLY_LOG", "trace")
            .envs(overrides.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let logs = Arc::new(Mutex::new(String::new()));
        for pipe in [child.stderr.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), child.stdout.take().map(|p| Box::new(p) as _)] {
            let logs = logs.clone();
            let mut lines = BufReader::new(pipe.unwrap()).lines();
            tokio::spawn(async move {
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut l = logs.lock().unwrap();
                    l.push_str(&line);
                    l.push('\n');
                }
            });
        }
        Server { child, logs }
    }

    pub fn logs(&self) -> String {
        self.logs.lock().unwrap().clone()
    }

    /// "포트를 열었습니다 addr=127.0.0.1:NNNN" 줄을 기다린다.
    pub async fn addr(&self) -> SocketAddr {
        for _ in 0..200 {
            if let Some(addr) = self.logs().lines().filter(|l| l.contains("포트를 열었습니다")).find_map(|l| {
                let rest = &l[l.find("addr=")? + 5..];
                rest.split_whitespace().next()?.parse().ok()
            }) {
                return addr;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("서버가 포트를 열지 않았습니다. 로그:\n{}", self.logs());
    }

    pub async fn stop(mut self) -> String {
        let _ = self.child.kill().await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        self.logs()
    }
}
