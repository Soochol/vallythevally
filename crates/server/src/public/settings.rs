
use std::collections::{BTreeMap, HashMap};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use account_server::settings::Settings as AccountSettings;

use crate::config::{BindAddr, ConfigError};

pub const KEYS: &[&str] = &[
    "VALLY_PUBLIC_BIND",
    "VALLY_PUBLIC_ORIGIN",
    "VALLY_PUBLIC_ACCOUNT_DB_PATH",
    "VALLY_PUBLIC_GOOGLE_CLIENT_ID",
    "VALLY_PUBLIC_GOOGLE_CLIENT_SECRET",
    "VALLY_PUBLIC_GOOGLE_AUTHORIZE_URL",
    "VALLY_PUBLIC_GOOGLE_TOKEN_URL",
    "VALLY_PUBLIC_NAVER_CLIENT_ID",
    "VALLY_PUBLIC_NAVER_CLIENT_SECRET",
    "VALLY_PUBLIC_NAVER_AUTHORIZE_URL",
    "VALLY_PUBLIC_NAVER_TOKEN_URL",
    "VALLY_PUBLIC_NAVER_PROFILE_URL",
    "VALLY_PUBLIC_ACCOUNT_LIMIT",
    "VALLY_PUBLIC_PENDING_LOGIN_LIMIT",
    "VALLY_PUBLIC_BLOCKED_ACCOUNTS",
    "VALLY_PUBLIC_ACCOUNT_RATE",
    "VALLY_PUBLIC_ACCOUNT_BURST",
    "VALLY_PUBLIC_LIGHT_COST",
    "VALLY_PUBLIC_TOTAL_RATE",
    "VALLY_PUBLIC_TOTAL_BURST",
    "VALLY_PUBLIC_ANON_RATE",
    "VALLY_PUBLIC_ANON_BURST",
    "VALLY_PUBLIC_LOGIN_PER_MINUTE",
    "VALLY_PUBLIC_MAX_IN_FLIGHT",
    "VALLY_PUBLIC_ACCOUNT_IN_FLIGHT",
    "VALLY_PUBLIC_ANON_IN_FLIGHT",
    "VALLY_PUBLIC_REQUEST_TIMEOUT_SECS",
    "VALLY_PUBLIC_KIWOOM_ACCOUNT_IN_FLIGHT",
    "VALLY_PUBLIC_MARKET_CONCURRENCY",
    "VALLY_PUBLIC_RANKINGS_CONCURRENCY",
    "VALLY_PUBLIC_BOARD_CONCURRENCY",
    "VALLY_PUBLIC_FLOW_CONCURRENCY",
    "VALLY_PUBLIC_FLOW_TR_PER_MINUTE",
    "VALLY_PUBLIC_FLOW_ACCOUNT_TR_PER_MINUTE",
    "VALLY_PUBLIC_FLOW_FETCH_CONCURRENCY",
    "VALLY_PUBLIC_BOARD_TR_PER_WINDOW",
    "VALLY_PUBLIC_MARKET_CACHE_SECS",
    "VALLY_PUBLIC_RANKING_MAX_PAGES",
    "VALLY_PUBLIC_SCREENER_CONCURRENCY",
    "VALLY_PUBLIC_SCREENER_ACCOUNT_PER_MINUTE",
    "VALLY_PUBLIC_SCREENER_TOTAL_PER_MINUTE",
    "VALLY_PUBLIC_SCREENER_STATUS_CACHE_SECS",
];

