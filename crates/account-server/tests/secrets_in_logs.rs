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
}

