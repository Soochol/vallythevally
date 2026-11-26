use crate::common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::support::fixture;
use common::{ScriptedTransport, Server};
use server::kiwoom::link::LinkState;

const SPACING_MILLIS: &str = "600";
const SPACING: Duration = Duration::from_millis(600);
const FIRST_BOOK: &str = "/api/symbols/005930/order-book?venue=krx";
const SECOND_BOOK: &str = "/api/symbols/005930/order-book?venue=combined";

struct Running {
    _tmp: tempfile::TempDir,
    fake: ScriptedTransport,
    server: Server,
    base: String,
}

async fn start_with_spacing() -> Running {
    let tmp = tempfile::tempdir().unwrap();
    let lock: PathBuf = tmp.path().join("run/server.lock");
    let dist: &Path = &tmp.path().join("dist");
    std::fs::create_dir_all(dist).unwrap();
    std::fs::write(dist.join("index.html"), "<!doctype html>").unwrap();
    let fake = ScriptedTransport::new();
    fake.respond_with("ka10004", 200, fixture("ka10004_005930_AL"));
    let pairs = [("VALLY_KIWOOM_CONNECT", "off"), ("KIWOOM_SEND_SPACING_MILLIS", SPACING_MILLIS)];
    let overrides: Vec<_> = pairs.iter().map(|(key, value)| (*key, std::ffi::OsStr::new(*value))).collect();
    let server = Server::spawn_with(&fake, &lock, dist, &overrides);
    let base = format!("http://{}", server.addr().await);
    assert_eq!(server.connect(false).await, LinkState::Connected);
    Running { _tmp: tmp, fake, server, base }
}

impl Running {
    fn ask(&self, path: &'static str) -> tokio::task::JoinHandle<u16> {
        let url = format!("{}{path}", self.base);
        tokio::spawn(async move { reqwest::get(url).await.unwrap().status().as_u16() })
    }

    fn books_asked(&self) -> Vec<String> {
        self.fake.calls().into_iter().filter(|c| c.api_id == "ka10004").map(|c| c.body["stk_cd"].as_str().unwrap().to_owned()).collect()
    }

    async fn wait_for_books(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.books_asked().len() < count {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("호가 요청이 {count}건 나가지 않았다: {:?}", self.books_asked()));
    }
}

async fn answered(request: tokio::task::JoinHandle<u16>) -> u16 {
    tokio::time::timeout(Duration::from_secs(5), request).await.expect("응답이 오지 않았다").unwrap()
}

#[tokio::test]
async fn a_request_the_client_dropped_while_it_waited_in_the_queue_is_never_sent() {
    let running = start_with_spacing().await;
    let first = running.ask(FIRST_BOOK);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let dropped = running.ask(SECOND_BOOK);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(running.books_asked().is_empty(), "간격 때문에 첫 요청도 아직 줄에 있다");
    dropped.abort();
    let _ = dropped.await;
    running.wait_for_books(1).await;
    tokio::time::sleep(SPACING + Duration::from_millis(200)).await;
    assert_eq!(running.books_asked(), ["005930"], "끊긴 요청은 간격이 지나도 나가지 않는다");
    assert_eq!(answered(first).await, 200);
    running.server.stop().await;
}

#[tokio::test]
async fn the_same_request_kept_by_the_client_is_sent_after_the_spacing() {
    let running = start_with_spacing().await;
    let first = running.ask(FIRST_BOOK);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let kept = running.ask(SECOND_BOOK);
    running.wait_for_books(2).await;
    assert_eq!(running.books_asked(), ["005930", "005930_AL"]);
    assert_eq!((answered(first).await, answered(kept).await), (200, 200));
    running.server.stop().await;
}
