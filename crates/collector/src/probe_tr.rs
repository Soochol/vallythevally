use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use server::clock::Clock;
use server::config::{KisCredentials, Secret};
use server::instance::InstanceLock;
use server::kis::auth::KisAuth;
use server::kis::transport::ReqwestTransport as KisReqwestTransport;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::token_file::TokenFile;
use server::kiwoom::transport::{ReqwestTransport as KiwoomReqwestTransport, SEND_TIMEOUT};
use server::shared_data::Broker;

use crate::args::{ArgSpec, Arguments};
use crate::build::store::write_atomically;
use crate::collect::config::{Variables, default_state_folder, process_variables};
use crate::keys::{ActiveKey, KeyList};
use crate::protocol::KeyName;
use crate::supervise::{kis_base_url, rest_base_url};

const SPEC: ArgSpec = ArgSpec {
    value_options: &["broker", "tr", "path", "method", "query", "body", "key", "keys", "state", "out"],
    flag_options: &[],
};

const KEYS_ENV_VARIABLE: &str = "VALLY_KEYS";
const DEFAULT_KEYS_FILE: &str = ".config/vally/collector-keys.json";
const REDACTED: &str = "[REDACTED]";
const CUSTOMER_TYPE_PERSONAL: &str = "P";
const SENSITIVE_KEY_FRAGMENTS: [&str; 17] = [
    "token",
    "secret",
    "appkey",
    "app_key",
    "api_key",
    "apikey",
    "approval",
    "cano",
    "acnt",
    "acct",
    "account",
    "hts",
    "authorization",
    "bearer",
    "passwd",
    "password",
    "cookie",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeMethod {
    Get,
    Post,
}

impl ProbeMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            ProbeMethod::Get => "GET",
            ProbeMethod::Post => "POST",
        }
    }

    fn parse(text: &str) -> Result<ProbeMethod, String> {
        match text.to_ascii_uppercase().as_str() {
            "GET" => Ok(ProbeMethod::Get),
            "POST" => Ok(ProbeMethod::Post),
            _ => Err(format!("--method는 GET 또는 POST여야 합니다: {text:?}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeRequest {
    pub broker: Broker,
    pub tr_id: String,
    pub path: String,
    pub method: ProbeMethod,
    pub query: Vec<(String, String)>,
    pub body: Option<String>,
    pub key: KeyName,
    pub keys_path: PathBuf,
    pub state_dir: PathBuf,
    pub out_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapturedFixture {
    pub broker: String,
    pub tr_id: String,
    pub path: String,
    pub method: String,
    pub status: u16,
    pub tr_cont: Option<String>,
    pub cont_yn: Option<String>,
    pub next_key: Option<String>,
    pub body: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProbeResult {
    pub output_path: PathBuf,
    pub fixture: CapturedFixture,
}

pub fn broker_label(broker: Broker) -> &'static str {
    match broker {
        Broker::Kiwoom => "kiwoom",
        Broker::Kis => "kis",
    }
}

fn parse_broker(text: &str) -> Result<Broker, String> {
    match text {
        "kiwoom" => Ok(Broker::Kiwoom),
        "kis" => Ok(Broker::Kis),
        _ => Err(format!("--broker는 kiwoom 또는 kis여야 합니다: {text:?}")),
    }
}

fn validate_tr_id(text: &str) -> Result<String, String> {
    let valid = !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    if !valid {
        return Err(format!("--tr은 영문자·숫자·'-'·'_'만 쓸 수 있습니다: {text:?}"));
    }
    Ok(text.to_owned())
}

fn validate_path(text: &str) -> Result<String, String> {
    if !text.starts_with('/') || text.starts_with("//") || text.chars().any(char::is_whitespace) {
        return Err(format!("--path는 '/'로 시작하는 경로여야 합니다: {text:?}"));
    }
    Ok(text.to_owned())
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let decoded = (bytes[index] == b'%')
            .then(|| bytes.get(index + 1).copied().zip(bytes.get(index + 2).copied()))
            .flatten()
            .and_then(|(high, low)| Some((hex_value(high)? << 4) | hex_value(low)?));
        if let Some(byte) = decoded {
            out.push(byte);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).map_err(|_| format!("--query 값이 올바른 UTF-8 퍼센트 인코딩이 아닙니다: {text:?}"))
}

fn parse_query(text: &str) -> Result<Vec<(String, String)>, String> {
    let mut pairs = Vec::new();
    for segment in text.split('&') {
        if segment.is_empty() {
            continue;
        }
        let Some((raw_name, raw_value)) = segment.split_once('=') else {
            return Err(format!("--query 항목은 키=값 형식이어야 합니다: {segment:?}"));
        };
        let name = percent_decode(raw_name)?;
        if name.is_empty() {
            return Err(format!("--query 키 이름이 비어 있습니다: {segment:?}"));
        }
        let value = percent_decode(raw_value)?;
        pairs.push((name, value));
    }
    Ok(pairs)
}

fn default_keys_path(process: &Variables) -> Result<PathBuf, String> {
    if let Some(path) = process.get(KEYS_ENV_VARIABLE).filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    match process.get("HOME").filter(|home| !home.is_empty()) {
        Some(home) => Ok(PathBuf::from(home).join(DEFAULT_KEYS_FILE)),
        None => Err("HOME이 없어 기본 키 목록 경로를 정할 수 없습니다. --keys를 주세요".to_owned()),
    }
}

pub fn parse_arguments(raw_arguments: &[String], process: &Variables) -> Result<ProbeRequest, String> {
    let arguments = Arguments::parse(raw_arguments, &SPEC).map_err(|error| error.to_string())?;
    let broker_text = arguments.value("broker").ok_or_else(|| "--broker <kiwoom|kis>가 필요합니다".to_owned())?;
    let broker = parse_broker(broker_text)?;
    let tr_text = arguments.value("tr").ok_or_else(|| "--tr <TR_ID>가 필요합니다".to_owned())?;
    let tr_id = validate_tr_id(tr_text)?;
    let path_text = arguments.value("path").ok_or_else(|| "--path </경로>가 필요합니다".to_owned())?;
    let path = validate_path(path_text)?;
    let method = match arguments.value("method") {
        Some(text) => ProbeMethod::parse(text)?,
        None => match broker {
            Broker::Kis => ProbeMethod::Get,
            Broker::Kiwoom => ProbeMethod::Post,
        },
    };
    let query = match arguments.value("query") {
        Some(text) => parse_query(text)?,
        None => Vec::new(),
    };
    let body = match method {
        ProbeMethod::Get => {
            if arguments.value("body").is_some() {
                return Err("GET 요청에는 --body를 줄 수 없습니다".to_owned());
            }
            None
        }
        ProbeMethod::Post => {
            let raw = arguments.value("body").unwrap_or("{}");
            let parsed: Value = serde_json::from_str(raw).map_err(|error| format!("--body가 올바른 JSON이 아닙니다: {error}"))?;
            Some(parsed.to_string())
        }
    };
    let key_text = arguments.value("key").ok_or_else(|| "--key <키 이름>이 필요합니다".to_owned())?;
    let key = KeyName::parse(key_text).map_err(|error| format!("--key가 올바르지 않습니다: {error}"))?;
    let keys_path = match arguments.value("keys") {
        Some(path) => PathBuf::from(path),
        None => default_keys_path(process)?,
    };
    let state_dir = match arguments.value("state") {
        Some(folder) => PathBuf::from(folder),
        None => default_state_folder(process).map_err(|error| error.to_string())?,
    };
    let out_dir = arguments.value("out").map(PathBuf::from).ok_or_else(|| "--out <출력 폴더>가 필요합니다".to_owned())?;
    Ok(ProbeRequest { broker, tr_id, path, method, query, body, key, keys_path, state_dir, out_dir })
}

fn is_sensitive_key(key: &str) -> bool {
    let lowered = key.to_ascii_lowercase();
    SENSITIVE_KEY_FRAGMENTS.iter().any(|fragment| lowered.contains(fragment))
}

fn redact_value(value: &mut Value) {
    match value {
        Value::String(text) => *text = REDACTED.to_owned(),
        Value::Number(_) => *value = Value::String(REDACTED.to_owned()),
        Value::Array(items) => {
            for item in items {
                redact_value(item);
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                redact_value(item);
            }
        }
        Value::Null | Value::Bool(_) => {}
    }
}

pub fn scrub_json(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                if is_sensitive_key(key) {
                    redact_value(item);
                } else {
                    scrub_json(item);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                scrub_json(item);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

fn percent_encode(text: &str, space_as_plus: bool) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else if space_as_plus && byte == b' ' {
            out.push('+');
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out
}

fn build_secret_variants(secrets: &[&str]) -> Vec<String> {
    let mut variants = Vec::new();
    for secret in secrets {
        if secret.is_empty() {
            continue;
        }
        for candidate in [
            (*secret).to_ascii_lowercase(),
            percent_encode(secret, false).to_ascii_lowercase(),
            percent_encode(secret, true).to_ascii_lowercase(),
        ] {
            if !candidate.is_empty() && !variants.contains(&candidate) {
                variants.push(candidate);
            }
        }
    }
    variants.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
    variants
}

fn scrub_known_secrets_in_text(text: &mut String, variants_lower: &[String]) {
    for variant in variants_lower {
        if variant.is_empty() {
            continue;
        }
        let lower = text.to_ascii_lowercase();
        if !lower.contains(variant.as_str()) {
            continue;
        }
        let mut result = String::with_capacity(text.len());
        let mut cursor = 0;
        while let Some(offset) = lower[cursor..].find(variant.as_str()) {
            let match_start = cursor + offset;
            result.push_str(&text[cursor..match_start]);
            result.push_str(REDACTED);
            cursor = match_start + variant.len();
        }
        result.push_str(&text[cursor..]);
        *text = result;
    }
}

fn is_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

fn is_value_delimiter(byte: u8) -> bool {
    byte.is_ascii_whitespace() || matches!(byte, b'<' | b'>' | b',' | b';' | b'&' | b'"' | b'\'' | b')' | b']' | b'}')
}

fn scan_unquoted_value_end(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && !is_value_delimiter(bytes[index]) {
        index += 1;
    }
    index
}

fn skip_spaces(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && matches!(bytes[index], b' ' | b'\t') {
        index += 1;
    }
    index
}

fn scan_quoted_value_end(bytes: &[u8], mut index: usize, quote: u8) -> (usize, bool) {
    while index < bytes.len() {
        if bytes[index] == b'\\' && index + 1 < bytes.len() {
            index += 2;
            continue;
        }
        if bytes[index] == quote {
            return (index, true);
        }
        index += 1;
    }
    (bytes.len(), false)
}

fn scrub_sensitive_text(text: &mut String) {
    let source = text.as_str();
    let bytes = source.as_bytes();
    let mut out = String::with_capacity(source.len());
    let mut index = 0;
    while index < bytes.len() {
        if !is_identifier_byte(bytes[index]) {
            let ch = source[index..].chars().next().expect("유효한 UTF-8 경계");
            out.push(ch);
            index += ch.len_utf8();
            continue;
        }
        let ident_start = index;
        while index < bytes.len() && is_identifier_byte(bytes[index]) {
            index += 1;
        }
        let ident = &source[ident_start..index];
        out.push_str(ident);
        if ident.eq_ignore_ascii_case("bearer") {
            let after_space = skip_spaces(bytes, index);
            if after_space > index {
                let token_end = scan_unquoted_value_end(bytes, after_space);
                if token_end > after_space {
                    out.push_str(&source[index..after_space]);
                    out.push_str(REDACTED);
                    index = token_end;
                    continue;
                }
            }
        }
        if !is_sensitive_key(ident) {
            continue;
        }
        let mut cursor = index;
        if cursor < bytes.len() && matches!(bytes[cursor], b'"' | b'\'') {
            cursor += 1;
        }
        cursor = skip_spaces(bytes, cursor);
        if cursor >= bytes.len() || !matches!(bytes[cursor], b'=' | b':') {
            continue;
        }
        cursor = skip_spaces(bytes, cursor + 1);
        out.push_str(&source[index..cursor]);
        if cursor < bytes.len() && matches!(bytes[cursor], b'"' | b'\'') {
            let quote = bytes[cursor];
            out.push(quote as char);
            let (end, closed) = scan_quoted_value_end(bytes, cursor + 1, quote);
            out.push_str(REDACTED);
            if closed {
                out.push(quote as char);
                index = end + 1;
            } else {
                index = end;
            }
        } else {
            let first_end = scan_unquoted_value_end(bytes, cursor);
            let first_word = &source[cursor..first_end];
            if first_word.eq_ignore_ascii_case("bearer") || first_word.eq_ignore_ascii_case("basic") {
                let after_scheme = skip_spaces(bytes, first_end);
                let token_end = scan_unquoted_value_end(bytes, after_scheme);
                if token_end > after_scheme {
                    out.push_str(REDACTED);
                    index = token_end;
                    continue;
                }
            }
            if first_end > cursor {
                out.push_str(REDACTED);
                index = first_end;
            } else {
                index = cursor;
            }
        }
    }
    *text = out;
}

fn scrub_known_secrets(value: &mut Value, variants_lower: &[String]) {
    match value {
        Value::String(text) => scrub_known_secrets_in_text(text, variants_lower),
        Value::Array(items) => {
            for item in items {
                scrub_known_secrets(item, variants_lower);
            }
        }
        Value::Object(map) => {
            let original = std::mem::take(map);
            for (mut key, mut item) in original {
                scrub_known_secrets_in_text(&mut key, variants_lower);
                scrub_known_secrets(&mut item, variants_lower);
                map.insert(key, item);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn scrub_header_value(header: Option<String>, variants_lower: &[String]) -> Option<String> {
    header.map(|mut value| {
        scrub_sensitive_text(&mut value);
        scrub_known_secrets_in_text(&mut value, variants_lower);
        value
    })
}

fn select_key(request: &ProbeRequest, process: &Variables) -> Result<ActiveKey, String> {
    let keys = KeyList::load(&request.keys_path, &request.state_dir, process).map_err(|error| error.to_string())?;
    let selected = keys
        .active
        .into_iter()
        .find(|entry| entry.identity.name == request.key)
        .ok_or_else(|| format!("활성 키 목록에서 키 {}를 찾지 못했습니다", request.key))?;
    if selected.broker != request.broker {
        return Err(format!(
            "키 {}는 {} 키이지만 --broker가 {}입니다",
            request.key,
            broker_label(selected.broker),
            broker_label(request.broker)
        ));
    }
    Ok(selected)
}

async fn obtain_kiwoom_token(key: &ActiveKey, base_url: &str, clock: Clock) -> Result<Secret<String>, String> {
    let lock = InstanceLock::acquire(&key.lock_path).map_err(|error| format!("키 {} 잠금 실패: {error}", key.identity.name))?;
    let file = TokenFile::new(key.token_path.clone(), &lock);
    let auth = KiwoomAuth::new(key.app_key.clone(), key.app_secret.clone(), Some(file));
    if let Some(halt) = auth.halted() {
        return Err(format!("키움 인증이 중단된 상태입니다: {halt:?}"));
    }
    if let Some((token, _)) = auth.current(clock.now()) {
        return Ok(token);
    }
    let transport = KiwoomReqwestTransport::new(base_url.to_owned()).map_err(|error| format!("키움 HTTP 클라이언트를 만들지 못했습니다: {error}"))?;
    let rest = KiwoomRest::new(Arc::new(transport), auth, clock.clone());
    rest.issue_token().await.map_err(|error| format!("키움 토큰 발급 실패: {error}"))?;
    rest.auth()
        .current(clock.now())
        .map(|(token, _)| token)
        .ok_or_else(|| "키움 토큰을 발급했지만 사용할 수 있는 토큰이 없습니다".to_owned())
}

async fn obtain_kis_token(key: &ActiveKey, base_url: &str, clock: Clock) -> Result<Secret<String>, String> {
    let _lock = InstanceLock::acquire(&key.lock_path).map_err(|error| format!("키 {} 잠금 실패: {error}", key.identity.name))?;
    let transport = KisReqwestTransport::new(base_url.to_owned()).map_err(|error| format!("한투 HTTP 클라이언트를 만들지 못했습니다: {error}"))?;
    let credentials = KisCredentials { app_key: key.app_key.clone(), app_secret: key.app_secret.clone() };
    let auth = KisAuth::new(credentials, key.token_path.clone(), Arc::new(transport), clock);
    let lease = auth.token().await.map_err(|error| format!("한투 토큰 확보 실패: {error}"))?;
    Ok(lease.token)
}

fn non_empty_header(headers: &reqwest::header::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub async fn execute_probe(request: &ProbeRequest, base_url: &str, process: &Variables, clock: Clock) -> Result<ProbeResult, String> {
    let key = select_key(request, process)?;
    let trimmed_base = base_url.trim_end_matches('/');
    let token = match request.broker {
        Broker::Kiwoom => obtain_kiwoom_token(&key, trimmed_base, clock).await?,
        Broker::Kis => obtain_kis_token(&key, trimmed_base, clock).await?,
    };
    let client = reqwest::Client::builder()
        .tls_backend_rustls()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(SEND_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP 클라이언트를 만들지 못했습니다: {}", error.without_url()))?;
    let url = format!("{trimmed_base}{}", request.path);
    let mut builder = match request.method {
        ProbeMethod::Get => client.get(url).query(&request.query),
        ProbeMethod::Post => {
            let mut post = client.post(url);
            if !request.query.is_empty() {
                post = post.query(&request.query);
            }
            if let Some(body) = &request.body {
                post = post.body(body.clone());
            }
            post
        }
    };
    builder = match request.broker {
        Broker::Kiwoom => builder
            .header("api-id", request.tr_id.as_str())
            .header("authorization", format!("Bearer {}", token.expose()))
            .header("content-type", "application/json;charset=UTF-8"),
        Broker::Kis => builder
            .header("authorization", format!("Bearer {}", token.expose()))
            .header("appkey", key.app_key.expose().as_str())
            .header("appsecret", key.app_secret.expose().as_str())
            .header("tr_id", request.tr_id.as_str())
            .header("custtype", CUSTOMER_TYPE_PERSONAL)
            .header("tr_cont", "")
            .header("content-type", "application/json; charset=utf-8"),
    };
    let response = builder.send().await.map_err(|error| format!("TR 요청 실패: {}", error.without_url()))?;
    let status = response.status().as_u16();
    let tr_cont = non_empty_header(response.headers(), "tr_cont");
    let cont_yn = non_empty_header(response.headers(), "cont-yn");
    let next_key = non_empty_header(response.headers(), "next-key");
    let raw_body = response.text().await.map_err(|error| format!("TR 응답 본문 읽기 실패: {}", error.without_url()))?;
    let mut body = match serde_json::from_str::<Value>(&raw_body) {
        Ok(value) => value,
        Err(_) => {
            let mut text = raw_body;
            scrub_sensitive_text(&mut text);
            Value::String(text)
        }
    };
    let secret_variants = build_secret_variants(&[key.app_key.expose().as_str(), key.app_secret.expose().as_str(), token.expose().as_str()]);
    scrub_json(&mut body);
    scrub_known_secrets(&mut body, &secret_variants);
    let fixture = CapturedFixture {
        broker: broker_label(request.broker).to_owned(),
        tr_id: request.tr_id.clone(),
        path: request.path.clone(),
        method: request.method.as_str().to_owned(),
        status,
        tr_cont: scrub_header_value(tr_cont, &secret_variants),
        cont_yn: scrub_header_value(cont_yn, &secret_variants),
        next_key: scrub_header_value(next_key, &secret_variants),
        body,
    };
    let mut bytes = serde_json::to_vec_pretty(&fixture).map_err(|error| format!("픽스처 직렬화 실패: {error}"))?;
    bytes.push(b'\n');
    let output_path = request.out_dir.join(format!("{}-{}.json", broker_label(request.broker), request.tr_id));
    write_atomically(&output_path, &bytes).map_err(|error| format!("픽스처 저장 실패({}): {error}", output_path.display()))?;
    Ok(ProbeResult { output_path, fixture })
}

fn usage_error(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("probe-tr: {message}");
    ExitCode::from(2)
}

pub fn run(raw_arguments: &[String]) -> ExitCode {
    let process = process_variables();
    let request = match parse_arguments(raw_arguments, &process) {
        Ok(request) => request,
        Err(message) => return usage_error(message),
    };
    let base_url = match request.broker {
        Broker::Kiwoom => rest_base_url(&process),
        Broker::Kis => kis_base_url(&process),
    };
    let base_url = match base_url {
        Ok(url) => url,
        Err(message) => return usage_error(message),
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => return usage_error(format_args!("실행 환경을 만들지 못했습니다: {error}")),
    };
    match runtime.block_on(execute_probe(&request, &base_url, &process, Clock::system())) {
        Ok(result) => {
            println!("저장 완료: {} (status={})", result.output_path.display(), result.fixture.status);
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("probe-tr: {message}");
            ExitCode::FAILURE
        }
    }
}
