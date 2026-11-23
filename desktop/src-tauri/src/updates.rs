use crate::{EngineSlot, MAIN_WINDOW};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::{Update, UpdaterExt};

#[cfg(test)]
mod tests;

pub const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const PLUGIN_CONFIG_KEY: &str = "updater";
const NOTICE_WINDOW: &str = "update";
const NOTICE_PAGE: &str = "update.html";
const NOTICE_TITLE: &str = "vally 업데이트";
const MAIN_TITLE: &str = "vally";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum UpdateStatus {
    #[default]
    Current,
    CheckFailed { reason: String },
    Available { version: String, notes: Option<String> },
    Downloading { received: u64, total: Option<u64> },
    Installing,
    InstallFailed { reason: String, engine_stopped: bool },
}

impl UpdateStatus {
    pub fn window_title(&self) -> String {
        match self {
            UpdateStatus::Current => MAIN_TITLE.to_string(),
            UpdateStatus::CheckFailed { .. } => format!("{MAIN_TITLE} · 업데이트 확인 실패"),
            UpdateStatus::Available { version, .. } => format!("{MAIN_TITLE} · 새 판 {version} 있음"),
            UpdateStatus::Downloading { .. } | UpdateStatus::Installing => format!("{MAIN_TITLE} · 업데이트 설치 중"),
            UpdateStatus::InstallFailed { .. } => format!("{MAIN_TITLE} · 업데이트 설치 실패"),
        }
    }

    fn in_progress(&self) -> bool {
        matches!(self, UpdateStatus::Downloading { .. } | UpdateStatus::Installing)
    }
}

#[derive(Default)]
struct Inner {
    status: UpdateStatus,
    offered: Option<Update>,
}

#[derive(Default)]
pub struct UpdateCenter {
    inner: Mutex<Inner>,
    engine_stopped_for_install: AtomicBool,
}

impl UpdateCenter {
    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn status(&self) -> UpdateStatus {
        self.inner().status.clone()
    }

    fn set(&self, status: UpdateStatus) {
        self.inner().status = status;
    }

    fn offer(&self, update: Update) -> UpdateStatus {
        let status = UpdateStatus::Available { version: update.version.clone(), notes: update.body.clone() };
        let mut inner = self.inner();
        inner.status = status.clone();
        inner.offered = Some(update);
        status
    }

    fn start_download(&self) -> Result<Update, &'static str> {
        let mut inner = self.inner();
        let may_start = matches!(inner.status, UpdateStatus::Available { .. } | UpdateStatus::InstallFailed { engine_stopped: false, .. });
        if !may_start {
            return Err("설치할 새 판이 없거나 이미 진행 중입니다");
        }
        let update = inner.offered.clone().ok_or("설치할 새 판이 없습니다")?;
        inner.status = UpdateStatus::Downloading { received: 0, total: None };
        Ok(update)
    }

    fn note_engine_stopped_for_install(&self) {
        self.engine_stopped_for_install.store(true, Ordering::SeqCst);
    }

    fn engine_stopped_for_install(&self) -> bool {
        self.engine_stopped_for_install.load(Ordering::SeqCst)
    }

    fn note_progress(&self, received: u64, total: Option<u64>) {
        self.set(UpdateStatus::Downloading { received, total });
    }

    fn checking_is_allowed(&self) -> bool {
        !self.inner().status.in_progress()
    }
}

pub fn enable<R: Runtime>(app: &AppHandle<R>) -> bool {
    if !app.config().plugins.0.contains_key(PLUGIN_CONFIG_KEY) {
        return false;
    }
    match app.plugin(tauri_plugin_updater::Builder::new().build()) {
        Ok(()) => true,
        Err(error) => {
            publish(app, UpdateStatus::CheckFailed { reason: format!("업데이트 설정이 올바르지 않습니다: {error}") });
            false
        }
    }
}

pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if !enable(app) {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("update-checker".into()).spawn(move || loop {
        tauri::async_runtime::block_on(check_once(&app));
        std::thread::sleep(CHECK_INTERVAL);
    });
    if let Err(error) = spawned {
        eprintln!("[update] 확인 스레드를 시작할 수 없습니다: {error}");
    }
}

