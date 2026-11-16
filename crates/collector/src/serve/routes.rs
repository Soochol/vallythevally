use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;

use super::assets;
use crate::build::index::INDEX_FILE_NAME;
use crate::build::store::{parse_span_file_name, spans_day_dir};

const SPAN_CACHE: &str = "public, max-age=31536000, immutable";
const NEVER_CACHE: &str = "no-store";
const REVALIDATE: &str = "no-cache";
const SPAN_FILE_SUFFIX: &str = ".hoga";
const BROTLI_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Clone)]
struct Data {
    root: Arc<PathBuf>,
}

pub fn router(data_dir: PathBuf) -> Router {
    Router::new()
        .route("/data/dates.json", get(dates))
        .route("/data/{date}/index.json", get(day_index))
        .route("/data/{date}/{symbol}/{file}", get(span_file))
        .fallback(page_asset)
        .with_state(Data { root: Arc::new(data_dir) })
}

async fn read_inside(root: &Path, path: &Path) -> Option<Vec<u8>> {
    let inside = tokio::fs::canonicalize(root).await.ok()?;
    let target = tokio::fs::canonicalize(path).await.ok()?;
    if !target.starts_with(&inside) {
        return None;
    }
    tokio::fs::read(target).await.ok()
}

fn not_found() -> Response {
    StatusCode::NOT_FOUND.into_response()
}

fn is_date(text: &str) -> bool {
    text.len() == 8 && text.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_symbol(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn stored_span_name(file: &str) -> Option<String> {
    let stem = file.strip_suffix(SPAN_FILE_SUFFIX)?;
    let stored = format!("{stem}{SPAN_FILE_SUFFIX}.br");
    parse_span_file_name(&stored)?;
    Some(stored)
}

async fn page_asset(uri: Uri) -> Response {
    let Some(asset) = assets::find(uri.path()) else {
        return not_found();
    };
    (
        [(header::CONTENT_TYPE, asset.content_type), (header::CACHE_CONTROL, REVALIDATE)],
        asset.bytes,
    )
        .into_response()
}

async fn dates(State(data): State<Data>) -> Response {
    let spans = data.root.join("spans");
    let mut dates: Vec<String> = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(&spans).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(name) = entry.file_name().into_string() else { continue };
            if is_date(&name) && read_inside(&data.root, &entry.path().join(INDEX_FILE_NAME)).await.is_some() {
                dates.push(name);
            }
        }
    }
    dates.sort();
    let body = serde_json::to_vec(&dates).expect("문자열 목록은 직렬화된다");
    ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, NEVER_CACHE)], body).into_response()
}

fn day_dir(data: &Data, date: &str) -> Option<PathBuf> {
    let number: u32 = date.parse().ok().filter(|_| is_date(date))?;
    Some(spans_day_dir(&data.root, number))
}

async fn day_index(State(data): State<Data>, UrlPath(date): UrlPath<String>) -> Response {
    let Some(folder) = day_dir(&data, &date) else { return not_found() };
    match read_inside(&data.root, &folder.join(INDEX_FILE_NAME)).await {
        Some(bytes) => {
            ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, NEVER_CACHE)], bytes).into_response()
        }
        None => not_found(),
    }
}

fn accepts_brotli(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|coding| {
            let mut parts = coding.split(';');
            let name = parts.next().unwrap_or("").trim();
            let refused = parts.any(|parameter| {
                let parameter = parameter.trim();
                parameter.len() > 2
                    && parameter[..2].eq_ignore_ascii_case("q=")
                    && parameter[2..].trim().parse::<f32>() == Ok(0.0)
            });
            name.eq_ignore_ascii_case("br") && !refused
        })
}

fn inflate(compressed: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut plain = Vec::new();
    brotli::Decompressor::new(compressed, BROTLI_BUFFER_BYTES).read_to_end(&mut plain)?;
    Ok(plain)
}

async fn span_file(
    State(data): State<Data>,
    headers: HeaderMap,
    UrlPath((date, symbol, file)): UrlPath<(String, String, String)>,
) -> Response {
    if !is_symbol(&symbol) {
        return not_found();
    }
    let (Some(folder), Some(stored_name)) = (day_dir(&data, &date), stored_span_name(&file)) else {
        return not_found();
    };
    let path: PathBuf = Path::new(&folder).join(&symbol).join(stored_name);
    let Some(compressed) = read_inside(&data.root, &path).await else { return not_found() };
    let common = [
        (header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream")),
        (header::VARY, HeaderValue::from_static("Accept-Encoding")),
        (header::CACHE_CONTROL, HeaderValue::from_static(SPAN_CACHE)),
    ];
    if accepts_brotli(&headers) {
        return (common, [(header::CONTENT_ENCODING, "br")], compressed).into_response();
    }
    match inflate(&compressed) {
        Ok(plain) => (common, plain).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
