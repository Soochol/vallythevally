use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::Hasher;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use domain::{KstDate, StockCode};

use super::accumulation::{discover_days, hash_day_dir, read_stored_snapshot};
use super::collect::pdf_dir;
use super::history::{Held, compare};
use super::{EtfChangeKind, EtfRecentActivity};
use crate::http::AppState;

#[derive(Debug, Clone, PartialEq, Eq)]
struct ActivityDirStamp {
    days: Vec<KstDate>,
    dir_mtimes: Vec<Option<SystemTime>>,
    latest_fingerprint: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ActivityCacheStamp {
    dir: ActivityDirStamp,
    catalog_revision: u64,
}

struct ActivityCacheEntry {
    stamp: ActivityCacheStamp,
    activities: Arc<HashMap<StockCode, EtfRecentActivity>>,
}

#[derive(Default)]
pub(super) struct RecentActivityCache {
    entry: Mutex<Option<ActivityCacheEntry>>,
}

fn scan_activity_stamp(dir: &Path) -> ActivityDirStamp {
    let days = discover_days(dir);
    if days.len() < 2 {
        return ActivityDirStamp { days, dir_mtimes: Vec::new(), latest_fingerprint: 0 };
    }
    let dir_mtimes = days
        .iter()
        .map(|day| std::fs::metadata(pdf_dir(dir, *day)).ok().and_then(|m| m.modified().ok()))
        .collect();
    let mut hasher = DefaultHasher::new();
    hash_day_dir(&pdf_dir(dir, days[days.len() - 2]), &mut hasher);
    hash_day_dir(&pdf_dir(dir, days[days.len() - 1]), &mut hasher);
    ActivityDirStamp { days, dir_mtimes, latest_fingerprint: hasher.finish() }
}

fn load_latest_pair(dir: &Path, days: &[KstDate], code: StockCode) -> Option<(Vec<Held>, Vec<Held>)> {
    let file_name = format!("{}.json", code.as_str());
    let mut after: Option<Vec<Held>> = None;
    for &day in days.iter().rev() {
        if let Some(snapshot) = read_stored_snapshot(&pdf_dir(dir, day).join(&file_name), code, day) {
            match after.take() {
                None => after = Some(snapshot.holdings),
                Some(latest) => return Some((snapshot.holdings, latest)),
            }
        }
    }
    None
}

fn compute_activities(dir: &Path, days: &[KstDate], codes: &[StockCode]) -> HashMap<StockCode, EtfRecentActivity> {
    let mut map = HashMap::new();
    for &code in codes {
        let Some((before, after)) = load_latest_pair(dir, days, code) else {
            continue;
        };
        let comparison = compare(&before, &after);
        let mut added = 0u32;
        let mut removed = 0u32;
        let mut increased = 0u32;
        let mut decreased = 0u32;
        for row in comparison.rows {
            match row.kind {
                EtfChangeKind::Added => added += 1,
                EtfChangeKind::Removed => removed += 1,
                EtfChangeKind::Increased => increased += 1,
                EtfChangeKind::Decreased => decreased += 1,
                EtfChangeKind::Unchanged => {}
            }
        }
        map.insert(code, EtfRecentActivity { added, removed, increased, decreased });
    }
    map
}

impl RecentActivityCache {
    pub(super) async fn get(&self, st: &AppState) -> Arc<HashMap<StockCode, EtfRecentActivity>> {
        let Some(dir) = st.etf.pdf_dir().map(PathBuf::from) else {
            return Arc::default();
        };
        let scan_dir = dir.clone();
        let dir_stamp = tokio::task::spawn_blocking(move || scan_activity_stamp(&scan_dir))
            .await
            .unwrap_or_else(|_| ActivityDirStamp { days: Vec::new(), dir_mtimes: Vec::new(), latest_fingerprint: 0 });
        let catalog = st.etf.catalog();
        let catalog_revision = st.etf.revision();
        let stamp = ActivityCacheStamp { dir: dir_stamp, catalog_revision };
        if let Some(entry) = self.entry.lock().expect("최근 리밸런싱 캐시 잠금").as_ref()
            && entry.stamp == stamp
        {
            return entry.activities.clone();
        }
        if stamp.dir.days.len() < 2 {
            let empty: Arc<HashMap<StockCode, EtfRecentActivity>> = Arc::default();
            *self.entry.lock().expect("최근 리밸런싱 캐시 잠금") = Some(ActivityCacheEntry { stamp, activities: empty.clone() });
            return empty;
        }
        let days = stamp.dir.days.clone();
        let codes: Vec<StockCode> = catalog.funds().iter().map(|f| f.code).collect();
        let activities = Arc::new(
            tokio::task::spawn_blocking(move || compute_activities(&dir, &days, &codes))
                .await
                .unwrap_or_default(),
        );
        *self.entry.lock().expect("최근 리밸런싱 캐시 잠금") = Some(ActivityCacheEntry { stamp, activities: activities.clone() });
        activities
    }
}
