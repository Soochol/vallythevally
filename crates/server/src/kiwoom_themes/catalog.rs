use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use domain::{KstDate, KstTime, StockCode, TimeOfDay, Venue};
use serde::{Deserialize, Serialize};

use super::{WalkFailure, walk};
use crate::api::UnixSeconds;
use crate::clock::next_daily;
use crate::heatmap_board::{KiwoomCatalogInfo, KiwoomCatalogState};
use crate::http::AppState;
use crate::kiwoom::api::{ThemeGroups, ThemeMembers};
use crate::kiwoom::rest::{Access, KiwoomRest, Priority};

pub const CATALOG_AT: TimeOfDay = match TimeOfDay::hms(8, 30, 0) {
    Some(at) => at,
    None => panic!("08:30은 시각이다"),
};
const RETRY_SECS: i64 = 300;
const CATALOG_PERIOD_DAYS: u8 = 1;
const FILE_SUFFIX: &str = ".json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredTheme {
    pub code: String,
    pub name: String,
    pub members: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredCatalog {
    pub date: String,
    pub collected_at: i64,
    pub themes: Vec<StoredTheme>,
}

impl StoredCatalog {
    fn day(&self) -> Option<KstDate> {
        KstDate::parse_yyyymmdd(&self.date)
    }
}

#[derive(Default)]
struct Inner {
    dir: Option<PathBuf>,
    latest: Option<Arc<StoredCatalog>>,
    collecting: bool,
}

#[derive(Default)]
pub struct CatalogStore {
    inner: Mutex<Inner>,
}

fn file_day(path: &Path) -> Option<KstDate> {
    path.file_name()?.to_str()?.strip_suffix(FILE_SUFFIX).and_then(KstDate::parse_yyyymmdd)
}

fn newest_in(dir: &Path) -> Option<StoredCatalog> {
    let mut files: Vec<(KstDate, PathBuf)> = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).filter_map(|p| file_day(&p).map(|day| (day, p))).collect();
    files.sort_by_key(|(day, _)| *day);
    files.into_iter().rev().find_map(|(_, path)| match std::fs::read(&path).map_err(|e| e.to_string()).and_then(|bytes| serde_json::from_slice::<StoredCatalog>(&bytes).map_err(|e| e.to_string())) {
        Ok(catalog) => Some(catalog),
        Err(reason) => {
            tracing::warn!(path = %path.display(), %reason, "키움 테마 구성종목 파일을 읽지 못해 건너뜁니다");
            None
        }
    })
}

impl CatalogStore {
    pub fn open(&self, dir: PathBuf) {
        let latest = newest_in(&dir).map(Arc::new);
        let mut inner = self.inner.lock().expect("키움 테마 구성종목 잠금");
        inner.dir = Some(dir);
        inner.latest = latest;
    }

    pub fn latest(&self) -> Option<Arc<StoredCatalog>> {
        self.inner.lock().expect("키움 테마 구성종목 잠금").latest.clone()
    }

    pub fn info(&self) -> KiwoomCatalogInfo {
        let inner = self.inner.lock().expect("키움 테마 구성종목 잠금");
        let state = match (&inner.latest, inner.collecting) {
            (Some(_), _) => KiwoomCatalogState::Ready,
            (None, true) => KiwoomCatalogState::Collecting,
            (None, false) => KiwoomCatalogState::Empty,
        };
        let latest = inner.latest.as_deref();
        KiwoomCatalogInfo {
            date: latest.and_then(StoredCatalog::day).map(crate::api::KstDate),
            collected_at: latest.map(|c| UnixSeconds(c.collected_at)),
            themes: latest.map_or(0, |c| u32::try_from(c.themes.len()).unwrap_or(u32::MAX)),
            state,
        }
    }

    fn collecting(&self, on: bool) {
        self.inner.lock().expect("키움 테마 구성종목 잠금").collecting = on;
    }

    fn keep(&self, catalog: StoredCatalog) -> std::io::Result<()> {
        let dir = self.inner.lock().expect("키움 테마 구성종목 잠금").dir.clone();
        if let Some(dir) = dir {
            std::fs::create_dir_all(&dir)?;
            let path = dir.join(format!("{}{FILE_SUFFIX}", catalog.date));
            let partial = dir.join(format!(".{}{FILE_SUFFIX}.partial", catalog.date));
            std::fs::write(&partial, serde_json::to_vec(&catalog).expect("구성종목은 언제나 직렬화된다"))?;
            std::fs::rename(&partial, &path)?;
        }
        self.inner.lock().expect("키움 테마 구성종목 잠금").latest = Some(Arc::new(catalog));
        Ok(())
    }

    fn has_day(&self, day: KstDate) -> bool {
        self.latest().and_then(|c| c.day()) == Some(day)
    }
}

pub async fn collect(rest: &KiwoomRest, now: KstTime, previous: Option<&StoredCatalog>) -> Result<StoredCatalog, WalkFailure> {
    let request = ThemeGroups::by_change_rate(CATALOG_PERIOD_DAYS, Venue::Combined).expect("1일은 기간 범위 안이다");
    let groups = walk(rest, &request, Priority::Background).await?;
    let mut seen = std::collections::BTreeSet::new();
    let mut themes = Vec::new();
    let mut fallback = 0;
    for row in groups.bodies.iter().flat_map(|body| body.rows().rows) {
        if !seen.insert(row.code.clone()) {
            continue;
        }
        let Some(request) = ThemeMembers::new(&row.code, CATALOG_PERIOD_DAYS, Venue::Combined) else {
            tracing::warn!(code = %row.code, "키움 테마코드 모양이 달라 구성종목을 묻지 않습니다");
            continue;
        };
        let members = match walk(rest, &request, Priority::Background).await {
            Ok(walked) => {
                let mut codes: Vec<String> = Vec::new();
                for member in walked.bodies.iter().flat_map(|body| body.rows().rows) {
                    let code = member.code.as_str().to_owned();
                    if !codes.contains(&code) {
                        codes.push(code);
                    }
                }
                Some(codes)
            }
            Err(reason) => {
                fallback += 1;
                tracing::warn!(code = %row.code, ?reason, "키움 테마 구성종목을 받지 못해 지난 구성종목을 씁니다");
                previous.and_then(|p| p.themes.iter().find(|t| t.code == row.code)).map(|t| t.members.clone())
            }
        };
        if let Some(members) = members {
            themes.push(StoredTheme { code: row.code, name: row.name, members });
        }
    }
    tracing::info!(themes = themes.len(), fallback, complete = groups.complete, "키움 테마 구성종목을 받았습니다");
    Ok(StoredCatalog { date: now.kst_date().yyyymmdd(), collected_at: now.unix(), themes })
}

