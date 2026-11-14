use std::ops::RangeInclusive;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api::{Period, Revision, SymbolCode, UnixSeconds};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum DrawingTool {
    Trendline,
    Ray,
    Extline,
    Hline,
    Hray,
    Vline,
    Channel,
    Fib,
    Fibext,
    Rect,
    Ellipse,
    Arrow,
    Path,
    Brush,
    Text,
    Callout,
    Pricelabel,
    Pricerange,
    Daterange,
    Long,
    Short,
    Crossline,
    Regression,
    Pitchfork,
    Fibfan,
    Fibtime,
    Gannfan,
    Gannbox,
    Triangle,
    Datepricerange,
    Avwap,
    Volprofile,
    Elliott,
    Elliottabc,
    Xabcd,
    Headshoulders,
}

impl DrawingTool {
    pub const fn point_count(self) -> RangeInclusive<usize> {
        use DrawingTool::*;
        match self {
            Hline | Hray | Vline | Text | Pricelabel | Crossline | Avwap => 1..=1,
            Trendline | Ray | Extline | Arrow | Fib | Rect | Ellipse | Callout | Pricerange | Daterange
            | Regression | Fibfan | Fibtime | Gannfan | Gannbox | Datepricerange | Volprofile => 2..=2,
            Channel | Fibext | Long | Short | Pitchfork | Triangle => 3..=3,
            Elliottabc => 4..=4,
            Xabcd => 5..=5,
            Elliott => 6..=6,
            Headshoulders => 7..=7,
            Path => 2..=100,
            Brush => 2..=1000,
        }
    }
}

/// 봉 순서가 아니라 시각과 가격. `t`는 봉 시작과 맞을 필요가 없다.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DrawingPoint {
    pub t: UnixSeconds,
    pub price: f64,
}

/// 드로잉이 보이는 곳. 어느 범위든 드로잉은 종목에 붙는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export)]
pub enum DrawingScope {
    Symbol,
    Layout {
        #[serde(rename = "layoutId")]
        layout_id: String,
    },
    Cell {
        #[serde(rename = "layoutId")]
        layout_id: String,
        #[ts(type = "0 | 1 | 2 | 3")]
        slot: u8,
    },
}

/// `GET /api/drawings?symbol=` 원소, `PUT /api/drawings/:id`의 응답.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Drawing {
    pub id: String,
    pub symbol: SymbolCode,
    pub tool: DrawingTool,
    pub points: Vec<DrawingPoint>,
    pub text: Option<String>,
    /// 도구가 모양을 정한다. 서버는 모르는 키까지 그대로 저장한다.
    #[ts(type = "unknown")]
    pub style: serde_json::Value,
    pub locked: bool,
    pub hidden: bool,
    /// null이면 모든 봉 주기에 보인다. 빈 배열은 받지 않는다.
    pub periods: Option<Vec<Period>>,
    /// 큰 것이 위다.
    pub z: f64,
    /// 그룹 이름. 같은 종목에서 이름이 같으면 한 그룹이다.
    pub group: Option<String>,
    pub scope: DrawingScope,
    pub revision: Revision,
    pub updated_at: UnixSeconds,
}

/// `PUT /api/drawings/:id` 본문(없으면 만들고 있으면 바꾼다). 본문 전체가 64KB 이하.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DrawingInput {
    pub id: String,
    pub symbol: SymbolCode,
    pub tool: DrawingTool,
    pub points: Vec<DrawingPoint>,
    pub text: Option<String>,
    #[ts(type = "unknown")]
    pub style: serde_json::Value,
    pub locked: bool,
    pub hidden: bool,
    pub periods: Option<Vec<Period>>,
    pub z: f64,
    pub group: Option<String>,
    pub scope: DrawingScope,
    pub revision: Revision,
}

impl DrawingInput {
    pub fn saved_at(self, updated_at: UnixSeconds) -> Drawing {
        let DrawingInput { id, symbol, tool, points, text, style, locked, hidden, periods, z, group, scope, revision } = self;
        Drawing { id, symbol, tool, points, text, style, locked, hidden, periods, z, group, scope, revision, updated_at }
    }
}
