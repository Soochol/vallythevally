use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::api::{AccountProvider, UnixSeconds};
use crate::config::Secret;
use crate::instance::InstanceLock;
use crate::kiwoom::private_file::{FileError, PrivateFile};

#[derive(Clone)]
pub struct Login {
    pub server_url: String,
    pub token: Secret<String>,
    pub account_id: String,
    pub provider: AccountProvider,
    pub signed_in_at: UnixSeconds,
}

#[derive(Serialize, Deserialize)]
struct Saved {
    server_url: String,
    token: String,
    account_id: String,
    provider: AccountProvider,
    signed_in_at: i64,
}

pub struct AccountStateFile {
    file: PrivateFile,
}

impl AccountStateFile {
    pub fn new(path: PathBuf, _held: &InstanceLock) -> Self {
        AccountStateFile { file: PrivateFile::new(path) }
    }

    pub fn path(&self) -> &Path {
        self.file.path()
    }

    pub fn load(&self) -> Result<Option<Login>, FileError> {
        let Some(text) = self.file.read()? else { return Ok(None) };
        let saved: Saved = serde_json::from_str(&text).map_err(|e| self.file.error(format_args!("JSON {:?} 오류, {}번째 줄", e.classify(), e.line())))?;
        Ok(Some(Login { server_url: saved.server_url, token: Secret::new(saved.token), account_id: saved.account_id, provider: saved.provider, signed_in_at: UnixSeconds(saved.signed_in_at) }))
    }

    pub fn save(&self, login: &Login) -> Result<(), FileError> {
        let saved = Saved { server_url: login.server_url.clone(), token: login.token.expose().clone(), account_id: login.account_id.clone(), provider: login.provider, signed_in_at: login.signed_in_at.0 };
        self.file.write(&serde_json::to_vec(&saved).expect("문자열과 정수만 담은 구조체"))
    }

    pub fn remove(&self) -> Result<(), FileError> {
        self.file.remove()
    }
}
