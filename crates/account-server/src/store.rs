use crate::clock::UnixSeconds;
use crate::model::{CodeChallenge, ConnectorPort, ConnectorState, LoginFlow, Provider, StartRequest};
use crate::secrets::{random_string, sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Row, Sqlite, SqlitePool, Transaction};
use std::path::Path;

pub const PENDING_LOGIN_SECONDS: i64 = 10 * 60;
pub const AUTH_CODE_SECONDS: i64 = 60;
pub const TOKEN_IDLE_SECONDS: i64 = 90 * 24 * 60 * 60;
pub const SESSION_IDLE_SECONDS: i64 = 30 * 24 * 60 * 60;
pub const SESSION_ABSOLUTE_SECONDS: i64 = 90 * 24 * 60 * 60;
pub const SESSION_TOUCH_SECONDS: i64 = 60 * 60;

pub async fn open_database(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new().max_connections(8).connect_with(options).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

pub struct NewPendingLogin<'a> {
    pub idp_state: &'a str,
    pub provider: Provider,
    pub browser_secret: &'a str,
    pub nonce: &'a str,
    pub flow: &'a LoginFlow,
}

pub enum PendingLoginSlot {
    Granted,
    Full,
}

pub struct PendingLogin {
    pub nonce: String,
    pub flow: LoginFlow,
}

pub enum AccountSlot {
    Existing(String),
    Created(String),
    Full,
}

pub struct SessionRecord {
    pub account_id: String,
    pub provider: String,
    pub subject: String,
    pub created_at: i64,
}

pub struct AccountView {
    pub id: String,
    pub provider: String,
    pub subject: String,
    pub created_at: i64,
}

#[derive(Clone)]
pub struct Store {
    pub(crate) pool: SqlitePool,
}

