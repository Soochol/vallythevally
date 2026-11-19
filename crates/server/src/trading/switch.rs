use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::api::{KiwoomEnvironment, MarginPolicy};
use crate::kiwoom::private_file::{FileError, PrivateFile, parse_stamped, render_stamped};

pub const ORDER_SWITCH_FILE_NAME: &str = "kiwoom-orders.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchRecord {
    pub enabled: bool,
    pub salt: String,
    #[serde(default)]
    pub account_ref: Option<String>,
    #[serde(default, rename = "accountNumberTail")]
    pub account_tail: Option<String>,
    #[serde(default, rename = "accountTail", skip_serializing_if = "Option::is_none")]
    pub legacy_product_tail: Option<String>,
    #[serde(default)]
    pub confirm_won: Option<u64>,
    #[serde(default)]
    pub cap_won: Option<u64>,
    #[serde(default)]
    pub margin_policy: MarginPolicy,
}

pub enum SwitchStore {
    File { file: PrivateFile, environment: KiwoomEnvironment },
    Memory(Mutex<Option<SwitchRecord>>),
}

impl SwitchStore {
    pub fn file(file: PrivateFile, environment: KiwoomEnvironment) -> SwitchStore {
        SwitchStore::File { file, environment }
    }

    pub fn memory() -> SwitchStore {
        SwitchStore::Memory(Mutex::new(None))
    }

    pub fn load(&self) -> Result<Option<SwitchRecord>, FileError> {
        match self {
            SwitchStore::Memory(record) => Ok(record.lock().expect("주문 스위치 잠금").clone()),
            SwitchStore::File { file, environment } => {
                let Some(text) = file.read()? else { return Ok(None) };
                let (stored, record): (KiwoomEnvironment, SwitchRecord) = parse_stamped(&text).map_err(|e| file.error(format_args!("JSON {:?} 오류, {}번째 줄", e.classify(), e.line())))?;
                if stored != *environment {
                    return Ok(None);
                }
                if record.salt.is_empty() || (record.enabled && (record.account_ref.is_none() || (record.account_tail.is_none() && record.legacy_product_tail.is_none()))) {
                    return Err(file.error("켜져 있는데 확인한 계좌가 없어 쓰지 않습니다"));
                }
                Ok(Some(record))
            }
        }
    }

    pub fn save(&self, record: &SwitchRecord) -> Result<(), FileError> {
        match self {
            SwitchStore::Memory(slot) => {
                *slot.lock().expect("주문 스위치 잠금") = Some(record.clone());
                Ok(())
            }
            SwitchStore::File { file, environment } => {
                file.read()?;
                if let Some(stored) = file.stored_environment()?
                    && stored != *environment
                {
                    return Err(file.error_for_other_environment(stored, *environment));
                }
                file.write(&render_stamped(*environment, record))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn record(enabled: bool) -> SwitchRecord {
        SwitchRecord { enabled, salt: "00ff".into(), account_ref: Some("ref".into()), account_tail: Some("01".into()), legacy_product_tail: None, confirm_won: None, cap_won: None, margin_policy: MarginPolicy::CashOnly }
    }

    fn open_up(path: &std::path::Path, mode: u32) {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn switch_file_is_private() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        let path = state.join(ORDER_SWITCH_FILE_NAME);
        let store = SwitchStore::file(PrivateFile::new(path.clone()), KiwoomEnvironment::Real);
        assert_eq!(store.load().unwrap(), None);
        store.save(&record(true)).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(&state).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(store.load().unwrap(), Some(record(true)));

        open_up(&path, 0o644);
        assert!(store.load().unwrap_err().to_string().contains("chmod 600"));
        assert!(store.save(&record(false)).is_err());
        open_up(&path, 0o600);
        assert_eq!(store.load().unwrap(), Some(record(true)), "쓰지 않았으므로 그대로다");

        open_up(&state, 0o755);
        assert!(store.load().unwrap_err().to_string().contains("chmod 700"));
        assert!(store.save(&record(false)).is_err());
        open_up(&state, 0o700);
        assert_eq!(store.load().unwrap(), Some(record(true)));
    }

    #[test]
    fn an_open_directory_blocks_the_first_write_too() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        std::fs::create_dir(&state).unwrap();
        open_up(&state, 0o755);
        let store = SwitchStore::file(PrivateFile::new(state.join(ORDER_SWITCH_FILE_NAME)), KiwoomEnvironment::Real);
        assert!(store.save(&record(true)).is_err());
        assert!(!state.join(ORDER_SWITCH_FILE_NAME).exists());
    }

    #[test]
    fn an_enabled_switch_without_a_confirmed_account_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = SwitchStore::file(PrivateFile::new(dir.path().join("s").join(ORDER_SWITCH_FILE_NAME)), KiwoomEnvironment::Real);
        store.save(&SwitchRecord { enabled: true, salt: "00".into(), account_ref: None, account_tail: None, legacy_product_tail: None, confirm_won: None, cap_won: None, margin_policy: MarginPolicy::CashOnly }).unwrap();
        assert!(store.load().is_err());
    }

    #[test]
    fn a_switch_file_from_the_other_environment_reads_as_off() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state").join(ORDER_SWITCH_FILE_NAME);
        let real = SwitchStore::file(PrivateFile::new(path.clone()), KiwoomEnvironment::Real);
        real.save(&record(true)).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("\"environment\":\"real\""));
        let before = std::fs::read(&path).unwrap();

