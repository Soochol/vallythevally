use std::fs;
use std::io::Read;

use axum::http::StatusCode;
use serde_json::Value;

use super::support::{DATE, app, built_day, get};

const SPAN_URL: &str = "/data/20260720/005930/1025-r1.hoga";

fn inflate(compressed: &[u8]) -> Vec<u8> {
    let mut plain = Vec::new();
    brotli::Decompressor::new(compressed, 4096).read_to_end(&mut plain).unwrap();
    plain
}

#[tokio::test]
async fn dates_json_lists_days_with_an_index() {
    let data = built_day();
    fs::create_dir_all(data.path().join("spans/20260719")).unwrap();
    fs::create_dir_all(data.path().join("spans/notadate")).unwrap();
    let reply = get(&app(&data), "/data/dates.json", None).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.header("content-type"), Some("application/json"));
    assert_eq!(serde_json::from_slice::<Vec<String>>(&reply.body).unwrap(), vec![DATE.to_string()]);
}

#[tokio::test]
async fn dates_json_is_empty_without_spans() {
    let data = tempfile::tempdir().unwrap();
    let reply = get(&app(&data), "/data/dates.json", None).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body, b"[]");
}

#[tokio::test]
async fn index_json_is_the_file_on_disk_and_never_cached() {
    let data = built_day();
    let reply = get(&app(&data), "/data/20260720/index.json", None).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body, fs::read(data.path().join("spans/20260720/index.json")).unwrap());
    assert_eq!(reply.header("cache-control"), Some("no-store"));
    let index: Value = serde_json::from_slice(&reply.body).unwrap();
    assert!(index["symbols"]["005930"]["spans"].as_array().is_some_and(|spans| !spans.is_empty()));
}

#[tokio::test]
async fn span_file_is_sent_as_stored_when_brotli_is_accepted() {
    let data = built_day();
    let stored = fs::read(data.path().join("spans/20260720/005930/1025-r1.hoga.br")).unwrap();
    for accept in ["br", "gzip, deflate, br", "gzip, br;q=0.8", "BR", "br;q=1"] {
        let reply = get(&app(&data), SPAN_URL, Some(accept)).await;
        assert_eq!(reply.status, StatusCode::OK, "{accept}");
        assert_eq!(reply.header("content-encoding"), Some("br"), "{accept}");
        assert_eq!(reply.body, stored, "{accept}");
        assert_eq!(reply.header("content-type"), Some("application/octet-stream"));
        assert_eq!(reply.header("vary"), Some("Accept-Encoding"));
        assert!(reply.header("cache-control").unwrap().contains("max-age=31536000"));
        let span = hoga_format::decode(&inflate(&reply.body)).unwrap();
        assert_eq!(span.symbol, "005930");
        assert_eq!(span.start_minute, 10 * 60 + 25);
    }
}

#[tokio::test]
async fn span_file_is_inflated_when_brotli_is_not_accepted() {
    let data = built_day();
    let stored = fs::read(data.path().join("spans/20260720/005930/1025-r1.hoga.br")).unwrap();
    for accept in [None, Some("gzip, deflate"), Some("identity"), Some("br;q=0"), Some("br;Q=0"), Some("gzip, br;Q=0.0")] {
        let reply = get(&app(&data), SPAN_URL, accept).await;
        assert_eq!(reply.status, StatusCode::OK, "{accept:?}");
        assert_eq!(reply.header("content-encoding"), None, "{accept:?}");
        assert_eq!(reply.header("vary"), Some("Accept-Encoding"));
        assert_eq!(reply.body, inflate(&stored), "{accept:?}");
        let span = hoga_format::decode(&reply.body).unwrap();
        assert_eq!(span.symbol, "005930");
    }
}

#[tokio::test]
async fn unknown_or_malformed_paths_are_not_found() {
    let data = built_day();
    let app = app(&data);
    let paths = [
        "/data/20260101/index.json",
        "/data/2026072/index.json",
        "/data/2026072a/index.json",
        "/data/20260720/999999/1025-r1.hoga",
        "/data/20260720/005930/1025-r99.hoga",
        "/data/20260720/005930/1020-r1.hoga",
        "/data/20260720/../1025-r1.hoga",
        "/data/20260720/%2e%2e/1025-r1.hoga",
        "/data/20260720/005930/..%2f..%2findex.json",
        "/data/..%2f..%2fCargo/005930/1025-r1.hoga",
        "/data/20260720/005930.x/1025-r1.hoga",
        "/data/20260720/005930/1025-r1.hoga.br",
        "/data/20260720/005930/1025-r1.hoga.br.hoga",
        "/data/20260720/005930/1025-r0.hoga",
        "/data/20260720/005930/1025.hoga",
        "/data/20260720/005930/index.json",
        "/data/20260720/005930",
        "/data/20260720/verified.json",
        "/data/20260720/",
        "/raw/20260720/1025-000.jsonl.zst",
        "/spans/20260720/index.json",
        "/data",
        "/nothing",
    ];
    for path in paths {
        assert_eq!(get(&app, path, Some("br")).await.status, StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn page_files_come_with_their_content_types() {
    let data = built_day();
    let app = app(&data);
    let expected = [
        ("/", "text/html; charset=utf-8"),
        ("/style.css", "text/css; charset=utf-8"),
        ("/main.js", "text/javascript; charset=utf-8"),
        ("/worker.js", "text/javascript; charset=utf-8"),
        ("/decode.js", "text/javascript; charset=utf-8"),
        ("/seek.js", "text/javascript; charset=utf-8"),
        ("/replay.js", "text/javascript; charset=utf-8"),
        ("/view.js", "text/javascript; charset=utf-8"),
    ];
    for (path, content_type) in expected {
        let reply = get(&app, path, None).await;
        assert_eq!(reply.status, StatusCode::OK, "{path}");
        assert_eq!(reply.header("content-type"), Some(content_type), "{path}");
        assert!(!reply.body.is_empty(), "{path}");
        assert_eq!(reply.header("access-control-allow-origin"), None, "{path}");
    }
    assert!(String::from_utf8(get(&app, "/", None).await.body).unwrap().contains("호가 복기"));
}

#[cfg(unix)]
#[tokio::test]
async fn links_that_leave_the_data_folder_are_not_followed() {
    use std::os::unix::fs::symlink;

    let data = built_day();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.json"), "SECRET").unwrap();
    fs::write(outside.path().join("1025-r5.hoga.br"), "SECRET").unwrap();
    let day = data.path().join("spans/20260720");
    fs::remove_file(day.join("index.json")).unwrap();
    symlink(outside.path().join("secret.json"), day.join("index.json")).unwrap();
    symlink(outside.path(), day.join("EVIL")).unwrap();
    let app = app(&data);
    assert_eq!(get(&app, "/data/20260720/index.json", None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(get(&app, "/data/20260720/EVIL/1025-r5.hoga", Some("br")).await.status, StatusCode::NOT_FOUND);
    assert_eq!(get(&app, "/data/dates.json", None).await.body, b"[]");
}
