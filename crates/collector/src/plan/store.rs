use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use tempfile::NamedTempFile;

use super::check::check_plan;
use super::model::{FORMAT_VERSION, PlanFile};
use super::PlanError;

const FOLDER: &str = "plan";

pub fn plan_path(data_dir: &Path, date: u32) -> PathBuf {
    data_dir.join(FOLDER).join(format!("{date}.json"))
}

pub fn read_plan(data_dir: &Path, date: u32) -> Result<PlanFile, PlanError> {
    let path = plan_path(data_dir, date);
    let read_error = |cause: String| PlanError::Read { path: path.clone(), cause };
    let bytes = fs::read(&path).map_err(|error| read_error(error.to_string()))?;
    let plan: PlanFile = serde_json::from_slice(&bytes).map_err(|error| read_error(error.to_string()))?;
    if plan.format_version != FORMAT_VERSION {
        return Err(read_error(format!("형식 버전 {}은 지원하지 않습니다", plan.format_version)));
    }
    Ok(plan)
}

pub fn write_plan(data_dir: &Path, plan: &PlanFile) -> Result<(), PlanError> {
    check_plan(plan)?;
    let path = plan_path(data_dir, plan.date);
    let write_error = |cause: io::Error| PlanError::Write { path: path.clone(), cause };
    let mut bytes = serde_json::to_vec_pretty(plan).expect("계획 파일은 언제나 직렬화된다");
    bytes.push(b'\n');
    let folder = path.parent().expect("계획 파일 경로에는 폴더가 있다");
    fs::create_dir_all(folder).map_err(write_error)?;
    let mut temporary = NamedTempFile::new_in(folder).map_err(write_error)?;
    temporary.write_all(&bytes).map_err(write_error)?;
    temporary.flush().map_err(write_error)?;
    temporary.persist_noclobber(&path).map_err(|failure| match failure.error.kind() {
        io::ErrorKind::AlreadyExists => PlanError::AlreadyExists { path: path.clone() },
        _ => write_error(failure.error),
    })?;
    Ok(())
}
