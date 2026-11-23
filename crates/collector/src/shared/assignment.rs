use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use server::shared_data::Broker;

use super::JobName;
use crate::keys::{ActiveKey, KeyRole};
use crate::protocol::KeyName;

pub const ASSIGNMENT_VERSION: u32 = 1;
const LAST_GOOD_FILE: &str = "shared-assignment.last.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyOptions {
    #[serde(default)]
    pub total_per_second: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AssignmentFile {
    version: u32,
    #[serde(default)]
    keys: BTreeMap<String, KeyOptions>,
    jobs: BTreeMap<JobName, JobEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct JobEntry {
    keys: Vec<String>,
    #[serde(default)]
    period_secs: Option<u64>,
    #[serde(default)]
    options: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssignedJob {
    pub job: JobName,
    pub slice_index: u32,
    pub slice_count: u32,
    pub period_secs: u64,
    pub options: Value,
    #[serde(default)]
    pub peers: Vec<Broker>,
}

#[derive(Debug, Clone, PartialEq)]
struct JobPlan {
    keys: Vec<KeyName>,
    brokers: Vec<Broker>,
    period: Duration,
    options: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Assignment {
    jobs: BTreeMap<JobName, JobPlan>,
    key_options: BTreeMap<KeyName, KeyOptions>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssignmentError {
    Unreadable { path: PathBuf, kind: io::ErrorKind },
    Malformed { path: PathBuf, detail: String },
    UnsupportedVersion(u32),
    UnknownKey { place: String, key: String },
    NotRestKey { place: String, key: KeyName },
    WrongBroker { job: JobName, key: KeyName, broker: Broker },
    NoKeys(JobName),
    DuplicateKey { job: JobName, key: KeyName },
    BadPeriod(JobName),
    BadOptions { job: JobName, detail: String },
    BadTotalPerSecond(KeyName),
}

impl std::fmt::Display for AssignmentError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AssignmentError::Unreadable { path, kind } => write!(formatter, "키 배정표를 읽을 수 없습니다({}): {kind}", path.display()),
            AssignmentError::Malformed { path, detail } => write!(formatter, "키 배정표 형식이 틀렸습니다({}): {detail}", path.display()),
            AssignmentError::UnsupportedVersion(version) => write!(formatter, "키 배정표의 형식 버전 {version}은 지원하지 않습니다"),
            AssignmentError::UnknownKey { place, key } => write!(formatter, "{place}의 키 {key:?}가 키 목록에 없거나 활성이 아닙니다"),
            AssignmentError::NotRestKey { place, key } => write!(formatter, "{place}의 키 {key}는 역할이 rest가 아닙니다. 공용 자료는 rest 키만 맡습니다"),
            AssignmentError::WrongBroker { job, key, broker } => write!(formatter, "일 {job:?}은 {broker:?} 키 {key}를 받지 않습니다"),
            AssignmentError::NoKeys(job) => write!(formatter, "일 {job:?}에 키가 없습니다"),
            AssignmentError::DuplicateKey { job, key } => write!(formatter, "일 {job:?}에 키 {key}가 두 번 적혀 있습니다"),
            AssignmentError::BadPeriod(job) => write!(formatter, "일 {job:?}의 period_secs는 1 이상이어야 합니다"),
            AssignmentError::BadOptions { job, detail } => write!(formatter, "일 {job:?}의 options가 틀렸습니다: {detail}"),
            AssignmentError::BadTotalPerSecond(key) => write!(formatter, "키 {key}의 total_per_second는 1 이상이어야 합니다"),
        }
    }
}

impl std::error::Error for AssignmentError {}

impl Assignment {
    pub fn parse(text: &str, path: &Path, keys: &[ActiveKey]) -> Result<Assignment, AssignmentError> {
        let file: AssignmentFile = serde_json::from_str(text).map_err(|error| AssignmentError::Malformed { path: path.to_owned(), detail: format!("JSON {:?} 오류, {}번째 줄: {error}", error.classify(), error.line()) })?;
        if file.version != ASSIGNMENT_VERSION {
            return Err(AssignmentError::UnsupportedVersion(file.version));
        }
        let rest_key = |place: &str, name: &str| -> Result<&ActiveKey, AssignmentError> {
            let key = keys.iter().find(|key| key.identity.name.as_str() == name).ok_or_else(|| AssignmentError::UnknownKey { place: place.to_owned(), key: name.to_owned() })?;
            match key.identity.role {
                KeyRole::Rest => Ok(key),
                _ => Err(AssignmentError::NotRestKey { place: place.to_owned(), key: key.identity.name.clone() }),
            }
        };
        let mut key_options = BTreeMap::new();
        for (name, options) in &file.keys {
            let key = rest_key("keys", name)?;
            if options.total_per_second == Some(0) {
                return Err(AssignmentError::BadTotalPerSecond(key.identity.name.clone()));
            }
            key_options.insert(key.identity.name.clone(), *options);
        }
        let mut jobs = BTreeMap::new();
        for (job, entry) in file.jobs {
            if entry.keys.is_empty() {
                return Err(AssignmentError::NoKeys(job));
            }
            let shared_job = job.job();
            let period_secs = entry.period_secs.unwrap_or_else(|| shared_job.default_period_secs());
            if period_secs == 0 {
                return Err(AssignmentError::BadPeriod(job));
            }
            shared_job.check_options(&entry.options).map_err(|detail| AssignmentError::BadOptions { job, detail })?;
            let mut names: Vec<KeyName> = Vec::new();
            let mut brokers: Vec<Broker> = Vec::new();
            for name in &entry.keys {
                let key = rest_key(&format!("일 {job:?}"), name)?;
                if !shared_job.brokers().contains(&key.broker) {
                    return Err(AssignmentError::WrongBroker { job, key: key.identity.name.clone(), broker: key.broker });
                }
                if names.contains(&key.identity.name) {
                    return Err(AssignmentError::DuplicateKey { job, key: key.identity.name.clone() });
                }
                names.push(key.identity.name.clone());
                brokers.push(key.broker);
            }
            jobs.insert(job, JobPlan { keys: names, brokers, period: Duration::from_secs(period_secs), options: entry.options });
        }
        Ok(Assignment { jobs, key_options })
    }

    pub fn total_per_second(&self, key: &KeyName) -> Option<u32> {
        self.key_options.get(key).and_then(|options| options.total_per_second)
    }

    pub fn is_empty(&self) -> bool {
        self.jobs.is_empty()
    }

    pub fn keys_in_use(&self) -> BTreeSet<KeyName> {
        self.jobs.values().flat_map(|plan| plan.keys.iter().cloned()).collect()
    }

    pub fn jobs_of(&self, down: &BTreeSet<KeyName>) -> BTreeMap<KeyName, Vec<AssignedJob>> {
        let mut by_key: BTreeMap<KeyName, Vec<AssignedJob>> = BTreeMap::new();
        for (job, plan) in &self.jobs {
            let live: Vec<&KeyName> = plan.keys.iter().filter(|key| !down.contains(*key)).collect();
            let peers: Vec<Broker> = plan.keys.iter().zip(&plan.brokers).filter(|(key, _)| !down.contains(*key)).map(|(_, broker)| *broker).collect();
            for (index, key) in live.iter().enumerate() {
                by_key.entry((*key).clone()).or_default().push(AssignedJob {
                    job: *job,
                    slice_index: index as u32,
                    slice_count: live.len() as u32,
                    period_secs: plan.period.as_secs(),
                    options: plan.options.clone(),
                    peers: peers.clone(),
                });
            }
        }
        by_key
    }

    pub fn unserved(&self, down: &BTreeSet<KeyName>) -> Vec<JobName> {
        self.jobs.iter().filter(|(_, plan)| plan.keys.iter().all(|key| down.contains(key))).map(|(job, _)| *job).collect()
    }

    pub fn next_key_of(&self, job: JobName, after: &KeyName, down: &BTreeSet<KeyName>) -> Option<KeyName> {
        let plan = self.jobs.get(&job)?;
        let position = plan.keys.iter().position(|key| key == after)?;
        plan.keys.iter().cycle().skip(position + 1).take(plan.keys.len()).find(|key| *key != after && !down.contains(*key)).cloned()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Reload {
    NoFile,
    Loaded,
    KeptPrevious(AssignmentError),
    Unusable(AssignmentError),
}

pub struct AssignmentStore {
    path: PathBuf,
    last_good_path: PathBuf,
    current: Option<Assignment>,
}

impl AssignmentStore {
    pub fn new(path: PathBuf, data_dir: &Path) -> AssignmentStore {
        AssignmentStore { path, last_good_path: data_dir.join("plan").join(LAST_GOOD_FILE), current: None }
    }

    pub fn current(&self) -> Option<&Assignment> {
        self.current.as_ref()
    }

    pub fn reload(&mut self, keys: &[ActiveKey]) -> Reload {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.current = None;
                return Reload::NoFile;
            }
            Err(error) => return self.fall_back(AssignmentError::Unreadable { path: self.path.clone(), kind: error.kind() }, keys),
        };
        match Assignment::parse(&text, &self.path, keys) {
            Ok(assignment) => {
                self.remember(&text);
                self.current = Some(assignment);
                Reload::Loaded
            }
            Err(error) => self.fall_back(error, keys),
        }
    }

    fn fall_back(&mut self, error: AssignmentError, keys: &[ActiveKey]) -> Reload {
        if self.current.is_none() {
            self.current = std::fs::read_to_string(&self.last_good_path).ok().and_then(|text| Assignment::parse(&text, &self.last_good_path, keys).ok());
        }
        match self.current {
            Some(_) => Reload::KeptPrevious(error),
            None => Reload::Unusable(error),
        }
    }

    fn remember(&self, text: &str) {
        let Some(folder) = self.last_good_path.parent() else { return };
        let temporary = self.last_good_path.with_extension("tmp");
        let written = std::fs::create_dir_all(folder).and_then(|()| std::fs::write(&temporary, text)).and_then(|()| std::fs::rename(&temporary, &self.last_good_path));
        if let Err(error) = written {
            tracing::warn!(path = %self.last_good_path.display(), %error, "직전 배정표 사본을 쓰지 못했습니다");
        }
    }
}
