//! 시세 API만 허용(backend.md §4.4, ADR 0004). 주문·계좌 경로와 api-id는 `src/trading/` 안에만 있고, 그 안의 목록은 ADR 0029가 정한 것과 같아야 한다.

use std::collections::BTreeSet;
use std::path::Path;

fn rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

struct Source {
    relative: String,
    text: String,
}

impl Source {
    fn in_trading(&self) -> bool {
        self.relative.starts_with("trading/")
    }
}

fn server_sources() -> Vec<Source> {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    assert!(files.len() > 3, "소스 파일을 찾지 못했습니다: {}", src.display());
    files
        .into_iter()
        .map(|file| Source { relative: file.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/"), text: std::fs::read_to_string(&file).unwrap() })
        .collect()
}

/// `kt1` 다음에 숫자가 오는 api-id(주문·계좌 TR) 자리를 찾는다.
fn has_kt_api_id(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.match_indices("kt1").any(|(i, _)| lower[i + 3..].starts_with(|c: char| c.is_ascii_digit()))
}

fn banned_paths() -> [String; 2] {
    [["/api/dostk/", "ordr"].concat(), ["/api/dostk/", "acnt"].concat()]
}

fn violations_outside_trading(sources: &[Source]) -> Vec<String> {
    let mut found = Vec::new();
    for source in sources.iter().filter(|s| !s.in_trading()) {
        for needle in banned_paths() {
            if source.text.contains(needle.as_str()) {
                found.push(format!("{}에 {needle}가 있습니다", source.relative));
            }
        }
        if has_kt_api_id(&source.text) || api_ids(&source.text).iter().any(|id| id.starts_with("kt")) {
            found.push(format!("{}에 kt로 시작하는 api-id가 있습니다", source.relative));
        }
    }
    found
}

#[test]
fn no_order_or_account_endpoints_outside_trading() {
    let sources = server_sources();
    assert_eq!(violations_outside_trading(&sources), Vec::<String>::new());
    assert!(sources.iter().any(|s| s.in_trading() && s.text.contains(&banned_paths()[1])), "trading 안에서 계좌 경로를 찾지 못했습니다");
}

#[test]
fn the_check_catches_order_and_account_ids_outside_trading() {
    let account_path = banned_paths()[1].clone();
    let order_path = banned_paths()[0].clone();
    let source = |relative: &str, text: &str| Source { relative: relative.into(), text: text.into() };
    let sources = [
        source("market/leaks_path.rs", &format!("const P: &str = \"{account_path}\";")),
        source("kiwoom/leaks_order_path.rs", &order_path),
        source("quotes/leaks_account_id.rs", &["\"", "kt", "00018\""].concat()),
        source("quotes/leaks_order_id.rs", &["\"", "kt", "10000\""].concat()),
        source("trading/allowed.rs", &format!("{account_path} {}{}", "kt", "00018")),
    ];
    let found = violations_outside_trading(&sources);
    assert_eq!(found.len(), 4, "{found:?}");
    assert!(found.iter().all(|f| !f.starts_with("trading/")));
    for leaked in ["market/leaks_path.rs", "kiwoom/leaks_order_path.rs", "quotes/leaks_account_id.rs", "quotes/leaks_order_id.rs"] {
        assert!(found.iter().any(|f| f.starts_with(leaked)), "{leaked}를 잡지 못했습니다: {found:?}");
    }
}

const TRADING_API_IDS: [&str; 9] = ["ka00001", "kt00018", "ka10075", "kt00011", "kt00007", "kt10000", "kt10001", "kt10002", "kt10003"];

#[test]
fn trading_api_ids_are_exactly_the_account_reads_and_the_four_order_writes() {
    let sources = server_sources();
    let seen: BTreeSet<String> = sources.iter().filter(|s| s.in_trading()).flat_map(|s| api_ids(&s.text)).collect();
    let want: BTreeSet<String> = TRADING_API_IDS.iter().map(|id| (*id).to_owned()).collect();
    assert_eq!(seen, want, "trading 안의 api-id가 ADR 0029의 목록과 다릅니다");
    assert!(sources.iter().any(|s| s.in_trading() && s.text.contains(&banned_paths()[0])), "trading 안에서 주문 경로를 찾지 못했습니다");
}

#[test]
fn trading_list_check_notices_a_missing_and_an_extra_id() {
    let listed = |text: &str| api_ids(text).into_iter().collect::<BTreeSet<String>>();
    let want: BTreeSet<String> = TRADING_API_IDS.iter().map(|id| (*id).to_owned()).collect();
    let all = TRADING_API_IDS.join(" ");
    assert_ne!(listed("ka00001 kt00018 ka10075 kt00011 kt00007 kt10000 kt10001 kt10002"), want, "빠진 id를 알아채야 한다");
    assert_ne!(listed(&format!("{all} kt10004")), want, "더해진 id를 알아채야 한다");
    assert_eq!(listed(&all), want);
    assert!(!want.contains("kt00010"), "kt00010은 허용 목록에 없다");
    assert_ne!(listed(&all.replace("kt00011", "kt00010")), want, "kt00011 대신 kt00010이 들어오면 알아채야 한다");
}

/// 키움 api-id 모양(영문 2자 + 숫자 5자리) 낱말을 모두 찾는다.
fn api_ids(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let word = |i: usize| b.get(i).is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_');
    (0..b.len().saturating_sub(6))
        .filter(|&i| {
            (i == 0 || !word(i - 1))
                && b[i..i + 2].iter().all(u8::is_ascii_alphabetic)
                && b[i + 2..i + 7].iter().all(u8::is_ascii_digit)
                && !word(i + 7)
        })
        .map(|i| text[i..i + 7].to_ascii_lowercase())
        .collect()
}

/// 토큰 발급과 시세 조회(종목 정보, 분·일·주·월봉, 외국인 보유·투자자별 매매, 호가·당일 체결·프로그램매매, 순위)만 서버 소스에 있어야 한다(ADR 0004).
const MARKET_API_IDS: [&str; 36] =
    ["au10001", "ka10099", "ka10100", "ka10095", "ka10001", "ka10080", "ka10081", "ka10082", "ka10083", "ka10094", "ka20005", "ka20006", "ka20007", "ka20008", "ka20019", "ka10008", "ka10059", "ka10004", "ka10003", "ka90008", "ka10032", "ka10030", "ka10023", "ka10027", "ka10029", "ka10065", "ka10035", "ka10020", "ka10033", "ka90003", "ka00198", "ka20003", "ka10051", "ka90005", "ka90010", "ka10131"];

#[test]
fn only_market_api_ids_outside_trading() {
    let mut seen = BTreeSet::new();
    for source in server_sources().into_iter().filter(|s| !s.in_trading()) {
        for id in api_ids(&source.text) {
            assert!(MARKET_API_IDS.contains(&id.as_str()), "{}에 시세 목록에 없는 api-id {id}가 있습니다", source.relative);
            seen.insert(id);
        }
    }
    assert!(seen.contains("ka10080") && seen.contains("ka20005"), "분봉 TR을 찾지 못했습니다: {seen:?}");
}

#[test]
fn api_id_scanner_finds_words_only() {
    assert_eq!(api_ids("ApiId::Ka10080 => \"ka10080\", kt10000"), ["ka10080", "ka10080", "kt10000"]);
    assert!(api_ids("ka100801 xka10080 ka1008").is_empty());
}

#[test]
fn detector_catches_order_ids() {
    assert!(has_kt_api_id(&["\"", "kt", "10000\""].concat()));
    assert!(has_kt_api_id(&["KT", "10001"].concat()));
    assert!(!has_kt_api_id("ka10081 kt_x"));
}
