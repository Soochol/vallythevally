use super::*;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};
use tauri::App;

const RUNNING_VERSION: &str = "0.1.0";
const ARTIFACT_PATH: &str = "/vally-setup.bin";
const MANIFEST_PATH: &str = "/latest.json";

struct StaticServer {
    address: SocketAddr,
}

impl StaticServer {
    fn serving(files: HashMap<String, Vec<u8>>) -> Self {
        StaticServer::serving_with_own_address(|_| files)
    }

    fn serving_with_own_address(files_at: impl FnOnce(SocketAddr) -> HashMap<String, Vec<u8>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let files = Arc::new(files_at(address));
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let files = files.clone();
                std::thread::spawn(move || answer(stream, &files));
            }
        });
        StaticServer { address }
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.address)
    }
}

fn answer(mut stream: TcpStream, files: &HashMap<String, Vec<u8>>) {
    let mut request = [0u8; 2048];
    let read = stream.read(&mut request).unwrap_or(0);
    let head = String::from_utf8_lossy(&request[..read]);
    let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
    let (status, body) = match files.get(&path) {
        Some(body) => ("200 OK", body.as_slice()),
        None => ("404 Not Found", b"".as_slice()),
    };
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = stream.write_all(body);
}

struct SigningKeys {
    public_key: String,
    secret: minisign::SecretKey,
    public: minisign::PublicKey,
}

impl SigningKeys {
    fn generate() -> Self {
        let pair = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let public_key = STANDARD.encode(pair.pk.to_box().unwrap().to_string());
        SigningKeys { public_key, secret: pair.sk, public: pair.pk }
    }

    fn sign(&self, artifact: &[u8], version: &str) -> String {
        let trusted = format!("timestamp:1\tfile:vally-setup.bin\tversion:{version}");
        let signature = minisign::sign(Some(&self.public), &self.secret, artifact, Some(&trusted), Some("test signature")).unwrap();
        STANDARD.encode(signature.to_string())
    }
}

fn artifact_bytes() -> Vec<u8> {
    (0..4096u32).map(|index| (index % 251) as u8).collect()
}

fn with_one_byte_changed(bytes: &[u8]) -> Vec<u8> {
    let mut changed = bytes.to_vec();
    changed[bytes.len() / 2] ^= 1;
    changed
}

fn changed_signature(signature: &str) -> String {
    let mut text = STANDARD.decode(signature).unwrap();
    let signature_line = text.iter().position(|byte| *byte == b'\n').unwrap() + 1;
    text[signature_line + 12] ^= 1;
    STANDARD.encode(text)
}

fn manifest(announced_version: &str, signature: &str, artifact_url: &str) -> Vec<u8> {
    let target = tauri_plugin_updater::target().expect("이 OS는 업데이트를 지원합니다");
    json!({
        "version": announced_version,
        "notes": "시험용 새 판",
        "pub_date": "2026-11-23T00:00:00Z",
        "platforms": { target: { "signature": signature, "url": artifact_url } },
    })
    .to_string()
    .into_bytes()
}

struct Release {
    server: StaticServer,
    keys: SigningKeys,
}

impl Release {
    fn announcing(announced_version: &str, signed_version: &str, artifact: &[u8], served_artifact: &[u8], tamper_signature: bool) -> Self {
        let keys = SigningKeys::generate();
        let mut signature = keys.sign(artifact, signed_version);
        if tamper_signature {
            signature = changed_signature(&signature);
        }
        let server = StaticServer::serving_with_own_address(|address| {
            let artifact_url = format!("http://{address}{ARTIFACT_PATH}");
            HashMap::from([(MANIFEST_PATH.to_string(), manifest(announced_version, &signature, &artifact_url)), (ARTIFACT_PATH.to_string(), served_artifact.to_vec())])
        });
        Release { server, keys }
    }

    fn honest(version: &str) -> Self {
        let artifact = artifact_bytes();
        Release::announcing(version, version, &artifact, &artifact, false)
    }

    fn app(&self) -> App<MockRuntime> {
        app_with_updater(json!({
            "pubkey": self.keys.public_key,
            "endpoints": [self.server.url(MANIFEST_PATH)],
            "dangerousInsecureTransportProtocol": true,
            "requireSignedVersion": true,
        }))
    }
}

fn app_with_updater(updater_config: serde_json::Value) -> App<MockRuntime> {
    let mut context = mock_context(noop_assets());
    context.config_mut().plugins.0.insert(PLUGIN_CONFIG_KEY.into(), updater_config);
    context.package_info_mut().version = RUNNING_VERSION.parse().unwrap();
    mock_builder().manage(UpdateCenter::default()).build(context).unwrap()
}

fn run<F: std::future::Future>(future: F) -> F::Output {
    tauri::async_runtime::block_on(future)
}

