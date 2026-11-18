use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex, OnceLock};

use collector::calendar::{
    Calendar, Day, HolidayRequest, HolidayTransport, ReqwestHolidayTransport, TransportError,
    Verdict,
};
use server::config::Secret;
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const SERVICE_KEY: &str = "SvcKey-9f2c+/7aQ==";
const ENCODED_KEY_FRAGMENT: &str = "SvcKey-9f2c%2B%2F7aQ%3D%3D";

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

fn captured_logs() -> LogCapture {
    static LOGS: OnceLock<LogCapture> = OnceLock::new();
    LOGS.get_or_init(|| {
        let logs = LogCapture::default();
        tracing::subscriber::set_global_default(
            tracing_subscriber::fmt()
                .with_writer(logs.clone())
                .with_ansi(false)
                .with_max_level(tracing::Level::TRACE)
                .finish(),
        )
        .unwrap();
        logs
    })
    .clone()
}

struct Reply {
    status: u16,
    content_type: &'static str,
    body: String,
}

fn ok_json(body: String) -> Option<Reply> {
    Some(Reply { status: 200, content_type: "application/json", body })
}

struct TestServer {
    base_url: String,
    targets: Arc<Mutex<Vec<String>>>,
}

impl TestServer {
    async fn start(handler: impl Fn(&str) -> Option<Reply> + Send + Sync + 'static) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}/service", listener.local_addr().unwrap());
        let targets = Arc::new(Mutex::new(Vec::new()));
        let recorded = targets.clone();
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let recorded = recorded.clone();
                let handler = handler.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut chunk = [0u8; 1024];
                    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
                        match stream.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(read) => head.extend_from_slice(&chunk[..read]),
                        }
                    }
                    let text = String::from_utf8_lossy(&head).into_owned();
                    let target = text.split_whitespace().nth(1).unwrap_or_default().to_owned();
                    recorded.lock().unwrap().push(target.clone());
                    let Some(reply) = handler(&target) else { return };
                    let response = format!(
                        "HTTP/1.1 {} X\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        reply.status,
                        reply.content_type,
                        reply.body.len(),
                        reply.body
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        TestServer { base_url, targets }
    }

    fn targets(&self) -> Vec<String> {
        self.targets.lock().unwrap().clone()
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                decoded.push(u8::from_str_radix(&text[index + 1..index + 3], 16).unwrap());
                index += 3;
            }
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).unwrap()
}

fn query_of(target: &str) -> (String, HashMap<String, String>) {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let arguments = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap();
            (percent_decode(name), percent_decode(value))
        })
        .collect();
    (path.to_owned(), arguments)
}

fn year_of(target: &str) -> u32 {
    query_of(target).1["solYear"].parse().unwrap()
}

fn item(date: u32, name: &str) -> String {
    format!(r#"{{"dateKind":"01","dateName":"{name}","isHoliday":"Y","locdate":{date},"seq":1}}"#)
}

fn holidays_body(year: u32) -> String {
    let items = [item(year * 10_000 + 101, "1월1일"), item(year * 10_000 + 1009, "한글날")];
    format!(
        r#"{{"response":{{"header":{{"resultCode":"00","resultMsg":"NORMAL SERVICE."}},"body":{{"items":{{"item":[{}]}},"numOfRows":100,"pageNo":1,"totalCount":2}}}}}}"#,
        items.join(",")
    )
}

fn single_item_body(year: u32) -> String {
    format!(
        r#"{{"response":{{"header":{{"resultCode":"00","resultMsg":"NORMAL SERVICE."}},"body":{{"items":{{"item":{}}},"numOfRows":100,"pageNo":1,"totalCount":1}}}}}}"#,
        item(year * 10_000 + 101, "1월1일")
    )
}

fn empty_items_body() -> String {
    r#"{"response":{"header":{"resultCode":"00","resultMsg":"NORMAL SERVICE."},"body":{"items":"","numOfRows":100,"pageNo":1,"totalCount":0}}}"#.to_owned()
}

fn key() -> Secret<String> {
    Secret::new(SERVICE_KEY.to_owned())
}

fn november_17() -> i64 {
    Day::from_ymd(2026, 11, 17).unwrap().unix_ms_at_kst(7, 20)
}

#[tokio::test]
async fn sends_the_documented_request_and_the_judgment_reads_the_response() {
    captured_logs();
    let server = TestServer::start(|target| {
        let year = year_of(target);
        ok_json(if year == 2025 { single_item_body(year) } else { holidays_body(year) })
    })
    .await;
    let transport = ReqwestHolidayTransport::with_base_url(&server.base_url).unwrap();
    let data = tempdir().unwrap();
    let calendar = Calendar::load(data.path(), &transport, &key(), november_17()).await;

    let mut requests: Vec<_> = server.targets().iter().map(|target| query_of(target)).collect();
    requests.sort_by_key(|(_, arguments)| arguments["solYear"].clone());
    assert_eq!(requests.len(), 2);
    for ((path, arguments), year) in requests.iter().zip(["2025", "2026"]) {
        assert_eq!(path, "/service/getRestDeInfo");
        assert_eq!(arguments["solYear"], year);
        assert_eq!(arguments["_type"], "json");
        assert_eq!(arguments["numOfRows"], "100");
        assert_eq!(arguments["ServiceKey"], SERVICE_KEY);
        assert_eq!(arguments.len(), 4, "{arguments:?}");
    }

    let holiday = calendar.judge(Day::from_ymd(2026, 10, 9).unwrap());
    assert_eq!(holiday.verdict, Verdict::Closed);
    let weekday = calendar.judge(Day::from_ymd(2026, 11, 17).unwrap());
    assert!(matches!(weekday.verdict, Verdict::Observed { .. }));
    let single = calendar.judge(Day::from_ymd(2025, 1, 1).unwrap());
    assert_eq!(single.verdict, Verdict::Closed);
}

#[tokio::test]
async fn a_base_url_with_a_trailing_slash_reaches_the_same_path() {
    captured_logs();
    let server = TestServer::start(|target| ok_json(holidays_body(year_of(target)))).await;
    let transport = ReqwestHolidayTransport::with_base_url(&format!("{}/", server.base_url)).unwrap();
    let body = transport.fetch(HolidayRequest { year: 2026, service_key: &key() }).await.unwrap();
    assert!(body.contains("한글날"));
    assert_eq!(query_of(&server.targets()[0]).0, "/service/getRestDeInfo");
}

#[tokio::test]
async fn http_status_and_connection_failures_map_to_transport_errors() {
    captured_logs();
    let key = key();
    let server = TestServer::start(|_| {
        Some(Reply { status: 503, content_type: "text/plain", body: "down".to_owned() })
    })
    .await;
    let transport = ReqwestHolidayTransport::with_base_url(&server.base_url).unwrap();
    let error = transport.fetch(HolidayRequest { year: 2026, service_key: &key }).await.unwrap_err();
    assert_eq!(error, TransportError::HttpStatus(503));

    let dropped = TestServer::start(|_| None).await;
    let transport = ReqwestHolidayTransport::with_base_url(&dropped.base_url).unwrap();
    let error = transport.fetch(HolidayRequest { year: 2026, service_key: &key }).await.unwrap_err();
    assert_eq!(error, TransportError::Unreachable);

    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        format!("http://{}/service", listener.local_addr().unwrap())
    };
    let transport = ReqwestHolidayTransport::with_base_url(&closed).unwrap();
    let error = transport.fetch(HolidayRequest { year: 2026, service_key: &key }).await.unwrap_err();
    assert_eq!(error, TransportError::Unreachable);
}

