use std::collections::HashSet;
use std::fmt;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const FORMAT_VERSION: u32 = 1;
pub const SINGLETON_ID: &str = "main";
pub const DOCUMENT_ID_BYTES: std::ops::RangeInclusive<usize> = 1..=64;

pub const SERVER_FIELDS_ALLOWANCE: usize = 64;
pub const ACCOUNT_LIMIT: usize = 32 * 1024 * 1024;
pub const BUNDLE_LIMIT: usize = 2 * ACCOUNT_LIMIT;

pub const JSON_LIMIT: usize = 64 * 1024;
pub const MAX_CHART_WINDOWS: usize = 8;
pub const LAYOUT_LIMIT: usize = (MAX_CHART_WINDOWS + 1) * JSON_LIMIT + 16 * 1024;

pub const MAX_WATCHLISTS: usize = 20;
pub const MAX_WATCHLIST_NAME_CHARS: usize = 20;
pub const MAX_WATCH_GROUPS: usize = 100;
pub const MAX_WATCHLIST_ID_BYTES: usize = 64;
const LONGEST_WATCH_GROUP_WRAPPER_BYTES: usize = r#"{"id":"","name":"","symbols":[]},"#.len() + MAX_WATCHLIST_ID_BYTES + 4 * MAX_WATCHLIST_NAME_CHARS;
const LONGEST_WATCHLIST_WRAPPER_BYTES: usize = LONGEST_WATCH_GROUP_WRAPPER_BYTES + r#""groups":[],"#.len() + MAX_WATCH_GROUPS * LONGEST_WATCH_GROUP_WRAPPER_BYTES;
pub const WATCHLISTS_LIMIT: usize = (MAX_WATCH_GROUPS + 1) * JSON_LIMIT + MAX_WATCHLISTS * LONGEST_WATCHLIST_WRAPPER_BYTES;

pub const SCREENS_LIMIT: usize = 2 * JSON_LIMIT;

pub const MAX_HEATMAP_THEMES: usize = 100;
pub const MAX_HEATMAP_THEME_SYMBOLS: usize = 60;
pub const MAX_HEATMAP_THEME_NAME_CHARS: usize = 40;
pub const MAX_HEATMAP_THEME_ID_BYTES: usize = 64;
const THEME_STOCK_CODE_BYTES: usize = r#""000000","#.len();
const LONGEST_THEME_BYTES: usize = r#"{"id":"","name":"","symbols":[]},"#.len() + MAX_HEATMAP_THEME_ID_BYTES + 4 * MAX_HEATMAP_THEME_NAME_CHARS + MAX_HEATMAP_THEME_SYMBOLS * THEME_STOCK_CODE_BYTES;
pub const HEATMAP_THEMES_LIMIT: usize = JSON_LIMIT + MAX_HEATMAP_THEMES * LONGEST_THEME_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DocumentKind {
    Watchlists,
    Screens,
    UiState,
    Layout,
    Drawing,
    HeatmapThemes,
}

impl DocumentKind {
    pub const ALL: [DocumentKind; 6] = [DocumentKind::Watchlists, DocumentKind::Screens, DocumentKind::UiState, DocumentKind::Layout, DocumentKind::Drawing, DocumentKind::HeatmapThemes];

