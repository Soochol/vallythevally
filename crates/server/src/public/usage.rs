//! 조정 근거(D7b): 묶음별 응답·429·503·대기·TR·캐시 적중, 상위 계정, 운영자 쪽 키움 경로 응답 시간.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

use super::limits::locked;

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
        } else {
            Bundle::Shared
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BundleCounters {
    pub responses: u64,
    pub too_many_requests: u64,
    pub unavailable: u64,
    pub wait_total_ms: u64,
    pub wait_max_ms: u64,
    pub tr_calls: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CacheHits {
    pub market_overview: u64,
    pub screener_status: u64,
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

    pub fn tr_calls(&self, bundle: Bundle, count: u64) {
        locked(&self.counted).bundles.entry(bundle).or_default().tr_calls += count;
    }

    pub fn waited(&self, bundle: Bundle, wait: Duration) {
        let mut counted = locked(&self.counted);
        let counters = counted.bundles.entry(bundle).or_default();
        let ms = wait.as_millis() as u64;
        counters.wait_total_ms += ms;
        counters.wait_max_ms = counters.wait_max_ms.max(ms);
    }

    pub fn market_cache_hit(&self) {
        locked(&self.counted).cache_hits.market_overview += 1;
    }

    pub fn screener_status_cache_hit(&self) {
        locked(&self.counted).cache_hits.screener_status += 1;
    }

    pub fn operator_kiwoom_response(&self, now: i64, elapsed: Duration) {
        let mut latency = locked(&self.latency);
        latency.roll(now);
        latency.samples.push(elapsed);
    }

    pub fn snapshot(&self, now: i64) -> UsageSnapshot {
        let counted = locked(&self.counted);
        let mut accounts: Vec<TopAccount> = counted.accounts.iter().map(|(account, requests)| TopAccount { account: account.clone(), requests: *requests }).collect();
        accounts.sort_by(|a, b| b.requests.cmp(&a.requests).then_with(|| a.account.cmp(&b.account)));
        accounts.truncate(10);
        let mut latency = locked(&self.latency);
        latency.roll(now);
        let mut samples = latency.samples.clone();
        let current = summary(latency.minute_started_at, &mut samples);
        UsageSnapshot { since: *locked(&self.since), bundles: counted.bundles.clone(), cache_hits: counted.cache_hits.clone(), top_accounts: accounts, operator_kiwoom_latency: OperatorLatency { current, last_minute: latency.last.clone() } }
    }

    pub fn take_minute_line(&self, now: i64) -> Option<String> {
        let mut counted = locked(&self.counted);
        if std::mem::take(&mut counted.minute_activity) == 0 {
            return None;
        }
        drop(counted);
        let snapshot = self.snapshot(now);
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
        usage.tr_calls(Bundle::Rankings, 5);
        usage.waited(Bundle::Rankings, Duration::ZERO);
        usage.market_cache_hit();
        let snapshot = usage.snapshot(0);
        let rankings = &snapshot.bundles[&Bundle::Rankings];
        assert_eq!((rankings.responses, rankings.too_many_requests, rankings.unavailable, rankings.tr_calls, rankings.wait_max_ms), (3, 1, 1, 5, 0));
        assert_eq!(snapshot.cache_hits.market_overview, 1);
        assert_eq!(snapshot.top_accounts[0], TopAccount { account: "google:a".into(), requests: 2 });
    }

    #[test]
    fn the_minute_line_is_silent_without_public_requests() {
        let usage = Usage::default();
        assert!(usage.take_minute_line(0).is_none());
        usage.response(Bundle::Shared, 200, None);
        assert!(usage.take_minute_line(0).is_some());
        assert!(usage.take_minute_line(0).is_none());
    }

    #[test]
    fn operator_latency_rolls_into_the_last_minute() {
        let usage = Usage::default();
        for ms in [10, 30, 20] {
            usage.operator_kiwoom_response(5, Duration::from_millis(ms));
        }
        let during = usage.snapshot(30).operator_kiwoom_latency;
        assert_eq!((during.current.samples, during.current.p50_ms, during.current.max_ms), (3, 20, 30));
        let after = usage.snapshot(61).operator_kiwoom_latency;
        assert_eq!((after.current.samples, after.last_minute.map(|m| (m.p50_ms, m.max_ms))), (0, Some((20, 30))));
    }
}
