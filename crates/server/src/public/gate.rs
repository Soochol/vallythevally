//! 공개 `/api/*`와 `/v1/*`의 문: 세션, 요청 제한, 동시 처리 상한, 허용 목록(ADR D2·D6·D7·D26).

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::Method;
use axum::middleware::Next;
use axum::response::Response;

use super::limits::{Rate, TokenBucket, locked};
use super::{AccountMark, Principal, Runtime, errors};
use crate::api::AccountProvider;
use crate::collector::SessionIdentity;

enum Kind {
    LoginStart,
    Login,
    ServerMode,
    Api { light: bool },
    Unlisted,
}

fn kind_of(method: &Method, path: &str) -> Kind {
    if path == "/api/server-mode" {
        return Kind::ServerMode;
    }
    if path == "/api" || path.starts_with("/api/") {
        let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
        let light = *method == Method::GET && (path == "/api/symbols" || path == "/api/screener/status" || (segments.len() == 3 && segments[1] == "symbols"));
        return Kind::Api { light };
    }
    let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
    match (method, segments.as_slice()) {
        (&Method::GET, ["v1", "session", provider, "start"]) if !provider.is_empty() => Kind::LoginStart,
        (&Method::GET, ["v1", "auth", provider, "callback"]) if !provider.is_empty() => Kind::Login,
        (&Method::GET, ["v1", "session"]) | (&Method::POST, ["v1", "session", "logout"]) | (&Method::DELETE, ["v1", "account"]) => Kind::Login,
        _ => Kind::Unlisted,
    }
}

pub(super) struct Meters {
    account: super::limits::PerAccount<TokenBucket>,
    total: std::sync::Mutex<TokenBucket>,
    anon: std::sync::Mutex<TokenBucket>,
    login: std::sync::Mutex<TokenBucket>,
    account_rate: Rate,
}

impl Meters {
    pub fn new(limits: &super::settings::Limits, now: i64) -> Self {
        let account_rate = Rate { per_second: limits.account_rate, burst: limits.account_burst };
        Meters {
            account: Default::default(),
            total: std::sync::Mutex::new(TokenBucket::new(Rate { per_second: limits.total_rate, burst: limits.total_burst }, now)),
            anon: std::sync::Mutex::new(TokenBucket::new(Rate { per_second: limits.anon_rate, burst: limits.anon_burst }, now)),
            login: std::sync::Mutex::new(TokenBucket::new(Rate { per_second: f64::from(limits.login_per_minute) / 60.0, burst: f64::from(limits.login_per_minute) }, now)),
            account_rate,
        }
    }

    fn account(&self, account: &str, cost: f64, now: i64) -> Result<(), i64> {
        self.account.with(account, || TokenBucket::new(self.account_rate, now), |bucket| bucket.take(cost, now))
    }

    fn refund_account(&self, account: &str, cost: f64, now: i64) {
        self.account.with(account, || TokenBucket::new(self.account_rate, now), |bucket| bucket.refund(cost));
    }
}

pub(super) struct Flight {
    total: super::limits::Slots,
    anon: super::limits::Slots,
    account: super::limits::AccountSlots,
}

impl Flight {
    pub fn new(limits: &super::settings::Limits) -> Self {
        Flight { total: super::limits::Slots::new(limits.max_in_flight), anon: super::limits::Slots::new(limits.anon_in_flight), account: super::limits::AccountSlots::new(limits.account_in_flight) }
    }
}

fn marked(mut response: Response, account: &str) -> Response {
    response.extensions_mut().insert(AccountMark(account.to_owned()));
    response
}

pub(super) async fn gate(State(runtime): State<Arc<Runtime>>, mut request: Request, next: Next) -> Response {
    let now = runtime.clock.now().unix();
    let kind = kind_of(request.method(), request.uri().path());
    match kind {
        Kind::Unlisted => errors::not_found(),
        Kind::LoginStart | Kind::Login => {
            if matches!(kind, Kind::LoginStart)
                && let Err(retry_at) = locked(&runtime.meters.login).take(1.0, now)
            {
                return errors::too_many(now, retry_at);
            }
            anonymous(&runtime, request, next, now).await
        }
        Kind::ServerMode | Kind::Api { .. } => {
            let light = matches!(kind, Kind::Api { light: true } | Kind::ServerMode);
            let session = match runtime.accounts.session_account(request.headers()).await {
                Ok(session) => session,
                Err(e) => {
                    tracing::error!(error = %e, "세션을 확인하지 못했습니다");
                    return errors::busy(now, 2);
                }
            };
            let Some(session) = session else {
                if matches!(kind, Kind::ServerMode) {
                    return anonymous(&runtime, request, next, now).await;
                }
                return match locked(&runtime.meters.anon).take(1.0, now) {
                    Ok(()) => errors::signed_out(),
                    Err(retry_at) => errors::too_many(now, retry_at),
                };
            };
            let provider = match session.provider {
                account_server::Provider::Google => AccountProvider::Google,
                account_server::Provider::Naver => AccountProvider::Naver,
            };
            let key = format!("{}:{}", session.provider.as_str(), session.subject);
            let cost = if light { runtime.limits.light_cost } else { 1.0 };
            if let Err(retry_at) = runtime.meters.account(&key, cost, now) {
                return marked(errors::too_many(now, retry_at), &key);
            }
            if let Err(retry_at) = locked(&runtime.meters.total).take(cost, now) {
                runtime.meters.refund_account(&key, cost, now);
                return marked(errors::too_many(now, retry_at), &key);
            }
            let Ok(_total_slot) = runtime.flight.total.take() else { return marked(errors::busy(now, 2), &key) };
            let Ok(_account_slot) = runtime.flight.account.take(&session.account_id) else { return marked(errors::busy(now, 2), &key) };
            request.extensions_mut().insert(Principal { account_id: session.account_id, key: key.clone() });
            request.extensions_mut().insert(SessionIdentity(crate::account::ProviderSubject { provider, subject: session.subject }));
            marked(next.run(request).await, &key)
        }
    }
}

async fn anonymous(runtime: &Runtime, request: Request, next: Next, now: i64) -> Response {
    if let Err(retry_at) = locked(&runtime.meters.anon).take(1.0, now) {
        return errors::too_many(now, retry_at);
    }
    let Ok(_slot) = runtime.flight.anon.take() else { return errors::busy(now, 2) };
    next.run(request).await
}
