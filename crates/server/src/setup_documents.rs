use std::collections::HashSet;

use domain::{Feed, Symbol, Venue};
use setup::{DocumentKind, JSON_LIMIT, MAX_CHART_WINDOWS, MAX_HEATMAP_THEME_ID_BYTES, MAX_HEATMAP_THEME_NAME_CHARS, MAX_HEATMAP_THEME_SYMBOLS, MAX_HEATMAP_THEMES, MAX_WATCHLIST_ID_BYTES, MAX_WATCHLIST_NAME_CHARS, MAX_WATCHLISTS, MAX_WATCH_GROUPS};

use crate::api::{self, ApiErrorCode, HeatmapThemes, LayoutInput, Screen, Screens, Watchlist, Watchlists, WindowContent};
use crate::drawing_api::DrawingInput;
use crate::http::{ApiFailure, AppState, symbol_list};
use crate::screener::{RunnableScreen, parse_screen};
use crate::userdata::{self, wire_name};

pub const MAX_WINDOWS: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Refusal {
    Invalid(String),
    TooLarge { what: &'static str, limit: usize },
}

impl Refusal {
    pub(crate) fn reason(&self) -> String {
        match self {
            Refusal::Invalid(why) => why.clone(),
            Refusal::TooLarge { what, limit } => too_large_text(what, *limit),
        }
    }
}

impl From<Refusal> for ApiFailure {
    fn from(refusal: Refusal) -> Self {
        match refusal {
            Refusal::Invalid(why) => ApiFailure::bad_request(why),
            Refusal::TooLarge { what, limit } => ApiFailure::new(ApiErrorCode::PayloadTooLarge, too_large_text(what, limit)),
        }
    }
}

pub(crate) fn too_large_text(what: &str, limit: usize) -> String {
    format!("{what}는 {}KB를 넘을 수 없습니다", limit / 1024)
}

fn invalid(why: impl Into<String>) -> Refusal {
    Refusal::Invalid(why.into())
}

fn parse_symbol(code: &str) -> Result<Symbol, Refusal> {
    Symbol::parse(code).map_err(|e| invalid(format!("{e}: {code}")))
}

/// 종목 목록에 없는 코드도 받는다. 상장폐지된 종목이 목록에서 사라져도 관심종목은 남아야 한다.
pub(crate) fn check_watchlists(all: &Watchlists) -> Result<(), Refusal> {
    if all.lists.is_empty() || all.lists.len() > MAX_WATCHLISTS {
        return Err(invalid(format!("관심종목 목록은 1~{MAX_WATCHLISTS}개여야 합니다: {}개", all.lists.len())));
    }
    let (mut ids, mut names, mut group_ids) = (HashSet::new(), HashSet::new(), HashSet::new());
    for list in &all.lists {
        if list.id.is_empty() || list.id.len() > MAX_WATCHLIST_ID_BYTES || !ids.insert(list.id.as_str()) {
            return Err(invalid(format!("관심종목 목록 id가 비었거나 길거나 겹칩니다: {}", list.id)));
        }
        let name = list.name.trim();
        if name.is_empty() || name != list.name || name.chars().count() > MAX_WATCHLIST_NAME_CHARS {
            return Err(invalid(format!("관심종목 목록 이름은 앞뒤 공백 없이 1~{MAX_WATCHLIST_NAME_CHARS}자여야 합니다: {:?}", list.name)));
        }
        if !names.insert(name) {
            return Err(invalid(format!("같은 이름의 관심종목 목록이 두 개 있습니다: {name}")));
        }
        let mut seen = HashSet::new();
        for code in &list.symbols {
            if !seen.insert(parse_symbol(&code.0)?) {
                return Err(invalid(format!("관심종목 목록 {name}에 같은 종목이 두 번 있습니다: {}", code.0)));
            }
        }
        check_watch_groups(list, &mut group_ids)?;
    }
    Ok(())
}

fn check_watch_groups<'a>(list: &'a Watchlist, ids: &mut HashSet<&'a str>) -> Result<(), Refusal> {
    let list_name = &list.name;
    if list.groups.len() > MAX_WATCH_GROUPS {
        return Err(invalid(format!("관심종목 목록 {list_name}의 그룹은 {MAX_WATCH_GROUPS}개까지입니다: {}개", list.groups.len())));
    }
    let members: HashSet<&str> = list.symbols.iter().map(|c| c.0.as_str()).collect();
    let mut names = HashSet::new();
    for group in &list.groups {
        if group.id.is_empty() || group.id.len() > MAX_WATCHLIST_ID_BYTES || !ids.insert(group.id.as_str()) {
            return Err(invalid(format!("관심종목 그룹 id가 비었거나 길거나 겹칩니다: {}", group.id)));
        }
        let name = group.name.trim();
        if name.is_empty() || name != group.name || name.chars().count() > MAX_WATCHLIST_NAME_CHARS {
            return Err(invalid(format!("관심종목 그룹 이름은 앞뒤 공백 없이 1~{MAX_WATCHLIST_NAME_CHARS}자여야 합니다: {:?}", group.name)));
        }
        if !names.insert(name) {
            return Err(invalid(format!("관심종목 목록 {list_name}에 같은 이름의 그룹이 두 개 있습니다: {name}")));
        }
        let mut grouped = HashSet::new();
        for code in &group.symbols {
            if !members.contains(code.0.as_str()) {
                return Err(invalid(format!("관심종목 그룹 {name}의 종목이 목록 {list_name}에 없습니다: {}", code.0)));
            }
            if !grouped.insert(code.0.as_str()) {
                return Err(invalid(format!("관심종목 그룹 {name}에 같은 종목이 두 번 있습니다: {}", code.0)));
            }
        }
    }
    Ok(())
}