pub fn members_of(theme: &StoredTheme) -> Vec<StockCode> {
    theme.members.iter().filter_map(|code| StockCode::parse(code).ok()).collect()
}

fn due(now: KstTime, store: &CatalogStore) -> bool {
    now.kst_time_of_day() >= CATALOG_AT && !store.has_day(now.kst_date())
}

pub fn start_collection(st: Arc<AppState>, dir: PathBuf) -> tokio::task::JoinHandle<()> {
    st.kiwoom_catalog.open(dir);
    tokio::spawn(async move {
        loop {
            let now = st.clock.now();
            if due(now, &st.kiwoom_catalog) {
                let open = st.kiwoom.rest().ok().filter(|rest| rest.access() == Access::Open).cloned();
                match open {
                    Some(rest) => {
                        st.kiwoom_catalog.collecting(true);
                        let previous = st.kiwoom_catalog.latest();
                        let outcome = collect(&rest, now, previous.as_deref()).await;
                        st.kiwoom_catalog.collecting(false);
                        match outcome {
                            Ok(catalog) => {
                                if let Err(e) = st.kiwoom_catalog.keep(catalog) {
                                    tracing::warn!(error = %e, "키움 테마 구성종목을 파일에 쓰지 못했습니다. 메모리의 것만 씁니다");
                                }
                            }
                            Err(reason) => {
                                tracing::warn!(?reason, "키움 테마 목록을 받지 못했습니다. 지난 구성종목을 그대로 씁니다");
                                st.clock.sleep_until(KstTime::from_unix(st.clock.now().unix() + RETRY_SECS)).await;
                                continue;
                            }
                        }
                    }
                    None => {
                        st.clock.sleep_until(KstTime::from_unix(st.clock.now().unix() + RETRY_SECS)).await;
                        continue;
                    }
                }
            }
            st.clock.sleep_until(next_daily(st.clock.now(), CATALOG_AT)).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::kst;

    fn catalog(date: &str, codes: &[&str]) -> StoredCatalog {
        StoredCatalog { date: date.into(), collected_at: 1, themes: codes.iter().map(|c| StoredTheme { code: (*c).into(), name: format!("테마 {c}"), members: vec!["005930".into()] }).collect() }
    }

    #[test]
    fn the_store_opens_the_newest_readable_file_and_reports_its_day() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("20261120.json"), serde_json::to_vec(&catalog("20261120", &["1"])).unwrap()).unwrap();
        std::fs::write(tmp.path().join("20261121.json"), serde_json::to_vec(&catalog("20261121", &["1", "2"])).unwrap()).unwrap();
        std::fs::write(tmp.path().join("20261122.json"), b"{broken").unwrap();
        std::fs::write(tmp.path().join("notes.txt"), b"x").unwrap();
        let store = CatalogStore::default();
        store.open(tmp.path().to_owned());
        let info = store.info();
        assert_eq!((info.date.map(|d| d.0.yyyymmdd()), info.themes, info.state), (Some("20261121".to_owned()), 2, KiwoomCatalogState::Ready));
    }

    #[test]
    fn an_empty_store_is_empty_or_collecting_and_keeping_writes_the_days_file() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CatalogStore::default();
        store.open(tmp.path().join("kiwoom-themes"));
        assert_eq!(store.info().state, KiwoomCatalogState::Empty);
        store.collecting(true);
        assert_eq!(store.info().state, KiwoomCatalogState::Collecting);
        store.keep(catalog("20261123", &["319"])).unwrap();
        store.collecting(false);
        assert_eq!(store.info().state, KiwoomCatalogState::Ready);
        let reopened = CatalogStore::default();
        reopened.open(tmp.path().join("kiwoom-themes"));
        assert_eq!(reopened.latest().unwrap().themes[0].code, "319");
        assert!(!tmp.path().join("kiwoom-themes/.20261123.json.partial").exists());
    }

    #[test]
    fn collection_is_due_after_half_past_eight_until_the_days_file_exists() {
        let store = CatalogStore::default();
        let day = KstDate::new(2026, 11, 23).unwrap();
        assert!(!due(kst(day, 8, 29, 59), &store));
        assert!(due(kst(day, 8, 30, 0), &store));
        store.keep(catalog("20261123", &["1"])).unwrap();
        assert!(!due(kst(day, 15, 0, 0), &store));
        assert!(due(kst(day.add_days(1), 9, 0, 0), &store));
    }

    #[test]
    fn member_codes_that_are_not_stock_codes_are_dropped() {
        let theme = StoredTheme { code: "1".into(), name: "가".into(), members: vec!["005930".into(), "IDX:001".into(), "bad".into(), "0158S0".into()] };
        assert_eq!(members_of(&theme).iter().map(|c| c.as_str().to_owned()).collect::<Vec<_>>(), ["005930", "0158S0"]);
    }
}
