use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::api::{KiwoomEnvironment, MarginPolicy};
use crate::kiwoom::key_file::KeyId;
use crate::kiwoom::private_file::{FileError, PrivateFile, parse_stamped, render_stamped};

pub const ORDER_SWITCH_FILE_NAME: &str = "kiwoom-orders.json";
const UNOWNED_LEGACY_KEY: &str = "market";

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

impl SwitchRecord {
    fn is_usable(&self) -> bool {
        !self.salt.is_empty() && !(self.enabled && (self.account_ref.is_none() || (self.account_tail.is_none() && self.legacy_product_tail.is_none())))
    }
}

#[derive(Serialize, Deserialize)]
struct KeyedRecords {
    keys: BTreeMap<String, SwitchRecord>,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum StoredRecords {
    Keyed(KeyedRecords),
    Legacy(SwitchRecord),
}

enum Backing {
    File { file: PrivateFile, environment: KiwoomEnvironment },
    Memory(Mutex<BTreeMap<String, SwitchRecord>>),
}

pub struct SwitchStore {
    backing: Backing,
    legacy_owner: Mutex<Option<KeyId>>,
    writing: Mutex<()>,
}

impl SwitchStore {
    pub fn file(file: PrivateFile, environment: KiwoomEnvironment) -> SwitchStore {
        SwitchStore { backing: Backing::File { file, environment }, legacy_owner: Mutex::new(None), writing: Mutex::new(()) }
    }

    pub fn memory() -> SwitchStore {
        SwitchStore { backing: Backing::Memory(Mutex::new(BTreeMap::new())), legacy_owner: Mutex::new(None), writing: Mutex::new(()) }
    }

    pub fn claim_legacy(&self, key: &KeyId) {
        self.legacy_owner.lock().expect("옛 스위치 주인 잠금").get_or_insert_with(|| key.clone());
    }

    fn legacy_key(&self) -> String {
        self.legacy_owner.lock().expect("옛 스위치 주인 잠금").as_ref().map_or_else(|| UNOWNED_LEGACY_KEY.to_owned(), |key| key.as_str().to_owned())
    }

    fn read_records(&self) -> Result<BTreeMap<String, SwitchRecord>, FileError> {
        match &self.backing {
            Backing::Memory(records) => Ok(records.lock().expect("주문 스위치 잠금").clone()),
            Backing::File { file, environment } => {
                let Some(text) = file.read()? else { return Ok(BTreeMap::new()) };
                let (stored, records): (KiwoomEnvironment, StoredRecords) = parse_stamped(&text).map_err(|e| file.error(format_args!("JSON {:?} 오류, {}번째 줄", e.classify(), e.line())))?;
                if stored != *environment {
                    return Ok(BTreeMap::new());
                }
                Ok(match records {
                    StoredRecords::Keyed(keyed) => keyed.keys,
                    StoredRecords::Legacy(record) => BTreeMap::from([(self.legacy_key(), record)]),
                })
            }
        }
    }

    pub fn load(&self, key: &KeyId) -> Result<Option<SwitchRecord>, FileError> {
        let Some(record) = self.read_records()?.remove(key.as_str()) else { return Ok(None) };
        if !record.is_usable() {
            return Err(self.problem("켜져 있는데 확인한 계좌가 없어 쓰지 않습니다"));
        }
        Ok(Some(record))
    }

    pub fn records(&self) -> Result<Vec<(String, SwitchRecord)>, FileError> {
        Ok(self.read_records()?.into_iter().filter(|(_, record)| record.is_usable()).collect())
    }

    pub fn shared_salt(&self) -> Result<Option<String>, FileError> {
        Ok(self.read_records()?.into_values().map(|record| record.salt).find(|salt| !salt.is_empty()))
    }

    fn problem(&self, what: &str) -> FileError {
        match &self.backing {
            Backing::File { file, .. } => file.error(what),
            Backing::Memory(_) => PrivateFile::new(std::path::PathBuf::from(ORDER_SWITCH_FILE_NAME)).error(what),
        }
    }

    pub fn save(&self, key: &KeyId, record: &SwitchRecord) -> Result<(), FileError> {
        self.update(|records| {
            records.insert(key.as_str().to_owned(), record.clone());
        })
    }

    pub fn switch_off_except(&self, present: &[KeyId]) -> Result<(), FileError> {
        let records = self.read_records()?;
        if records.iter().all(|(key, record)| !record.enabled || present.iter().any(|present| present.as_str() == key)) {
            return Ok(());
        }
        self.update(|records| {
            for (key, record) in records.iter_mut() {
                if record.enabled && !present.iter().any(|present| present.as_str() == key) {
                    record.enabled = false;
                }
            }
        })
    }

