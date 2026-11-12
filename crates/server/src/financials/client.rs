use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::time::Duration;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::config::Secret;
use super::model::{Basis, Company, Failure, Security};

mod preferred;
mod discovery;

#[cfg(test)]
mod tls_tests;

pub type Row = BTreeMap<String, String>;

const ATTEMPTS: u64 = 3;

pub struct Client {
    http: reqwest::Client,
    kind_http: reqwest::Client,
    base: String,
    kind_base: String,
    key: Secret<String>,
    directory: Mutex<Option<Arc<Vec<Row>>>>,
    pace: Mutex<Option<tokio::time::Instant>>,
    paused: AtomicBool,
    yielding: AtomicBool,
    journal: std::sync::Mutex<Option<Journal>>,
}

#[derive(Clone)]
struct Journal { store: super::store::Store, job: String, through_date: String, clock: crate::clock::Clock }

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Stop {
    pub failure: Failure,
    pub next_check_at: Option<i64>,
    request: Request,
}

#[derive(Clone, Serialize, Deserialize)]
enum Request { Json { endpoint: String, params: Vec<(String, String)> }, Archive { endpoint: String, params: Vec<(String, String)> } }

impl Client {
    pub fn new(key: Secret<String>, base: String, kind_base: String) -> Result<Self, Failure> {
        let http = dart_http_builder().build().map_err(|_| Failure::Network)?;
        let kind_http = kind_http_builder().build().map_err(|_| Failure::Network)?;
        Ok(Self { http, kind_http, base, kind_base, key, directory: Mutex::new(None), pace: Mutex::new(None), paused: AtomicBool::new(false), yielding: AtomicBool::new(false), journal: std::sync::Mutex::new(None) })
    }

    pub(super) async fn begin_job(&self, store: super::store::Store, job: u64, generation: u64, through_date: String, clock: crate::clock::Clock) -> Result<(), Failure> {
        let job = if generation == 0 { job.to_string() } else { format!("{job}/{generation}") };
        store.begin_requests(&job).await?;
        *self.directory.lock().await = None;
        *self.journal.lock().unwrap() = Some(Journal { store, job, through_date, clock });
        Ok(())
    }

    async fn cached<T: DeserializeOwned>(&self, request: &str) -> Result<Option<T>, Failure> {
        self.check_control()?;
        let journal = self.journal.lock().unwrap().clone();
        let Some(journal) = journal else { return Ok(None); };
        if let Some(stop) = journal.store.stop().await? { return Err(stop.failure); }
        journal.store.response(&journal.job, request).await?.map(|body| serde_json::from_str(&body).map_err(|_| Failure::Storage)).transpose()
    }

    async fn checkpoint<T: Serialize>(&self, request: &str, value: &T) -> Result<(), Failure> {
        let journal = self.journal.lock().unwrap().clone();
        if let Some(journal) = journal {
            let body = serde_json::to_string(value).map_err(|_| Failure::Storage)?;
            journal.store.save_response(&journal.job, request, body).await?;
        }
        Ok(())
    }

    pub(super) fn pause(&self, paused: bool) { self.paused.store(paused, Ordering::SeqCst); }
    pub(super) fn is_paused(&self) -> bool { self.paused.load(Ordering::SeqCst) }
    pub(super) fn check_control(&self) -> Result<(), Failure> {
        if self.is_paused() { Err(Failure::Paused) } else if self.is_yielding() { Err(Failure::Yielded) } else { Ok(()) }
    }
    pub(super) fn yield_to_latest(&self, yielding: bool) { self.yielding.store(yielding, Ordering::SeqCst); }
    pub(super) fn is_yielding(&self) -> bool { self.yielding.load(Ordering::SeqCst) }

    async fn retry<T, F, Fut>(&self, mut send: F) -> Result<T, Failure>
    where F: FnMut() -> Fut, Fut: std::future::Future<Output = Result<T, Failure>> {
        for attempt in 0..ATTEMPTS {
            self.check_control()?;
            let result = send().await;
            if !matches!(result, Err(Failure::Network | Failure::Remote)) || attempt + 1 == ATTEMPTS { return result; }
            tokio::time::sleep(Duration::from_millis(250 * (attempt + 1))).await;
        }
        unreachable!()
    }