    pub const fn wire_name(self) -> &'static str {
        match self {
            DocumentKind::Watchlists => "watchlists",
            DocumentKind::Screens => "screens",
            DocumentKind::UiState => "ui_state",
            DocumentKind::Layout => "layout",
            DocumentKind::Drawing => "drawing",
            DocumentKind::HeatmapThemes => "heatmap_themes",
        }
    }

    pub const fn is_singleton(self) -> bool {
        matches!(self, DocumentKind::Watchlists | DocumentKind::Screens | DocumentKind::UiState | DocumentKind::HeatmapThemes)
    }

    pub fn accepts_id(self, id: &str) -> bool {
        if self.is_singleton() {
            return id == SINGLETON_ID;
        }
        DOCUMENT_ID_BYTES.contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    }

    pub const fn document_limit(self) -> usize {
        self.body_limit() + SERVER_FIELDS_ALLOWANCE
    }

    pub const fn body_limit(self) -> usize {
        match self {
            DocumentKind::Watchlists => WATCHLISTS_LIMIT,
            DocumentKind::Screens => SCREENS_LIMIT,
            DocumentKind::Layout => LAYOUT_LIMIT,
            DocumentKind::HeatmapThemes => HEATMAP_THEMES_LIMIT,
            DocumentKind::UiState | DocumentKind::Drawing => JSON_LIMIT,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Document {
    pub kind: DocumentKind,
    pub id: String,
    #[ts(type = "number")]
    pub revision: i64,
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown", optional)]
    pub body: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Bundle {
    pub version: u32,
    pub documents: Vec<Document>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShapeError {
    Version(u32),
    Duplicate { kind: DocumentKind, id: String },
    Id { kind: DocumentKind, id: String },
    NegativeRevision { kind: DocumentKind, id: String, revision: i64 },
    DeletedWithBody { kind: DocumentKind, id: String },
    LiveWithoutBody { kind: DocumentKind, id: String },
    BodyTooLarge { kind: DocumentKind, id: String, size: usize },
    AccountTooLarge { size: usize },
}

impl ShapeError {
    pub fn document(&self) -> Option<(DocumentKind, &str)> {
        match self {
            ShapeError::Version(_) | ShapeError::AccountTooLarge { .. } => None,
            ShapeError::Duplicate { kind, id }
            | ShapeError::Id { kind, id }
            | ShapeError::NegativeRevision { kind, id, .. }
            | ShapeError::DeletedWithBody { kind, id }
            | ShapeError::LiveWithoutBody { kind, id }
            | ShapeError::BodyTooLarge { kind, id, .. } => Some((*kind, id)),
        }
    }
}

impl fmt::Display for ShapeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some((kind, id)) = self.document() {
            write!(f, "문서 {} {id:?}: ", kind.wire_name())?;
        }
        match self {
            ShapeError::Version(version) => write!(f, "셋업 형식 버전 {version}은 받지 않습니다(지원: {FORMAT_VERSION})"),
            ShapeError::Duplicate { .. } => f.write_str("같은 종류와 id의 문서가 두 개 있습니다"),
            ShapeError::Id { kind, .. } if kind.is_singleton() => write!(f, "{} 문서의 id는 {SINGLETON_ID:?}여야 합니다", kind.wire_name()),
            ShapeError::Id { .. } => write!(f, "id는 영문자·숫자·`-`·`_`로 {}~{}바이트여야 합니다", DOCUMENT_ID_BYTES.start(), DOCUMENT_ID_BYTES.end()),
            ShapeError::NegativeRevision { revision, .. } => write!(f, "revision은 0 이상이어야 합니다: {revision}"),
            ShapeError::DeletedWithBody { .. } => f.write_str("삭제 문서에는 본문이 없어야 합니다"),
            ShapeError::LiveWithoutBody { .. } => f.write_str("삭제가 아닌 문서에는 본문이 있어야 합니다"),
            ShapeError::BodyTooLarge { kind, size, .. } => write!(f, "본문이 {}바이트를 넘습니다: {size}바이트", kind.document_limit()),
            ShapeError::AccountTooLarge { size } => write!(f, "계정 전체 본문이 {}MB를 넘습니다: {}MB", ACCOUNT_LIMIT / (1024 * 1024), size / (1024 * 1024)),
        }
    }
}

impl std::error::Error for ShapeError {}

impl Document {
    pub fn check(&self) -> Result<usize, ShapeError> {
        let Document { kind, id, revision, deleted, body } = self;
        let (kind, id) = (*kind, id.clone());
        if !kind.accepts_id(&id) {
            return Err(ShapeError::Id { kind, id });
        }
        if *revision < 0 {
            return Err(ShapeError::NegativeRevision { kind, id, revision: *revision });
        }
        match (deleted, body) {
            (true, Some(_)) => Err(ShapeError::DeletedWithBody { kind, id }),
            (true, None) => Ok(0),
            (false, None) => Err(ShapeError::LiveWithoutBody { kind, id }),
            (false, Some(body)) => {
                let size = body.to_string().len();
                if size > kind.document_limit() { Err(ShapeError::BodyTooLarge { kind, id, size }) } else { Ok(size) }
            }
        }
    }
}

impl Bundle {
    pub fn check(&self) -> Result<(), ShapeError> {
        if self.version != FORMAT_VERSION {
            return Err(ShapeError::Version(self.version));
        }
        let mut seen = HashSet::new();
        let mut total = 0usize;
        for document in &self.documents {
            total = total.saturating_add(document.check()?);
            if !seen.insert((document.kind, document.id.as_str())) {
                return Err(ShapeError::Duplicate { kind: document.kind, id: document.id.clone() });
            }
        }
        if total > ACCOUNT_LIMIT {
            return Err(ShapeError::AccountTooLarge { size: total });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn live(kind: DocumentKind, id: &str, body: serde_json::Value) -> Document {
        Document { kind, id: id.into(), revision: 7, deleted: false, body: Some(body) }
    }

    fn gone(kind: DocumentKind, id: &str) -> Document {
        Document { kind, id: id.into(), revision: 9, deleted: true, body: None }
    }

    fn padded(bytes: usize) -> serde_json::Value {
        json!({ "pad": "x".repeat(bytes - r#"{"pad":""}"#.len()) })
    }

    #[test]
    fn the_wire_shape_is_fixed() {
        let bundle = Bundle { version: 1, documents: vec![live(DocumentKind::UiState, "main", json!({"theme": "dark"})), gone(DocumentKind::Layout, "L1")] };
        let wire = json!({
            "version": 1,
            "documents": [
                {"kind": "ui_state", "id": "main", "revision": 7, "deleted": false, "body": {"theme": "dark"}},
                {"kind": "layout", "id": "L1", "revision": 9, "deleted": true},
            ],
        });
        assert_eq!(serde_json::to_value(&bundle).unwrap(), wire);
        assert_eq!(serde_json::from_value::<Bundle>(wire).unwrap(), bundle);
    }

    #[test]
    fn the_kind_names_are_the_six_closed_wire_names() {
        let names: Vec<_> = DocumentKind::ALL.iter().map(|kind| serde_json::to_value(kind).unwrap()).collect();
        assert_eq!(names, ["watchlists", "screens", "ui_state", "layout", "drawing", "heatmap_themes"].map(|name| json!(name)));
        assert!(DocumentKind::ALL.iter().all(|kind| serde_json::to_value(kind).unwrap() == kind.wire_name()));
        assert!(serde_json::from_value::<DocumentKind>(json!("quotes")).is_err());
    }

    #[test]
    fn a_singleton_kind_has_the_fixed_id_and_the_others_take_a_plain_id() {
        for kind in [DocumentKind::Watchlists, DocumentKind::Screens, DocumentKind::UiState, DocumentKind::HeatmapThemes] {
            assert_eq!(live(kind, "main", json!({})).check(), Ok(2));
            assert!(matches!(live(kind, "other", json!({})).check(), Err(ShapeError::Id { .. })));
        }
        for kind in [DocumentKind::Layout, DocumentKind::Drawing] {
            assert_eq!(live(kind, "01900000-0000-7000-8000-000000000001", json!({})).check(), Ok(2));
            assert_eq!(live(kind, &"a".repeat(64), json!({})).check(), Ok(2));
            for id in ["", &"a".repeat(65), "a b", "가", "a/b", "a.b"] {
                assert!(matches!(live(kind, id, json!({})).check(), Err(ShapeError::Id { .. })), "{id:?}");
            }
        }
    }

    #[test]
    fn a_deleted_document_has_no_body_and_a_live_one_has_a_body() {
        assert_eq!(gone(DocumentKind::Drawing, "D1").check(), Ok(0));
        let with_body = Document { body: Some(json!({})), ..gone(DocumentKind::Drawing, "D1") };
        assert!(matches!(with_body.check(), Err(ShapeError::DeletedWithBody { .. })));
        let without_body = Document { body: None, ..live(DocumentKind::Drawing, "D1", json!({})) };
        assert!(matches!(without_body.check(), Err(ShapeError::LiveWithoutBody { .. })));
        let wire: Document = serde_json::from_value(json!({"kind": "drawing", "id": "D1", "revision": 1, "deleted": false})).unwrap();
        assert!(matches!(wire.check(), Err(ShapeError::LiveWithoutBody { .. })), "본문 키가 없으면 본문이 없다");
    }

    #[test]
    fn a_negative_revision_is_refused() {
        let negative = Document { revision: -1, ..gone(DocumentKind::Layout, "L1") };
        assert!(matches!(negative.check(), Err(ShapeError::NegativeRevision { .. })));
        assert_eq!(Document { revision: 0, ..gone(DocumentKind::Layout, "L1") }.check(), Ok(0));
    }

    #[test]
    fn each_kind_stops_at_its_body_limit_exactly() {
        for kind in DocumentKind::ALL {
            let id = if kind.is_singleton() { SINGLETON_ID } else { "X" };
            let limit = kind.document_limit();
            assert_eq!(live(kind, id, padded(limit)).check(), Ok(limit), "{kind:?}");
            assert!(matches!(live(kind, id, padded(limit + 1)).check(), Err(ShapeError::BodyTooLarge { size, .. }) if size == limit + 1), "{kind:?}");
        }
    }

    #[test]
    fn a_body_the_route_took_still_fits_after_the_server_fields_change() {
        let route_body = padded(DocumentKind::Drawing.body_limit());
        let stored = json!({"pad": route_body["pad"], "updatedAt": 1_794_152_040_i64});
        assert!(live(DocumentKind::Drawing, "D1", stored).check().is_ok());
    }

    #[test]
    fn the_limits_keep_the_values_the_routes_had() {
        let limits = DocumentKind::ALL.map(DocumentKind::body_limit);
        assert_eq!((JSON_LIMIT, MAX_CHART_WINDOWS), (64 * 1024, 8));
        assert_eq!(limits, [WATCHLISTS_LIMIT, 128 * 1024, 64 * 1024, 9 * 64 * 1024 + 16 * 1024, 64 * 1024, HEATMAP_THEMES_LIMIT]);
        assert_eq!(WATCHLISTS_LIMIT, 6_976_916);
        assert_eq!(HEATMAP_THEMES_LIMIT, 145_236);
    }

    #[test]
    fn the_bundle_stops_at_the_account_limit_and_at_a_repeated_document() {
        let full = |count: usize| Bundle {
            version: FORMAT_VERSION,
            documents: (0..count).map(|n| live(DocumentKind::Layout, &format!("L{n}"), padded(DocumentKind::Layout.document_limit()))).collect(),
        };
        let fits = ACCOUNT_LIMIT / DocumentKind::Layout.document_limit();
        assert_eq!(full(fits).check(), Ok(()));
        assert!(matches!(full(fits + 1).check(), Err(ShapeError::AccountTooLarge { .. })));

        let twice = Bundle { version: FORMAT_VERSION, documents: vec![gone(DocumentKind::Layout, "L1"), live(DocumentKind::Layout, "L1", json!({}))] };
        assert!(matches!(twice.check(), Err(ShapeError::Duplicate { .. })));
        let same_id_other_kind = Bundle { version: FORMAT_VERSION, documents: vec![gone(DocumentKind::Layout, "A"), gone(DocumentKind::Drawing, "A")] };
        assert_eq!(same_id_other_kind.check(), Ok(()));
    }

    #[test]
    fn another_format_version_is_refused() {
        assert_eq!(Bundle { version: 2, documents: vec![] }.check(), Err(ShapeError::Version(2)));
        assert_eq!(Bundle { version: 1, documents: vec![] }.check(), Ok(()));
    }

    #[test]
    fn the_message_names_the_document_and_the_reason() {
        let error = live(DocumentKind::Layout, "a b", json!({})).check().unwrap_err();
        assert!(error.to_string().starts_with(r#"문서 layout "a b": "#), "{error}");
    }
}
