use super::{AuthorizeParams, CodeGrant, IdpFailure, transport_failure};
use crate::config::NaverConfig;
use serde::Deserialize;
use url::Url;

pub fn authorize_url(config: &NaverConfig, redirect_uri: &str, params: AuthorizeParams<'_>) -> Url {
    let mut url = config.authorize_url.url().clone();
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &config.client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("state", params.state);
    url
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
}

#[derive(Deserialize)]
struct ProfileResponse {
    resultcode: String,
    response: Option<Profile>,
}

#[derive(Deserialize)]
struct Profile {
    id: String,
}

pub async fn subject(
    http: &reqwest::Client,
    config: &NaverConfig,
    _redirect_uri: &str,
    grant: CodeGrant<'_>,
) -> Result<String, IdpFailure> {
    let response = http
        .post(config.token_url.url().clone())
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", grant.code),
            ("state", grant.state),
            ("client_id", config.client_id.as_str()),
            ("client_secret", config.client_secret.expose()),
        ])
        .send()
        .await
        .map_err(transport_failure)?;
    if !response.status().is_success() {
        return Err(IdpFailure("Naver 토큰 교환이 거절됐다"));
    }
    let token: TokenResponse = response.json().await.map_err(|_| IdpFailure("Naver 토큰 응답을 읽지 못했다"))?;
    let access_token = token.access_token.filter(|value| !value.is_empty()).ok_or(IdpFailure("Naver가 접근 토큰을 주지 않았다"))?;
    let response = http
        .get(config.profile_url.url().clone())
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(transport_failure)?;
    if !response.status().is_success() {
        return Err(IdpFailure("Naver 프로필 요청이 거절됐다"));
    }
    let profile: ProfileResponse = response.json().await.map_err(|_| IdpFailure("Naver 프로필 응답을 읽지 못했다"))?;
    match (profile.resultcode.as_str(), profile.response) {
        ("00", Some(profile)) => Ok(profile.id),
        _ => Err(IdpFailure("Naver 프로필 결과가 실패다")),
    }
}
