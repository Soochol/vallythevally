use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeEntry {
    pub code: String,
    pub name: String,
    pub members: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemesBody {
    pub themes: Vec<ThemeEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IntradayThemesBody {
    pub themes: Vec<crate::kiwoom_themes::KiwoomTheme>,
    pub pages: u32,
    pub complete: bool,
    pub skipped: u32,
}
