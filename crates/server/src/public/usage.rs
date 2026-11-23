
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

use super::limits::locked;
use crate::http::AppState;
use crate::shared_data::DataKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Bundle {
    Rankings,
    MarketOverview,
    ScreenerRun,
    Board,
    Flow,
    Shared,
    UserData,
    Login,
}

impl Bundle {
    pub fn of_path(path: &str) -> Bundle {
        if path.starts_with("/v1/") {
            Bundle::Login
        } else if path == "/api/rankings" {
            Bundle::Rankings
        } else if path.starts_with("/api/market-overview/") {
            Bundle::MarketOverview
        } else if path == "/api/screener/run" {
            Bundle::ScreenerRun
        } else if path == "/api/heatmap/board" {
            Bundle::Board
        } else if path == "/api/heatmap/flow" {
            Bundle::Flow
        } else if is_user_data_path(path) {
            Bundle::UserData
        } else {
            Bundle::Shared
        }
    }
}

const USER_DATA_PATHS: &[&str] = &["/api/watchlists", "/api/screens", "/api/heatmap/themes", "/api/ui-state", "/api/layouts", "/api/drawings"];

fn is_user_data_path(path: &str) -> bool {
    USER_DATA_PATHS.iter().any(|prefix| path == *prefix || path.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('/')))
}