#[tokio::test]
async fn the_service_key_never_reaches_logs_errors_or_debug_output() {
    let logs = captured_logs();
    let key = key();
    let reflecting_html = |target: &str| {
        Some(Reply {
            status: 200,
            content_type: "text/html",
            body: format!("<html><body>잘못된 요청 {target} {SERVICE_KEY}</body></html>"),
        })
    };
    let reflecting_error = |target: &str| {
        Some(Reply {
            status: 500,
            content_type: "text/html",
            body: format!("<html>오류 {target} {SERVICE_KEY}</html>"),
        })
    };
    type Handler = Box<dyn Fn(&str) -> Option<Reply> + Send + Sync>;
    let handlers: Vec<Handler> = vec![
        Box::new(reflecting_html),
        Box::new(reflecting_error),
        Box::new(|_| ok_json(r#"{"response":{"header":{"resultCode":"00""#.to_owned())),
        Box::new(|_| ok_json(r#"{"unexpected":[1,2,3]}"#.to_owned())),
        Box::new(|_| ok_json(r#"{"response":{"body":"x"}}"#.to_owned())),
        Box::new(|_| ok_json(empty_items_body())),
        Box::new(|_| {
            ok_json(
                r#"{"response":{"header":{"resultCode":"30","resultMsg":"SERVICE KEY IS NOT REGISTERED ERROR."}}}"#
                    .to_owned(),
            )
        }),
        Box::new(|_| None),
    ];
    let mut surfaces = Vec::new();
    for handler in handlers {
        let server = TestServer::start(handler).await;
        let transport = ReqwestHolidayTransport::with_base_url(&server.base_url).unwrap();
        surfaces.push(format!("{transport:?}"));
        let fetched = transport.fetch(HolidayRequest { year: 2026, service_key: &key }).await;
        if let Err(error) = &fetched {
            surfaces.push(format!("{error:?}"));
        }
        let data = tempdir().unwrap();
        let calendar = Calendar::load(data.path(), &transport, &key, november_17()).await;
        for date in [(2026, 10, 9), (2025, 1, 1)] {
            let judgment = calendar.judge(Day::from_ymd(date.0, date.1, date.2).unwrap());
            surfaces.push(format!("{judgment:?}"));
        }
    }
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        format!("http://{}/service", listener.local_addr().unwrap())
    };
    let transport = ReqwestHolidayTransport::with_base_url(&closed).unwrap();
    let data = tempdir().unwrap();
    Calendar::load(data.path(), &transport, &key, november_17()).await;
    surfaces.push(format!("{key:?}"));

    let captured = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    assert!(captured.contains("특일정보 요청이 실패했다"), "{captured}");
    surfaces.push(captured);
    for surface in surfaces {
        for needle in [SERVICE_KEY, ENCODED_KEY_FRAGMENT, "SvcKey", "ServiceKey", "7aQ"] {
            assert!(!surface.contains(needle), "{needle} leaked: {surface}");
        }
    }
}