const ACCOUNT_NAME_FOR_PUBLIC_NAME: &[(&str, &str)] = &[
    ("VALLY_ACCOUNT_PUBLIC_URL", "VALLY_PUBLIC_ORIGIN"),
    ("VALLY_ACCOUNT_DB_PATH", "VALLY_PUBLIC_ACCOUNT_DB_PATH"),
    ("VALLY_ACCOUNT_GOOGLE_CLIENT_ID", "VALLY_PUBLIC_GOOGLE_CLIENT_ID"),
    ("VALLY_ACCOUNT_GOOGLE_CLIENT_SECRET", "VALLY_PUBLIC_GOOGLE_CLIENT_SECRET"),
    ("VALLY_ACCOUNT_GOOGLE_AUTHORIZE_URL", "VALLY_PUBLIC_GOOGLE_AUTHORIZE_URL"),
    ("VALLY_ACCOUNT_GOOGLE_TOKEN_URL", "VALLY_PUBLIC_GOOGLE_TOKEN_URL"),
    ("VALLY_ACCOUNT_NAVER_CLIENT_ID", "VALLY_PUBLIC_NAVER_CLIENT_ID"),
    ("VALLY_ACCOUNT_NAVER_CLIENT_SECRET", "VALLY_PUBLIC_NAVER_CLIENT_SECRET"),
    ("VALLY_ACCOUNT_NAVER_AUTHORIZE_URL", "VALLY_PUBLIC_NAVER_AUTHORIZE_URL"),
    ("VALLY_ACCOUNT_NAVER_TOKEN_URL", "VALLY_PUBLIC_NAVER_TOKEN_URL"),
    ("VALLY_ACCOUNT_NAVER_PROFILE_URL", "VALLY_PUBLIC_NAVER_PROFILE_URL"),
    ("VALLY_ACCOUNT_PENDING_LOGIN_LIMIT", "VALLY_PUBLIC_PENDING_LOGIN_LIMIT"),
    ("VALLY_ACCOUNT_MAX_ACCOUNTS", "VALLY_PUBLIC_ACCOUNT_LIMIT"),
    ("VALLY_ACCOUNT_BLOCKED_IDENTITIES", "VALLY_PUBLIC_BLOCKED_ACCOUNTS"),
];

#[derive(Debug, Clone)]
pub struct PublicSettings {
    pub bind: BindAddr,
    pub origin: PublicOrigin,
    pub account: AccountSettingsHandle,
    pub limits: Limits,
}

#[derive(Clone)]
pub struct AccountSettingsHandle(pub Arc<AccountSettings>);

impl std::fmt::Debug for AccountSettingsHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AccountSettings([가림])")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicOrigin {
    pub origin: String,
    pub host_port: String,
}

impl PublicOrigin {
    pub fn parse(value: &str) -> Result<Self, ConfigError> {
        let bad = |why: &str| ConfigError(format!("VALLY_PUBLIC_ORIGIN: {why}: {value}"));
        let (scheme, rest) = value.split_once("://").ok_or_else(|| bad("https://이름 형식이어야 합니다"))?;
        if scheme != "https" && scheme != "http" {
            return Err(bad("https만 받습니다(시험용으로 루프백 IP의 http만 더 받습니다)"));
        }
        if rest.is_empty() || rest.contains(['/', '?', '#', '@', '*', ' ']) {
            return Err(bad("경로, 질의, 와일드카드 없이 출처만 적습니다"));
        }
        let (host, port) = match rest.rsplit_once(':') {
            Some((host, port)) if !host.ends_with(']') || host.starts_with('[') => (host, Some(port)),
            _ => (rest, None),
        };
        if let Some(port) = port
            && port.parse::<u16>().map_or(true, |port| port == 0)
        {
            return Err(bad("포트를 읽을 수 없습니다"));
        }
        let ip = host.trim_matches(['[', ']']).parse::<IpAddr>().ok();
        match (scheme, ip) {
            ("https", Some(_)) => return Err(bad("IP 주소는 받지 않습니다. 이름을 씁니다")),
            ("http", Some(ip)) if ip.is_loopback() => {}
            ("http", _) => return Err(bad("http는 루프백 IP만 받습니다")),
            _ => {}
        }
        if host.is_empty() {
            return Err(bad("호스트가 비었습니다"));
        }
        let account_url = account_server::PublicUrl::parse(value).map_err(|e| bad(&e.to_string()))?;
        let origin = account_url.origin().to_owned();
        let host_port = origin.split_once("://").map_or_else(String::new, |(_, host_port)| host_port.to_ascii_lowercase());
        Ok(PublicOrigin { origin, host_port })
    }

    pub fn matches_host(&self, host: &str) -> bool {
        self.host_port.eq_ignore_ascii_case(host)
    }
}