    fn update(&self, change: impl FnOnce(&mut BTreeMap<String, SwitchRecord>)) -> Result<(), FileError> {
        let _writing = self.writing.lock().expect("스위치 쓰기 잠금");
        match &self.backing {
            Backing::Memory(slot) => {
                change(&mut slot.lock().expect("주문 스위치 잠금"));
                Ok(())
            }
            Backing::File { file, environment } => {
                let mut records = self.read_records()?;
                if let Some(stored) = file.stored_environment()?
                    && stored != *environment
                {
                    return Err(file.error_for_other_environment(stored, *environment));
                }
                change(&mut records);
                file.write(&render_stamped(*environment, &StoredRecords::Keyed(KeyedRecords { keys: records })))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn key() -> KeyId {
        KeyId::env()
    }

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
        assert_eq!(store.load(&key()).unwrap(), None);
        store.save(&key(), &record(true)).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(&state).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(store.load(&key()).unwrap(), Some(record(true)));

        open_up(&path, 0o644);
        assert!(store.load(&key()).unwrap_err().to_string().contains("chmod 600"));
        assert!(store.save(&key(), &record(false)).is_err());
        open_up(&path, 0o600);
        assert_eq!(store.load(&key()).unwrap(), Some(record(true)), "쓰지 않았으므로 그대로다");

        open_up(&state, 0o755);
        assert!(store.load(&key()).unwrap_err().to_string().contains("chmod 700"));
        assert!(store.save(&key(), &record(false)).is_err());
        open_up(&state, 0o700);
        assert_eq!(store.load(&key()).unwrap(), Some(record(true)));
    }

    #[test]
    fn an_open_directory_blocks_the_first_write_too() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        std::fs::create_dir(&state).unwrap();
        open_up(&state, 0o755);
        let store = SwitchStore::file(PrivateFile::new(state.join(ORDER_SWITCH_FILE_NAME)), KiwoomEnvironment::Real);
        assert!(store.save(&key(), &record(true)).is_err());
        assert!(!state.join(ORDER_SWITCH_FILE_NAME).exists());
    }

    #[test]
    fn an_enabled_switch_without_a_confirmed_account_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = SwitchStore::file(PrivateFile::new(dir.path().join("s").join(ORDER_SWITCH_FILE_NAME)), KiwoomEnvironment::Real);
        store.save(&key(), &SwitchRecord { enabled: true, salt: "00".into(), account_ref: None, account_tail: None, legacy_product_tail: None, confirm_won: None, cap_won: None, margin_policy: MarginPolicy::CashOnly }).unwrap();
        assert!(store.load(&key()).is_err());
    }

    #[test]
    fn a_switch_file_from_the_other_environment_reads_as_off() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state").join(ORDER_SWITCH_FILE_NAME);
        let real = SwitchStore::file(PrivateFile::new(path.clone()), KiwoomEnvironment::Real);
        real.save(&key(), &record(true)).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("\"environment\":\"real\""));
        let before = std::fs::read(&path).unwrap();

