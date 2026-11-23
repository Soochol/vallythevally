use super::stream::{self, Plan};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use tungstenite::Message;

const MAX_RESULT_BYTES: usize = 1 << 20;

pub struct Files {
    pub static_dir: PathBuf,
    pub result: PathBuf,
}

impl Files {
    pub fn marker(&self, suffix: &str) -> PathBuf {
        let mut name = self.result.clone().into_os_string();
        name.push(".");
        name.push(suffix);
        PathBuf::from(name)
    }
}

pub struct Ports {
    pub http: u16,
    pub websocket: u16,
}

pub fn start(files: Files) -> std::io::Result<Ports> {
    let http = TcpListener::bind(("127.0.0.1", 0))?;
    let websocket = TcpListener::bind(("127.0.0.1", 0))?;
    let ports = Ports { http: http.local_addr()?.port(), websocket: websocket.local_addr()?.port() };
    std::thread::spawn(move || {
        for connection in http.incoming().flatten() {
            let files = Files { static_dir: files.static_dir.clone(), result: files.result.clone() };
            std::thread::spawn(move || {
                let _ = answer(connection, &files);
            });
        }
    });
    std::thread::spawn(move || {
        for connection in websocket.incoming().flatten() {
            std::thread::spawn(move || {
                let _ = stream_over_websocket(connection);
            });
        }
    });
    Ok(ports)
}

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}

fn read_request(connection: &TcpStream) -> std::io::Result<Request> {
    let mut reader = BufReader::new(connection);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or_default().to_string(), parts.next().unwrap_or_default().to_string());
    let mut length = 0usize;
    loop {
        line.clear();
        reader.read_line(&mut line)?;
        let header = line.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse().unwrap_or(0).min(MAX_RESULT_BYTES);
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let path = target.split('?').next().unwrap_or_default().to_string();
    Ok(Request { method, path, body })
}

fn answer(mut connection: TcpStream, files: &Files) -> std::io::Result<()> {
    let request = read_request(&connection)?;
    let (status, content_type, body) = route(&request, files);
    write!(connection, "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len())?;
    connection.write_all(&body)
}

fn route(request: &Request, files: &Files) -> (&'static str, &'static str, Vec<u8>) {
    match (request.method.as_str(), request.path.as_str()) {
        ("POST", marker @ ("/begin" | "/end")) => match fs::write(files.marker(&marker[1..]), b"") {
            Ok(()) => ("204 No Content", "text/plain", Vec::new()),
            Err(_) => ("500 Internal Server Error", "text/plain", Vec::new()),
        },
        ("GET", "/now") => ("200 OK", "text/plain", stream::epoch_millis().to_string().into_bytes()),
        ("POST", "/result") => match fs::write(&files.result, &request.body) {
            Ok(()) => ("204 No Content", "text/plain", Vec::new()),
            Err(_) => ("500 Internal Server Error", "text/plain", Vec::new()),
        },
        ("GET", path) => match static_file(&files.static_dir, path) {
            Some((content_type, body)) => ("200 OK", content_type, body),
            None => ("404 Not Found", "text/plain", Vec::new()),
        },
        _ => ("405 Method Not Allowed", "text/plain", Vec::new()),
    }
}

fn static_file(root: &Path, request_path: &str) -> Option<(&'static str, Vec<u8>)> {
    let relative = request_path.trim_start_matches('/');
    let relative = if relative.is_empty() { "index.html" } else { relative };
    if relative.split('/').any(|part| part.is_empty() || part == "." || part == ".." || part.contains('\\')) {
        return None;
    }
    let content_type = match Path::new(relative).extension()?.to_str()? {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        _ => return None,
    };
    Some((content_type, fs::read(root.join(relative)).ok()?))
}

fn stream_over_websocket(connection: TcpStream) -> Result<(), tungstenite::Error> {
    connection.set_nodelay(true)?;
    let mut socket = tungstenite::accept(connection).map_err(|error| match error {
        tungstenite::HandshakeError::Failure(error) => error,
        tungstenite::HandshakeError::Interrupted(_) => tungstenite::Error::ConnectionClosed,
    })?;
    let request = socket.read()?;
    let Message::Text(text) = request else { return Ok(()) };
    let plan = parse_plan(text.as_str()).map_err(|_| tungstenite::Error::ConnectionClosed)?;
    stream::run(plan, |message| match serde_json::to_string(&message) {
        Ok(json) => socket.send(Message::text(json)).is_ok(),
        Err(_) => false,
    });
    let _ = socket.flush();
    let _ = socket.read();
    Ok(())
}

fn parse_plan(text: &str) -> Result<Plan, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    let field = |name: &str| value[name].as_u64().and_then(|number| u32::try_from(number).ok()).ok_or_else(|| format!("{name}가 없습니다"));
    Plan::new(field("perSecond")?, field("seconds")?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stream_request_names_the_rate_and_the_duration() {
        assert_eq!(parse_plan(r#"{"perSecond":3000,"seconds":30}"#), Ok(Plan { per_second: 3000, seconds: 30 }));
        assert!(parse_plan(r#"{"perSecond":0,"seconds":30}"#).is_err());
        assert!(parse_plan("not json").is_err());
    }

    #[test]
    fn only_the_measurement_files_are_served_and_never_outside_the_folder() {
        let folder = std::env::temp_dir().join(format!("vally-bench-static-{}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("index.html"), "<p>ok</p>").unwrap();
        fs::write(folder.join("secret.txt"), "no").unwrap();
        assert_eq!(static_file(&folder, "/").map(|(kind, _)| kind), Some("text/html; charset=utf-8"));
        assert!(static_file(&folder, "/secret.txt").is_none());
        assert!(static_file(&folder, "/../index.html").is_none());
        assert!(static_file(&folder, "/missing.js").is_none());
        fs::remove_dir_all(&folder).unwrap();
    }
}