impl Store {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub(crate) async fn begin_account_write(&self) -> Result<Transaction<'static, Sqlite>, sqlx::Error> {
        self.pool.begin_with("BEGIN IMMEDIATE").await
    }

    pub async fn purge_expired(&self, now: UnixSeconds) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM pending_logins WHERE expires_at <= ?")
            .bind(now.0)
            .execute(&self.pool)
            .await?;
        sqlx::query("DELETE FROM auth_codes WHERE expires_at <= ?")
            .bind(now.0)
            .execute(&self.pool)
            .await?;
        sqlx::query("DELETE FROM connector_tokens WHERE last_used_at <= ?")
            .bind(now.0 - TOKEN_IDLE_SECONDS)
            .execute(&self.pool)
            .await?;
        sqlx::query("DELETE FROM sessions WHERE last_used_at <= ? OR created_at <= ?")
            .bind(now.0 - SESSION_IDLE_SECONDS)
            .bind(now.0 - SESSION_ABSOLUTE_SECONDS)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn insert_pending_login(
        &self,
        pending: NewPendingLogin<'_>,
        now: UnixSeconds,
        limit: u32,
    ) -> Result<PendingLoginSlot, sqlx::Error> {
        let inserted = sqlx::query(
            "INSERT INTO pending_logins (idp_state, provider, browser_hash, nonce, flow, connector_port, connector_state, code_challenge, expires_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM pending_logins WHERE expires_at > ?) < ?",
        )
        .bind(pending.idp_state)
        .bind(pending.provider.as_str())
        .bind(sha256(pending.browser_secret))
        .bind(pending.nonce)
        .bind(match pending.flow {
            LoginFlow::Connector(_) => "connector",
            LoginFlow::Browser => "browser",
        })
        .bind(match pending.flow {
            LoginFlow::Connector(request) => Some(i64::from(request.port.get())),
            LoginFlow::Browser => None,
        })
        .bind(match pending.flow {
            LoginFlow::Connector(request) => Some(request.state.as_str()),
            LoginFlow::Browser => None,
        })
        .bind(match pending.flow {
            LoginFlow::Connector(request) => Some(request.code_challenge.as_str()),
            LoginFlow::Browser => None,
        })
        .bind(now.plus(PENDING_LOGIN_SECONDS).0)
        .bind(now.0)
        .bind(i64::from(limit))
        .execute(&self.pool)
        .await?
        .rows_affected();
        Ok(if inserted == 1 { PendingLoginSlot::Granted } else { PendingLoginSlot::Full })
    }

    pub async fn take_pending_login(
        &self,
        provider: Provider,
        idp_state: &str,
        browser_secret: &str,
        now: UnixSeconds,
    ) -> Result<Option<PendingLogin>, sqlx::Error> {
        let row = sqlx::query(
            "DELETE FROM pending_logins WHERE idp_state = ? AND provider = ? AND browser_hash = ? AND expires_at > ? RETURNING nonce, flow, connector_port, connector_state, code_challenge",
        )
        .bind(idp_state)
        .bind(provider.as_str())
        .bind(sha256(browser_secret))
        .bind(now.0)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.and_then(|row| {
            let flow = match row.get::<String, _>("flow").as_str() {
                "browser" => LoginFlow::Browser,
                _ => LoginFlow::Connector(StartRequest {
                    port: ConnectorPort::from_stored(row.get::<Option<i64>, _>("connector_port")?)?,
                    state: ConnectorState::from_stored(row.get::<Option<String>, _>("connector_state")?),
                    code_challenge: CodeChallenge::from_stored(row.get::<Option<String>, _>("code_challenge")?),
                }),
            };
            Some(PendingLogin { nonce: row.get("nonce"), flow })
        }))
    }

    pub async fn account_for_identity(
        &self,
        provider: Provider,
        subject: &str,
        now: UnixSeconds,
        max_accounts: u32,
    ) -> Result<AccountSlot, sqlx::Error> {
        let existing: Option<String> = sqlx::query_scalar("SELECT account_id FROM identities WHERE provider = ? AND subject = ?")
            .bind(provider.as_str())
            .bind(subject)
            .fetch_optional(&self.pool)
            .await?;
        if let Some(account_id) = existing {
            return Ok(AccountSlot::Existing(account_id));
        }
        let mut transaction = self.begin_account_write().await?;
        let existing: Option<String> = sqlx::query_scalar("SELECT account_id FROM identities WHERE provider = ? AND subject = ?")
            .bind(provider.as_str())
            .bind(subject)
            .fetch_optional(&mut *transaction)
            .await?;
        if let Some(account_id) = existing {
            return Ok(AccountSlot::Existing(account_id));
        }
        let accounts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM accounts").fetch_one(&mut *transaction).await?;
        if accounts >= i64::from(max_accounts) {
            return Ok(AccountSlot::Full);
        }
        let account_id = random_string(16);
        sqlx::query("INSERT INTO accounts (id, created_at) VALUES (?, ?)")
            .bind(&account_id)
            .bind(now.0)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("INSERT INTO identities (provider, subject, account_id) VALUES (?, ?, ?)")
            .bind(provider.as_str())
            .bind(subject)
            .bind(&account_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(AccountSlot::Created(account_id))
    }

    pub async fn insert_auth_code(&self, code: &str, account_id: &str, challenge: &CodeChallenge, now: UnixSeconds) -> Result<(), sqlx::Error> {
        sqlx::query("INSERT INTO auth_codes (code_hash, account_id, code_challenge, expires_at) VALUES (?, ?, ?, ?)")
            .bind(sha256(code))
            .bind(account_id)
            .bind(challenge.as_str())
            .bind(now.plus(AUTH_CODE_SECONDS).0)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn take_auth_code(&self, code: &str, now: UnixSeconds) -> Result<Option<(String, String)>, sqlx::Error> {
        let row = sqlx::query("DELETE FROM auth_codes WHERE code_hash = ? AND expires_at > ? RETURNING account_id, code_challenge")
            .bind(sha256(code))
            .bind(now.0)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|row| (row.get("account_id"), row.get("code_challenge"))))
    }

    pub async fn insert_token(&self, token: &str, account_id: &str, now: UnixSeconds) -> Result<(), sqlx::Error> {
        sqlx::query("INSERT INTO connector_tokens (token_hash, account_id, created_at, last_used_at) VALUES (?, ?, ?, ?)")
            .bind(sha256(token))
            .bind(account_id)
            .bind(now.0)
            .bind(now.0)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn touch_token(&self, token: &str, now: UnixSeconds) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar(
            "UPDATE connector_tokens SET last_used_at = ? WHERE token_hash = ? AND last_used_at > ? RETURNING account_id",
        )
        .bind(now.0)
        .bind(sha256(token))
        .bind(now.0 - TOKEN_IDLE_SECONDS)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn revoke_token(&self, token: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM connector_tokens WHERE token_hash = ?")
            .bind(sha256(token))
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn account(&self, account_id: &str) -> Result<Option<AccountView>, sqlx::Error> {
        let row = sqlx::query(
            "SELECT a.id, a.created_at, i.provider, i.subject FROM accounts a JOIN identities i ON i.account_id = a.id WHERE a.id = ?",
        )
        .bind(account_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| AccountView {
            id: row.get("id"),
            provider: row.get("provider"),
            subject: row.get("subject"),
            created_at: row.get("created_at"),
        }))
    }

    pub async fn delete_account(&self, account_id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM accounts WHERE id = ?").bind(account_id).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn insert_session(&self, session: &str, account_id: &str, now: UnixSeconds) -> Result<(), sqlx::Error> {
        sqlx::query("INSERT INTO sessions (token_hash, account_id, created_at, last_used_at) VALUES (?, ?, ?, ?)")
            .bind(sha256(session))
            .bind(account_id)
            .bind(now.0)
            .bind(now.0)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn touch_session(&self, session: &str, now: UnixSeconds) -> Result<Option<SessionRecord>, sqlx::Error> {
        let hash = sha256(session);
        let row = sqlx::query(
            "SELECT s.account_id, s.created_at, s.last_used_at, i.provider, i.subject FROM sessions s JOIN identities i ON i.account_id = s.account_id WHERE s.token_hash = ?",
        )
        .bind(&hash)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let created_at: i64 = row.get("created_at");
        let last_used_at: i64 = row.get("last_used_at");
        if now.0 - last_used_at >= SESSION_IDLE_SECONDS || now.0 - created_at >= SESSION_ABSOLUTE_SECONDS {
            sqlx::query("DELETE FROM sessions WHERE token_hash = ?").bind(&hash).execute(&self.pool).await?;
            return Ok(None);
        }
        if now.0 - last_used_at > SESSION_TOUCH_SECONDS {
            sqlx::query("UPDATE sessions SET last_used_at = ? WHERE token_hash = ? AND last_used_at = ?")
                .bind(now.0)
                .bind(&hash)
                .bind(last_used_at)
                .execute(&self.pool)
                .await?;
        }
        Ok(Some(SessionRecord { account_id: row.get("account_id"), provider: row.get("provider"), subject: row.get("subject"), created_at }))
    }

    pub async fn revoke_session(&self, session: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM sessions WHERE token_hash = ?").bind(sha256(session)).execute(&self.pool).await?;
        Ok(())
    }
}
