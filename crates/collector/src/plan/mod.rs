use std::fmt;
use std::io;
use std::path::PathBuf;

mod assign;
mod check;
mod model;
mod store;

pub use assign::{PlanInput, build_plan};
pub use check::{Violation, check_plan};
pub use model::{FORMAT_VERSION, InputSummary, KEY_CAPACITY, KeyShare, MARKET_TYPES, PlanFile};
pub use store::{plan_path, read_plan, write_plan};

#[derive(Debug)]
pub enum PlanError {
    NoCollectingKey,
    Violation(Violation),
    AlreadyExists { path: PathBuf },
    Read { path: PathBuf, cause: String },
    Write { path: PathBuf, cause: io::Error },
}

impl fmt::Display for PlanError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PlanError::NoCollectingKey => formatter.write_str("활성 수집 키가 없어 계획을 세울 수 없습니다"),
            PlanError::Violation(violation) => write!(formatter, "계획이 틀렸습니다: {violation}"),
            PlanError::AlreadyExists { path } => write!(formatter, "{}가 이미 있어 덮어쓰지 않습니다", path.display()),
            PlanError::Read { path, cause } => write!(formatter, "{}를 읽을 수 없습니다: {cause}", path.display()),
            PlanError::Write { path, cause } => write!(formatter, "{}를 쓸 수 없습니다: {cause}", path.display()),
        }
    }
}

impl std::error::Error for PlanError {}
