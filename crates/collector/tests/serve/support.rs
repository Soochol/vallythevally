use std::fs;
use std::path::Path;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use collector::build::build_day;
use collector::serve::router;
use http_body_util::BodyExt;
use tempfile::{TempDir, tempdir};
use tower::ServiceExt;

pub const DATE: &str = "20260720";
const AFTER_THE_DAY_UNIX_MS: i64 = 1_784_473_200_000 + 36 * 3_600_000;

pub fn built_day() -> TempDir {
    let data = tempdir().unwrap();
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/raw/20260720");
    let target = data.path().join("raw/20260720");
    fs::create_dir_all(&target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|extension| extension == "zst") {
            fs::copy(&path, target.join(path.file_name().unwrap())).unwrap();
        }
    }
    let report = build_day(data.path(), 20260720, AFTER_THE_DAY_UNIX_MS).unwrap();
    assert!(!report.failed());
    data
}

pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(|value| value.to_str().unwrap())
    }
}

pub fn app(data: &TempDir) -> Router {
    router(data.path().to_path_buf())
}

pub async fn get(app: &Router, path: &str, accept_encoding: Option<&str>) -> Reply {
    let mut request = Request::builder().uri(path);
    if let Some(value) = accept_encoding {
        request = request.header("accept-encoding", value);
    }
    let response = app.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
    let (parts, body) = response.into_parts();
    Reply { status: parts.status, headers: parts.headers, body: body.collect().await.unwrap().to_bytes().to_vec() }
}