pub(crate) fn check_heatmap_themes(all: &HeatmapThemes) -> Result<(), Refusal> {
    if all.themes.len() > MAX_HEATMAP_THEMES {
        return Err(invalid(format!("테마는 {MAX_HEATMAP_THEMES}개까지입니다: {}개", all.themes.len())));
    }
    let (mut ids, mut names) = (HashSet::new(), HashSet::new());
    for theme in &all.themes {
        if theme.id.is_empty() || theme.id.len() > MAX_HEATMAP_THEME_ID_BYTES || !ids.insert(theme.id.as_str()) {
            return Err(invalid(format!("테마 id가 비었거나 길거나 겹칩니다: {}", theme.id)));
        }
        let name = theme.name.trim();
        if name.is_empty() || name != theme.name || name.chars().count() > MAX_HEATMAP_THEME_NAME_CHARS {
            return Err(invalid(format!("테마 이름은 앞뒤 공백 없이 1~{MAX_HEATMAP_THEME_NAME_CHARS}자여야 합니다: {:?}", theme.name)));
        }
        if !names.insert(name) {
            return Err(invalid(format!("같은 이름의 테마가 두 개 있습니다: {name}")));
        }
        if theme.symbols.len() > MAX_HEATMAP_THEME_SYMBOLS {
            return Err(invalid(format!("테마 {name}의 종목은 {MAX_HEATMAP_THEME_SYMBOLS}개까지입니다: {}개", theme.symbols.len())));
        }
        let mut seen = HashSet::new();
        for code in &theme.symbols {
            let symbol = parse_symbol(&code.0)?;
            if matches!(symbol, Symbol::Index(_)) {
                return Err(invalid(format!("테마 {name}에는 지수를 넣을 수 없습니다: {}", code.0)));
            }
            if !seen.insert(symbol) {
                return Err(invalid(format!("테마 {name}에 같은 종목이 두 번 있습니다: {}", code.0)));
            }
        }
    }
    Ok(())
}

const MAX_SCREENS: usize = 50;
const MAX_SCREEN_NAME_CHARS: usize = 40;
const MAX_SCREEN_CONDITIONS: usize = 10;
const MAX_SCREEN_ID_BYTES: usize = 64;

pub(crate) fn check_screens(all: &Screens) -> Result<(), Refusal> {
    if all.screens.len() > MAX_SCREENS {
        return Err(invalid(format!("조건식은 {MAX_SCREENS}개까지 저장할 수 있습니다: {}개", all.screens.len())));
    }
    let mut ids = HashSet::new();
    for screen in &all.screens {
        parse_stored_screen(screen)?;
        if !ids.insert(screen.id.as_str()) {
            return Err(invalid(format!("조건식 id가 겹칩니다: {}", screen.id)));
        }
    }
    Ok(())
}

