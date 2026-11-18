mod client;
pub(crate) mod owner;
mod pending;
mod state_file;
pub mod sync;

use std::fmt;
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

pub use state_file::AccountStateFile;

use self::client::{AccountClient, ClientError, Me};
use self::pending::PendingLogins;
use self::state_file::Login;
use crate::api::{AccountProvider, AccountStatus, UnixSeconds};
use crate::config::Secret;
use crate::db::AppDb;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountServerUrl(reqwest::Url);

impl AccountServerUrl {
    pub fn parse(value: &str) -> Result<Self, String> {
        let url = reqwest::Url::parse(value).map_err(|_| "주소를 읽을 수 없습니다".to_owned())?;
        let loopback_ip = url.host_str().is_some_and(|host| host.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()));
        let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback_ip);
        if !scheme_ok || url.host_str().is_none() {
            return Err("https 주소이거나 루프백 IP의 http 주소여야 합니다".into());
        }
        if url.path() != "/" || url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {
            return Err("경로·질의·계정 정보 없이 출처만 적습니다".into());
        }
        Ok(AccountServerUrl(url))
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str().trim_end_matches('/')
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderSubject {
    pub provider: AccountProvider,
    pub subject: String,
}

impl ProviderSubject {
    pub fn parse(value: &str) -> Result<Self, String> {
        let (provider, subject) = value.split_once(':').ok_or_else(|| format!("provider:subject 형식이 아닙니다: {value}"))?;
        let provider = match provider {
            "google" => AccountProvider::Google,
            "naver" => AccountProvider::Naver,
            other => return Err(format!("모르는 provider입니다(google이나 naver): {other}")),
        };
        if subject.is_empty() || subject.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(format!("subject가 비었거나 공백·제어 문자를 담았습니다: {value}"));
        }
        Ok(ProviderSubject { provider, subject: subject.to_owned() })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    LocalOnly,
    NotSignedIn,
    NotOwnerMismatch,
    OwnerMismatch,
    NeedsChoice,
    NoChoicePending,
    ServerUnavailable(ClientError),
    Storage,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Refusal::LocalOnly => f.write_str("계정 서버를 쓰지 않는 로컬 전용 모드입니다"),
            Refusal::NotSignedIn => f.write_str("로그인한 계정이 없습니다"),
            Refusal::NotOwnerMismatch => f.write_str("이 PC의 셋업이 다른 계정의 것일 때만 쓸 수 있습니다"),
            Refusal::OwnerMismatch => f.write_str("이 PC의 셋업이 다른 계정의 것이라 동기화하지 않습니다"),
            Refusal::NeedsChoice => f.write_str("첫 로그인 선택이 끝나지 않아 동기화하지 않습니다"),
            Refusal::NoChoicePending => f.write_str("지금 고를 첫 로그인 선택이 없습니다"),
            Refusal::ServerUnavailable(e) => e.fmt(f),
            Refusal::Storage => f.write_str("계정 상태를 저장하지 못했습니다. 서버 로그를 확인하세요"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailedLogin {
    State,
    Cancelled,
    IdpFailed,
    BadRequest,
    LocalOnly,
    Exchange,
    ServerUnreachable,
    Storage,
}

impl FailedLogin {
    pub fn code(self) -> &'static str {
        match self {
            FailedLogin::State => "state",
            FailedLogin::Cancelled => "cancelled",
            FailedLogin::IdpFailed => "idp_failed",
            FailedLogin::BadRequest => "bad_request",
            FailedLogin::LocalOnly => "local_only",
            FailedLogin::Exchange => "exchange_failed",
            FailedLogin::ServerUnreachable => "server_unreachable",
            FailedLogin::Storage => "storage",
        }
    }

    fn of_client(error: ClientError) -> Self {
        match error {
            ClientError::Unreachable => FailedLogin::ServerUnreachable,
            ClientError::Rejected(_) | ClientError::Malformed => FailedLogin::Exchange,
        }
    }
}

pub struct CompleteQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

struct Linked {
    url: AccountServerUrl,
    client: AccountClient,
    file: AccountStateFile,
    login: Mutex<Option<Login>>,
    pending: Mutex<PendingLogins>,
}

enum Mode {
    LocalOnly,
    Linked(Box<Linked>),
}

pub struct AccountState {
    mode: Mode,
    changes: tokio::sync::watch::Sender<u64>,
    sessions: tokio::sync::watch::Sender<u64>,
    write: tokio::sync::Mutex<()>,
    sync: sync::Sync,
}

const RANDOM_BYTES: usize = 32;

fn random_token() -> String {
    let mut bytes = [0u8; RANDOM_BYTES];
    getrandom::fill(&mut bytes).expect("운영체제 난수를 얻지 못했습니다");
    URL_SAFE_NO_PAD.encode(bytes)
}

fn prefix(id: &str) -> String {
    id.chars().take(8).collect()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().expect("계정 상태 잠금")
}

impl AccountState {
    pub fn local_only() -> Self {
        AccountState { mode: Mode::LocalOnly, changes: tokio::sync::watch::channel(0).0, sessions: tokio::sync::watch::channel(0).0, write: tokio::sync::Mutex::new(()), sync: sync::Sync::default() }
    }

