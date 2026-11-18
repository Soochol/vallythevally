use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::kiwoom::private_file::{FileError, PrivateFile};

pub const ORDER_SWITCH_FILE_NAME: &str = "kiwoom-orders.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchRecord {
    pub enabled: bool,
    pub salt: String,
    #[serde(default)]
    pub account_ref: Option<String>,
    #[serde(default)]
    pub account_tail: Option<String>,
    #[serde(default)]
    pub confirm_won: Option<u64>,
    #[serde(default)]
    pub cap_won: Option<u64>,
}

pub enum SwitchStore {
    File(PrivateFile),
    Memory(Mutex<Option<SwitchRecord>>),
}

impl SwitchStore {
    pub fn file(file: PrivateFile) -> SwitchStore {
        SwitchStore::File(file)
    }

    pub fn memory() -> SwitchStore {
        SwitchStore::Memory(Mutex::new(None))
    }

    pub fn load(&self) -> Result<Option<SwitchRecord>, FileError> {
        match self {
            SwitchStore::Memory(record) => Ok(record.lock().expect("주문 스위치 잠금").clone()),
            SwitchStore::File(file) => {
                let Some(text) = file.read()? else { return Ok(None) };
                let record: SwitchRecord = serde_json::from_str(&text).map_err(|e| file.error(format_args!("JSON {:?} 오류, {}번째 줄", e.classify(), e.line())))?;
                if record.salt.is_empty() || (record.enabled && (record.account_ref.is_none() || record.account_tail.is_none())) {
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
            SwitchStore::File(file) => {
                file.read()?;
                file.write(&serde_json::to_vec(record).expect("문자열과 불리언만 담은 구조체"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn record(enabled: bool) -> SwitchRecord {
        SwitchRecord { enabled, salt: "00ff".into(), account_ref: Some("ref".into()), account_tail: Some("01".into()), confirm_won: None, cap_won: None }
    }

    fn open_up(path: &std::path::Path, mode: u32) {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn switch_file_is_private() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        let path = state.join(ORDER_SWITCH_FILE_NAME);
        let store = SwitchStore::file(PrivateFile::new(path.clone()));
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
        let store = SwitchStore::file(PrivateFile::new(state.join(ORDER_SWITCH_FILE_NAME)));
        assert!(store.save(&record(true)).is_err());
        assert!(!state.join(ORDER_SWITCH_FILE_NAME).exists());
    }

    #[test]
    fn an_enabled_switch_without_a_confirmed_account_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = SwitchStore::file(PrivateFile::new(dir.path().join("s").join(ORDER_SWITCH_FILE_NAME)));
        store.save(&SwitchRecord { enabled: true, salt: "00".into(), account_ref: None, account_tail: None, confirm_won: None, cap_won: None }).unwrap();
        assert!(store.load().is_err());
    }
}