#[derive(Debug, Clone)]
pub struct Limits {
    pub account_rate: f64,
    pub account_burst: f64,
    pub light_cost: f64,
    pub total_rate: f64,
    pub total_burst: f64,
    pub anon_rate: f64,
    pub anon_burst: f64,
    pub login_per_minute: u32,
    pub max_in_flight: usize,
    pub account_in_flight: usize,
    pub anon_in_flight: usize,
    pub request_timeout: Duration,
    pub kiwoom_account_in_flight: usize,
    pub market_concurrency: usize,
    pub rankings_concurrency: usize,
    pub board_concurrency: usize,
    pub flow_concurrency: usize,
    pub flow_tr_per_minute: u32,
    pub flow_account_tr_per_minute: u32,
    pub flow_fetch_concurrency: usize,
    pub board_tr_per_window: u32,
    pub market_cache: Duration,
    pub ranking_max_pages: u8,
    pub screener_concurrency: usize,
    pub screener_account_per_minute: u32,
    pub screener_total_per_minute: u32,
    pub screener_status_cache: Duration,
}

struct Reader<'a> {
    vars: &'a BTreeMap<String, String>,
}

impl Reader<'_> {
    fn raw(&self, name: &str) -> Option<&str> {
        self.vars.get(name).map(String::as_str).filter(|v| !v.is_empty())
    }

    fn number<T: std::str::FromStr + PartialOrd + Default + Copy>(&self, name: &str, default: T, zero_means_none: bool) -> Result<T, ConfigError> {
        let Some(text) = self.raw(name) else { return Ok(default) };
        let value: T = text.trim().parse().map_err(|_| ConfigError(format!("{name}를 숫자로 읽을 수 없습니다: {text}")))?;
        if value < T::default() || (value == T::default() && !zero_means_none) {
            return Err(ConfigError(format!("{name}는 0보다 커야 합니다{}: {text}", if zero_means_none { "(0은 한도 없음)" } else { "" })));
        }
        Ok(value)
    }

    fn positive_float(&self, name: &str, default: f64, at_least: f64) -> Result<f64, ConfigError> {
        let value = self.number::<f64>(name, default, false)?;
        if !value.is_finite() || value < at_least {
            return Err(ConfigError(format!("{name}는 {at_least} 이상의 유한한 수여야 합니다: {value}")));
        }
        Ok(value)
    }
}

impl Limits {
    pub fn parse(vars: &BTreeMap<String, String>) -> Result<Limits, ConfigError> {
        let r = Reader { vars };
        let light_cost = r.positive_float("VALLY_PUBLIC_LIGHT_COST", 0.1, f64::MIN_POSITIVE)?;
        if light_cost > 1.0 {
            return Err(ConfigError(format!("VALLY_PUBLIC_LIGHT_COST는 1 이하여야 합니다: {light_cost}")));
        }
        let ranking_max_pages = r.number::<u8>("VALLY_PUBLIC_RANKING_MAX_PAGES", 5, false)?;
        if ranking_max_pages > 30 {
            return Err(ConfigError(format!("VALLY_PUBLIC_RANKING_MAX_PAGES는 30 이하여야 합니다: {ranking_max_pages}")));
        }
        Ok(Limits {
            account_rate: r.positive_float("VALLY_PUBLIC_ACCOUNT_RATE", 20.0, f64::MIN_POSITIVE)?,
            account_burst: r.positive_float("VALLY_PUBLIC_ACCOUNT_BURST", 100.0, 1.0)?,
            light_cost,
            total_rate: r.positive_float("VALLY_PUBLIC_TOTAL_RATE", 200.0, f64::MIN_POSITIVE)?,
            total_burst: r.positive_float("VALLY_PUBLIC_TOTAL_BURST", 400.0, 1.0)?,
            anon_rate: r.positive_float("VALLY_PUBLIC_ANON_RATE", 5.0, f64::MIN_POSITIVE)?,
            anon_burst: r.positive_float("VALLY_PUBLIC_ANON_BURST", 20.0, 1.0)?,
            login_per_minute: r.number("VALLY_PUBLIC_LOGIN_PER_MINUTE", 30, false)?,
            max_in_flight: r.number("VALLY_PUBLIC_MAX_IN_FLIGHT", 64, false)?,
            account_in_flight: r.number("VALLY_PUBLIC_ACCOUNT_IN_FLIGHT", 8, false)?,
            anon_in_flight: r.number("VALLY_PUBLIC_ANON_IN_FLIGHT", 16, false)?,
            request_timeout: Duration::from_secs(r.number("VALLY_PUBLIC_REQUEST_TIMEOUT_SECS", 60, false)?),
            kiwoom_account_in_flight: r.number("VALLY_PUBLIC_KIWOOM_ACCOUNT_IN_FLIGHT", 1, false)?,
            market_concurrency: r.number("VALLY_PUBLIC_MARKET_CONCURRENCY", 4, false)?,
            rankings_concurrency: r.number("VALLY_PUBLIC_RANKINGS_CONCURRENCY", 2, false)?,
            board_concurrency: r.number("VALLY_PUBLIC_BOARD_CONCURRENCY", 1, false)?,
            flow_concurrency: r.number("VALLY_PUBLIC_FLOW_CONCURRENCY", 1, false)?,
            flow_tr_per_minute: r.number("VALLY_PUBLIC_FLOW_TR_PER_MINUTE", 60, false)?,
            flow_account_tr_per_minute: r.number("VALLY_PUBLIC_FLOW_ACCOUNT_TR_PER_MINUTE", 60, false)?,
            flow_fetch_concurrency: r.number("VALLY_PUBLIC_FLOW_FETCH_CONCURRENCY", 5, false)?,
            board_tr_per_window: r.number("VALLY_PUBLIC_BOARD_TR_PER_WINDOW", 45, false)?,
            market_cache: Duration::from_secs(r.number("VALLY_PUBLIC_MARKET_CACHE_SECS", 15, false)?),
            ranking_max_pages,
            screener_concurrency: r.number("VALLY_PUBLIC_SCREENER_CONCURRENCY", 4, true)?,
            screener_account_per_minute: r.number("VALLY_PUBLIC_SCREENER_ACCOUNT_PER_MINUTE", 2, false)?,
            screener_total_per_minute: r.number("VALLY_PUBLIC_SCREENER_TOTAL_PER_MINUTE", 3, true)?,
            screener_status_cache: Duration::from_secs(r.number("VALLY_PUBLIC_SCREENER_STATUS_CACHE_SECS", 2, false)?),
        })
    }
}