    pub fn linked(url: AccountServerUrl, file: AccountStateFile) -> Result<Self, reqwest::Error> {
        let client = AccountClient::new(&url)?;
        let login = match file.load() {
            Ok(Some(login)) if login.server_url == url.as_str() => {
                tracing::info!(provider = ?login.provider, "저장된 계정 로그인을 읽었습니다");
                Some(login)
            }
            Ok(Some(_)) => {
                tracing::warn!("계정 상태 파일이 다른 계정 서버의 것이라 로그인하지 않은 것으로 봅니다. 그 서버로 아무것도 보내지 않습니다");
                None
            }
            Ok(None) => None,
            Err(e) => {
                tracing::warn!(error = %e, "계정 상태 파일을 읽지 못해 로그인하지 않은 것으로 봅니다");
                None
            }
        };
        let linked = Linked { url, client, file, login: Mutex::new(login), pending: Mutex::new(PendingLogins::default()) };
        Ok(AccountState { mode: Mode::Linked(Box::new(linked)), changes: tokio::sync::watch::channel(0).0, sessions: tokio::sync::watch::channel(0).0, write: tokio::sync::Mutex::new(()), sync: sync::Sync::default() })
    }

    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.changes.subscribe()
    }

    fn changed(&self) {
        self.changes.send_modify(|version| *version += 1);
    }

    fn session_changed(&self) {
        self.sessions.send_modify(|version| *version += 1);
        self.changed();
    }

    pub fn subscribe_sessions(&self) -> tokio::sync::watch::Receiver<u64> {
        self.sessions.subscribe()
    }

    pub fn is_linked(&self) -> bool {
        self.linked_mode().is_some()
    }

    fn linked_mode(&self) -> Option<&Linked> {
        match &self.mode {
            Mode::LocalOnly => None,
            Mode::Linked(linked) => Some(linked),
        }
    }

    pub async fn status(&self, db: &AppDb) -> Result<AccountStatus, sqlx::Error> {
        let Some(linked) = self.linked_mode() else { return Ok(AccountStatus::LocalOnly) };
        let Some(login) = lock(&linked.login).clone() else { return Ok(AccountStatus::SignedOut) };
        let (provider, account_id, signed_in_at) = (login.provider, prefix(&login.account_id), login.signed_in_at);
        let local_owner = owner::get(db).await?;
        let mismatch = local_owner.as_deref().filter(|local_owner| *local_owner != login.account_id);
        let sync = self.sync_status(db, mismatch.is_some()).await?;
        Ok(match mismatch {
            Some(local_owner) => AccountStatus::OwnerMismatch { provider, account_id, signed_in_at, local_owner: prefix(local_owner), sync },
            None => AccountStatus::SignedIn { provider, account_id, signed_in_at, sync },
        })
    }

    pub fn start_login(&self, now: UnixSeconds, provider: AccountProvider, port: u16) -> Result<String, Refusal> {
        let linked = self.linked_mode().ok_or(Refusal::LocalOnly)?;
        let (state, verifier) = (random_token(), random_token());
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let provider_path = match provider {
            AccountProvider::Google => "google",
            AccountProvider::Naver => "naver",
        };
        let url = format!("{}/v1/auth/{provider_path}/start?port={port}&state={state}&code_challenge={challenge}&code_challenge_method=S256", linked.url.as_str());
        lock(&linked.pending).insert(now.0, state, Secret::new(verifier));
        Ok(url)
    }

