use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::http::Uri;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use domain::{Market, Symbol, SymbolInfo, SymbolKind};
use server::{clock::Clock, config::Secret, financials::{self, Financials, client::Client, store::Store}, symbols::{Directory, SymbolDirectory}};

#[tokio::main]
async fn main() {
    if let Err(message) = run().await {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let key = std::env::var("OPENDART_API_KEY").map_err(|_| "OPENDART_API_KEY가 필요합니다")?;
    if key.trim().is_empty() { return Err("OPENDART_API_KEY가 필요합니다".into()); }
    let database = PathBuf::from(std::env::var("VALLY_FINANCIAL_DB_PATH").map_err(|_| "VALLY_FINANCIAL_DB_PATH가 필요합니다")?);
    let static_dir = PathBuf::from(std::env::var("VALLY_STATIC_DIR").unwrap_or_else(|_| "web/dist".into()));
    let client = Client::new(Secret::new(key), "https://opendart.fss.or.kr".into(), "https://kind.krx.co.kr".into()).map_err(|failure| format!("DART 클라이언트 준비 실패: {failure:?}"))?;
    let store = Store::open(&database).await.map_err(|failure| format!("재무 저장소 준비 실패: {failure:?}"))?;
    let service = Financials::new(Some(client), store, Clock::system());
    let stock = SymbolInfo { symbol: Symbol::parse("005930").map_err(|_| "진단 종목 오류")?, name: "삼성전자".into(), kind: SymbolKind::Common, market: Market::Kospi, nxt_enabled: true };
    let symbols = Arc::new(SymbolDirectory::default());
    symbols.replace(Directory::build(vec![stock.clone()]));
    let assets = axum::Router::new().fallback(static_file).with_state(static_dir);
    let router = financials::routes(service.clone(), symbols).merge(assets);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|error| error.to_string())?;
    println!("addr={}", listener.local_addr().map_err(|error| error.to_string())?);
    service.start_update(vec![stock]).await;
    axum::serve(listener, router).await.map_err(|error| error.to_string())
}

async fn static_file(State(root): State<PathBuf>, uri: Uri) -> Response {
    if uri.path().starts_with("/api") { return StatusCode::NOT_FOUND.into_response(); }
    let relative = uri.path().trim_start_matches('/');
    if relative.split('/').any(|part| part == ".." || part.contains('\\')) { return StatusCode::BAD_REQUEST.into_response(); }
    let path = if relative.is_empty() { root.join("index.html") } else { root.join(relative) };
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mime = match path.extension().and_then(|extension| extension.to_str()) { Some("html") => "text/html", Some("js") => "text/javascript", Some("css") => "text/css", Some("wasm") => "application/wasm", Some("woff2") => "font/woff2", _ => "application/octet-stream" };
            ([(header::CONTENT_TYPE, mime)], bytes).into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
