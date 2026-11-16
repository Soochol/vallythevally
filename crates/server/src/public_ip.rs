use std::net::IpAddr;
use std::time::Duration;

use futures::future::BoxFuture;

const TIMEOUT: Duration = Duration::from_secs(5);
const BODY_LIMIT: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicIpFailure {
    Unreachable,
    Refused,
    NotAnAddress,
}

impl std::fmt::Display for PublicIpFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            PublicIpFailure::Unreachable => "공인 IP 확인 서비스에 닿지 못했습니다",
            PublicIpFailure::Refused => "공인 IP 확인 서비스가 정상 답을 주지 않았습니다",
            PublicIpFailure::NotAnAddress => "공인 IP 확인 서비스의 답이 IP 주소가 아닙니다",
        })
    }
}

pub trait PublicIpTransport: Send + Sync + 'static {
    fn get(&self) -> BoxFuture<'static, Result<Vec<u8>, PublicIpFailure>>;
}

pub struct ReqwestPublicIp {
    client: reqwest::Client,
    url: String,
}

impl ReqwestPublicIp {
    pub fn new(url: String) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder().tls_backend_rustls().timeout(TIMEOUT).redirect(reqwest::redirect::Policy::none()).build().map_err(reqwest::Error::without_url)?;
        Ok(ReqwestPublicIp { client, url })
    }
}

impl PublicIpTransport for ReqwestPublicIp {
    fn get(&self) -> BoxFuture<'static, Result<Vec<u8>, PublicIpFailure>> {
        let request = self.client.get(&self.url);
        Box::pin(async move {
            let mut response = request.send().await.map_err(|_| PublicIpFailure::Unreachable)?;
            if !response.status().is_success() {
                return Err(PublicIpFailure::Refused);
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| PublicIpFailure::Unreachable)? {
                body.extend_from_slice(&chunk);
                if body.len() > BODY_LIMIT {
                    return Err(PublicIpFailure::NotAnAddress);
                }
            }
            Ok(body)
        })
    }
}

pub async fn check(transport: &dyn PublicIpTransport) -> Result<IpAddr, PublicIpFailure> {
    let body = transport.get().await?;
    parse(&body).ok_or(PublicIpFailure::NotAnAddress)
}

fn parse(body: &[u8]) -> Option<IpAddr> {
    std::str::from_utf8(body).ok()?.trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_bare_ip_address_is_accepted() {
        assert_eq!(parse(b"203.0.113.7\n"), Some("203.0.113.7".parse().unwrap()));
        assert_eq!(parse(b" 2001:db8::1 "), Some("2001:db8::1".parse().unwrap()));
        for body in [&b"<html>203.0.113.7</html>"[..], b"203.0.113.7 extra", b"", b"999.1.1.1", b"\xff\xfe"] {
            assert_eq!(parse(body), None, "{body:?}");
        }
    }
}
