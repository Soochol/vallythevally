use std::path::{Path, PathBuf};

use super::engine::AlertState;

#[derive(Debug, Clone)]
pub struct StateStore {
    path: PathBuf,
}

impl StateStore {
    pub fn in_folder(folder: &Path, component: &str) -> StateStore {
        StateStore { path: folder.join(format!("alert-state-{component}.json")) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> AlertState {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return AlertState::default(),
            Err(error) => {
                tracing::warn!(path = %self.path.display(), %error, "알림 상태 파일을 읽지 못해 처음부터 시작합니다");
                return AlertState::default();
            }
        };
        serde_json::from_str(&text).unwrap_or_else(|error| {
            tracing::warn!(path = %self.path.display(), %error, "알림 상태 파일이 깨져 있어 처음부터 시작합니다");
            AlertState::default()
        })
    }

    pub fn save(&self, state: &AlertState) {
        let written = serde_json::to_vec(state).map_err(std::io::Error::other).and_then(|bytes| {
            if let Some(folder) = self.path.parent() {
                std::fs::create_dir_all(folder)?;
            }
            let temporary = self.path.with_extension("tmp");
            std::fs::write(&temporary, bytes)?;
            std::fs::rename(&temporary, &self.path)
        });
        if let Err(error) = written {
            tracing::warn!(path = %self.path.display(), %error, "알림 상태 파일을 남기지 못했습니다");
        }
    }
}