fn is_zero(count: &u64) -> bool {
    *count == 0
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BundleCounters {
    pub responses: u64,
    pub too_many_requests: u64,
    pub unavailable: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub rejected_symbols: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CacheHits {
    pub screener_status: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SharedKindReading {
    pub age_secs: Option<i64>,
    pub read_errors: u64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScreenerResultReuse {
    pub hits: u64,
    pub misses: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SharedReading {
    pub shared_data: BTreeMap<&'static str, SharedKindReading>,
    pub screener_results: Option<ScreenerResultReuse>,
}

impl SharedReading {
    pub fn of(state: &AppState) -> SharedReading {
        let now = state.clock.now();
        let shared_data = DataKind::ALL.iter().map(|kind| (kind.folder(), SharedKindReading { age_secs: state.shared_data.age_secs(*kind, now), read_errors: state.shared_data.error_count(*kind) })).collect();
        let screener_results = state.screener.result_reuse().map(|counts| ScreenerResultReuse { hits: counts.hits, misses: counts.misses });
        SharedReading { shared_data, screener_results }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TopAccount {
    pub account: String,
    pub requests: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LatencyMinute {
    pub started_at: i64,
    pub samples: u64,
    pub p50_ms: u64,
    pub max_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub since: i64,
    pub bundles: BTreeMap<Bundle, BundleCounters>,
    pub cache_hits: CacheHits,
    pub top_accounts: Vec<TopAccount>,
    pub operator_kiwoom_latency: OperatorLatency,
    #[serde(flatten)]
    pub reading: SharedReading,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperatorLatency {
    pub current: LatencyMinute,
    pub last_minute: Option<LatencyMinute>,
}

#[derive(Debug, Default)]
struct Counted {
    bundles: BTreeMap<Bundle, BundleCounters>,
    cache_hits: CacheHits,
    accounts: HashMap<String, u64>,
    minute_activity: u64,
}

#[derive(Debug, Default)]
struct Latency {
    minute_started_at: i64,
    samples: Vec<Duration>,
    last: Option<LatencyMinute>,
}

impl Latency {
    fn roll(&mut self, now: i64) {
        let minute = now - now.rem_euclid(60);
        if minute == self.minute_started_at {
            return;
        }
        if !self.samples.is_empty() {
            self.last = Some(summary(self.minute_started_at, &mut self.samples));
        }
        self.samples.clear();
        self.minute_started_at = minute;
    }
}

fn summary(started_at: i64, samples: &mut [Duration]) -> LatencyMinute {
    samples.sort();
    let ms = |d: Duration| d.as_millis() as u64;
    LatencyMinute { started_at, samples: samples.len() as u64, p50_ms: samples.get(samples.len().saturating_sub(1) / 2).copied().map_or(0, ms), max_ms: samples.last().copied().map_or(0, ms) }
}

#[derive(Debug, Default)]
pub struct Usage {
    counted: Mutex<Counted>,
    latency: Mutex<Latency>,
    since: Mutex<i64>,
}

impl Usage {
    pub fn started(&self, now: i64) {
        *locked(&self.since) = now;
    }

    pub fn response(&self, bundle: Bundle, status: u16, account: Option<&str>) {
        let mut counted = locked(&self.counted);
        counted.minute_activity += 1;
        let counters = counted.bundles.entry(bundle).or_default();
        counters.responses += 1;
        match status {
            429 => counters.too_many_requests += 1,
            503 => counters.unavailable += 1,
            _ => {}
        }
        if let Some(account) = account {
            *counted.accounts.entry(account.to_owned()).or_insert(0) += 1;
        }
    }

    pub fn rejected_symbols(&self, bundle: Bundle, count: u64) {
        locked(&self.counted).bundles.entry(bundle).or_default().rejected_symbols += count;
    }

    pub fn screener_status_cache_hit(&self) {
        locked(&self.counted).cache_hits.screener_status += 1;
    }

    pub fn operator_kiwoom_response(&self, now: i64, elapsed: Duration) {
        let mut latency = locked(&self.latency);
        latency.roll(now);
        latency.samples.push(elapsed);
    }

    pub fn snapshot(&self, now: i64, reading: SharedReading) -> UsageSnapshot {
        let counted = locked(&self.counted);
        let mut accounts: Vec<TopAccount> = counted.accounts.iter().map(|(account, requests)| TopAccount { account: account.clone(), requests: *requests }).collect();
        accounts.sort_by(|a, b| b.requests.cmp(&a.requests).then_with(|| a.account.cmp(&b.account)));
        accounts.truncate(10);
        let mut latency = locked(&self.latency);
        latency.roll(now);
        let mut samples = latency.samples.clone();
        let current = summary(latency.minute_started_at, &mut samples);
        UsageSnapshot { since: *locked(&self.since), bundles: counted.bundles.clone(), cache_hits: counted.cache_hits.clone(), top_accounts: accounts, operator_kiwoom_latency: OperatorLatency { current, last_minute: latency.last.clone() }, reading }
    }

    pub fn take_minute_line(&self, now: i64, reading: impl FnOnce() -> SharedReading) -> Option<String> {
        let mut counted = locked(&self.counted);
        if std::mem::take(&mut counted.minute_activity) == 0 {
            return None;
        }
        drop(counted);
        let snapshot = self.snapshot(now, reading());
        serde_json::to_string(&snapshot).ok().map(|line| format!("공개 사용량 {line}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_responses_limits_and_top_accounts() {
        let usage = Usage::default();
        usage.response(Bundle::Rankings, 200, Some("google:a"));
        usage.response(Bundle::Rankings, 429, Some("google:a"));
        usage.response(Bundle::Rankings, 503, Some("naver:b"));
        usage.response(Bundle::Shared, 200, None);
        usage.screener_status_cache_hit();
        let snapshot = usage.snapshot(0, SharedReading::default());
        let rankings = &snapshot.bundles[&Bundle::Rankings];
        assert_eq!((rankings.responses, rankings.too_many_requests, rankings.unavailable), (3, 1, 1));
        assert_eq!(snapshot.cache_hits.screener_status, 1);
        assert_eq!(snapshot.top_accounts[0], TopAccount { account: "google:a".into(), requests: 2 });
    }

    #[test]
    fn rejected_symbols_stay_out_of_the_json_until_something_is_counted() {
        let usage = Usage::default();
        usage.response(Bundle::Flow, 200, None);
        let quiet = serde_json::to_value(usage.snapshot(0, SharedReading::default()).bundles[&Bundle::Flow].clone()).unwrap();
        assert!(quiet.get("rejectedSymbols").is_none() && quiet.get("trCalls").is_none(), "{quiet}");
        usage.rejected_symbols(Bundle::Flow, 4);
        let loud = serde_json::to_value(usage.snapshot(0, SharedReading::default()).bundles[&Bundle::Flow].clone()).unwrap();
        assert_eq!(loud["rejectedSymbols"].as_u64(), Some(4));
    }

    #[test]
    fn user_data_and_heatmap_paths_have_their_own_bundles() {
        for path in ["/api/watchlists", "/api/screens", "/api/heatmap/themes", "/api/ui-state", "/api/layouts", "/api/layouts/abc", "/api/drawings", "/api/drawings/d1"] {
            assert_eq!(Bundle::of_path(path), Bundle::UserData, "{path}");
        }
        assert_eq!((Bundle::of_path("/api/heatmap/board"), Bundle::of_path("/api/heatmap/flow")), (Bundle::Board, Bundle::Flow));
        assert_eq!(Bundle::of_path("/api/layoutsx"), Bundle::Shared);
    }

    #[test]
    fn the_minute_line_is_silent_without_public_requests() {
        let usage = Usage::default();
        assert!(usage.take_minute_line(0, SharedReading::default).is_none());
        usage.response(Bundle::Shared, 200, None);
        assert!(usage.take_minute_line(0, SharedReading::default).is_some());
        assert!(usage.take_minute_line(0, SharedReading::default).is_none());
    }

    #[test]
    fn operator_latency_rolls_into_the_last_minute() {
        let usage = Usage::default();
        for ms in [10, 30, 20] {
            usage.operator_kiwoom_response(5, Duration::from_millis(ms));
        }
        let during = usage.snapshot(30, SharedReading::default()).operator_kiwoom_latency;
        assert_eq!((during.current.samples, during.current.p50_ms, during.current.max_ms), (3, 20, 30));
        let after = usage.snapshot(61, SharedReading::default()).operator_kiwoom_latency;
        assert_eq!((after.current.samples, after.last_minute.map(|m| (m.p50_ms, m.max_ms))), (0, Some((20, 30))));
    }
}