    pub async fn complete_login(&self, db: &AppDb, now: UnixSeconds, query: CompleteQuery) -> Result<(), FailedLogin> {
        let linked = self.linked_mode().ok_or(FailedLogin::LocalOnly)?;
        let state = query.state.filter(|state| !state.is_empty()).ok_or(FailedLogin::State)?;
        let pending = lock(&linked.pending).take(now.0, &state).ok_or(FailedLogin::State)?;
        if let Some(error) = query.error {
            return Err(if error == "cancelled" { FailedLogin::Cancelled } else { FailedLogin::IdpFailed });
        }
        let code = query.code.filter(|code| !code.is_empty()).ok_or(FailedLogin::BadRequest)?;
        let exchanged = linked.client.exchange(&code, &pending.verifier).await.map_err(FailedLogin::of_client)?;
        let me = match linked.client.me(&exchanged.token).await {
            Ok(me) => me,
            Err(e) => {
                let _ = linked.client.revoke(&exchanged.token).await;
                return Err(FailedLogin::of_client(e));
            }
        };
        let provider = me.provider;
        let login = Login { server_url: linked.url.as_str().to_owned(), token: exchanged.token, account_id: me.id, provider, subject: me.subject, signed_in_at: now };
        let _write = self.write.lock().await;
        let previous = lock(&linked.login).clone();
        if let Err(e) = linked.file.save(&login) {
            tracing::error!(error = %e, "계정 상태 파일을 쓰지 못했습니다");
            let _ = linked.client.revoke(&login.token).await;
            return Err(FailedLogin::Storage);
        }
        if let Err(e) = owner::set_if_none(db, &login.account_id).await {
            tracing::error!(error = %e, "로컬 소유 계정을 쓰지 못했습니다");
            let _ = linked.client.revoke(&login.token).await;
            match previous.as_ref() {
                Some(previous) => {
                    let _ = linked.file.save(previous);
                }
                None => {
                    let _ = linked.file.remove();
                }
            }
            return Err(FailedLogin::Storage);
        }
        *lock(&linked.login) = Some(login);
        if let Some(previous) = previous {
            let _ = linked.client.revoke(&previous.token).await;
        }
        tracing::info!(provider = ?provider, "계정에 로그인했습니다");
        self.session_changed();
        Ok(())
    }

    pub async fn refresh(&self) -> Result<(), Refusal> {
        let linked = self.linked_mode().ok_or(Refusal::LocalOnly)?;
        let _write = self.write.lock().await;
        let login = lock(&linked.login).clone().ok_or(Refusal::NotSignedIn)?;
        match linked.client.me(&login.token).await {
            Ok(me) if me.id == login.account_id => self.remember_subject(linked, &login, me),
            Ok(_) | Err(ClientError::Rejected(401)) => {
                tracing::warn!("계정 서버가 저장된 토큰을 받지 않아 로그아웃 상태로 돌립니다");
                linked.file.remove().map_err(|e| {
                    tracing::error!(error = %e, "계정 상태 파일을 지우지 못했습니다");
                    Refusal::Storage
                })?;
                *lock(&linked.login) = None;
                self.session_changed();
                Ok(())
            }
            Err(e) => Err(Refusal::ServerUnavailable(e)),
        }
    }

    fn remember_subject(&self, linked: &Linked, login: &Login, me: Me) -> Result<(), Refusal> {
        let Some(subject) = me.subject.filter(|_| login.subject.is_none()) else { return Ok(()) };
        let filled = Login { subject: Some(subject), ..login.clone() };
        let mut current = lock(&linked.login);
        if current.as_ref().is_none_or(|current| current.token.expose() != login.token.expose()) {
            return Ok(());
        }
        linked.file.save(&filled).map_err(|e| {
            tracing::error!(error = %e, "계정 상태 파일에 subject를 쓰지 못했습니다");
            Refusal::Storage
        })?;
        *current = Some(filled);
        drop(current);
        self.session_changed();
        Ok(())
    }