pub(crate) fn parse_stored_screen(screen: &Screen) -> Result<RunnableScreen, Refusal> {
    if screen.id.is_empty() || screen.id.len() > MAX_SCREEN_ID_BYTES {
        return Err(invalid(format!("조건식 id는 1~{MAX_SCREEN_ID_BYTES}바이트여야 합니다: {}", screen.id)));
    }
    let name = &screen.name;
    if !(1..=MAX_SCREEN_NAME_CHARS).contains(&name.trim().chars().count()) {
        return Err(invalid(format!("조건식 이름은 공백을 빼고 1~{MAX_SCREEN_NAME_CHARS}자여야 합니다: {name:?}")));
    }
    if screen.conditions.len() > MAX_SCREEN_CONDITIONS {
        return Err(invalid(format!("조건식 {name}의 조건은 0~{MAX_SCREEN_CONDITIONS}줄이어야 합니다: {}줄", screen.conditions.len())));
    }
    let runnable = parse_screen(screen).map_err(|e| Refusal::Invalid(e.to_string()))?;
    let mut markets = HashSet::new();
    if let Some(market) = screen.markets.iter().find(|m| !markets.insert(**m)) {
        return Err(invalid(format!("조건식 {name}의 시장 목록에 {}가 두 번 있습니다", wire_name(market))));
    }
    let mut kinds = HashSet::new();
    if let Some(kind) = screen.exclude.iter().find(|k| !kinds.insert(**k)) {
        return Err(invalid(format!("조건식 {name}의 제외 목록에 {}가 두 번 있습니다", wire_name(kind))));
    }
    Ok(runnable)
}

fn listed_without_nxt<'a>(dir: &'a crate::symbols::Directory, symbol: &Symbol) -> Option<&'a domain::SymbolInfo> {
    dir.get(*symbol).filter(|info| !info.nxt_enabled)
}

pub(crate) async fn check_nxt_traded(st: &AppState, nxt: &[Symbol]) -> Result<Result<(), Refusal>, ApiFailure> {
    if nxt.is_empty() {
        return Ok(Ok(()));
    }
    let dir = symbol_list(st).await?;
    Ok(match nxt.iter().find_map(|s| listed_without_nxt(&dir, s)) {
        Some(info) => Err(invalid(format!("NXT에서 거래되지 않는 종목입니다: {}({})", info.name, info.symbol.as_wire()))),
        None => Ok(()),
    })
}

pub(crate) fn check_layout_input(path_id: &str, input: &LayoutInput) -> Result<Vec<Symbol>, Refusal> {
    let oversized_chart = input.windows.iter().any(|w| matches!(&w.content, WindowContent::Chart { chart_settings, .. } if chart_settings.to_string().len() > JSON_LIMIT));
    if oversized_chart {
        return Err(Refusal::TooLarge { what: "차트 창의 chartSettings", limit: JSON_LIMIT });
    }
    if serde_json::to_string(&input.placement).expect("JSON 객체는 언제나 직렬화된다").len() > JSON_LIMIT {
        return Err(Refusal::TooLarge { what: "placement", limit: JSON_LIMIT });
    }
    check_layout(path_id, input)
}

pub(crate) fn check_layout(path_id: &str, input: &LayoutInput) -> Result<Vec<Symbol>, Refusal> {
    if !DocumentKind::Layout.accepts_id(path_id) {
        return Err(invalid(format!("레이아웃 id는 영문자·숫자·`-`·`_`로 1~64바이트여야 합니다: {path_id}")));
    }
    if input.id != path_id {
        return Err(invalid(format!("주소의 id({path_id})와 본문의 id({})가 다릅니다", input.id)));
    }
    if input.name.trim().is_empty() {
        return Err(invalid("레이아웃 이름이 비어 있습니다"));
    }
    if !(1..=MAX_WINDOWS).contains(&input.windows.len()) {
        return Err(invalid(format!("창은 1~{MAX_WINDOWS}개여야 합니다: {}개", input.windows.len())));
    }
    let mut ids = HashSet::new();
    if let Some(w) = input.windows.iter().find(|w| !ids.insert(&w.id)) {
        return Err(invalid(format!("창 id가 겹칩니다: {}", w.id.as_str())));
    }
    let charts = input.windows.iter().filter(|w| w.content.is_chart()).count();
    if !(1..=MAX_CHART_WINDOWS).contains(&charts) {
        return Err(invalid(format!("차트 창은 1~{MAX_CHART_WINDOWS}개여야 합니다: {charts}개")));
    }
    let mut indicators = input.windows.iter().filter(|w| matches!(w.content, WindowContent::Indicators));
    if let (Some(_), Some(second)) = (indicators.next(), indicators.next()) {
        return Err(invalid(format!("{} 창은 하나만 둘 수 있습니다", userdata::window_kind(&second.content))));
    }
    for w in &input.windows {
        check_window_state(w)?;
    }
    let mut nxt = Vec::new();
    for w in &input.windows {
        if let WindowContent::Chart { feed: api::ChartFeed(Feed::Stock(code, Venue::Nxt)), .. } = &w.content {
            nxt.push(Symbol::Stock(*code));
        }
    }
    Ok(nxt)
}

