use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};

pub struct StaticSite;

impl StaticSite {
    pub async fn load(_dir: std::path::PathBuf) -> std::io::Result<StaticSite> {
        Ok(StaticSite)
    }

    pub fn respond(&self, _method: &Method, _path: &str, _headers: &HeaderMap) -> Response {
        StatusCode::NOT_FOUND.into_response()
    }
}