    async fn stop_after<T>(&self, result: Result<T, Failure>, request: Request) -> Result<T, Failure> {
        let journal = self.journal.lock().unwrap().clone();
        if let Err(error @ (Failure::Authentication | Failure::RateLimited)) = &result && let Some(journal) = journal {
            let next_check_at = (*error == Failure::RateLimited).then(|| crate::clock::next_daily(journal.clock.now(), domain::TimeOfDay::hms(7, 0, 0).unwrap()).unix());
            journal.store.save_stop(Some(&Stop { failure: *error, next_check_at, request })).await?;
        }
        result
    }

    pub(super) async fn confirm(&self, mut stop: Stop) -> Result<bool, Failure> {
        let result = match &stop.request {
            Request::Json { endpoint, params } => {
                let params: Vec<_> = params.iter().map(|(key, value)| (key.as_str(), value.clone())).collect();
                match self.bytes(endpoint, &params).await {
                    Ok(bytes) => match self.json(&bytes) {
                        Ok(value) => self.checkpoint(&format!("json/{endpoint}/{}", serde_json::to_string(&params).unwrap()), &value).await,
                        Err(error) => Err(error),
                    },
                    Err(error) => Err(error),
                }
            }
            Request::Archive { endpoint, params } => {
                let params: Vec<_> = params.iter().map(|(key, value)| (key.as_str(), value.clone())).collect();
                match self.archive_response(endpoint, &params).await {
                    Ok(files) => self.checkpoint(&format!("archive/{endpoint}/{}", serde_json::to_string(&params).unwrap()), &files).await,
                    Err(error) => Err(error),
                }
            }
        };
        let journal = self.journal.lock().unwrap().clone().unwrap();
        match result {
            Ok(()) => { journal.store.save_stop(None).await?; Ok(true) }
            Err(error @ (Failure::Storage | Failure::Paused | Failure::Yielded)) => Err(error),
            Err(error) => {
                if matches!(error, Failure::Authentication | Failure::RateLimited) { stop.failure = error; }
                stop.next_check_at = (stop.failure == Failure::RateLimited).then(|| crate::clock::next_daily(journal.clock.now(), domain::TimeOfDay::hms(7, 0, 0).unwrap()).unix());
                journal.store.save_stop(Some(&stop)).await?;
                Ok(false)
            }
        }
    }

    async fn bytes(&self, endpoint: &str, params: &[(&str, String)]) -> Result<Vec<u8>, Failure> {
        let mut pace = self.pace.lock().await;
        if let Some(last) = *pace { tokio::time::sleep_until(last + Duration::from_millis(250)).await; }
        self.check_control()?;
        *pace = Some(tokio::time::Instant::now());
        let response = self.http.get(format!("{}/api/{endpoint}", self.base)).query(&[("crtfc_key", self.key.expose())]).query(params).send().await.map_err(|_| Failure::Network)?;
        drop(pace);
        match response.status().as_u16() {
            401 | 403 => return Err(Failure::Authentication),
            429 => return Err(Failure::RateLimited),
            _ if !response.status().is_success() => return Err(Failure::Remote),
            _ => {}
        }
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
        let request = format!("json/{endpoint}/{}", serde_json::to_string(params).map_err(|_| Failure::InvalidResponse)?);
        if let Some(value) = self.cached(&request).await? { return Ok(value); }
        let result = self.retry(|| async { self.json(&self.bytes(endpoint, params).await?) }).await;
        let value = self.stop_after(result, Request::Json { endpoint: endpoint.into(), params: params.iter().map(|(key, value)| ((*key).into(), value.clone())).collect() }).await?;
        self.checkpoint(&request, &value).await?;
        Ok(value)
    }

    pub async fn rows(&self, endpoint: &str, params: &[(&str, String)]) -> Result<Vec<Row>, Failure> {
        let value = self.response(endpoint, params).await?;
        rows(&value)
    }

