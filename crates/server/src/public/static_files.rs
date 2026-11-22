use std::collections::HashMap;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use sha2::{Digest, Sha256};

const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const NO_CACHE: &str = "no-cache";
const BROTLI_QUALITY: u32 = 11;
const BROTLI_WINDOW_BITS: u32 = 22;
const ALREADY_COMPRESSED_EXTENSIONS: [&str; 10] = ["woff2", "woff", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "zip"];

fn extension(path: &str) -> &str {
    path.rsplit('.').next().unwrap_or("")
}

fn mime(path: &str) -> &'static str {
    match extension(path) {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn is_already_compressed(path: &str) -> bool {
    ALREADY_COMPRESSED_EXTENSIONS.contains(&extension(path))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Encoding {
    Brotli,
    Gzip,
    Identity,
}

impl Encoding {
    fn content_encoding(self) -> Option<&'static str> {
        match self {
            Encoding::Brotli => Some("br"),
            Encoding::Gzip => Some("gzip"),
            Encoding::Identity => None,
        }
    }

    fn etag_suffix(self) -> &'static str {
        match self {
            Encoding::Brotli => "-br",
            Encoding::Gzip => "-gzip",
            Encoding::Identity => "",
        }
    }
}

struct Representation {
    body: Bytes,
    etag: HeaderValue,
}

struct StaticFile {
    content_type: &'static str,
    identity: Representation,
    brotli: Option<Representation>,
    gzip: Option<Representation>,
}

impl StaticFile {
    fn representation_for(&self, accepted: AcceptedEncodings) -> (Encoding, &Representation) {
        if accepted.brotli
            && let Some(representation) = &self.brotli
        {
            return (Encoding::Brotli, representation);
        }
        if accepted.gzip
            && let Some(representation) = &self.gzip
        {
            return (Encoding::Gzip, representation);
        }
        (Encoding::Identity, &self.identity)
    }

    fn varies_by_encoding(&self) -> bool {
        self.brotli.is_some() || self.gzip.is_some()
    }

    fn compressed_bytes(&self) -> usize {
        self.brotli.iter().chain(self.gzip.iter()).map(|r| r.body.len()).sum()
    }
}

#[derive(Clone, Copy)]
struct AcceptedEncodings {
    brotli: bool,
    gzip: bool,
}

impl AcceptedEncodings {
    fn parse(headers: &HeaderMap) -> Self {
        let mut accepted = AcceptedEncodings { brotli: false, gzip: false };
        for value in headers.get_all(header::ACCEPT_ENCODING) {
            let Ok(text) = value.to_str() else { continue };
            for item in text.split(',') {
                let mut parts = item.split(';');
                let name = parts.next().unwrap_or("").trim();
                let refused = parts.any(|param| param.trim().strip_prefix("q=").is_some_and(|q| q.trim().parse::<f32>().is_ok_and(|q| q <= 0.0)));
                if refused {
                    continue;
                }
                if name.eq_ignore_ascii_case("br") {
                    accepted.brotli = true;
                } else if name.eq_ignore_ascii_case("gzip") {
                    accepted.gzip = true;
                }
            }
        }
        accepted
    }
}

pub struct StaticSite {
    directory: PathBuf,
    files: HashMap<String, StaticFile>,
}

impl StaticSite {
    pub async fn load(dir: PathBuf) -> io::Result<StaticSite> {
        tokio::task::spawn_blocking(move || load_blocking(dir)).await.map_err(io::Error::other)?
    }

    pub fn respond(&self, method: &Method, path: &str, headers: &HeaderMap) -> Response {
        if method != Method::GET && method != Method::HEAD {
            return StatusCode::METHOD_NOT_ALLOWED.into_response();
        }
        let relative = path.trim_start_matches('/');
        if relative.split('/').any(|segment| segment == ".." || segment.contains('\\')) {
            return StatusCode::NOT_FOUND.into_response();
        }
        let is_asset = relative.starts_with("assets/");
        let has_extension = relative.rsplit('/').next().is_some_and(|last| last.contains('.'));
        let names_a_file = is_asset || has_extension;
        let (key, cache_control) = if names_a_file {
            let cache = if is_asset {
                Some(IMMUTABLE)
            } else if relative == "index.html" {
                Some(NO_CACHE)
            } else {
                None
            };
            (relative, cache)
        } else {
            ("index.html", Some(NO_CACHE))
        };
        match self.files.get(key) {
            Some(file) => file_response(file, cache_control, method, headers),
            None if names_a_file => StatusCode::NOT_FOUND.into_response(),
            None => (StatusCode::NOT_FOUND, format!("{}에 index.html이 없습니다. web을 먼저 빌드하세요", self.directory.display())).into_response(),
        }
    }
}

