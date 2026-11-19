use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use domain::{KstDate, KstTime, StockCode, Symbol, SymbolKind, TimeOfDay};
use serde::{Deserialize, Serialize};

use super::catalog::{Attempt, Catalog, CollectedFund, CollectedHolding, MAX_WEIGHT_BPS, MAX_WEIGHT_SUM_BPS};
use crate::api::UnixSeconds;
use crate::clock::next_daily;
use crate::http::AppState;
use crate::symbols::Directory;

const COLLECT_AT: TimeOfDay = match TimeOfDay::hms(12, 10, 0) {
    Some(at) => at,
    None => panic!("올바른 시각"),
};
const CALL_SPACING: Duration = Duration::from_millis(500);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const STORED_SCHEMA_VERSION: u32 = 1;
const PDF_DIR: &str = "pdf";
const ATTEMPTS_FILE: &str = "attempts.json";
const RAW_SUFFIX: &str = ".raw.json";

pub struct EtfBook {
    base: Arc<Catalog>,
    current: RwLock<Arc<Catalog>>,
    state: Mutex<Collected>,
}

#[derive(Default)]
struct Collected {
    funds: HashMap<StockCode, CollectedFund>,
    attempts: HashMap<StockCode, Attempt>,
}

impl Default for EtfBook {
    fn default() -> Self {
        let base = Arc::new(Catalog::embedded());
        EtfBook { current: RwLock::new(base.clone()), base, state: Mutex::default() }
    }
}

impl EtfBook {
    pub fn catalog(&self) -> Arc<Catalog> {
        self.current.read().expect("ETF 목록 잠금").clone()
    }

    fn publish(&self) {
        let merged = {
            let state = self.state.lock().expect("ETF 수집 잠금");
            Arc::new(self.base.overlaid(&state.funds, &state.attempts))
        };
        *self.current.write().expect("ETF 목록 잠금") = merged;
    }

    fn latest_as_of(&self, code: StockCode) -> Option<KstDate> {
        self.state.lock().expect("ETF 수집 잠금").funds.get(&code).map(|fund| fund.as_of)
    }

    fn attempted_on(&self, code: StockCode, day: KstDate) -> bool {
        self.state.lock().expect("ETF 수집 잠금").attempts.get(&code).is_some_and(|attempt| KstTime::from_unix(attempt.at.0).kst_date() == day)
    }

    fn record(&self, code: StockCode, attempt: Attempt, fund: Option<CollectedFund>) -> HashMap<StockCode, Attempt> {
        let mut state = self.state.lock().expect("ETF 수집 잠금");
        state.attempts.insert(code, attempt);
        if let Some(fund) = fund {
            state.funds.insert(code, fund);
        }
        state.attempts.clone()
    }