        let mock = SwitchStore::file(PrivateFile::new(path.clone()), KiwoomEnvironment::Mock);
        assert_eq!(mock.load().unwrap(), None, "다른 투자구분의 켜진 스위치는 꺼진 것으로 본다");
        let err = mock.save(&record(true)).unwrap_err().to_string();
        assert!(err.contains("real") && err.contains("mock"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), before, "쓰지 않았으므로 그대로다");
        assert_eq!(real.load().unwrap(), Some(record(true)));
    }

    #[test]
    fn a_switch_file_without_the_environment_mark_is_real() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state").join(ORDER_SWITCH_FILE_NAME);
        let real = SwitchStore::file(PrivateFile::new(path.clone()), KiwoomEnvironment::Real);
        real.save(&record(false)).unwrap();
        let text = std::fs::read_to_string(&path).unwrap().replace("\"environment\":\"real\",", "");
        assert!(!text.contains("environment"));
        std::fs::write(&path, text).unwrap();
        assert_eq!(real.load().unwrap(), Some(record(false)));
        let mock = SwitchStore::file(PrivateFile::new(path), KiwoomEnvironment::Mock);
        assert_eq!(mock.load().unwrap(), None);
    }

    #[test]
    fn a_switch_file_without_a_margin_policy_reads_as_cash_only_and_a_saved_policy_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state").join(ORDER_SWITCH_FILE_NAME);
        let store = SwitchStore::file(PrivateFile::new(path.clone()), KiwoomEnvironment::Real);
        store.save(&record(true)).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let without = text.replace(",\"marginPolicy\":\"cash_only\"", "");
        assert_ne!(without, text, "정책 칸을 지웠다: {text}");
        std::fs::write(&path, without).unwrap();
        assert_eq!(store.load().unwrap().map(|r| r.margin_policy), Some(MarginPolicy::CashOnly));

        store.save(&SwitchRecord { margin_policy: MarginPolicy::AllowMargin, ..record(true) }).unwrap();
        let reopened = SwitchStore::file(PrivateFile::new(path), KiwoomEnvironment::Real);
        assert_eq!(reopened.load().unwrap().map(|r| r.margin_policy), Some(MarginPolicy::AllowMargin));
    }

    #[test]
    fn a_switch_file_with_an_unreadable_environment_mark_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state").join(ORDER_SWITCH_FILE_NAME);
        SwitchStore::file(PrivateFile::new(path.clone()), KiwoomEnvironment::Real).save(&record(true)).unwrap();
        let valid = std::fs::read_to_string(&path).unwrap();
        let unknown = valid.replace("\"environment\":\"real\"", "\"environment\":\"paper\"");
        assert_ne!(unknown, valid);
        for content in [unknown, valid[..valid.len() / 2].to_owned()] {
            std::fs::write(&path, &content).unwrap();
            for environment in [KiwoomEnvironment::Real, KiwoomEnvironment::Mock] {
                let store = SwitchStore::file(PrivateFile::new(path.clone()), environment);
                assert!(store.save(&record(false)).is_err(), "표시를 읽을 수 없으면 쓰지 않는다");
                assert_eq!(std::fs::read_to_string(&path).unwrap(), content, "파일은 그대로다");
            }
        }
    }

    #[test]
    fn a_switch_file_without_the_environment_mark_is_written_by_the_real_process() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state").join(ORDER_SWITCH_FILE_NAME);
        let real = SwitchStore::file(PrivateFile::new(path.clone()), KiwoomEnvironment::Real);
        real.save(&record(false)).unwrap();
        let text = std::fs::read_to_string(&path).unwrap().replace("\"environment\":\"real\",", "");
        std::fs::write(&path, text).unwrap();
        real.save(&record(true)).expect("표시 없는 실전 파일에는 실전 프로세스가 쓴다");
        assert_eq!(real.load().unwrap(), Some(record(true)));
    }
}