fn status_of(app: &App<MockRuntime>) -> UpdateStatus {
    app.state::<UpdateCenter>().status()
}

fn source(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
}

#[test]
fn case_ga_a_correctly_signed_newer_release_is_recognized() {
    let release = Release::honest("0.2.0");
    let app = release.app();
    assert!(enable(app.handle()));
    run(check_once(app.handle()));
    assert_eq!(status_of(&app), UpdateStatus::Available { version: "0.2.0".into(), notes: Some("시험용 새 판".into()) });
    assert!(app.get_webview_window(NOTICE_WINDOW).is_some(), "새 판이 있으면 알림 창이 떠야 합니다");
    let update = run(find_update(app.handle())).unwrap().unwrap();
    assert_eq!(update.version, "0.2.0");
    assert_eq!(update.current_version, RUNNING_VERSION);
    assert_eq!(run(update.download(|_, _| {}, || {})).unwrap(), artifact_bytes(), "서명이 맞는 갱신본은 내려받아진다");
}

#[test]
fn case_na_an_artifact_with_one_changed_byte_is_not_installed() {
    let artifact = artifact_bytes();
    let release = Release::announcing("0.2.0", "0.2.0", &artifact, &with_one_byte_changed(&artifact), false);
    let app = release.app();
    assert!(enable(app.handle()));
    run(check_once(app.handle()));
    assert!(matches!(status_of(&app), UpdateStatus::Available { .. }), "목록은 정상이라 새 판으로 알린다");
    let update = run(find_update(app.handle())).unwrap().unwrap();
    let downloaded = run(update.download(|_, _| {}, || {}));
    assert!(matches!(downloaded, Err(tauri_plugin_updater::Error::Minisign(_))), "한 바이트가 바뀐 갱신본은 서명 검증에서 거부돼야 합니다: {downloaded:?}");
    let installed = update.install(with_one_byte_changed(&artifact));
    assert!(matches!(installed, Err(tauri_plugin_updater::Error::Minisign(_))), "바뀐 바이트를 직접 설치시켜도 서명 검증에서 거부돼야 합니다: {installed:?}");
    let refused = run(install_offered(app.handle())).unwrap_err();
    assert!(refused.contains("새 판을 받지 못했습니다"), "{refused}");
    assert!(matches!(status_of(&app), UpdateStatus::InstallFailed { engine_stopped: false, .. }), "설치 전에 거부됐으므로 엔진은 멈추지 않았다: {:?}", status_of(&app));
    assert!(!app.state::<UpdateCenter>().engine_stopped_for_install());
    assert!(app.state::<UpdateCenter>().start_download().is_ok(), "엔진이 살아 있는 받기 실패는 다시 시도할 수 있다");
}

#[test]
fn case_na_a_signature_with_one_changed_byte_is_not_installed() {
    let artifact = artifact_bytes();
    let release = Release::announcing("0.2.0", "0.2.0", &artifact, &artifact, true);
    let app = release.app();
    assert!(enable(app.handle()));
    run(check_once(app.handle()));
    let update = run(find_update(app.handle())).unwrap().unwrap();
    let downloaded = run(update.download(|_, _| {}, || {}));
    assert!(matches!(downloaded, Err(tauri_plugin_updater::Error::Minisign(_))), "{downloaded:?}");
    let installed = update.install(&artifact);
    assert!(matches!(installed, Err(tauri_plugin_updater::Error::Minisign(_))), "{installed:?}");
    assert!(run(install_offered(app.handle())).is_err());
    assert!(matches!(status_of(&app), UpdateStatus::InstallFailed { engine_stopped: false, .. }));
}

#[test]
fn a_signature_made_by_another_key_is_not_installed() {
    let artifact = artifact_bytes();
    let release = Release::announcing("0.2.0", "0.2.0", &artifact, &artifact, false);
    let other_keys = SigningKeys::generate();
    let app = app_with_updater(json!({
        "pubkey": other_keys.public_key,
        "endpoints": [release.server.url(MANIFEST_PATH)],
        "dangerousInsecureTransportProtocol": true,
    }));
    assert!(enable(app.handle()));
    run(check_once(app.handle()));
    assert!(run(install_offered(app.handle())).is_err());
    assert!(matches!(status_of(&app), UpdateStatus::InstallFailed { engine_stopped: false, .. }));
}

#[test]
fn case_da_a_release_not_newer_than_the_running_version_is_not_announced() {
    for announced in [RUNNING_VERSION, "0.0.9"] {
        let release = Release::honest(announced);
        let app = release.app();
        assert!(enable(app.handle()));
        run(check_once(app.handle()));
        assert_eq!(status_of(&app), UpdateStatus::Current, "목록의 판 {announced}");
        assert!(app.get_webview_window(NOTICE_WINDOW).is_none(), "목록의 판 {announced}는 알리지 않는다");
        assert!(run(find_update(app.handle())).unwrap().is_none());
    }
}