    fn restore(&self, loaded: Collected) {
        *self.state.lock().expect("ETF 수집 잠금") = loaded;
        self.publish();
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPdf {
    schema_version: u32,
    code: String,
    as_of: String,
    holdings: Vec<StoredHolding>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredHolding {
    code: String,
    name: String,
    cu_quantity: f64,
    weight_bps: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRow {
    item_code: Option<String>,
    component_item_code: Option<String>,
    component_name: Option<String>,
    component_count: Option<String>,
    cu_unit_quantity: Option<String>,
    weight: Option<String>,
    reference_date: Option<String>,
}

struct Parsed {
    as_of: KstDate,
    holdings: Vec<StoredHolding>,
}

fn weight_bps(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    let (negative, unsigned) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let (whole, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) || !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut digits = fraction.bytes().map(|b| i64::from(b - b'0'));
    let (tenths, hundredths, third) = (digits.next().unwrap_or(0), digits.next().unwrap_or(0), digits.next().unwrap_or(0));
    let bps = whole.parse::<i64>().ok()?.checked_mul(100)? + tenths * 10 + hundredths + i64::from(third >= 5);
    Some(if negative { -bps } else { bps })
}

fn parse_response(code: StockCode, body: &[u8], today: KstDate, stored_as_of: Option<KstDate>) -> Result<Parsed, String> {
    let rows: Vec<RawRow> = serde_json::from_slice(body).map_err(|e| format!("응답을 읽을 수 없습니다: {e}"))?;
    if rows.is_empty() {
        return Err("빈 응답입니다".into());
    }
    let mut as_of = None;
    let mut holdings = Vec::with_capacity(rows.len());
    for row in &rows {
        if row.item_code.as_deref() != Some(code.as_str()) {
            return Err(format!("다른 ETF 코드의 행이 있습니다: {}", row.item_code.as_deref().unwrap_or("(없음)")));
        }
        let reference = row.reference_date.as_deref().and_then(|text| text.parse::<crate::api::KstDate>().ok()).ok_or("기준일이 없거나 YYYY-MM-DD가 아닙니다")?.0;
        if *as_of.get_or_insert(reference) != reference {
            return Err("한 응답에 기준일이 둘 이상입니다".into());
        }
        if let Some(declared) = &row.component_count && declared.trim().parse::<usize>().ok() != Some(rows.len()) {
            return Err(format!("선언한 구성 항목 수({declared})와 응답 행 수({})가 다릅니다", rows.len()));
        }
        let Some(stock) = row.component_item_code.as_deref().and_then(|text| StockCode::parse(text).ok()) else {
            continue;
        };
        let label = stock.as_str();
        let weight = row.weight.as_deref().and_then(weight_bps).ok_or_else(|| format!("비중을 읽을 수 없습니다: {label}"))?;
        let weight = u32::try_from(weight).ok().filter(|w| *w <= MAX_WEIGHT_BPS).ok_or_else(|| format!("종목 비중이 0~{MAX_WEIGHT_BPS}bps를 벗어납니다: {label} {weight}bps"))?;
        let quantity = row.cu_unit_quantity.as_deref().and_then(|text| text.trim().parse::<f64>().ok()).filter(|q| q.is_finite()).ok_or_else(|| format!("CU 수량을 읽을 수 없습니다: {label}"))?;
        if holdings.iter().any(|h: &StoredHolding| h.code == label) {
            return Err(format!("종목이 중복입니다: {label}"));
        }
        holdings.push(StoredHolding { code: label.into(), name: row.component_name.clone().unwrap_or_default(), cu_quantity: quantity, weight_bps: weight });
    }
    let as_of = as_of.expect("행이 하나 이상이다");
    if as_of > today {
        return Err(format!("기준일 {as_of}이 오늘({today})보다 뒤입니다"));
    }
    if let Some(stored) = stored_as_of.filter(|stored| *stored > as_of) {
        return Err(format!("기준일 {as_of}이 이미 저장한 {stored}보다 앞섭니다"));
    }
    if holdings.is_empty() {
        return Err("구성 종목이 없습니다".into());
    }
    let sum: u64 = holdings.iter().map(|h| u64::from(h.weight_bps)).sum();
    if sum == 0 || sum > u64::from(MAX_WEIGHT_SUM_BPS) {
        return Err(format!("비중 합이 허용 범위(1~{MAX_WEIGHT_SUM_BPS}bp)를 벗어납니다: {sum}bps"));
    }
    Ok(Parsed { as_of, holdings })
}

struct Naver {
    http: reqwest::Client,
    base: String,
}

impl Naver {
    fn new(base: String) -> Result<Naver, reqwest::Error> {
        let http = reqwest::Client::builder().tls_backend_native().user_agent(concat!("vallythevally/", env!("CARGO_PKG_VERSION"))).timeout(REQUEST_TIMEOUT).redirect(reqwest::redirect::Policy::none()).build()?;
        Ok(Naver { http, base })
    }

    async fn components(&self, code: StockCode) -> Result<Vec<u8>, String> {
        let response = self.http.get(format!("{}/api/domestic/detail/{}/ETFComponent", self.base, code.as_str())).send().await.map_err(|e| format!("요청에 실패했습니다: {}", e.without_url()))?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }
        let body = response.bytes().await.map_err(|e| format!("응답을 끝까지 받지 못했습니다: {}", e.without_url()))?;
        if body.len() > MAX_BODY_BYTES {
            return Err(format!("응답이 {MAX_BODY_BYTES}바이트를 넘습니다"));
        }
        Ok(body.to_vec())
    }
}

fn pdf_dir(dir: &Path, day: KstDate) -> PathBuf {
    dir.join(PDF_DIR).join(day.yyyymmdd())
}

async fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension("tmp");
    tokio::fs::write(&temporary, bytes).await?;
    tokio::fs::rename(&temporary, path).await
}

async fn save_pdf(dir: &Path, code: StockCode, raw: &[u8], parsed: &Parsed) -> std::io::Result<()> {
    let day_dir = pdf_dir(dir, parsed.as_of);
    tokio::fs::create_dir_all(&day_dir).await?;
    let stored = StoredPdf { schema_version: STORED_SCHEMA_VERSION, code: code.as_str().into(), as_of: parsed.as_of.to_string(), holdings: parsed.holdings.iter().map(|h| StoredHolding { code: h.code.clone(), name: h.name.clone(), cu_quantity: h.cu_quantity, weight_bps: h.weight_bps }).collect() };
    write_atomically(&day_dir.join(format!("{}{RAW_SUFFIX}", code.as_str())), raw).await?;
    write_atomically(&day_dir.join(format!("{}.json", code.as_str())), &serde_json::to_vec(&stored)?).await
}

#[derive(Serialize, Deserialize)]
struct StoredAttempt {
    at: i64,
    failed: bool,
}

async fn save_attempts(dir: &Path, attempts: &HashMap<StockCode, Attempt>) -> std::io::Result<()> {
    let stored: std::collections::BTreeMap<&str, StoredAttempt> = attempts.iter().map(|(code, attempt)| (code.as_str(), StoredAttempt { at: attempt.at.0, failed: attempt.failed })).collect();
    tokio::fs::create_dir_all(dir).await?;
    write_atomically(&dir.join(ATTEMPTS_FILE), &serde_json::to_vec(&stored)?).await
}

async fn load(dir: &Path) -> Collected {
    let mut loaded = Collected::default();
    if let Ok(bytes) = tokio::fs::read(dir.join(ATTEMPTS_FILE)).await {
        match serde_json::from_slice::<HashMap<String, StoredAttempt>>(&bytes) {
            Ok(stored) => {
                for (code, attempt) in stored {
                    if let Ok(code) = StockCode::parse(&code) {
                        loaded.attempts.insert(code, Attempt { at: UnixSeconds(attempt.at), failed: attempt.failed });
                    }
                }
            }
            Err(e) => tracing::warn!(error = %e, "ETF 수집 시도 기록을 읽지 못했습니다. 비어 있는 것으로 봅니다"),
        }
    }
    let Ok(mut days) = tokio::fs::read_dir(dir.join(PDF_DIR)).await else {
        return loaded;
    };
    let mut day_dirs = BTreeSet::new();
    while let Ok(Some(entry)) = days.next_entry().await {
        if let Some(day) = entry.file_name().to_str().and_then(KstDate::parse_yyyymmdd) {
            day_dirs.insert(day);
        }
    }
    for day in day_dirs {
        let Ok(mut files) = tokio::fs::read_dir(pdf_dir(dir, day)).await else { continue };
        while let Ok(Some(entry)) = files.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(code) = name.strip_suffix(".json").filter(|stem| !name.ends_with(RAW_SUFFIX) && !stem.is_empty()) else { continue };
            match read_stored(&entry.path(), code, day).await {
                Ok(fund) => {
                    let code = StockCode::parse(code).expect("읽기에서 확인했다");
                    loaded.funds.insert(code, fund);
                }
                Err(reason) => tracing::warn!(file = %entry.path().display(), %reason, "저장된 ETF 구성을 싣지 않습니다"),
            }
        }
    }
    loaded
}

async fn read_stored(path: &Path, code: &str, day: KstDate) -> Result<CollectedFund, String> {
    let stored: StoredPdf = serde_json::from_slice(&tokio::fs::read(path).await.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if stored.schema_version != STORED_SCHEMA_VERSION || stored.code != code || stored.as_of != day.to_string() {
        return Err("자료 버전·ETF 코드·기준일이 파일 위치와 다릅니다".into());
    }
    let holdings = stored.holdings.into_iter().map(|h| Ok(CollectedHolding { code: StockCode::parse(&h.code).map_err(|e| e.to_string())?, name: h.name, weight_bps: h.weight_bps })).collect::<Result<Vec<_>, String>>()?;
    if holdings.is_empty() {
        return Err("구성 종목이 없습니다".into());
    }
    Ok(CollectedFund { as_of: day, holdings })
}

pub fn start(state: Arc<AppState>, dir: PathBuf, base_url: String) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        match Naver::new(base_url) {
            Ok(naver) => run(state, dir, naver).await,
            Err(e) => tracing::error!(error = %e, "ETF 구성내역 수집용 HTTP 클라이언트를 만들 수 없습니다"),
        }
    })
}