        let mock = SwitchStore::file(PrivateFile::new(path.clone()), KiwoomEnvironment::Mock);
        assert_eq!(mock.load(&key()).unwrap(), None, "다른 투자구분의 켜진 스위치는 꺼진 것으로 본다");
        let err = mock.save(&key(), &record(true)).unwrap_err().to_string();
        assert!(err.contains("real") && err.contains("mock"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), before, "쓰지 않았으므로 그대로다");
        assert_eq!(real.load(&key()).unwrap(), Some(record(true)));
    }

    #[test]
    fn a_switch_file_without_the_environment_mark_is_real() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state").join(ORDER_SWITCH_FILE_NAME);
        let real = SwitchStore::file(PrivateFile::new(path.clone()), KiwoomEnvironment::Real);
        real.save(&key(), &record(false)).unwrap();
        let text = std::fs::read_to_string(&path).unwrap().replace("\"environment\":\"real\",", "");
        assert!(!text.contains("environment"));
        std::fs::write(&path, text).unwrap();
        assert_eq!(real.load(&key()).unwrap(), Some(record(false)));
        let mock = SwitchStore::file(PrivateFile::new(path), KiwoomEnvironment::Mock);
        assert_eq!(mock.load(&key()).unwrap(), None);
    }

    #[test]
    fn a_switch_file_without_a_margin_policy_reads_as_cash_only_and_a_saved_policy_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state").join(ORDER_SWITCH_FILE_NAME);
        let store = SwitchStore::file(PrivateFile::new(path.clone()), KiwoomEnvironment::Real);
        store.save(&key(), &record(true)).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let without = text.replace(",\"marginPolicy\":\"cash_only\"", "");
        assert_ne!(without, text, "정책 칸을 지웠다: {text}");
        std::fs::write(&path, without).unwrap();
        assert_eq!(store.load(&key()).unwrap().map(|r| r.margin_policy), Some(MarginPolicy::CashOnly));

        store.save(&key(), &SwitchRecord { margin_policy: MarginPolicy::AllowMargin, ..record(true) }).unwrap();
        let reopened = SwitchStore::file(PrivateFile::new(path), KiwoomEnvironment::Real);
        assert_eq!(reopened.load(&key()).unwrap().map(|r| r.margin_policy), Some(MarginPolicy::AllowMargin));
    }

    #[test]
    fn a_switch_file_with_an_unreadable_environment_mark_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state").join(ORDER_SWITCH_FILE_NAME);
        SwitchStore::file(PrivateFile::new(path.clone()), KiwoomEnvironment::Real).save(&key(), &record(true)).unwrap();
        let valid = std::fs::read_to_string(&path).unwrap();
        let unknown = valid.replace("\"environment\":\"real\"", "\"environment\":\"paper\"");
        assert_ne!(unknown, valid);
        for content in [unknown, valid[..valid.len() / 2].to_owned()] {
            std::fs::write(&path, &content).unwrap();
            for environment in [KiwoomEnvironment::Real, KiwoomEnvironment::Mock] {
                let store = SwitchStore::file(PrivateFile::new(path.clone()), environment);
                assert!(store.save(&key(), &record(false)).is_err(), "표시를 읽을 수 없으면 쓰지 않는다");
                assert_eq!(std::fs::read_to_string(&path).unwrap(), content, "파일은 그대로다");
            }
        }
    }

    #[test]
    fn a_switch_file_without_the_environment_mark_is_written_by_the_real_process() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state").join(ORDER_SWITCH_FILE_NAME);
        let real = SwitchStore::file(PrivateFile::new(path.clone()), KiwoomEnvironment::Real);
        real.save(&key(), &record(false)).unwrap();
        let text = std::fs::read_to_string(&path).unwrap().replace("\"environment\":\"real\",", "");
        std::fs::write(&path, text).unwrap();
        real.save(&key(), &record(true)).expect("표시 없는 실전 파일에는 실전 프로세스가 쓴다");
        assert_eq!(real.load(&key()).unwrap(), Some(record(true)));
    }

    #[test]
    fn a_legacy_single_record_belongs_to_the_claiming_key_and_the_next_save_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state").join(ORDER_SWITCH_FILE_NAME);
        SwitchStore::file(PrivateFile::new(path.clone()), KiwoomEnvironment::Real).save(&key(), &record(false)).unwrap();
        std::fs::write(&path, r#"{"environment":"real","enabled":true,"salt":"00ff","accountRef":"ref","accountNumberTail":"01","marginPolicy":"cash_only"}"#).unwrap();

        let store = SwitchStore::file(PrivateFile::new(path.clone()), KiwoomEnvironment::Real);
        let k1 = KeyId::numbered(1);
        store.claim_legacy(&k1);
        assert_eq!(store.load(&k1).unwrap(), Some(record(true)));
        assert_eq!(store.load(&key()).unwrap(), None, "다른 키는 옛 기록을 보지 않는다");

        store.save(&key(), &SwitchRecord { account_ref: Some("other".into()), ..record(false) }).unwrap();
        let reopened = SwitchStore::file(PrivateFile::new(path), KiwoomEnvironment::Real);
        assert_eq!(reopened.load(&key()).unwrap().and_then(|r| r.account_ref), Some("other".into()));
        reopened.claim_legacy(&k1);
        assert_eq!(reopened.load(&k1).unwrap(), Some(record(true)), "다른 키를 저장해도 옛 기록은 그 키 것으로 남는다");
    }

    #[test]
    fn records_of_two_keys_are_independent_and_share_one_salt() {
        let store = SwitchStore::memory();
        let (a, b) = (KeyId::numbered(1), KeyId::numbered(2));
        assert_eq!(store.shared_salt().unwrap(), None);
        store.save(&a, &record(true)).unwrap();
        assert_eq!(store.shared_salt().unwrap(), Some("00ff".into()));
        assert_eq!(store.load(&b).unwrap(), None);
        store.save(&b, &SwitchRecord { account_tail: Some("99".into()), ..record(true) }).unwrap();
        store.save(&a, &record(false)).unwrap();
        assert!(!store.load(&a).unwrap().unwrap().enabled);
        assert_eq!(store.load(&b).unwrap().unwrap().account_tail, Some("99".into()));
    }

    #[test]
    fn switching_off_the_keys_that_left_the_list_keeps_the_rest() {
        let store = SwitchStore::memory();
        let (a, b) = (KeyId::numbered(1), KeyId::numbered(2));
        store.save(&a, &record(true)).unwrap();
        store.save(&b, &record(true)).unwrap();
        store.switch_off_except(std::slice::from_ref(&a)).unwrap();
        assert!(store.load(&a).unwrap().unwrap().enabled);
        assert!(!store.load(&b).unwrap().unwrap().enabled);
    }
}