fn file_response(file: &StaticFile, cache_control: Option<&'static str>, method: &Method, headers: &HeaderMap) -> Response {
    let (encoding, representation) = file.representation_for(AcceptedEncodings::parse(headers));
    let not_modified = headers.get_all(header::IF_NONE_MATCH).iter().any(|value| value.to_str().is_ok_and(|text| etag_listed(text, &representation.etag)));
    let body = if not_modified || method == Method::HEAD { Body::empty() } else { Body::from(representation.body.clone()) };
    let mut response = Response::new(body);
    let out = response.headers_mut();
    out.insert(header::ETAG, representation.etag.clone());
    if let Some(cache) = cache_control {
        out.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    }
    if file.varies_by_encoding() {
        out.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    }
    if not_modified {
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        return response;
    }
    out.insert(header::CONTENT_TYPE, HeaderValue::from_static(file.content_type));
    if let Some(name) = encoding.content_encoding() {
        out.insert(header::CONTENT_ENCODING, HeaderValue::from_static(name));
    }
    out.insert(header::CONTENT_LENGTH, HeaderValue::from(representation.body.len()));
    response
}

fn etag_listed(header_value: &str, etag: &HeaderValue) -> bool {
    let Ok(own) = etag.to_str() else { return false };
    header_value.split(',').map(str::trim).any(|candidate| candidate == "*" || candidate.strip_prefix("W/").unwrap_or(candidate) == own)
}

struct Source {
    key: String,
    bytes: Vec<u8>,
}

fn load_blocking(directory: PathBuf) -> io::Result<StaticSite> {
    let started = Instant::now();
    let mut sources = Vec::new();
    read_directory(&directory, &directory, &mut sources)?;
    let original_bytes: usize = sources.iter().map(|s| s.bytes.len()).sum();
    let files = build_files(&sources);
    let compressed_bytes: usize = files.iter().map(|(_, file)| file.compressed_bytes()).sum();
    tracing::info!(
        directory = %directory.display(),
        files = files.len(),
        original_bytes,
        compressed_bytes,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "공개 화면 파일을 메모리에 올렸습니다"
    );
    Ok(StaticSite { directory, files: files.into_iter().collect() })
}

fn read_directory(root: &Path, directory: &Path, out: &mut Vec<Source>) -> io::Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            read_directory(root, &path, out)?;
        } else {
            let relative = path.strip_prefix(root).map_err(io::Error::other)?;
            let key = relative.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
            out.push(Source { key, bytes: std::fs::read(&path)? });
        }
    }
    Ok(())
}

fn build_files(sources: &[Source]) -> Vec<(String, StaticFile)> {
    let next = AtomicUsize::new(0);
    let workers = std::thread::available_parallelism().map_or(1, |n| n.get()).min(sources.len().max(1));
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                scope.spawn(|| {
                    let mut built = Vec::new();
                    while let Some(source) = sources.get(next.fetch_add(1, Ordering::Relaxed)) {
                        built.push((source.key.clone(), build_file(source)));
                    }
                    built
                })
            })
            .collect();
        handles.into_iter().flat_map(|handle| handle.join().expect("압축 작업자가 죽었습니다")).collect()
    })
}

fn build_file(source: &Source) -> StaticFile {
    let digest = Sha256::digest(&source.bytes);
    let hash: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    let representation = |body: Vec<u8>, encoding: Encoding| Representation {
        body: Bytes::from(body),
        etag: HeaderValue::from_str(&format!("\"{hash}{}\"", encoding.etag_suffix())).expect("ETag는 ASCII입니다"),
    };
    let only_if_smaller = |compressed: Vec<u8>| (compressed.len() < source.bytes.len()).then_some(compressed);
    let (brotli, gzip) = if is_already_compressed(&source.key) {
        (None, None)
    } else {
        (only_if_smaller(brotli_compress(&source.bytes)), only_if_smaller(gzip_compress(&source.bytes)))
    };
    StaticFile {
        content_type: mime(&source.key),
        identity: representation(source.bytes.clone(), Encoding::Identity),
        brotli: brotli.map(|body| representation(body, Encoding::Brotli)),
        gzip: gzip.map(|body| representation(body, Encoding::Gzip)),
    }
}