async fn run(st: Arc<AppState>, dir: PathBuf, naver: Naver) {
    st.etf.restore(load(&dir).await);
    let mut listing = st.symbols.updates();
    loop {
        let Ok(listed) = listing.wait_for(Option::is_some).await.map(|d| d.clone().expect("Some을 기다렸다")) else { return };
        let now = st.clock.now();
        let today = now.kst_date();
        if now >= kst_at(today) {
            collect_day(&st, &dir, &naver, &listed, today).await;
        }
        st.clock.sleep_until(next_daily(st.clock.now(), COLLECT_AT)).await;
    }
}

fn kst_at(day: KstDate) -> KstTime {
    KstTime::from_kst_civil(day, COLLECT_AT)
}

fn etf_codes(listed: &Directory) -> Vec<StockCode> {
    let mut codes: Vec<StockCode> = listed.all().filter(|info| info.kind == SymbolKind::Etf).filter_map(|info| match info.symbol {
        Symbol::Stock(code) => Some(code),
        Symbol::Index(_) => None,
    }).collect();
    codes.sort();
    codes
}

async fn collect_day(st: &AppState, dir: &Path, naver: &Naver, listed: &Directory, today: KstDate) {
    let pending: Vec<StockCode> = etf_codes(listed).into_iter().filter(|code| !st.etf.attempted_on(*code, today)).collect();
    if pending.is_empty() {
        return;
    }
    tracing::info!(date = %today, count = pending.len(), "ETF 구성내역을 받습니다");
    let mut last_finished: Option<tokio::time::Instant> = None;
    let mut failed = 0usize;
    for code in pending {
        if let Some(last) = last_finished {
            tokio::time::sleep_until(last + CALL_SPACING).await;
        }
        let outcome = fetch_and_store(st, dir, naver, code, today).await;
        last_finished = Some(tokio::time::Instant::now());
        let failure = outcome.as_ref().err();
        if let Some(reason) = failure {
            failed += 1;
            tracing::warn!(etf = code.as_str(), %reason, "ETF 구성내역을 갱신하지 못했습니다. 이전 자료를 그대로 둡니다");
        }
        let attempt = Attempt { at: UnixSeconds(st.clock.now().unix()), failed: failure.is_some() };
        let attempts = st.etf.record(code, attempt, outcome.ok());
        if let Err(e) = save_attempts(dir, &attempts).await {
            tracing::warn!(error = %e, "ETF 수집 시도 기록을 저장하지 못했습니다");
        }
        st.etf.publish();
    }
    tracing::info!(date = %today, failed, "ETF 구성내역 수집을 마쳤습니다");
}