fn check_window_state(w: &api::LayoutWindow) -> Result<(), Refusal> {
    let (symbol, list, screen) = match &w.content {
        WindowContent::Trades { symbol } | WindowContent::Book { symbol } | WindowContent::Program { symbol } | WindowContent::Brokers { symbol } | WindowContent::Order { symbol, .. } => {
            (symbol.as_ref(), None, None)
        }
        WindowContent::Watchlist { list } => (None, list.as_deref(), None),
        WindowContent::Screener { screen } => (None, None, screen.as_deref()),
        WindowContent::Chart { .. } | WindowContent::Indicators | WindowContent::Ranking { .. } => return Ok(()),
    };
    if let Some(symbol) = symbol.filter(|s| domain::StockCode::parse(&s.0).is_err()) {
        return Err(invalid(format!("창 {}의 고정 종목은 주식 코드여야 합니다: {}", w.id.as_str(), symbol.0)));
    }
    if let Some(list) = list.filter(|l| l.is_empty() || l.len() > MAX_WATCHLIST_ID_BYTES) {
        return Err(invalid(format!("창 {}의 관심종목 목록 id는 1~{MAX_WATCHLIST_ID_BYTES}바이트여야 합니다: {list}", w.id.as_str())));
    }
    if let Some(screen) = screen.filter(|s| s.is_empty() || s.len() > MAX_SCREEN_ID_BYTES) {
        return Err(invalid(format!("창 {}의 조건식 id는 1~{MAX_SCREEN_ID_BYTES}바이트여야 합니다: {screen}", w.id.as_str())));
    }
    Ok(())
}

const GROUP_CHARS: std::ops::RangeInclusive<usize> = 1..=100;

pub(crate) fn check_drawing(path_id: &str, d: &DrawingInput) -> Result<(), Refusal> {
    if !DocumentKind::Drawing.accepts_id(path_id) {
        return Err(invalid(format!("드로잉 id는 영문자·숫자·`-`·`_`로 1~64바이트여야 합니다: {path_id}")));
    }
    if d.id != path_id {
        return Err(invalid(format!("주소의 id({path_id})와 본문의 id({})가 다릅니다", d.id)));
    }
    parse_symbol(&d.symbol.0)?;
    let range = d.tool.point_count();
    if !range.contains(&d.points.len()) {
        return Err(invalid(format!(
            "{}의 점은 {}~{}개여야 합니다: {}개",
            wire_name(&d.tool),
            range.start(),
            range.end(),
            d.points.len()
        )));
    }
    if d.points.iter().any(|p| !p.price.is_finite()) {
        return Err(invalid("점의 가격은 유한한 수여야 합니다"));
    }
    if d.periods.as_ref().is_some_and(Vec::is_empty) {
        return Err(invalid("periods는 null이거나 봉 주기가 하나 이상이어야 합니다"));
    }
    if !d.z.is_finite() {
        return Err(invalid("z는 유한한 수여야 합니다"));
    }
    if let Some(group) = &d.group
        && !GROUP_CHARS.contains(&group.chars().count())
    {
        return Err(invalid(format!("그룹 이름은 {}~{}자여야 합니다", GROUP_CHARS.start(), GROUP_CHARS.end())));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    use super::*;

    fn as_http(refusal: &Refusal) -> (StatusCode, String) {
        let failure = ApiFailure::from(refusal.clone());
        let message = failure.message().to_owned();
        (failure.into_response().status(), message)
    }

    #[test]
    fn a_refusal_reads_the_same_as_a_bundle_reason_and_as_an_http_failure() {
        let too_large = Refusal::TooLarge { what: "placement", limit: JSON_LIMIT };
        assert_eq!(as_http(&too_large), (StatusCode::PAYLOAD_TOO_LARGE, too_large.reason()));
        let invalid = invalid("레이아웃 이름이 비어 있습니다");
        assert_eq!(as_http(&invalid), (StatusCode::BAD_REQUEST, invalid.reason()));
    }
}
