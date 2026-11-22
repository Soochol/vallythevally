use axum::response::Json;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ServerModeKind {
    Local,
    Public,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ServerMode {
    pub mode: ServerModeKind,
}

pub async fn local() -> Json<ServerMode> {
    Json(ServerMode { mode: ServerModeKind::Local })
}

pub(super) async fn public() -> Json<ServerMode> {
    Json(ServerMode { mode: ServerModeKind::Public })
}
