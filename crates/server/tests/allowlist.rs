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

#[test]
fn detector_catches_order_ids() {
    assert!(has_kt_api_id(&["\"", "kt", "10000\""].concat()));
    assert!(has_kt_api_id(&["KT", "10001"].concat()));
    assert!(!has_kt_api_id("ka10081 kt_x"));
}