pub struct Inputs<'a> {
    pub vars: &'a BTreeMap<String, String>,
    pub operator_bind: SocketAddr,
    pub mock: bool,
    pub connector_mode: bool,
    pub default_account_db: PathBuf,
}

impl PublicSettings {
    pub fn from_vars(inputs: Inputs<'_>) -> Result<Option<PublicSettings>, ConfigError> {
        let Inputs { vars, operator_bind, mock, connector_mode, default_account_db } = inputs;
        let present = |name: &str| vars.get(name).filter(|v| !v.is_empty());
        let (bind, origin) = match (present("VALLY_PUBLIC_BIND"), present("VALLY_PUBLIC_ORIGIN")) {
            (None, None) => return Ok(None),
            (Some(bind), Some(origin)) => (bind, origin),
            (Some(_), None) => return Err(ConfigError("VALLY_PUBLIC_BIND를 적으면 VALLY_PUBLIC_ORIGIN도 적어야 합니다".into())),
            (None, Some(_)) => return Err(ConfigError("VALLY_PUBLIC_ORIGIN을 적으면 VALLY_PUBLIC_BIND도 적어야 합니다".into())),
        };
        let bind = BindAddr::parse(bind).map_err(|e| ConfigError(format!("VALLY_PUBLIC_BIND: {}", e.0)))?;
        if bind.socket_addr() == operator_bind && operator_bind.port() != 0 {
            return Err(ConfigError("VALLY_PUBLIC_BIND가 VALLY_BIND와 같습니다. 두 리스너는 다른 포트여야 합니다".into()));
        }
        if connector_mode {
            return Err(ConfigError("공개 리스너(VALLY_PUBLIC_BIND)와 VALLY_ACCOUNT_SERVER_URL(커넥터 계정 모드)은 함께 쓸 수 없습니다".into()));
        }
        if mock {
            return Err(ConfigError("공개 리스너(VALLY_PUBLIC_BIND)와 VALLY_KIWOOM_ENV=mock은 함께 쓸 수 없습니다".into()));
        }
        let origin = PublicOrigin::parse(origin)?;
        let mut mapped: HashMap<String, String> = HashMap::new();
        for (account_name, public_name) in ACCOUNT_NAME_FOR_PUBLIC_NAME {
            if let Some(value) = present(public_name) {
                mapped.insert((*account_name).to_owned(), value.clone());
            }
        }
        mapped.entry("VALLY_ACCOUNT_DB_PATH".into()).or_insert_with(|| default_account_db.display().to_string());
        let account = AccountSettings::from_values(&mapped).map_err(|e| ConfigError(renamed(&e.to_string())))?;
        if account.max_accounts == 0 {
            return Err(ConfigError("VALLY_PUBLIC_ACCOUNT_LIMIT는 0보다 커야 합니다".into()));
        }
        let limits = Limits::parse(vars)?;
        Ok(Some(PublicSettings { bind, origin, account: AccountSettingsHandle(Arc::new(account)), limits }))
    }

