use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct DataLayout {
    pub root: PathBuf,
    pub data_dir: PathBuf,
    pub state_dir: PathBuf,
    pub user_db: PathBuf,
    pub screener_db: PathBuf,
    pub financial_db: PathBuf,
    pub etf_pdf_dir: PathBuf,
    pub market_samples_dir: PathBuf,
    pub kiwoom_themes_dir: PathBuf,
    pub lock: PathBuf,
    pub token: PathBuf,
    pub kiwoom_key: PathBuf,
    pub kis_token: PathBuf,
    pub account_state: PathBuf,
}

impl DataLayout {
    pub fn under(root: &Path) -> Self {
        let data_dir = root.join("data");
        let state_dir = root.join("state");
        DataLayout {
            root: root.to_path_buf(),
            user_db: data_dir.join("vally.db"),
            screener_db: data_dir.join("screener.duckdb"),
            financial_db: data_dir.join("financials.db"),
            etf_pdf_dir: data_dir.join("etf-pdf"),
            market_samples_dir: data_dir.join("market-samples"),
            kiwoom_themes_dir: data_dir.join("kiwoom-themes"),
            lock: state_dir.join("server.lock"),
            token: state_dir.join("token.json"),
            kiwoom_key: state_dir.join("kiwoom-key.json"),
            kis_token: state_dir.join("kis-token.json"),
            account_state: state_dir.join("account.json"),
            data_dir,
            state_dir,
        }
    }

    pub fn create_directories(&self) -> io::Result<()> {
        std::fs::create_dir_all(&self.data_dir)?;
        create_private_directory(&self.state_dir)
    }
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn create_private_directory(path: &Path) -> io::Result<()> {
    std::fs::create_dir_all(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(layout: &DataLayout) -> Vec<&Path> {
        vec![&layout.user_db, &layout.screener_db, &layout.financial_db, &layout.lock, &layout.token, &layout.kiwoom_key, &layout.kis_token, &layout.account_state]
    }

    #[test]
    fn every_path_sits_under_the_root() {
        let root = Path::new("/apps/vally");
        let layout = DataLayout::under(root);
        let directories = [&layout.data_dir, &layout.state_dir, &layout.etf_pdf_dir, &layout.market_samples_dir, &layout.kiwoom_themes_dir];
        for path in files(&layout).into_iter().chain(directories.iter().map(|d| d.as_path())) {
            assert!(path.starts_with(root), "{} is outside {}", path.display(), root.display());
        }
    }

    #[test]
    fn the_engine_rejects_shared_files_so_every_file_is_distinct() {
        let layout = DataLayout::under(Path::new("/apps/vally"));
        let all = files(&layout);
        for (index, path) in all.iter().enumerate() {
            assert!(!all[index + 1..].contains(path), "{} repeats", path.display());
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_state_directory_that_holds_keys_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("vally-desktop-layout-{}", std::process::id()));
        let layout = DataLayout::under(&root);
        layout.create_directories().unwrap();
        let mode = std::fs::metadata(&layout.state_dir).unwrap().permissions().mode() & 0o777;
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(mode, 0o700);
    }
}
