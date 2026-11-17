use std::io;
use std::sync::{Arc, Mutex};

use collector::calendar::{Calendar, Day, HolidayRequest, HolidayTransport, TransportError};
use futures::future::BoxFuture;
use server::config::Secret;
use tempfile::tempdir;

const SERVICE_KEY: &str = "SvcKey-9f2c+/7aQ==";

#[derive(Clone, Default)]
struct LogCapture(Arc<Mutex<Vec<u8>>>);

impl io::Write for LogCapture {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogCapture {
    type Writer = LogCapture;

    fn make_writer(&'a self) -> LogCapture {
        self.clone()
    }
}

struct Unreachable;

impl HolidayTransport for Unreachable {
    fn fetch<'a>(&'a self, _request: HolidayRequest<'a>) -> BoxFuture<'a, Result<String, TransportError>> {
        Box::pin(async { Err(TransportError::Unreachable) })
    }
}

struct Garbage;

impl HolidayTransport for Garbage {
    fn fetch<'a>(&'a self, request: HolidayRequest<'a>) -> BoxFuture<'a, Result<String, TransportError>> {
        let body = format!("<error>{}</error>", request.service_key.expose().len());
        Box::pin(async move { Ok(body) })
    }
}

struct OneHoliday;

impl HolidayTransport for OneHoliday {
    fn fetch<'a>(&'a self, request: HolidayRequest<'a>) -> BoxFuture<'a, Result<String, TransportError>> {
        let date = u32::from(request.year) * 10_000 + 101;
        let body = format!(
            r#"{{"response":{{"header":{{"resultCode":"00"}},"body":{{"items":{{"item":{{"dateName":"1월1일","isHoliday":"Y","locdate":{date}}}}},"totalCount":1}}}}}}"#
        );
        Box::pin(async move { Ok(body) })
    }
}

#[tokio::test]
async fn failed_fetches_log_without_the_service_key() {
    let logs = LogCapture::default();
    let _guard = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_writer(logs.clone())
            .with_ansi(false)
            .with_max_level(tracing::Level::TRACE)
            .finish(),
    );
    let key = Secret::new(SERVICE_KEY.to_owned());
    let now = Day::from_ymd(2026, 11, 17).unwrap().unix_ms_at_kst(7, 20);
    for transport in [&Unreachable as &dyn HolidayTransport, &Garbage] {
        let data = tempdir().unwrap();
        Calendar::load(data.path(), transport, &key, now).await;
    }
    let blocked = tempdir().unwrap();
    std::fs::write(blocked.path().join("calendar"), "").unwrap();
    Calendar::load(blocked.path(), &OneHoliday, &key, now).await;
    let captured = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    assert!(captured.contains("특일정보를 받지 못했고 캐시도 없다"), "{captured}");
    assert!(captured.contains("특일정보 캐시를 쓰지 못했다"), "{captured}");
    assert!(!captured.contains(SERVICE_KEY), "{captured}");
    assert!(!captured.contains("SvcKey"), "{captured}");
}
