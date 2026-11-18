use std::time::Duration;

use futures::future::BoxFuture;

use super::holidays::{HolidayRequest, HolidayTransport, TransportError};

pub const HOLIDAY_BASE_URL: &str = "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService";
const REST_DAY_PATH: &str = "getRestDeInfo";
const ROWS_PER_PAGE: &str = "100";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct ReqwestHolidayTransport {
    client: reqwest::Client,
    rest_day_url: String,
}

impl ReqwestHolidayTransport {
    pub fn new() -> Result<ReqwestHolidayTransport, reqwest::Error> {
        ReqwestHolidayTransport::with_base_url(HOLIDAY_BASE_URL)
    }

    pub fn with_base_url(base_url: &str) -> Result<ReqwestHolidayTransport, reqwest::Error> {
        let client = reqwest::Client::builder()
            .tls_backend_rustls()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(reqwest::Error::without_url)?;
        let rest_day_url = format!("{}/{REST_DAY_PATH}", base_url.trim_end_matches('/'));
        Ok(ReqwestHolidayTransport { client, rest_day_url })
    }

    async fn get(&self, request: HolidayRequest<'_>) -> Result<String, reqwest::Error> {
        let year = request.year.to_string();
        let response = self
            .client
            .get(&self.rest_day_url)
            .query(&[
                ("solYear", year.as_str()),
                ("_type", "json"),
                ("numOfRows", ROWS_PER_PAGE),
                ("ServiceKey", request.service_key.expose().as_str()),
            ])
            .send()
            .await
            .map_err(reqwest::Error::without_url)?;
        let response = response.error_for_status().map_err(reqwest::Error::without_url)?;
        response.text().await.map_err(reqwest::Error::without_url)
    }
}

fn classify(error: &reqwest::Error) -> TransportError {
    if error.is_timeout() {
        TransportError::TimedOut
    } else if let Some(status) = error.status() {
        TransportError::HttpStatus(status.as_u16())
    } else {
        TransportError::Unreachable
    }
}

impl HolidayTransport for ReqwestHolidayTransport {
    fn fetch<'a>(
        &'a self,
        request: HolidayRequest<'a>,
    ) -> BoxFuture<'a, Result<String, TransportError>> {
        Box::pin(async move {
            self.get(request).await.map_err(|error| {
                tracing::warn!(year = request.year, %error, "특일정보 요청이 실패했다");
                classify(&error)
            })
        })
    }
}
