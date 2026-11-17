use crate::app::{AppState, Shared, authenticate};
use crate::error::ApiError;
use crate::setup_store::{Checked, Outcome, SetupDocument};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, RawQuery, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

pub const MESSAGE_BYTES: usize = 8 * 1024 * 1024;
pub const CHANGES_BODY_BYTES: i64 = 7 * 1024 * 1024;
pub const MAX_PUSH_DOCUMENTS: usize = 500;
pub const DEFAULT_CHANGES_LIMIT: i64 = 100;
pub const MAX_CHANGES_LIMIT: i64 = 500;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v1/setup/push", post(push).layer(DefaultBodyLimit::max(MESSAGE_BYTES)))
        .route("/v1/setup/changes", get(changes))
        .route("/v1/setup/summary", get(summary))
}

#[derive(Deserialize)]
struct PushRequest {
    documents: Vec<Box<RawValue>>,
}

#[derive(Deserialize)]
struct PushRequestValues {
    documents: Vec<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum PushStatus {
    Accepted { seq: i64 },
    Stale { document: SetupDocument },
    Rejected { reason: String },
}

#[derive(Serialize)]
struct PushResult {
    kind: Option<String>,
    id: Option<String>,
    #[serde(flatten)]
    status: PushStatus,
}

#[derive(Serialize)]
struct PushResponse {
    results: Vec<PushResult>,
    seq: i64,
}

fn echoed(raw: &serde_json::Value, field: &str) -> Option<String> {
    raw.get(field).and_then(serde_json::Value::as_str).map(str::to_owned)
}

fn invalid_push() -> ApiError {
    ApiError::invalid_request("본문은 {documents: [문서…]} JSON이어야 합니다")
}

async fn push(State(state): Shared, headers: HeaderMap, body: Bytes) -> Result<Json<PushResponse>, ApiError> {
    let (_, account_id) = authenticate(&state, &headers).await?;
    let request: PushRequest =
        serde_json::from_slice(&body).map_err(|_| invalid_push())?;
    if request.documents.len() > MAX_PUSH_DOCUMENTS {
        return Err(ApiError::invalid_request(format!("한 번에 문서 {MAX_PUSH_DOCUMENTS}개까지 보냅니다")));
    }
    let values: PushRequestValues = serde_json::from_slice(&body).map_err(|_| invalid_push())?;
    let labels: Vec<_> = values.documents.iter().map(|value| (echoed(value, "kind"), echoed(value, "id"))).collect();
    let now_millis = state.clock.now().0.saturating_mul(1000);
    let mut seen = HashSet::new();
    let parsed: Vec<_> = request
        .documents
        .into_iter()
        .map(|raw| {
            let checked = Checked::parse(&raw, now_millis)?;
            if seen.insert((checked.document.kind, checked.document.id.clone())) {
                Ok(checked)
            } else {
                Err("같은 요청에 같은 종류와 id의 문서가 두 개 있습니다".to_owned())
            }
        })
        .collect();
    let valid: Vec<_> = parsed.iter().filter_map(|checked| checked.as_ref().ok()).collect();
    let pushed = state.store.push_documents(&account_id, &valid).await.map_err(|error| {
        if ApiError::is_foreign_key_violation(&error) { ApiError::unauthorized() } else { error.into() }
    })?;
    let mut stored = pushed.outcomes.into_iter();
    let results: Vec<_> = parsed
        .iter()
        .zip(labels)
        .map(|(checked, (kind, id))| {
            let status = match checked {
                Err(reason) => PushStatus::Rejected { reason: reason.clone() },
                Ok(_) => match stored.next().expect("검사를 통과한 문서마다 결과가 하나 있다") {
                    Outcome::Accepted { seq } => PushStatus::Accepted { seq },
                    Outcome::Stale(document) => PushStatus::Stale { document },
                    Outcome::Rejected(reason) => PushStatus::Rejected { reason },
                },
            };
            PushResult { kind, id, status }
        })
        .collect();
    let accepted = results.iter().filter(|result| matches!(result.status, PushStatus::Accepted { .. })).count();
    tracing::info!(account_id, documents = results.len(), accepted, bytes = pushed.accepted_bytes, "셋업 문서 받음");
    Ok(Json(PushResponse { results, seq: pushed.seq }))
}

fn query_number(query: &HashMap<String, String>, name: &str, default: i64, range: std::ops::RangeInclusive<i64>) -> Result<i64, ApiError> {
    let Some(value) = query.get(name) else { return Ok(default) };
    value
        .parse()
        .ok()
        .filter(|number| range.contains(number))
        .ok_or_else(|| ApiError::invalid_request(format!("{name}는 {}~{} 정수여야 합니다", range.start(), range.end())))
}

#[derive(Serialize)]
struct ChangesResponse {
    documents: Vec<SetupDocument>,
    seq: i64,
    more: bool,
}

async fn changes(State(state): Shared, headers: HeaderMap, RawQuery(raw): RawQuery) -> Result<Json<ChangesResponse>, ApiError> {
    let (_, account_id) = authenticate(&state, &headers).await?;
    let query: HashMap<String, String> = url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes()).into_owned().collect();
    let since = query_number(&query, "since", 0, 0..=i64::MAX)?;
    let limit = query_number(&query, "limit", DEFAULT_CHANGES_LIMIT, 1..=MAX_CHANGES_LIMIT)?;
    let changes = state.store.setup_changes(&account_id, since, limit, CHANGES_BODY_BYTES).await?;
    tracing::info!(account_id, documents = changes.documents.len(), "셋업 변경 보냄");
    Ok(Json(ChangesResponse { documents: changes.documents, seq: changes.seq, more: changes.more }))
}

#[derive(Serialize)]
struct SummaryResponse {
    documents: i64,
    bytes: i64,
    seq: i64,
}

async fn summary(State(state): Shared, headers: HeaderMap) -> Result<Json<SummaryResponse>, ApiError> {
    let (_, account_id) = authenticate(&state, &headers).await?;
    let summary = state.store.setup_summary(&account_id).await?;
    Ok(Json(SummaryResponse { documents: summary.documents, bytes: summary.bytes, seq: summary.seq }))
}