async fn fetch_and_store(st: &AppState, dir: &Path, naver: &Naver, code: StockCode, today: KstDate) -> Result<CollectedFund, String> {
    let raw = naver.components(code).await?;
    let parsed = parse_response(code, &raw, today, st.etf.latest_as_of(code))?;
    save_pdf(dir, code, &raw, &parsed).await.map_err(|e| format!("저장하지 못했습니다: {e}"))?;
    let holdings = parsed.holdings.iter().map(|h| CollectedHolding { code: StockCode::parse(&h.code).expect("파싱에서 확인했다"), name: h.name.clone(), weight_bps: h.weight_bps }).collect();
    Ok(CollectedFund { as_of: parsed.as_of, holdings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weights_become_basis_points_without_floats() {
        assert_eq!(weight_bps("19.00"), Some(1900));
        assert_eq!(weight_bps("0.34"), Some(34));
        assert_eq!(weight_bps("-0.20"), Some(-20));
        assert_eq!(weight_bps("5"), Some(500));
        assert_eq!(weight_bps("12.3456"), Some(1235));
        assert_eq!(weight_bps("12.3449"), Some(1234));
        assert_eq!(weight_bps(""), None);
        assert_eq!(weight_bps("1e2"), None);
        assert_eq!(weight_bps(".5"), None);
    }
}
