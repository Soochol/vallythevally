use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use account_server::open_database;
use server::api::KiwoomEnvironment;
use server::db::AppDb;
use server::screener::store::Store;
use sqlx::Connection;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};

struct TemplateFile {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

pub fn copy_template(src: &Path, dest: &Path) {
    if dest.exists() {
        return;
    }
    if let Some(parent) = dest.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::copy(src, dest).unwrap();
}

fn sqlite_checkpoint(path: PathBuf, sql: Option<&'static str>) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async move {
            let opts = SqliteConnectOptions::new()
                .filename(&path)
                .busy_timeout(Duration::from_secs(5))
                .journal_mode(SqliteJournalMode::Delete);
            let mut conn = sqlx::SqliteConnection::connect_with(&opts).await.unwrap();
            if let Some(stmt) = sql {
                sqlx::query(stmt).execute(&mut conn).await.unwrap();
            }
            conn.close().await.unwrap();
        });
    })
    .join()
    .unwrap();
}

pub fn seed_vally_db(dest: &Path) {
    static TEMPLATE: OnceLock<TemplateFile> = OnceLock::new();
    let tpl = TEMPLATE.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vally.db");
        let built = path.clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            rt.block_on(async move {
                let db = AppDb::open_in(&built, KiwoomEnvironment::Real).await.unwrap();
                drop(db);
            });
        })
        .join()
        .unwrap();
        sqlite_checkpoint(path.clone(), Some("DELETE FROM kiwoom_environment"));
        TemplateFile { _dir: dir, path }
    });
    copy_template(&tpl.path, dest);
}

pub fn seed_account_db(dest: &Path) {
    static TEMPLATE: OnceLock<TemplateFile> = OnceLock::new();
    let tpl = TEMPLATE.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("accounts.db");
        let built = path.clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            rt.block_on(async move {
                let pool = open_database(&built).await.unwrap();
                pool.close().await;
            });
        })
        .join()
        .unwrap();
        sqlite_checkpoint(path.clone(), None);
        TemplateFile { _dir: dir, path }
    });
    copy_template(&tpl.path, dest);
}

pub fn seed_screener_duckdb(dest: &Path) {
    static TEMPLATE: OnceLock<TemplateFile> = OnceLock::new();
    let tpl = TEMPLATE.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("screener.duckdb");
        drop(Store::open(&path).unwrap());
        TemplateFile { _dir: dir, path }
    });
    copy_template(&tpl.path, dest);
}

pub async fn open_app_db(path: &Path) -> AppDb {
    seed_vally_db(path);
    AppDb::open(path).await.unwrap()
}

pub fn open_screener_store(path: &Path) -> Store {
    seed_screener_duckdb(path);
    Store::open(path).unwrap()
}
