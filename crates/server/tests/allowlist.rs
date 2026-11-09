//! 시세 API만 허용(backend.md §4.4): 주문·계좌 경로와 api-id가 서버 소스에 없어야 한다.

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

/// `kt1` 다음에 숫자가 오는 api-id(주문·계좌 TR) 자리를 찾는다.
fn has_kt_api_id(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.match_indices("kt1").any(|(i, _)| lower[i + 3..].starts_with(|c: char| c.is_ascii_digit()))
}

#[test]
fn no_order_or_account_endpoints_in_server_source() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    assert!(files.len() > 3, "소스 파일을 찾지 못했습니다: {}", src.display());
    let banned = [["/api/dostk/", "ordr"].concat(), ["/api/dostk/", "acnt"].concat()];
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap();
        for needle in &banned {
            assert!(!text.contains(needle.as_str()), "{}에 {needle}가 있습니다", file.display());
        }
        assert!(!has_kt_api_id(&text), "{}에 kt1로 시작하는 api-id가 있습니다", file.display());
    }
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

/// 토큰 발급과 시세 조회(종목 정보, 분·일·주·월봉)만 서버 소스에 있어야 한다(ADR 0004).
const MARKET_API_IDS: [&str; 12] =
    ["au10001", "ka10099", "ka10100", "ka10095", "ka10080", "ka10081", "ka10082", "ka10083", "ka20005", "ka20006", "ka20007", "ka20008"];

#[test]
fn only_market_api_ids_in_server_source() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let mut seen = std::collections::BTreeSet::new();
    for file in files {
        for id in api_ids(&std::fs::read_to_string(&file).unwrap()) {
            assert!(MARKET_API_IDS.contains(&id.as_str()), "{}에 시세 목록에 없는 api-id {id}가 있습니다", file.display());
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
