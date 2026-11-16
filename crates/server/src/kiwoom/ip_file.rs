use std::net::IpAddr;

use serde::{Deserialize, Serialize};

use super::private_file::{FileError, PrivateFile};
use crate::api::{RegisteredIp, UnixSeconds};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    ip: String,
    at: i64,
}

pub struct RegisteredIpFile {
    file: PrivateFile,
}

impl RegisteredIpFile {
    pub(super) fn new(file: PrivateFile) -> Self {
        RegisteredIpFile { file }
    }

    pub fn load(&self) -> Result<Option<RegisteredIp>, FileError> {
        let Some(text) = self.file.read()? else { return Ok(None) };
        let stored: Stored = serde_json::from_str(&text).map_err(|e| self.file.error(format_args!("JSON {:?} 오류, {}번째 줄", e.classify(), e.line())))?;
        let ip: IpAddr = stored.ip.parse().map_err(|_| self.file.error("IP 주소가 아닌 값이 있어 쓰지 않습니다"))?;
        Ok(Some(RegisteredIp { ip: ip.to_string(), at: UnixSeconds(stored.at) }))
    }

    pub fn save(&self, registered: &RegisteredIp) -> Result<(), FileError> {
        let stored = Stored { ip: registered.ip.clone(), at: registered.at.0 };
        self.file.write(&serde_json::to_vec(&stored).expect("문자열과 정수만 담은 구조체"))
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use crate::instance::InstanceLock;
    use crate::kiwoom::key_file::KeyFile;

    #[test]
    fn round_trip_next_to_the_key_file_with_private_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let lock = InstanceLock::acquire(&dir.path().join("server.lock")).unwrap();
        let file = KeyFile::new(dir.path().join("state/vallythevally/kiwoom-key.json"), &lock).registered_ip_file();
        assert_eq!(file.load().unwrap(), None);
        let registered = RegisteredIp { ip: "203.0.113.7".into(), at: UnixSeconds(1_700_000_000) };
        file.save(&registered).unwrap();
        assert_eq!(file.load().unwrap(), Some(registered));
        let path = dir.path().join("state/vallythevally/kiwoom-ip.json");
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        std::fs::write(&path, r#"{"ip":"not an ip","at":1}"#).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(file.load().unwrap_err().to_string().contains("kiwoom-ip.json"));
    }
}
