use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Mutex;

use crate::config::Secret;
use super::model::{Basis, Company, Failure, Security};

mod preferred;
mod discovery;

#[cfg(test)]
mod tls_tests;

pub type Row = BTreeMap<String, String>;

pub struct Client {
    http: reqwest::Client,
    kind_http: reqwest::Client,
    base: String,
    kind_base: String,
    key: Secret<String>,
    directory: Mutex<Option<Arc<Vec<Row>>>>,
    pace: Mutex<Option<tokio::time::Instant>>,
}

impl Client {
    pub fn new(key: Secret<String>, base: String, kind_base: String) -> Result<Self, Failure> {
        let http = dart_http_builder().build().map_err(|_| Failure::Network)?;
        let kind_http = kind_http_builder().build().map_err(|_| Failure::Network)?;
        Ok(Self { http, kind_http, base, kind_base, key, directory: Mutex::new(None), pace: Mutex::new(None) })
    }

    async fn bytes(&self, endpoint: &str, params: &[(&str, String)]) -> Result<Vec<u8>, Failure> {
        let mut pace = self.pace.lock().await;
        if let Some(last) = *pace { tokio::time::sleep_until(last + Duration::from_millis(250)).await; }
        *pace = Some(tokio::time::Instant::now());
        let response = self.http.get(format!("{}/api/{endpoint}", self.base)).query(&[("crtfc_key", self.key.expose())]).query(params).send().await.map_err(|_| Failure::Network)?;
        drop(pace);
        if !response.status().is_success() { return Err(Failure::Remote); }
        let bytes = response.bytes().await.map_err(|_| Failure::Network)?;
        if bytes.len() > 64 * 1024 * 1024 { return Err(Failure::InvalidResponse); }
        Ok(bytes.to_vec())
    }

    fn json(&self, bytes: &[u8]) -> Result<Value, Failure> {
        let mut value: Value = serde_json::from_slice(bytes).map_err(|_| Failure::InvalidResponse)?;
        redact(&mut value, self.key.expose());
        check_status(value.get("status").and_then(Value::as_str).ok_or(Failure::InvalidResponse)?)?;
        Ok(value)
    }

    pub(crate) fn redact(&self, value: &str) -> String { value.replace(self.key.expose(), "[redacted]") }

    pub async fn response(&self, endpoint: &str, params: &[(&str, String)]) -> Result<Value, Failure> {
        self.json(&self.bytes(endpoint, params).await?)
    }

    pub async fn rows(&self, endpoint: &str, params: &[(&str, String)]) -> Result<Vec<Row>, Failure> {
        let value = self.response(endpoint, params).await?;
        rows(&value)
    }

