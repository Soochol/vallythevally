use super::{AuthorizeParams, CodeGrant, IdpFailure, transport_failure};
use crate::config::GoogleConfig;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use url::Url;

const ISSUERS: [&str; 2] = ["https://accounts.google.com", "accounts.google.com"];

pub fn authorize_url(config: &GoogleConfig, redirect_uri: &str, params: AuthorizeParams<'_>) -> Url {
    let mut url = config.authorize_url.url().clone();
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &config.client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", "openid")
        .append_pair("state", params.state)
        .append_pair("nonce", params.nonce);
    url
}

#[derive(Deserialize)]
struct TokenResponse {
    id_token: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
}

#[derive(Deserialize)]
struct Claims {
    iss: String,
    aud: Audience,
    exp: i64,
    nonce: Option<String>,
    sub: String,
}

pub async fn subject(
    http: &reqwest::Client,
    config: &GoogleConfig,
    redirect_uri: &str,
    grant: CodeGrant<'_>,
) -> Result<String, IdpFailure> {
    let response = http
        .post(config.token_url.url().clone())
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", grant.code),
            ("client_id", config.client_id.as_str()),
            ("client_secret", config.client_secret.expose()),
            ("redirect_uri", redirect_uri),
        ])
        .send()
        .await
        .map_err(transport_failure)?;
    if !response.status().is_success() {
        return Err(IdpFailure("Google 토큰 교환이 거절됐다"));
    }
    let token: TokenResponse = response.json().await.map_err(|_| IdpFailure("Google 토큰 응답을 읽지 못했다"))?;
    let claims = decode_claims(&token.id_token)?;
    verify(&claims, config, &grant)?;
    Ok(claims.sub)
}

fn decode_claims(id_token: &str) -> Result<Claims, IdpFailure> {
    let payload = id_token.split('.').nth(1).ok_or(IdpFailure("id_token 모양이 맞지 않는다"))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .map_err(|_| IdpFailure("id_token 모양이 맞지 않는다"))?;
    serde_json::from_slice(&bytes).map_err(|_| IdpFailure("id_token 내용을 읽지 못했다"))
}

fn verify(claims: &Claims, config: &GoogleConfig, grant: &CodeGrant<'_>) -> Result<(), IdpFailure> {
    if !ISSUERS.contains(&claims.iss.as_str()) {
        return Err(IdpFailure("id_token iss가 맞지 않는다"));
    }
    let audience_matches = match &claims.aud {
        Audience::One(value) => value == &config.client_id,
        Audience::Many(values) => values.len() == 1 && values[0] == config.client_id,
    };
    if !audience_matches {
        return Err(IdpFailure("id_token aud가 맞지 않는다"));
    }
    if claims.exp <= grant.now.0 {
        return Err(IdpFailure("id_token이 만료됐다"));
    }
    if claims.nonce.as_deref() != Some(grant.nonce) {
        return Err(IdpFailure("id_token nonce가 맞지 않는다"));
    }
    Ok(())
}