#[test]
fn an_older_signed_artifact_cannot_be_passed_off_under_a_newer_announced_version() {
    let artifact = artifact_bytes();
    let release = Release::announcing("9.9.9", "0.0.5", &artifact, &artifact, false);
    let app = release.app();
    assert!(enable(app.handle()));
    run(check_once(app.handle()));
    assert!(run(install_offered(app.handle())).is_err(), "서명된 판 번호와 목록의 판 번호가 다르면 설치하지 않는다");
    assert!(matches!(status_of(&app), UpdateStatus::InstallFailed { engine_stopped: false, .. }));
}

#[test]
fn a_failed_check_is_a_small_indicator_and_leaves_the_app_usable() {
    let broken_lists: [(&str, HashMap<String, Vec<u8>>); 3] = [
        ("목록이 없다", HashMap::new()),
        ("목록 형식이 틀리다", HashMap::from([(MANIFEST_PATH.to_string(), b"not json".to_vec())])),
        ("이 OS의 항목이 없다", HashMap::from([(MANIFEST_PATH.to_string(), json!({"version": "0.2.0", "platforms": {}}).to_string().into_bytes())])),
    ];
    for (case, files) in broken_lists {
        let server = StaticServer::serving(files);
        let keys = SigningKeys::generate();
        let app = app_with_updater(json!({"pubkey": keys.public_key, "endpoints": [server.url(MANIFEST_PATH)], "dangerousInsecureTransportProtocol": true}));
        assert!(enable(app.handle()));
        run(check_once(app.handle()));
        let status = status_of(&app);
        assert!(matches!(status, UpdateStatus::CheckFailed { .. }), "{case}: {status:?}");
        assert_eq!(status.window_title(), "vally · 업데이트 확인 실패");
        assert!(app.get_webview_window(NOTICE_WINDOW).is_none(), "{case}: 확인 실패는 창을 띄우지 않는다");
    }
}

#[test]
fn an_unreachable_endpoint_is_a_failed_check() {
    let unused = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = unused.local_addr().unwrap();
    drop(unused);
    let keys = SigningKeys::generate();
    let app = app_with_updater(json!({"pubkey": keys.public_key, "endpoints": [format!("http://{address}{MANIFEST_PATH}")], "dangerousInsecureTransportProtocol": true}));
    assert!(enable(app.handle()));
    run(check_once(app.handle()));
    assert!(matches!(status_of(&app), UpdateStatus::CheckFailed { .. }));
}

#[test]
fn a_config_without_a_pubkey_is_refused() {
    let app = app_with_updater(json!({"endpoints": ["https://example.invalid/latest.json"]}));
    assert!(!enable(app.handle()));
    assert!(matches!(status_of(&app), UpdateStatus::CheckFailed { .. }));
}

#[test]
fn a_build_without_updater_config_enables_nothing() {
    let mut context = mock_context(noop_assets());
    context.package_info_mut().version = RUNNING_VERSION.parse().unwrap();
    let app = mock_builder().manage(UpdateCenter::default()).build(context).unwrap();
    assert!(!enable(app.handle()));
    assert_eq!(status_of(&app), UpdateStatus::Current);
}

#[test]
fn the_checked_in_config_has_updates_off() {
    for file in ["tauri.conf.json", "tauri.bundle.conf.json"] {
        let config: serde_json::Value = serde_json::from_str(&fs::read_to_string(source(file)).unwrap()).unwrap();
        assert!(config["plugins"].get(PLUGIN_CONFIG_KEY).is_none(), "{file}에 updater 설정이 있습니다");
        assert!(config["bundle"].get("createUpdaterArtifacts").is_none(), "{file}가 갱신 산출물을 만듭니다");
        assert!(config["bundle"].get("windows").is_none(), "{file}에 Windows 서명 설정이 있습니다");
        assert!(config["bundle"].get("macOS").is_none(), "{file}에 macOS 서명 설정이 있습니다");
    }
}

#[test]
fn the_window_title_names_what_the_user_should_know() {
    let cases = [
        (UpdateStatus::Current, "vally"),
        (UpdateStatus::Available { version: "1.2.3".into(), notes: None }, "vally · 새 판 1.2.3 있음"),
        (UpdateStatus::Downloading { received: 1, total: None }, "vally · 업데이트 설치 중"),
        (UpdateStatus::Installing, "vally · 업데이트 설치 중"),
        (UpdateStatus::InstallFailed { reason: "x".into(), engine_stopped: true }, "vally · 업데이트 설치 실패"),
    ];
    for (status, title) in cases {
        assert_eq!(status.window_title(), title);
    }
}

