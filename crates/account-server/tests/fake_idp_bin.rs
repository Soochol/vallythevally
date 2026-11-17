use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

const CREDENTIALS: [(&str, &str); 4] = [
    ("VALLY_FAKE_IDP_GOOGLE_CLIENT_ID", "FAKE-google-id"),
    ("VALLY_FAKE_IDP_GOOGLE_CLIENT_SECRET", "FAKE-google-secret"),
    ("VALLY_FAKE_IDP_NAVER_CLIENT_ID", "FAKE-naver-id"),
    ("VALLY_FAKE_IDP_NAVER_CLIENT_SECRET", "FAKE-naver-secret"),
];

struct Running(Child);

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn command(credentials: &[(&str, &str)]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_vally-fake-idp"));
    command.env_clear().envs(credentials.iter().copied());
    command
}

#[tokio::test]
async fn the_fake_idp_binary_prints_its_loopback_address_and_answers_authorize_requests() {
    let mut child = command(&CREDENTIALS).stdout(Stdio::piped()).spawn().unwrap();
    let stdout = child.stdout.take().unwrap();
    let _running = Running(child);
    let mut line = String::new();
    BufReader::new(stdout).read_line(&mut line).unwrap();
    let ready: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(ready["fakeIdp"], true);
    let base = ready["url"].as_str().unwrap();
    assert!(base.starts_with("http://127.0.0.1:"), "{base}");

    let browser = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let answer = browser
        .get(format!("{base}/google/authorize"))
        .query(&[("redirect_uri", "http://127.0.0.1:1/callback"), ("state", "s-1"), ("client_id", "FAKE-google-id")])
        .send()
        .await
        .unwrap();
    assert_eq!(answer.status(), 302);
    let target = url::Url::parse(answer.headers()["location"].to_str().unwrap()).unwrap();
    let query: std::collections::HashMap<_, _> = target.query_pairs().into_owned().collect();
    assert_eq!(query["state"], "s-1");
    assert!(query["code"].starts_with("fake-code-"), "{query:?}");
}

#[test]
fn the_fake_idp_binary_refuses_to_start_without_its_credentials() {
    let output = command(&CREDENTIALS[..3]).output().unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty(), "준비되지 않았으면 주소를 내지 않는다");
    assert!(String::from_utf8_lossy(&output.stderr).contains("VALLY_FAKE_IDP_NAVER_CLIENT_SECRET"));
}