    pub async fn archive(&self, endpoint: &str, params: &[(&str, String)]) -> Result<Vec<(String, String)>, Failure> {
        let request = format!("archive/{endpoint}/{}", serde_json::to_string(params).map_err(|_| Failure::InvalidResponse)?);
        if let Some(value) = self.cached(&request).await? { return Ok(value); }
        let result = self.retry(|| self.archive_response(endpoint, params)).await;
        let files = self.stop_after(result, Request::Archive { endpoint: endpoint.into(), params: params.iter().map(|(key, value)| ((*key).into(), value.clone())).collect() }).await?;
        self.checkpoint(&request, &files).await?;
        Ok(files)
    }

    async fn archive_response(&self, endpoint: &str, params: &[(&str, String)]) -> Result<Vec<(String, String)>, Failure> {
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
        let files = tokio::task::spawn_blocking(move || unzip(&bytes, &key)).await.map_err(|_| Failure::InvalidResponse)??;
        Ok(files)
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
        let request = format!("kind/{path}/{}", serde_json::to_string(params).map_err(|_| Failure::InvalidResponse)?);
        if let Some(value) = self.cached(&request).await? { return Ok(value); }
        self.check_control()?;
        let bytes = self.retry(|| async {
            self.check_control()?;
            let response = self.kind_http.get(format!("{}{path}", self.kind_base)).query(params).send().await.map_err(|_| Failure::Network)?;
            if !response.status().is_success() { return Err(Failure::Remote); }
            response.bytes().await.map_err(|_| Failure::Network)
        }).await?;
        if bytes.len() > 1024 * 1024 { return Err(Failure::InvalidResponse); }
        let mut redacted = Vec::with_capacity(bytes.len());
        let mut remaining = bytes.as_ref();
        let key = self.key.expose().as_bytes();
        while !remaining.is_empty() {
            if !key.is_empty() && remaining.starts_with(key) { redacted.extend_from_slice(b"[redacted]"); remaining = &remaining[key.len()..]; }
            else { redacted.push(remaining[0]); remaining = &remaining[1..]; }
        }
        self.checkpoint(&request, &redacted).await?;
        Ok(redacted)
    }

    async fn kind_companies(&self, stock: &str) -> Result<Vec<Row>, Failure> {
        let bytes = self.kind_bytes("/common/searchcorpname.do", &[("method", "searchCorpNameJson"), ("searchCodeType", "number"), ("searchCorpName", stock)]).await?;
        serde_json::from_slice(&bytes).map_err(|_| Failure::InvalidResponse)
    }

    pub async fn disclosures(&self, corp: &str, today: &str) -> Result<Vec<Row>, Failure> {
        let through_date = self.journal.lock().unwrap().as_ref().map(|journal| journal.through_date.clone()).unwrap_or_else(|| today.into());
        let mut result = BTreeMap::new();
        let mut total = None;
        for page in 1..=10000 {
            let value = self.response("list.json", &[("corp_code", corp.into()), ("bgn_de", "20150101".into()), ("end_de", through_date.clone()), ("last_reprt_at", "N".into()), ("pblntf_ty", "A".into()), ("page_no", page.to_string()), ("page_count", "100".into())]).await?;
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
        for basis in [Basis::CFS, Basis::OFS] {
            if let Some(rows) = self.statement_basis(corp, year, report, basis).await? { return Ok(Some((basis, rows))); }
        }
        Ok(None)
    }

    pub(super) async fn statement_basis(&self, corp: &str, year: i32, report: &str, basis: Basis) -> Result<Option<Vec<Row>>, Failure> {
        let params = [("corp_code", corp.into()), ("bsns_year", year.to_string()), ("reprt_code", report.into()), ("fs_div", format!("{basis:?}"))];
        let value = self.response("fnlttSinglAcntAll.json", &params).await?;
        if value["status"] == "013" { return Ok(None); }
        let rows = rows(&value)?;
        if rows.is_empty() || rows.iter().any(|r| field(r, "corp_code") != corp || field(r, "bsns_year") != year.to_string() || field(r, "reprt_code") != report || !digits(field(r, "rcept_no"), 14)) { return Err(Failure::InvalidResponse); }
        Ok(Some(rows))
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