    pub fn signed_in_identity(&self) -> Option<ProviderSubject> {
        let login = lock(&self.linked_mode()?.login).clone()?;
        Some(ProviderSubject { provider: login.provider, subject: login.subject? })
    }

    pub fn is_signed_in_without_subject(&self) -> bool {
        self.linked_mode().is_some_and(|linked| lock(&linked.login).as_ref().is_some_and(|login| login.subject.is_none()))
    }

    pub async fn logout(&self) -> Result<(), Refusal> {
        let linked = self.linked_mode().ok_or(Refusal::LocalOnly)?;
        let _write = self.write.lock().await;
        let Some(login) = lock(&linked.login).clone() else { return Ok(()) };
        if let Err(e) = linked.client.revoke(&login.token).await {
            tracing::warn!(error = %e, "계정 서버에 토큰 폐기를 보내지 못했습니다. 로컬 로그아웃만 합니다");
        }
        linked.file.remove().map_err(|e| {
            tracing::error!(error = %e, "계정 상태 파일을 지우지 못했습니다");
            Refusal::Storage
        })?;
        *lock(&linked.login) = None;
        tracing::info!("계정에서 로그아웃했습니다");
        self.session_changed();
        Ok(())
    }

    pub async fn delete_account(&self, db: &AppDb) -> Result<(), Refusal> {
        let linked = self.linked_mode().ok_or(Refusal::LocalOnly)?;
        let _write = self.write.lock().await;
        let login = lock(&linked.login).clone().ok_or(Refusal::NotSignedIn)?;
        linked.client.delete_account(&login.token).await.map_err(|e| {
            tracing::warn!(error = %e, "계정 삭제를 계정 서버가 끝내지 못했습니다. 로컬 상태는 그대로 둡니다");
            Refusal::ServerUnavailable(e)
        })?;
        let removed = linked.file.remove();
        let cleared = owner::clear_if_owned_by(db, &login.account_id).await;
        if let Err(e) = &removed {
            tracing::error!(error = %e, "계정 삭제 뒤 계정 상태 파일을 지우지 못했습니다. 파일과 같게 로그인 상태로 둡니다");
        } else {
            *lock(&linked.login) = None;
        }
        if let Err(e) = &cleared {
            tracing::error!(error = %e, "계정 삭제 뒤 로컬 소유 표시를 지우지 못했습니다");
        }
        self.session_changed();
        tracing::info!("계정을 삭제했습니다");
        if removed.is_err() || cleared.is_err() { Err(Refusal::Storage) } else { Ok(()) }
    }

    pub async fn replace_local(&self, db: &AppDb) -> Result<(), Refusal> {
        let linked = self.linked_mode().ok_or(Refusal::LocalOnly)?;
        let _write = self.write.lock().await;
        let login = lock(&linked.login).clone().ok_or(Refusal::NotSignedIn)?;
        let current_owner = owner::get(db).await.map_err(|e| {
            tracing::error!(error = %e, "로컬 소유 계정을 읽지 못했습니다");
            Refusal::Storage
        })?;
        if current_owner.as_deref().is_none_or(|current| current == login.account_id) {
            return Err(Refusal::NotOwnerMismatch);
        }
        crate::setup_bundle::reset_to_default(db, &login.account_id).await.map_err(|e| {
            tracing::error!(error = e.message(), "로컬 셋업을 기본 상태로 되돌리지 못했습니다");
            Refusal::Storage
        })?;
        tracing::info!("이 PC의 셋업을 기본 상태로 되돌리고 소유 계정을 바꿨습니다");
        self.session_changed();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_account_server_is_https_or_a_loopback_origin() {
        for good in ["https://account.example.com", "https://account.example.com/", "http://127.0.0.1:8090", "http://[::1]:8090"] {
            assert!(AccountServerUrl::parse(good).is_ok(), "{good}");
        }
        for bad in ["http://account.example.com", "http://localhost:8090", "ftp://127.0.0.1", "https://user@account.example.com", "https://account.example.com/v1", "https://account.example.com/?a=1", "not a url", ""] {
            assert!(AccountServerUrl::parse(bad).is_err(), "{bad}");
        }
        assert_eq!(AccountServerUrl::parse("https://account.example.com/").unwrap().as_str(), "https://account.example.com");
    }
}