fn brotli_compress(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut writer = brotli::CompressorWriter::new(&mut out, 64 * 1024, BROTLI_QUALITY, BROTLI_WINDOW_BITS);
        writer.write_all(bytes).expect("메모리에 쓰기는 실패하지 않습니다");
    }
    out
}

fn gzip_compress(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    encoder.write_all(bytes).expect("메모리에 쓰기는 실패하지 않습니다");
    encoder.finish().expect("메모리에 쓰기는 실패하지 않습니다")
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use axum::body::to_bytes;

    use super::*;

    fn script_text(bytes: usize) -> Vec<u8> {
        let words = ["function", "const", "return", "chart", "candle", "await", "volume", "render", "state", "(", ")", "{", "}", ";"];
        let mut seed = 0x2545_f491_u64;
        let mut out = String::new();
        while out.len() < bytes {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            out.push_str(words[(seed >> 33) as usize % words.len()]);
            out.push(' ');
        }
        out.into_bytes()
    }

    fn accept(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT_ENCODING, value.parse().unwrap());
        headers
    }

    fn header_of(response: &Response, name: header::HeaderName) -> String {
        response.headers().get(name).map(|v| v.to_str().unwrap().to_owned()).unwrap_or_default()
    }

    async fn body_of(response: Response) -> Vec<u8> {
        to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec()
    }

    fn unbrotli(bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        brotli::Decompressor::new(bytes, 4096).read_to_end(&mut out).unwrap();
        out
    }

    fn ungzip(bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(bytes).read_to_end(&mut out).unwrap();
        out
    }

    async fn site_with(files: &[(&str, &[u8])]) -> (tempfile::TempDir, StaticSite) {
        let dir = tempfile::tempdir().unwrap();
        for (relative, bytes) in files {
            let path = dir.path().join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
        let site = StaticSite::load(dir.path().to_path_buf()).await.unwrap();
        (dir, site)
    }

    #[tokio::test]
    async fn brotli_is_preferred_then_gzip_then_the_original() {
        let script = script_text(50_000);
        let (_dir, site) = site_with(&[("assets/app.js", &script)]).await;

        let br = site.respond(&Method::GET, "/assets/app.js", &accept("gzip, br"));
        assert_eq!(header_of(&br, header::CONTENT_ENCODING), "br");
        assert_eq!(header_of(&br, header::VARY), "Accept-Encoding");
        assert_eq!(header_of(&br, header::CONTENT_TYPE), "text/javascript; charset=utf-8");
        assert_eq!(unbrotli(&body_of(br).await), script);

        let gz = site.respond(&Method::GET, "/assets/app.js", &accept("gzip"));
        assert_eq!(header_of(&gz, header::CONTENT_ENCODING), "gzip");
        assert_eq!(ungzip(&body_of(gz).await), script);

        let plain = site.respond(&Method::GET, "/assets/app.js", &HeaderMap::new());
        assert_eq!(header_of(&plain, header::CONTENT_ENCODING), "");
        assert_eq!(header_of(&plain, header::VARY), "Accept-Encoding");
        assert_eq!(header_of(&plain, header::CONTENT_LENGTH), script.len().to_string());
        assert_eq!(body_of(plain).await, script);
    }

    #[tokio::test]
    async fn an_encoding_refused_with_q_zero_is_not_used() {
        let (_dir, site) = site_with(&[("assets/app.js", &script_text(20_000))]).await;
        let response = site.respond(&Method::GET, "/assets/app.js", &accept("br;q=0, gzip;q=0.5"));
        assert_eq!(header_of(&response, header::CONTENT_ENCODING), "gzip");
    }

    #[tokio::test]
    async fn a_copy_that_is_not_smaller_is_dropped() {
        let (_dir, site) = site_with(&[("assets/tiny.txt", b"a")]).await;
        let response = site.respond(&Method::GET, "/assets/tiny.txt", &accept("br, gzip"));
        assert_eq!(header_of(&response, header::CONTENT_ENCODING), "");
        assert_eq!(header_of(&response, header::VARY), "");
        assert_eq!(body_of(response).await, b"a");
    }

    #[tokio::test]
    async fn already_compressed_formats_are_served_as_they_are() {
        let payload = script_text(20_000);
        let names: Vec<String> = ["woff2", "woff", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "zip"].iter().map(|ext| format!("assets/file.{ext}")).collect();
        let files: Vec<(&str, &[u8])> = names.iter().map(|name| (name.as_str(), payload.as_slice())).collect();
        let (_dir, site) = site_with(&files).await;
        for name in &names {
            let response = site.respond(&Method::GET, &format!("/{name}"), &accept("br, gzip"));
            assert_eq!(header_of(&response, header::CONTENT_ENCODING), "", "{name}");
            assert_eq!(header_of(&response, header::VARY), "", "{name}");
            assert_eq!(body_of(response).await, payload, "{name}");
        }
    }

    #[tokio::test]
    async fn wasm_and_svg_are_compressed_because_they_shrink_well() {
        let (_dir, site) = site_with(&[("assets/engine.wasm", &script_text(30_000)), ("assets/logo.svg", &script_text(30_000))]).await;
        for path in ["/assets/engine.wasm", "/assets/logo.svg"] {
            let response = site.respond(&Method::GET, path, &accept("br"));
            assert_eq!(header_of(&response, header::CONTENT_ENCODING), "br", "{path}");
        }
        let wasm = site.respond(&Method::GET, "/assets/engine.wasm", &accept("br"));
        assert_eq!(header_of(&wasm, header::CONTENT_TYPE), "application/wasm");
    }

    #[tokio::test]
    async fn a_matching_if_none_match_gets_an_empty_304_with_the_validators() {
        let (_dir, site) = site_with(&[("assets/app.js", &script_text(20_000))]).await;
        let first = site.respond(&Method::GET, "/assets/app.js", &accept("br"));
        let etag = header_of(&first, header::ETAG);
        assert!(etag.starts_with('"') && etag.ends_with('"'));

        let mut headers = accept("br");
        headers.insert(header::IF_NONE_MATCH, etag.parse().unwrap());
        let revalidated = site.respond(&Method::GET, "/assets/app.js", &headers);
        assert_eq!(revalidated.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(header_of(&revalidated, header::ETAG), etag);
        assert_eq!(header_of(&revalidated, header::CACHE_CONTROL), IMMUTABLE);
        assert_eq!(header_of(&revalidated, header::VARY), "Accept-Encoding");
        assert!(body_of(revalidated).await.is_empty());

        headers.insert(header::IF_NONE_MATCH, "\"other\"".parse().unwrap());
        assert_eq!(site.respond(&Method::GET, "/assets/app.js", &headers).status(), StatusCode::OK);

        headers.insert(header::IF_NONE_MATCH, format!("\"x\", W/{etag}").parse().unwrap());
        assert_eq!(site.respond(&Method::GET, "/assets/app.js", &headers).status(), StatusCode::NOT_MODIFIED);
    }

    #[tokio::test]
    async fn each_encoding_of_one_file_has_its_own_etag_and_the_same_content_keeps_it() {
        let script = script_text(20_000);
        let (_dir, site) = site_with(&[("assets/app.js", &script)]).await;
        let etag_for = |site: &StaticSite, encoding: &str| header_of(&site.respond(&Method::GET, "/assets/app.js", &accept(encoding)), header::ETAG);
        assert_ne!(etag_for(&site, "br"), etag_for(&site, "gzip"));
        assert_ne!(etag_for(&site, "br"), etag_for(&site, ""));
        let (_other_dir, other) = site_with(&[("assets/app.js", &script)]).await;
        assert_eq!(etag_for(&site, "br"), etag_for(&other, "br"));

        let mut headers = accept("gzip");
        headers.insert(header::IF_NONE_MATCH, etag_for(&site, "br").parse().unwrap());
        assert_eq!(site.respond(&Method::GET, "/assets/app.js", &headers).status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn head_has_the_get_headers_and_no_body() {
        let (_dir, site) = site_with(&[("assets/app.js", &script_text(20_000))]).await;
        let get = site.respond(&Method::GET, "/assets/app.js", &accept("br"));
        let head = site.respond(&Method::HEAD, "/assets/app.js", &accept("br"));
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.headers(), get.headers());
        assert!(body_of(head).await.is_empty());
        assert!(!body_of(get).await.is_empty());
    }

    #[tokio::test]
    async fn methods_other_than_get_and_head_are_405() {
        let (_dir, site) = site_with(&[("index.html", b"<html></html>")]).await;
        for method in [Method::POST, Method::PUT, Method::DELETE, Method::PATCH] {
            assert_eq!(site.respond(&method, "/", &HeaderMap::new()).status(), StatusCode::METHOD_NOT_ALLOWED, "{method}");
        }
    }

    #[tokio::test]
    async fn a_path_without_extension_gets_index_html() {
        let page = b"<html>spa</html>";
        let (_dir, site) = site_with(&[("index.html", page)]).await;
        for path in ["/", "/chart/005930", "/screener"] {
            let response = site.respond(&Method::GET, path, &HeaderMap::new());
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert_eq!(header_of(&response, header::CONTENT_TYPE), "text/html; charset=utf-8");
            assert_eq!(header_of(&response, header::CACHE_CONTROL), NO_CACHE);
            assert_eq!(body_of(response).await, page);
        }
    }

    #[tokio::test]
    async fn a_missing_index_html_still_loads_and_answers_404_with_guidance() {
        let (_dir, site) = site_with(&[("assets/app.js", b"x")]).await;
        let response = site.respond(&Method::GET, "/chart", &HeaderMap::new());
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(String::from_utf8(body_of(response).await).unwrap().contains("index.html이 없습니다"));
    }

    #[tokio::test]
    async fn parent_segments_and_backslashes_are_404() {
        let (_dir, site) = site_with(&[("index.html", b"<html></html>"), ("assets/app.js", b"x")]).await;
        for path in ["/../index.html", "/assets/../index.html", "/assets/..", "/assets\\app.js", "/a\\b"] {
            assert_eq!(site.respond(&Method::GET, path, &HeaderMap::new()).status(), StatusCode::NOT_FOUND, "{path}");
        }
    }

    #[tokio::test]
    async fn a_missing_asset_or_file_with_extension_is_an_empty_404_without_spa_fallback() {
        let (_dir, site) = site_with(&[("index.html", b"<html></html>")]).await;
        for path in ["/assets/missing.js", "/assets/missing", "/nothing.txt"] {
            let response = site.respond(&Method::GET, path, &HeaderMap::new());
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            assert!(body_of(response).await.is_empty(), "{path}");
        }
    }

    #[tokio::test]
    async fn cache_headers_follow_the_table() {
        let (_dir, site) = site_with(&[("index.html", b"<html></html>"), ("assets/app.js", b"x"), ("favicon.ico", b"i"), ("manifest.webmanifest", b"{}")]).await;
        let cache = |path: &str| header_of(&site.respond(&Method::GET, path, &HeaderMap::new()), header::CACHE_CONTROL);
        assert_eq!(cache("/assets/app.js"), IMMUTABLE);
        assert_eq!(cache("/index.html"), NO_CACHE);
        assert_eq!(cache("/some/spa/route"), NO_CACHE);
        assert_eq!(cache("/favicon.ico"), "");
        assert_eq!(cache("/manifest.webmanifest"), "");
    }

    #[tokio::test]
    async fn nested_directories_are_read_recursively() {
        let (_dir, site) = site_with(&[("assets/deep/er/chunk.js", b"deep"), ("assets/a.css", b"a{}")]).await;
        let response = site.respond(&Method::GET, "/assets/deep/er/chunk.js", &HeaderMap::new());
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_of(response).await, b"deep");
        assert_eq!(header_of(&site.respond(&Method::GET, "/assets/a.css", &HeaderMap::new()), header::CONTENT_TYPE), "text/css; charset=utf-8");
    }

    #[tokio::test]
    async fn a_missing_directory_fails_to_load() {
        let dir = tempfile::tempdir().unwrap();
        assert!(StaticSite::load(dir.path().join("nope")).await.is_err());
    }
}