#[test]
fn the_notice_window_reads_the_status_shape_the_command_sends() {
    let shapes = [
        (UpdateStatus::Current, json!({"state": "current"})),
        (UpdateStatus::Available { version: "1.2.3".into(), notes: Some("메모".into()) }, json!({"state": "available", "version": "1.2.3", "notes": "메모"})),
        (UpdateStatus::Downloading { received: 5, total: Some(10) }, json!({"state": "downloading", "received": 5, "total": 10})),
        (UpdateStatus::InstallFailed { reason: "x".into(), engine_stopped: false }, json!({"state": "install_failed", "reason": "x", "engine_stopped": false})),
    ];
    for (status, shape) in shapes {
        assert_eq!(serde_json::to_value(&status).unwrap(), shape);
    }
    let script = fs::read_to_string(source("../ui/update.js")).unwrap();
    for state in ["current", "check_failed", "available", "downloading", "installing", "install_failed"] {
        assert!(script.contains(&format!("\"{state}\"")), "update.js가 {state} 상태를 다루지 않습니다");
    }
}

#[test]
fn a_second_install_request_while_one_is_running_is_refused() {
    let release = Release::honest("0.2.0");
    let app = release.app();
    assert!(enable(app.handle()));
    run(check_once(app.handle()));
    let center = app.state::<UpdateCenter>();
    let first = center.start_download();
    assert!(first.is_ok());
    assert!(center.start_download().is_err());
    assert!(!center.checking_is_allowed(), "받는 중에는 새 확인으로 상태를 덮어쓰지 않는다");
}

fn announced_update(app: &App<MockRuntime>) -> Update {
    run(find_update(app.handle())).unwrap().unwrap()
}

#[test]
fn a_failed_check_after_a_new_release_was_announced_keeps_the_offer() {
    let release = Release::honest("0.2.0");
    let app = release.app();
    assert!(enable(app.handle()));
    run(check_once(app.handle()));
    let center = app.state::<UpdateCenter>();
    assert_eq!(center.record_check(CheckOutcome::Failed("흔들린 네트워크".into())), None);
    assert!(matches!(status_of(&app), UpdateStatus::Available { .. }));
    assert!(center.start_download().is_ok(), "이미 알린 새 판은 다음 확인이 실패해도 설치할 수 있다");
}

#[test]
fn a_check_that_finishes_during_a_download_does_not_overwrite_it() {
    let release = Release::honest("0.2.0");
    let app = release.app();
    assert!(enable(app.handle()));
    run(check_once(app.handle()));
    let center = app.state::<UpdateCenter>();
    center.start_download().unwrap();
    let downloading = status_of(&app);
    assert_eq!(center.record_check(CheckOutcome::Found(Box::new(announced_update(&app)))), None);
    assert_eq!(center.record_check(CheckOutcome::NothingNewer), None);
    assert_eq!(center.record_check(CheckOutcome::Failed("x".into())), None);
    assert_eq!(status_of(&app), downloading);
    assert!(center.start_download().is_err(), "받는 중에 확인이 끝나도 두 번째 설치는 시작되지 않는다");
}

#[test]
fn an_install_failure_that_stopped_the_engine_survives_later_checks() {
    let release = Release::honest("0.2.0");
    let app = release.app();
    assert!(enable(app.handle()));
    let center = app.state::<UpdateCenter>();
    center.set(UpdateStatus::InstallFailed { reason: "x".into(), engine_stopped: true });
    assert_eq!(center.record_check(CheckOutcome::Failed("y".into())), None);
    assert_eq!(center.record_check(CheckOutcome::NothingNewer), None);
    assert!(matches!(status_of(&app), UpdateStatus::InstallFailed { engine_stopped: true, .. }));
}

#[test]
fn a_release_pulled_after_it_was_announced_clears_the_offer() {
    let release = Release::honest("0.2.0");
    let app = release.app();
    assert!(enable(app.handle()));
    run(check_once(app.handle()));
    let center = app.state::<UpdateCenter>();
    assert_eq!(center.record_check(CheckOutcome::NothingNewer), Some(UpdateStatus::Current));
    assert!(center.start_download().is_err());
}

#[test]
fn a_release_pulled_after_a_failed_install_cannot_be_retried() {
    let release = Release::honest("0.2.0");
    let app = release.app();
    assert!(enable(app.handle()));
    run(check_once(app.handle()));
    let center = app.state::<UpdateCenter>();
    center.start_download().unwrap();
    center.set(UpdateStatus::InstallFailed { reason: "x".into(), engine_stopped: false });
    assert_eq!(center.record_check(CheckOutcome::NothingNewer), Some(UpdateStatus::Current));
    assert!(center.start_download().is_err(), "서버가 내린 판은 다시 시도로 설치되지 않는다");
}
