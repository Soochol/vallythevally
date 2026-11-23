use crate::layout::DataLayout;
use crate::loopback::LoopbackAddr;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::Path;

pub type Environment = BTreeMap<OsString, OsString>;

const HOST_NAMES_KEPT: &[&str] = &["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "SystemRoot", "SystemDrive", "windir", "TEMP", "TMP"];

pub fn engine_environment(layout: &DataLayout, bind: LoopbackAddr, static_dir: &Path, host: &Environment) -> Environment {
    let mut environment: Environment = host
        .iter()
        .filter(|(name, _)| HOST_NAMES_KEPT.iter().any(|kept| name.eq_ignore_ascii_case(kept)))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    let assigned: [(&str, OsString); 15] = [
        ("HOME", layout.root.clone().into()),
        ("XDG_STATE_HOME", layout.state_dir.clone().into()),
        ("VALLY_BIND", bind.socket_addr().to_string().into()),
        ("VALLY_STATIC_DIR", static_dir.into()),
        ("VALLY_DB_PATH", layout.user_db.clone().into()),
        ("VALLY_SCREENER_DB_PATH", layout.screener_db.clone().into()),
        ("VALLY_FINANCIAL_DB_PATH", layout.financial_db.clone().into()),
        ("VALLY_ETF_PDF_DIR", layout.etf_pdf_dir.clone().into()),
        ("VALLY_MARKET_SAMPLES_DIR", layout.market_samples_dir.clone().into()),
        ("VALLY_KIWOOM_THEMES_DIR", layout.kiwoom_themes_dir.clone().into()),
        ("VALLY_LOCK_PATH", layout.lock.clone().into()),
        ("VALLY_TOKEN_PATH", layout.token.clone().into()),
        ("VALLY_KIWOOM_KEY_PATH", layout.kiwoom_key.clone().into()),
        ("VALLY_KIS_TOKEN_PATH", layout.kis_token.clone().into()),
        ("VALLY_ACCOUNT_STATE_PATH", layout.account_state.clone().into()),
    ];
    environment.extend(assigned.into_iter().map(|(name, value)| (OsString::from(name), value)));
    environment
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> Environment {
        [
            ("PATH", "/usr/bin"),
            ("LANG", "ko_KR.UTF-8"),
            ("HOME", "/home/developer"),
            ("XDG_STATE_HOME", "/home/developer/.local/state"),
            ("XDG_RUNTIME_DIR", "/run/user/1000"),
            ("OPENDART_API_KEY", "dart-secret"),
            ("VALLY_ENV_FILE", "/home/developer/.config/vally/server.env"),
            ("VALLY_KIWOOM_APP_KEY", "kiwoom-app-key"),
            ("VALLY_KIWOOM_APP_SECRET", "kiwoom-app-secret"),
            ("VALLY_KIS_APP_KEY", "kis-app-key"),
            ("VALLY_DB_PATH", "/home/developer/vally-data/vally.db"),
            ("VALLY_PUBLIC_BIND", "0.0.0.0:9000"),
            ("KIWOOM_APP_KEY", "bare-kiwoom"),
            ("KIS_APP_SECRET", "bare-kis"),
        ]
        .into_iter()
        .map(|(name, value)| (name.into(), value.into()))
        .collect()
    }

    fn built() -> (DataLayout, Environment) {
        let layout = DataLayout::under(Path::new("/apps/vally"));
        let bind = LoopbackAddr::at_port(4321);
        let environment = engine_environment(&layout, bind, Path::new("/opt/vally/web-dist"), &host());
        (layout, environment)
    }

    fn name_is(name: &OsString, expected: &str) -> bool {
        name.to_str() == Some(expected)
    }

    #[test]
    fn nothing_from_the_parent_vally_kiwoom_or_kis_namespaces_is_inherited() {
        let (layout, environment) = built();
        let inherited_values: Vec<&str> = ["kiwoom-app-key", "kiwoom-app-secret", "kis-app-key", "bare-kiwoom", "bare-kis", "dart-secret", "/home/developer/.config/vally/server.env", "0.0.0.0:9000", "/home/developer/vally-data/vally.db"].to_vec();
        for (name, value) in &environment {
            let value = value.to_string_lossy();
            assert!(!inherited_values.contains(&value.as_ref()), "{} inherited {value}", name.to_string_lossy());
            let name = name.to_string_lossy();
            assert!(!name.starts_with("KIWOOM_") && !name.starts_with("KIS_"), "{name}");
            assert_ne!(name, "OPENDART_API_KEY");
            assert_ne!(name, "VALLY_ENV_FILE");
            assert_ne!(name, "VALLY_PUBLIC_BIND");
        }
        assert_eq!(environment.get(&OsString::from("VALLY_DB_PATH")), Some(&layout.user_db.clone().into_os_string()));
    }

    #[test]
    fn every_vally_name_is_one_the_shell_assigns_itself() {
        let (_, environment) = built();
        let assigned: Vec<String> = environment.keys().map(|name| name.to_string_lossy().into_owned()).filter(|name| name.starts_with("VALLY_")).collect();
        assert_eq!(assigned.len(), 13);
        assert!(assigned.iter().all(|name| !name.contains("KIWOOM_APP") && !name.contains("KIS_APP")));
    }

    #[test]
    fn every_data_path_is_under_the_app_data_root() {
        let (layout, environment) = built();
        let mut checked = 0;
        for (name, value) in &environment {
            let name = name.to_string_lossy();
            let is_data_path = name == "HOME" || name == "XDG_STATE_HOME" || ((name.ends_with("_PATH") || name.ends_with("_DIR")) && name != "VALLY_STATIC_DIR");
            if is_data_path {
                checked += 1;
                assert!(Path::new(value).starts_with(&layout.root), "{name}={}", value.to_string_lossy());
            }
        }
        assert_eq!(checked, 13);
    }

    #[test]
    fn the_engine_binds_the_reserved_loopback_address_and_serves_the_given_screen_files() {
        let (_, environment) = built();
        assert_eq!(environment.get(&OsString::from("VALLY_BIND")).unwrap(), "127.0.0.1:4321");
        assert_eq!(environment.get(&OsString::from("VALLY_STATIC_DIR")).unwrap(), "/opt/vally/web-dist");
    }

    #[test]
    fn only_the_operating_system_basics_pass_through() {
        let (_, environment) = built();
        assert!(environment.iter().any(|(name, value)| name_is(name, "PATH") && value == "/usr/bin"));
        assert!(environment.iter().any(|(name, value)| name_is(name, "LANG") && value == "ko_KR.UTF-8"));
        assert!(!environment.keys().any(|name| name_is(name, "XDG_RUNTIME_DIR")));
    }
}