    pub fn account_db_path(&self) -> &Path {
        &self.account.0.database_path
    }
}

fn renamed(message: &str) -> String {
    ACCOUNT_NAME_FOR_PUBLIC_NAME.iter().fold(message.to_owned(), |text, (account_name, public_name)| text.replace(account_name, public_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    const ACCOUNT: &[(&str, &str)] = &[
        ("VALLY_PUBLIC_GOOGLE_CLIENT_ID", "g"),
        ("VALLY_PUBLIC_GOOGLE_CLIENT_SECRET", "gs"),
        ("VALLY_PUBLIC_NAVER_CLIENT_ID", "n"),
        ("VALLY_PUBLIC_NAVER_CLIENT_SECRET", "ns"),
    ];

    fn start(extra: &[(&str, &str)]) -> Result<Option<PublicSettings>, ConfigError> {
        let mut all = vec![("VALLY_PUBLIC_BIND", "127.0.0.1:8443"), ("VALLY_PUBLIC_ORIGIN", "https://vally.tail1234.ts.net")];
        all.extend_from_slice(ACCOUNT);
        all.extend_from_slice(extra);
        let vars = vars(&all);
        PublicSettings::from_vars(Inputs { vars: &vars, operator_bind: "127.0.0.1:8080".parse().unwrap(), mock: false, connector_mode: false, default_account_db: "data/public-accounts.db".into() })
    }

    #[test]
    fn nothing_set_means_no_public_listener() {
        let vars = vars(&[]);
        let settings = PublicSettings::from_vars(Inputs { vars: &vars, operator_bind: "127.0.0.1:8080".parse().unwrap(), mock: false, connector_mode: false, default_account_db: "x".into() });
        assert!(settings.unwrap().is_none());
    }

    #[test]
    fn origin_and_bind_come_together() {
        let only_bind = vars(&[("VALLY_PUBLIC_BIND", "127.0.0.1:8443")]);
        let only_origin = vars(&[("VALLY_PUBLIC_ORIGIN", "https://a.ts.net")]);
        for vars in [only_bind, only_origin] {
            let result = PublicSettings::from_vars(Inputs { vars: &vars, operator_bind: "127.0.0.1:8080".parse().unwrap(), mock: false, connector_mode: false, default_account_db: "x".into() });
            assert!(result.is_err());
        }
    }

    #[test]
    fn defaults_follow_the_table() {
        let settings = start(&[]).unwrap().unwrap();
        let l = settings.limits;
        assert_eq!((l.account_rate, l.account_burst, l.light_cost, l.total_rate, l.total_burst, l.anon_rate, l.anon_burst), (20.0, 100.0, 0.1, 200.0, 400.0, 5.0, 20.0));
        assert_eq!((l.login_per_minute, l.max_in_flight, l.account_in_flight, l.anon_in_flight, l.request_timeout), (30, 64, 8, 16, Duration::from_secs(60)));
        assert_eq!((l.kiwoom_account_in_flight, l.market_concurrency, l.rankings_concurrency, l.ranking_max_pages), (1, 4, 2, 5));
        assert_eq!((l.screener_concurrency, l.screener_account_per_minute, l.screener_total_per_minute), (4, 2, 3));
        assert_eq!((l.market_cache, l.screener_status_cache), (Duration::from_secs(15), Duration::from_secs(2)));
        assert_eq!(settings.account.0.max_accounts, 100);
    }

    #[test]
    fn bad_values_stop_the_start() {
        let origins = ["https://a.ts.net/path", "https://a.ts.net?x=1", "https://*.ts.net", "https://100.64.0.1", "http://a.ts.net", "ftp://a.ts.net", "a.ts.net", "https://a.ts.net:x"];
        for origin in origins {
            assert!(start(&[("VALLY_PUBLIC_ORIGIN", origin)]).is_err(), "{origin}");
        }
        assert!(start(&[("VALLY_PUBLIC_ORIGIN", "https://a.ts.net:8443")]).is_ok());
        assert!(start(&[("VALLY_PUBLIC_ORIGIN", "http://127.0.0.1:5000")]).is_ok());
        assert!(start(&[("VALLY_PUBLIC_ORIGIN", "https://a.ts.net:0")]).is_err(), "포트 0");
        assert!(start(&[("VALLY_PUBLIC_BIND", "0.0.0.0:8443")]).is_err(), "루프백이 아님");
        assert!(start(&[("VALLY_PUBLIC_BIND", "127.0.0.1:8080")]).is_err(), "운영자 주소와 같음");
        for (name, value) in [
            ("VALLY_PUBLIC_ACCOUNT_RATE", "0"),
            ("VALLY_PUBLIC_ACCOUNT_RATE", "fast"),
            ("VALLY_PUBLIC_ACCOUNT_BURST", "0.5"),
            ("VALLY_PUBLIC_LIGHT_COST", "0"),
            ("VALLY_PUBLIC_LIGHT_COST", "2"),
            ("VALLY_PUBLIC_MAX_IN_FLIGHT", "0"),
            ("VALLY_PUBLIC_MAX_IN_FLIGHT", "-1"),
            ("VALLY_PUBLIC_REQUEST_TIMEOUT_SECS", "0"),
            ("VALLY_PUBLIC_RANKING_MAX_PAGES", "31"),
            ("VALLY_PUBLIC_SCREENER_ACCOUNT_PER_MINUTE", "0"),
            ("VALLY_PUBLIC_ACCOUNT_LIMIT", "0"),
            ("VALLY_PUBLIC_TOTAL_RATE", "inf"),
        ] {
            assert!(start(&[(name, value)]).is_err(), "{name}={value}");
        }
    }

    #[test]
    fn the_host_to_match_is_the_one_a_browser_sends() {
        let host = |origin: &str| PublicOrigin::parse(origin).unwrap().host_port;
        assert_eq!(host("https://A.ts.net:443"), "a.ts.net");
        assert_eq!(host("https://a.ts.net:08443"), "a.ts.net:8443");
        assert_eq!(host("https://한글.ts.net"), "xn--bj0bj06e.ts.net");
        assert_eq!(host("http://127.0.0.1:80"), "127.0.0.1");
    }

    #[test]
    fn zero_means_no_limit_only_where_the_table_says() {
        let l = start(&[("VALLY_PUBLIC_SCREENER_CONCURRENCY", "0"), ("VALLY_PUBLIC_SCREENER_TOTAL_PER_MINUTE", "0")]).unwrap().unwrap().limits;
        assert_eq!((l.screener_concurrency, l.screener_total_per_minute), (0, 0));
    }

    #[test]
    fn incompatible_modes_stop_the_start() {
        let mut all = vec![("VALLY_PUBLIC_BIND", "127.0.0.1:8443"), ("VALLY_PUBLIC_ORIGIN", "https://a.ts.net")];
        all.extend_from_slice(ACCOUNT);
        let vars = vars(&all);
        for (mock, connector_mode) in [(true, false), (false, true)] {
            let result = PublicSettings::from_vars(Inputs { vars: &vars, operator_bind: "127.0.0.1:8080".parse().unwrap(), mock, connector_mode, default_account_db: "x".into() });
            assert!(result.is_err());
        }
    }

    #[test]
    fn missing_idp_credentials_name_the_public_setting() {
        let vars = vars(&[("VALLY_PUBLIC_BIND", "127.0.0.1:8443"), ("VALLY_PUBLIC_ORIGIN", "https://a.ts.net")]);
        let e = PublicSettings::from_vars(Inputs { vars: &vars, operator_bind: "127.0.0.1:8080".parse().unwrap(), mock: false, connector_mode: false, default_account_db: "x".into() }).unwrap_err();
        assert!(e.0.contains("VALLY_PUBLIC_GOOGLE_CLIENT_ID"), "{e:?}");
    }

    #[test]
    fn blocked_accounts_must_be_provider_subject_pairs() {
        assert!(start(&[("VALLY_PUBLIC_BLOCKED_ACCOUNTS", "google:abc, naver:def")]).is_ok());
        assert!(start(&[("VALLY_PUBLIC_BLOCKED_ACCOUNTS", "abc")]).is_err());
    }
}
