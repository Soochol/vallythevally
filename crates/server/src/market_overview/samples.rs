use std::path::{Path, PathBuf};
use std::sync::Mutex;

use domain::{KstDate, KstTime};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use super::session::observation_day;
use crate::api::Market;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SampleValue {
    Investors { individual_eok: i64, foreign_eok: i64, institution_eok: i64 },
    Program { arbitrage_million_won: i64, non_arbitrage_million_won: i64, total_million_won: i64 },
}

impl SampleValue {
    fn same_kind(&self, other: &SampleValue) -> bool {
        std::mem::discriminant(self) == std::mem::discriminant(other)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sample {
    pub at: i64,
    pub received_at: i64,
    pub market: Market,
    pub value: SampleValue,
}

#[derive(Default)]
struct Today {
    dir: Option<PathBuf>,
    day: Option<KstDate>,
    samples: Vec<Sample>,
}

#[derive(Default)]
pub struct SampleBook {
    today: Mutex<Today>,
}

const FILE_SUFFIX: &str = ".jsonl";

fn file_name(day: KstDate) -> String {
    format!("{}{FILE_SUFFIX}", day.yyyymmdd())
}

fn day_of_file(name: &str) -> Option<KstDate> {
    name.strip_suffix(FILE_SUFFIX).filter(|stem| stem.len() == 8).and_then(KstDate::parse_yyyymmdd)
}

impl SampleBook {
    pub async fn open(&self, dir: PathBuf, now: KstTime) {
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            tracing::error!(path = %dir.display(), error = %e, "시장 표본 폴더를 만들 수 없어 표본을 메모리에만 둡니다");
        } else {
            self.today.lock().expect("표본 잠금").dir = Some(dir);
        }
        self.roll_over(now).await;
    }

    pub async fn roll_over(&self, now: KstTime) {
        let day = observation_day(now);
        let dir = {
            let mut today = self.today.lock().expect("표본 잠금");
            if today.day == Some(day) {
                return;
            }
            today.day = Some(day);
            today.samples.clear();
            today.dir.clone()
        };
        let Some(dir) = dir else { return };
        remove_days_before(&dir, day).await;
        let loaded = read_day(&dir, day).await;
        let mut today = self.today.lock().expect("표본 잠금");
        if today.day == Some(day) {
            today.samples = loaded;
        }
    }

    pub async fn record(&self, now: KstTime, sample: Sample) {
        self.roll_over(now).await;
        let (dir, day) = {
            let mut today = self.today.lock().expect("표본 잠금");
            if today.samples.iter().any(|s| s.at == sample.at && s.market == sample.market && s.value.same_kind(&sample.value)) {
                return;
            }
            today.samples.push(sample.clone());
            (today.dir.clone(), today.day)
        };
        let (Some(dir), Some(day)) = (dir, day) else { return };
        if let Err(e) = append(&dir, day, &sample).await {
            tracing::error!(path = %dir.display(), error = %e, "시장 표본을 파일에 쓰지 못했습니다. 메모리에는 남아 있습니다");
        }
    }

    pub fn samples(&self, now: KstTime, market: Market) -> Vec<Sample> {
        let today = self.today.lock().expect("표본 잠금");
        if today.day != Some(observation_day(now)) {
            return Vec::new();
        }
        let mut samples: Vec<_> = today.samples.iter().filter(|s| s.market == market).cloned().collect();
        samples.sort_by_key(|s| s.at);
        samples
    }
}

async fn remove_days_before(dir: &Path, day: KstDate) {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(e) => {
            tracing::error!(path = %dir.display(), error = %e, "시장 표본 폴더를 읽지 못해 지난날 표본을 지우지 못했습니다");
            return;
        }
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Some(old) = entry.file_name().to_str().and_then(day_of_file).filter(|old| *old < day) else { continue };
        if let Err(e) = tokio::fs::remove_file(entry.path()).await {
            tracing::error!(path = %entry.path().display(), error = %e, "지난날 시장 표본을 지우지 못했습니다");
        } else {
            tracing::info!(day = %old, "지난날 시장 표본을 지웠습니다");
        }
    }
}

async fn read_day(dir: &Path, day: KstDate) -> Vec<Sample> {
    let text = match tokio::fs::read_to_string(dir.join(file_name(day))).await {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            tracing::error!(path = %dir.display(), error = %e, "그날 시장 표본을 읽지 못해 비어 있는 것으로 시작합니다");
            return Vec::new();
        }
    };
    if !text.is_empty() && !text.ends_with('\n') {
        if let Err(e) = terminate_line(dir, day).await {
            tracing::error!(path = %dir.display(), error = %e, "끊긴 마지막 줄을 닫지 못했습니다");
        }
    }
    let mut samples = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        match serde_json::from_str::<Sample>(line) {
            Ok(sample) => samples.push(sample),
            Err(e) => tracing::warn!(error = %e, "읽을 수 없는 표본 줄을 건너뜁니다(쓰다 끊긴 줄일 수 있습니다)"),
        }
    }
    samples
}

async fn terminate_line(dir: &Path, day: KstDate) -> std::io::Result<()> {
    let mut file = tokio::fs::OpenOptions::new().append(true).open(dir.join(file_name(day))).await?;
    file.write_all(b"\n").await?;
    file.flush().await
}

async fn append(dir: &Path, day: KstDate, sample: &Sample) -> std::io::Result<()> {
    let mut line = serde_json::to_string(sample).map_err(std::io::Error::other)?;
    line.push('\n');
    let mut file = tokio::fs::OpenOptions::new().create(true).append(true).open(dir.join(file_name(day))).await?;
    file.write_all(line.as_bytes()).await?;
    file.flush().await
}