    pub async fn archive(&self, endpoint: &str, params: &[(&str, String)]) -> Result<Vec<(String, String)>, Failure> {
        let bytes = self.bytes(endpoint, params).await?;
        if !bytes.starts_with(b"PK") {
            if bytes.iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'{') {
                self.json(&bytes)?;
                return Err(Failure::SourceUnavailable);
            }
            if let Ok(text) = std::str::from_utf8(&bytes)
                && let Ok(xml) = roxmltree::Document::parse(text)
                && let Some(status) = xml.descendants().find(|n| n.has_tag_name("status")).and_then(|n| n.text()) {
                check_status(status)?;
                return Err(Failure::SourceUnavailable);
            }
            return Err(Failure::InvalidResponse);
        }
        let key = self.key.expose().clone();
        tokio::task::spawn_blocking(move || unzip(&bytes, &key)).await.map_err(|_| Failure::InvalidResponse)?
    }

    pub async fn resolve(&self, stock: &str, preferred: bool) -> Result<Option<Security>, Failure> {
        let mut cached_directory = self.directory.lock().await;
        if cached_directory.is_none() {
            let files = self.archive("corpCode.xml", &[]).await?;
            let mut companies = Vec::new();
            for (_, xml) in files {
                let doc = roxmltree::Document::parse(&xml).map_err(|_| Failure::InvalidResponse)?;
                for node in doc.descendants().filter(|n| n.has_tag_name("list")) {
                    let row: Row = node.children().filter(|n| n.is_element()).filter_map(|n| n.text().map(|t| (n.tag_name().name().into(), t.trim().into()))).collect();
                    if row.get("corp_code").is_some_and(|s| digits(s, 8)) { companies.push(row); }
                }
            }
            if companies.is_empty() { return Err(Failure::InvalidResponse); }
            *cached_directory = Some(Arc::new(companies));
        }
        let directory = cached_directory.as_ref().unwrap().clone();
        drop(cached_directory);
        let direct: Vec<_> = directory.iter().filter(|r| field(r, "stock_code") == stock).collect();
        if direct.len() > 1 { return Ok(None); }
        let (corp, evidence) = if direct.len() == 1 {
            (field(direct[0], "corp_code").to_owned(), "OpenDART/corpCode.xml".to_owned())
        } else {
            let candidates = self.kind_companies(stock).await?;
            if candidates.is_empty() && preferred {
                if let Some(link) = preferred::for_stock(stock) {
                    let body = self.kind_bytes(link.path, &[]).await?;
                    let text = std::str::from_utf8(&body).map_err(|_| Failure::InvalidResponse)?;
                    if !link.verify_notice(text)? { return Ok(None); }
                    let candidates = self.kind_companies(link.common_code).await?;
                    if !link.verify_company(&candidates, &directory) { return Ok(None); }
                    (link.corp_code.to_owned(), link.evidence())
                } else {
                    let Some(mapping) = self.discover_preferred(stock, &directory).await? else { return Ok(None); };
                    mapping
                }
            } else {
                if candidates.len() != 1 { return Ok(None); }
                let row = &candidates[0];
                if field(row, "repisusrtcd2") != stock || field(row, "secugrpId") != "ST" || !digits(field(row, "fssunqno"), 8) { return Ok(None); }
                (field(row, "fssunqno").to_owned(), "KRX KIND/common/searchcorpname.do/repisusrtcd2+fssunqno".to_owned())
            }
        };
        if preferred && let Some(link) = preferred::for_stock(stock) && corp != link.corp_code { return Ok(None); }
        let company = self.response("company.json", &[("corp_code", corp.clone())]).await?;
        if company.get("corp_code").is_some_and(|value| value != &corp) { return Err(Failure::InvalidResponse); }
        let name = company["corp_name"].as_str().ok_or(Failure::InvalidResponse)?.to_owned();
        let fiscal_month = company["acc_mt"].as_str().and_then(|s| s.parse().ok()).filter(|m| (1..=12).contains(m));
        Ok(Some(Security {
            stock_code: stock.into(), company: Company { corp_code: corp, name, fiscal_month },
            share_class: (!preferred).then(|| "보통주".into()),
            share_class_reason: preferred.then(|| "preferred_issue_class_unverified".into()), evidence,
        }))
    }

    async fn kind_bytes(&self, path: &str, params: &[(&str, &str)]) -> Result<Vec<u8>, Failure> {
        let response = self.kind_http.get(format!("{}{path}", self.kind_base)).query(params).send().await.map_err(|_| Failure::Network)?;
        if !response.status().is_success() { return Err(Failure::Remote); }
        let bytes = response.bytes().await.map_err(|_| Failure::Network)?;
        if bytes.len() > 1024 * 1024 { return Err(Failure::InvalidResponse); }
        Ok(bytes.to_vec())
    }

    async fn kind_companies(&self, stock: &str) -> Result<Vec<Row>, Failure> {
        let bytes = self.kind_bytes("/common/searchcorpname.do", &[("method", "searchCorpNameJson"), ("searchCodeType", "number"), ("searchCorpName", stock)]).await?;
        serde_json::from_slice(&bytes).map_err(|_| Failure::InvalidResponse)
    }

    pub async fn disclosures(&self, corp: &str, today: &str) -> Result<Vec<Row>, Failure> {
        let mut result = BTreeMap::new();
        let mut total = None;
        for page in 1..=10000 {
            let value = self.response("list.json", &[("corp_code", corp.into()), ("bgn_de", "20150101".into()), ("end_de", today.into()), ("last_reprt_at", "N".into()), ("pblntf_ty", "A".into()), ("page_no", page.to_string()), ("page_count", "100".into())]).await?;
            if value["status"] == "013" {
                return if page == 1 { Ok(Vec::new()) } else { Err(Failure::InvalidResponse) };
            }
            let number = |key: &str| value[key].as_u64().or_else(|| value[key].as_str()?.parse().ok()).ok_or(Failure::InvalidResponse);
            let pages = number("total_page")?;
            if number("page_no")? != page || pages == 0 || pages > 10000 || total.is_some_and(|t| t != pages) { return Err(Failure::InvalidResponse); }
            total = Some(pages);
            let rows = rows(&value)?;
            if rows.is_empty() { return Err(Failure::InvalidResponse); }
            for row in rows {
                let receipt = field(&row, "rcept_no");
                if field(&row, "corp_code") != corp || !digits(receipt, 14) || result.contains_key(receipt) { return Err(Failure::InvalidResponse); }
                result.insert(receipt.to_owned(), row);
            }
            if page == pages { return Ok(result.into_values().collect()); }
        }
        Err(Failure::InvalidResponse)
    }

    pub async fn statement(&self, corp: &str, year: i32, report: &str) -> Result<Option<(Basis, Vec<Row>)>, Failure> {
        let params = [("corp_code", corp.into()), ("bsns_year", year.to_string()), ("reprt_code", report.into())];
        for basis in [Basis::CFS, Basis::OFS] {
            let mut params = params.to_vec();
            params.push(("fs_div", format!("{basis:?}")));
            let value = self.response("fnlttSinglAcntAll.json", &params).await?;
            if value["status"] == "013" { continue; }
            let rows = rows(&value)?;
            if rows.is_empty() || rows.iter().any(|r| field(r, "corp_code") != corp || field(r, "bsns_year") != year.to_string() || field(r, "reprt_code") != report || !digits(field(r, "rcept_no"), 14)) { return Err(Failure::InvalidResponse); }
            return Ok(Some((basis, rows)));
        }
        Ok(None)
    }
}

