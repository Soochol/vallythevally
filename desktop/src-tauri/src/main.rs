#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
mod environment;
mod layout;
mod lifetime;
mod locations;
mod loopback;
mod tail;

use engine::{Engine, EngineSpec, EngineStatus, StatusCell};
use environment::{Environment, engine_environment};
use layout::DataLayout;
use locations::{engine_file_name, first_existing};
use loopback::LoopbackAddr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tail::LogTail;
use tauri::{AppHandle, Manager, RunEvent, State};

const MAIN_WINDOW: &str = "main";
const ENGINE_BINARY_OVERRIDE: &str = "VALLY_DESKTOP_ENGINE_BIN";
const WEB_DIR_OVERRIDE: &str = "VALLY_DESKTOP_WEB_DIR";
const BUNDLED_WEB_DIR: &str = "web-dist";

#[derive(Default)]
struct EngineSlot(Mutex<Option<Engine>>);

impl EngineSlot {
    fn hold(&self, engine: Engine) {
        *self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(engine);
    }

    fn stop_engine(&self) {
        let engine = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        if let Some(engine) = engine {
            engine.stop();
        }
    }
}

#[tauri::command]
fn engine_status(status: State<StatusCell>) -> EngineStatus {
    status.get()
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _arguments, _working_dir| focus_main_window(app)))
        .manage(StatusCell::starting())
        .manage(EngineSlot::default())
        .invoke_handler(tauri::generate_handler![engine_status])
        .setup(|app| {
            start_engine(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 앱을 만들 수 없습니다");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            app.state::<EngineSlot>().stop_engine();
        }
    });
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn start_engine(app: &AppHandle) {
    let status = app.state::<StatusCell>().inner().clone();
    let tail = LogTail::default();
    match launch(app, &tail) {
        Ok((engine, address)) => {
            let start_page = app.get_webview_window(MAIN_WINDOW).and_then(|window| window.url().ok());
            let window = app.get_webview_window(MAIN_WINDOW);
            engine.supervise(address, status, tail, move || {
                if let (Some(window), Some(url)) = (window, start_page) {
                    let _ = window.navigate(url);
                }
            });
            app.state::<EngineSlot>().hold(engine);
        }
        Err(reason) => status.fail(reason, &tail),
    }
}

fn launch(app: &AppHandle, tail: &LogTail) -> Result<(Engine, LoopbackAddr), String> {
    let path = app.path();
    let data_root = path.app_data_dir().map_err(|error| format!("앱 자료 폴더를 알 수 없습니다: {error}"))?;
    let layout = DataLayout::under(&data_root);
    layout.create_directories().map_err(|error| format!("앱 자료 폴더를 만들 수 없습니다({}): {error}", data_root.display()))?;
    let binary = find_engine_binary().map_err(|searched| not_found("엔진 실행 파일", &searched))?;
    let web_dir = find_web_dir(path.resource_dir().ok()).map_err(|searched| not_found("화면 파일 폴더", &searched))?;
    let address = LoopbackAddr::reserve_free_port().map_err(|error| format!("빈 포트를 고를 수 없습니다: {error}"))?;
    let host: Environment = std::env::vars_os().collect();
    let spec = EngineSpec { binary, working_dir: layout.data_dir.clone(), environment: engine_environment(&layout, address, &web_dir, &host) };
    let engine = Engine::spawn_from_process_lifetime_thread(&spec, tail).map_err(|error| format!("엔진을 시작할 수 없습니다({}): {error}", spec.binary.display()))?;
    Ok((engine, address))
}

fn not_found(what: &str, searched: &[PathBuf]) -> String {
    let places: Vec<String> = searched.iter().map(|path| path.display().to_string()).collect();
    format!("{what}을 찾을 수 없습니다. 찾아본 곳: {}", places.join(", "))
}

fn find_engine_binary() -> Result<PathBuf, Vec<PathBuf>> {
    let beside_app = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join(engine_file_name())));
    let candidates = vec![std::env::var_os(ENGINE_BINARY_OVERRIDE).map(PathBuf::from), beside_app, development_path("target/dev/bin").map(|dir| dir.join(engine_file_name()))];
    first_existing(candidates, Path::is_file)
}

fn find_web_dir(resource_dir: Option<PathBuf>) -> Result<PathBuf, Vec<PathBuf>> {
    let candidates = vec![std::env::var_os(WEB_DIR_OVERRIDE).map(PathBuf::from), resource_dir.map(|dir| dir.join(BUNDLED_WEB_DIR)), development_path("web/dist")];
    first_existing(candidates, |dir| dir.join("index.html").is_file())
}

#[cfg(debug_assertions)]
fn development_path(relative: &str) -> Option<PathBuf> {
    Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).map(|repository| repository.join(relative))
}

#[cfg(not(debug_assertions))]
fn development_path(_relative: &str) -> Option<PathBuf> {
    None
}
