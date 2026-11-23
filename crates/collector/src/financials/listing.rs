use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use domain::{Market, Symbol, SymbolInfo, SymbolKind};
use serde::{Deserialize, Serialize};
use server::clock::Clock;
use tokio::sync::watch;

use crate::universe::{MarketName, StockKind, StoreError, UniverseFile, read_universe, universe_path};

pub const POLL_INTERVAL: Duration = Duration::from_secs(30);
const FOLDER: &str = "universe";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListingInfo {
    pub date: u32,
    pub stocks: usize,
}

pub struct ListingFeed {
    pub symbols: watch::Receiver<Option<Vec<SymbolInfo>>>,
    pub info: watch::Receiver<Option<ListingInfo>>,
}

pub fn symbols_of(file: &UniverseFile) -> Vec<SymbolInfo> {
    file.stocks
        .iter()
        .filter_map(|entry| {
            let symbol = Symbol::parse(&entry.code).ok()?;
            let kind = match entry.kind {
                StockKind::Common | StockKind::Spac => SymbolKind::Common,
                StockKind::Preferred => SymbolKind::Preferred,
            };
            let market = match entry.market {
                MarketName::Kospi => Market::Kospi,
                MarketName::Kosdaq => Market::Kosdaq,
            };
            Some(SymbolInfo { symbol, name: entry.name.clone(), kind, market, nxt_enabled: false })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Signature {
    date: u32,
    modified: Option<SystemTime>,
    length: u64,
}

fn candidate_dates(data_dir: &Path, today: u32) -> std::io::Result<Vec<u32>> {
    let entries = match std::fs::read_dir(data_dir.join(FOLDER)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut dates: Vec<u32> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let digits = name.to_str()?.strip_suffix(".json")?;
            let date = (digits.len() == 8 && digits.bytes().all(|byte| byte.is_ascii_digit())).then(|| digits.parse::<u32>().ok()).flatten()?;
            (date <= today).then_some(date)
        })
        .collect();
    dates.sort_unstable_by(|a, b| b.cmp(a));
    Ok(dates)
}

fn signature_of(data_dir: &Path, date: u32) -> std::io::Result<Signature> {
    let metadata = std::fs::metadata(universe_path(data_dir, date))?;
    Ok(Signature { date, modified: metadata.modified().ok(), length: metadata.len() })
}

enum Scan {
    Unchanged,
    Changed(Option<Signature>, Option<(ListingInfo, Vec<SymbolInfo>)>),
}

fn scan(data_dir: &Path, today: u32, seen: &Option<Option<Signature>>) -> Result<Scan, String> {
    let unreadable = |error: std::io::Error| format!("종목 목록 폴더를 읽을 수 없습니다: {error}");
    let dates = candidate_dates(data_dir, today).map_err(unreadable)?;
    let signature = dates.first().map(|date| signature_of(data_dir, *date)).transpose().map_err(unreadable)?;
    if seen.as_ref() == Some(&signature) {
        return Ok(Scan::Unchanged);
    }
    for date in dates {
        match read_universe(data_dir, date) {
            Ok(file) => {
                let symbols = symbols_of(&file);
                return Ok(Scan::Changed(signature, Some((ListingInfo { date, stocks: symbols.len() }, symbols))));
            }
            Err(error @ StoreError::Read { .. }) => return Err(error.to_string()),
            Err(error) => tracing::warn!(date, %error, "읽을 수 없는 종목 목록 파일을 건너뜁니다"),
        }
    }
    Ok(Scan::Changed(signature, None))
}

fn replace_if_different<T: PartialEq>(current: &mut Option<T>, next: Option<T>) -> bool {
    if *current == next {
        return false;
    }
    *current = next;
    true
}

fn today_of(clock: &Clock) -> u32 {
    clock.now().kst_date().yyyymmdd().parse().unwrap_or(0)
}

pub fn watch_listings(data_dir: PathBuf, clock: Clock, interval: Duration) -> (ListingFeed, tokio::task::JoinHandle<()>) {
    let (symbols_sender, symbols) = watch::channel(None);
    let (info_sender, info) = watch::channel(None);
    let task = tokio::spawn(async move {
        let mut seen: Option<Option<Signature>> = None;
        loop {
            let (directory, today, last) = (data_dir.clone(), today_of(&clock), seen.clone());
            match tokio::task::spawn_blocking(move || scan(&directory, today, &last)).await {
                Ok(Ok(Scan::Unchanged)) => {}
                Ok(Ok(Scan::Changed(signature, listing))) => {
                    seen = Some(signature);
                    let (found, list) = listing.unzip();
                    if found.is_none() {
                        tracing::warn!(data = %data_dir.display(), "읽을 수 있는 종목 목록 파일이 없어 재무를 모으지 않습니다");
                    }
                    info_sender.send_if_modified(|current| replace_if_different(current, found));
                    symbols_sender.send_if_modified(|current| replace_if_different(current, list));
                }
                Ok(Err(message)) => tracing::warn!(%message, "종목 목록을 읽지 못했습니다"),
                Err(_) => tracing::warn!("종목 목록 읽기 작업이 중단됐습니다"),
            }
            if symbols_sender.is_closed() {
                return;
            }
            tokio::time::sleep(interval).await;
        }
    });
    (ListingFeed { symbols, info }, task)
}