pub fn field<'a>(row: &'a Row, key: &str) -> &'a str { row.get(key).map_or("", String::as_str) }
pub fn digits(s: &str, len: usize) -> bool { s.len() == len && s.bytes().all(|b| b.is_ascii_digit()) }

fn check_status(status: &str) -> Result<(), Failure> {
    match status {
        "000" | "013" => Ok(()),
        "010" | "011" | "012" | "901" => Err(Failure::Authentication),
        "020" => Err(Failure::RateLimited),
        _ => Err(Failure::Remote),
    }
}

fn rows(value: &Value) -> Result<Vec<Row>, Failure> {
    if value["status"] == "013" { return Ok(Vec::new()); }
    value["list"].as_array().ok_or(Failure::InvalidResponse)?.iter().map(|v| {
        v.as_object().ok_or(Failure::InvalidResponse)?.iter().map(|(k, v)| Ok((k.clone(), v.as_str().ok_or(Failure::InvalidResponse)?.to_owned()))).collect()
    }).collect()
}

fn unzip(bytes: &[u8], key: &str) -> Result<Vec<(String, String)>, Failure> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| Failure::InvalidResponse)?;
    let mut result = Vec::new();
    let mut total = 0;
    for index in 0..zip.len() {
        let mut file = zip.by_index(index).map_err(|_| Failure::InvalidResponse)?;
        let name = file.name().to_owned();
        if !name.ends_with(".xml") && !name.ends_with(".xbrl") { continue; }
        total += file.size();
        if total > 128 * 1024 * 1024 { return Err(Failure::InvalidResponse); }
        let mut xml = String::new();
        file.read_to_string(&mut xml).map_err(|_| Failure::InvalidResponse)?;
        if roxmltree::Document::parse(&xml).is_err() { return Err(Failure::InvalidResponse); }
        result.push((name.replace(key, "[redacted]"), xml.replace(key, "[redacted]")));
    }
    if result.is_empty() { return Err(Failure::SourceUnavailable); }
    Ok(result)
}

fn redact(value: &mut Value, key: &str) {
    match value {
        Value::String(text) => *text = text.replace(key, "[redacted]"),
        Value::Array(values) => values.iter_mut().for_each(|value| redact(value, key)),
        Value::Object(fields) => {
            *fields = std::mem::take(fields).into_iter().map(|(name, mut value)| {
                redact(&mut value, key);
                (name.replace(key, "[redacted]"), value)
            }).collect();
        }
        _ => {}
    }
}

fn dart_http_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().tls_backend_native().user_agent(concat!("vallythevally/", env!("CARGO_PKG_VERSION"))).timeout(Duration::from_secs(30)).redirect(reqwest::redirect::Policy::none())
}

fn kind_http_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().tls_backend_rustls().timeout(Duration::from_secs(30)).redirect(reqwest::redirect::Policy::none())
}
