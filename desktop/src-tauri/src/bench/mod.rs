mod server;
mod stream;

use server::Files;
use std::path::PathBuf;
use tauri::{Context, Manager};

const STATIC_DIR: &str = "VALLY_BENCH_STATIC_DIR";
const RESULT_FILE: &str = "VALLY_BENCH_RESULT";
const QUERY: &str = "VALLY_BENCH_QUERY";
const SERVE_ONLY: &str = "VALLY_BENCH_SERVE_ONLY";
const MAIN_WINDOW: &str = "main";
const CAPABILITY: &str = include_str!("../../../bench/capability.json");

pub struct Request {
    files: Files,
    query: Option<String>,
    serve_only: bool,
}

pub fn requested() -> Option<Request> {
    let static_dir = PathBuf::from(std::env::var_os(STATIC_DIR)?);
    let result = PathBuf::from(std::env::var_os(RESULT_FILE).expect("VALLY_BENCH_RESULT가 필요합니다"));
    Some(Request { files: Files { static_dir, result }, query: std::env::var(QUERY).ok(), serve_only: std::env::var_os(SERVE_ONLY).is_some() })
}

pub fn run(request: Request, context: Context) {
    let ports = server::start(Files { static_dir: request.files.static_dir.clone(), result: request.files.result.clone() }).expect("측정 서버를 시작할 수 없습니다");
    if request.serve_only {
        std::fs::write(request.files.marker("ports"), format!("{} {}", ports.http, ports.websocket)).expect("포트 파일을 쓸 수 없습니다");
        std::thread::park();
        return;
    }
    let query = request.query.expect("VALLY_BENCH_QUERY가 필요합니다");
    let url = format!("http://127.0.0.1:{}/index.html?{query}&websocket={}", ports.http, ports.websocket);
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![stream::bench_stream])
        .setup(move |app| {
            app.add_capability(CAPABILITY)?;
            let window = app.get_webview_window(MAIN_WINDOW).ok_or("측정 창이 없습니다")?;
            window.navigate(url.parse()?)?;
            Ok(())
        })
        .build(context)
        .expect("Tauri 앱을 만들 수 없습니다");
    app.run(|_, _| {});
}