pub async fn check_once<R: Runtime>(app: &AppHandle<R>) {
    let center = app.state::<UpdateCenter>();
    if !center.checking_is_allowed() {
        return;
    }
    match find_update(app).await {
        Ok(Some(update)) => {
            let status = center.offer(update);
            apply_status(app, &status);
            show_notice(app);
        }
        Ok(None) => publish(app, UpdateStatus::Current),
        Err(reason) => publish(app, UpdateStatus::CheckFailed { reason }),
    }
}

async fn find_update<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Update>, String> {
    let before_installer = app.clone();
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .on_before_exit(move || {
            stop_engine(&before_installer);
            before_installer.state::<UpdateCenter>().note_engine_stopped_for_install();
            before_installer.cleanup_before_exit();
        })
        .build()
        .map_err(|error| error.to_string())?;
    let found = updater.check().await.map_err(|error| error.to_string())?;
    Ok(found.map(|mut update| {
        update.timeout = Some(DOWNLOAD_TIMEOUT);
        update
    }))
}

fn publish<R: Runtime>(app: &AppHandle<R>, status: UpdateStatus) {
    if let UpdateStatus::CheckFailed { reason } | UpdateStatus::InstallFailed { reason, .. } = &status {
        eprintln!("[update] {reason}");
    }
    app.state::<UpdateCenter>().set(status.clone());
    apply_status(app, &status);
}

fn apply_status<R: Runtime>(app: &AppHandle<R>, status: &UpdateStatus) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.set_title(&status.window_title());
    }
}

fn show_notice<R: Runtime>(app: &AppHandle<R>) {
    if app.get_webview_window(NOTICE_WINDOW).is_some() {
        return;
    }
    let built = WebviewWindowBuilder::new(app, NOTICE_WINDOW, WebviewUrl::App(NOTICE_PAGE.into())).title(NOTICE_TITLE).inner_size(460.0, 280.0).resizable(false).build();
    if let Err(error) = built {
        eprintln!("[update] 알림 창을 열 수 없습니다: {error}");
    }
}

pub async fn install_offered<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let center = app.state::<UpdateCenter>();
    let update = center.start_download().map_err(str::to_string)?;
    apply_status(app, &center.status());
    let progress_center = app.clone();
    let mut received = 0u64;
    let downloaded = update
        .download(
            move |chunk, total| {
                received += chunk as u64;
                progress_center.state::<UpdateCenter>().note_progress(received, total);
            },
            || {},
        )
        .await;
    let bytes = match downloaded {
        Ok(bytes) => bytes,
        Err(error) => return Err(fail_install(app, format!("새 판을 받지 못했습니다: {error}"), false)),
    };
    center.set(UpdateStatus::Installing);
    let installing = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        update.install(&bytes).map_err(|error| {
            let engine_stopped = installing.state::<UpdateCenter>().engine_stopped_for_install();
            fail_install(&installing, format!("새 판을 설치하지 못했습니다: {error}"), engine_stopped)
        })?;
        installing.restart()
    })
    .await;
    outcome.unwrap_or_else(|error| Err(fail_install(app, format!("설치 작업이 중단됐습니다: {error}"), center.engine_stopped_for_install())))
}

fn stop_engine<R: Runtime>(app: &AppHandle<R>) {
    if let Some(slot) = app.try_state::<EngineSlot>() {
        slot.stop_engine();
    }
}

fn fail_install<R: Runtime>(app: &AppHandle<R>, reason: String, engine_stopped: bool) -> String {
    publish(app, UpdateStatus::InstallFailed { reason: reason.clone(), engine_stopped });
    reason
}

#[tauri::command]
pub fn update_status(center: State<UpdateCenter>) -> UpdateStatus {
    center.status()
}

#[tauri::command]
pub async fn install_update<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    install_offered(&app).await
}

#[tauri::command]
pub fn dismiss_update_notice<R: Runtime>(app: AppHandle<R>) {
    if let Some(window) = app.get_webview_window(NOTICE_WINDOW) {
        let _ = window.close();
    }
}

#[tauri::command]
pub async fn restart_app<R: Runtime>(app: AppHandle<R>) {
    app.restart()
}
