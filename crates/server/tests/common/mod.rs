#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub use fake_kiwoom::{APP_KEY, APP_SECRET, FakeKiwoom, TOKEN};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

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
            .env("VALLY_KIWOOM_WS_URL", fake.ws_url())
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
