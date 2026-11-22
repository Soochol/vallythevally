mod common;

use common::*;
use account_server::fake_idp::Fault;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct LogSink(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for LogSink {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogSink {
    type Writer = LogSink;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

#[tokio::test(flavor = "current_thread")]
async fn client_secrets_never_appear_in_logs_responses_or_the_database() {
    let sink = LogSink::default();
    let subscriber = tracing_subscriber::fmt().with_max_level(tracing::Level::TRACE).with_ansi(false).with_writer(sink.clone()).finish();
    tracing::subscriber::set_global_default(subscriber).unwrap();

    let harness = Harness::start().await;
    let mut browsers = Vec::new();
    for (provider, label) in [("google", "a"), ("naver", "b")] {
        let mut browser = harness.browser();
        let callback = harness.idp_callback_url(&mut browser, provider, label).await;
        harness.finish(&mut browser, &callback, label).await;
        browsers.push(browser);
    }
    harness.idp.set_fault(Fault::WrongAudience);
    let mut failing = harness.browser();
    let callback = harness.idp_callback_url(&mut failing, "google", "e").await;
    harness.finish_error(&mut failing, &callback).await;
    browsers.push(failing);

    harness.idp.set_fault(Fault::None);
    let mut signed_in = harness.browser();
    let start = signed_in.get(&format!("{}/v1/session/google/start", harness.base)).await;
    let authorize = location(&start);
    let idp_state = authorize.query_pairs().find(|(name, _)| name == "state").unwrap().1.into_owned();
    let flow_cookie = signed_in.cookies.values().next().unwrap().clone();
    let idp = signed_in.get(authorize.as_str()).await;
    let callback = location(&idp);
    let landed = signed_in.get(&format!("{}{}?{}", harness.base, callback.path(), callback.query().unwrap())).await;
    assert_eq!(landed.status(), 302);
    let session_cookie = signed_in.cookies.iter().find(|(name, _)| name.ends_with("vally_session")).unwrap().1.clone();
    assert_eq!(signed_in.get(&format!("{}/v1/session", harness.base)).await.status(), 200);

    let logs = sink.0.lock().unwrap().clone();
    assert!(!logs.is_empty());
    let dump = harness.dump().await;
    for secret in [GOOGLE_SECRET, NAVER_SECRET] {
        assert!(!contains(&logs, secret), "로그에 비밀값이 있다");
        assert!(!contains(&dump, secret));
        for browser in &browsers {
            assert!(!browser.seen.iter().any(|line| line.contains(secret)));
        }
    }
    assert!(!contains(&logs, "subject-1"));
    assert!(!contains(&dump, &session_cookie), "DB에는 세션 값 해시만 있다");
    assert!(!contains(&dump, &flow_cookie));
    for secret in [&session_cookie, &flow_cookie, &idp_state] {
        assert!(!contains(&logs, secret), "로그에 쿠키 값이나 state가 있다");
    }
}

