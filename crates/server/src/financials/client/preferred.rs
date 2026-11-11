use super::{Row, field};
use crate::financials::model::Failure;

pub(super) struct ListingNotice {
    pub stock_code: &'static str,
    pub common_code: &'static str,
    pub corp_code: &'static str,
    pub path: &'static str,
    issuer: &'static str,
    common_name: &'static str,
    preferred_name: &'static str,
    common_isin: &'static str,
    preferred_isin: &'static str,
    issue_class: &'static str,
    observed_at: &'static str,
}

const NOTICES: &[ListingNotice] = &[
    ListingNotice {
        stock_code: "005935", common_code: "005930", corp_code: "00126380",
        path: "/external/2026/04/09/000375/20260409000536/68155.htm",
        issuer: "삼성전자(주)", common_name: "삼성전자보통주", preferred_name: "삼성전자1우선주",
        common_isin: "KR7005930003", preferred_isin: "KR7005931001", issue_class: "1우선주",
        observed_at: "2026-11-11T14:01:58Z",
    },
];

pub(super) fn for_stock(stock: &str) -> Option<&'static ListingNotice> {
    let mut matches = NOTICES.iter().filter(|notice| notice.stock_code == stock);
    let notice = matches.next()?;
    matches.next().is_none().then_some(notice)
}

impl ListingNotice {
    pub fn verify_notice(&self, text: &str) -> Result<bool, Failure> {
        if text.trim().is_empty() { return Err(Failure::InvalidResponse); }
        let doc = roxmltree::Document::parse(text).map_err(|_| Failure::InvalidResponse)?;
        let root = doc.root_element();
        if !root.has_tag_name("HTML") { return Err(Failure::InvalidResponse); }
        let blocks: Vec<_> = doc.descendants().filter(|node| node.has_tag_name("PRE")).collect();
        if blocks.is_empty() { return Err(Failure::InvalidResponse); }
        if blocks.len() != 1 { return Ok(false); }
        if blocks[0].parent() != Some(root) || root.children().any(|node| {
            (node.is_element() && !node.has_tag_name("HEAD") && !node.has_tag_name("PRE")) || (node.is_text() && node.text().is_some_and(|text| !text.trim().is_empty()))
        }) { return Ok(false); }
        if blocks[0].children().any(|node| !node.is_text()) { return Ok(false); }
        let body: String = blocks[0].children().filter_map(|node| node.text()).collect();
        let lines: Vec<_> = body.lines().map(|line| line.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|line| !line.is_empty()).collect();
        let title = format!("◎ {} 변경상장(주식소각)", self.issuer);
        if lines.first() != Some(&title) || lines.iter().filter(|line| line.contains('◎')).count() != 1 { return Ok(false); }
        let mut sections = Vec::new();
        for (index, marker) in ['①','②','③','④','⑤','⑥','⑦','⑧','⑨'].into_iter().enumerate() {
            let positions: Vec<_> = lines.iter().enumerate().filter(|(_, line)| line.starts_with(marker)).map(|(position, _)| position).collect();
            if positions.len() != 1 || (index > 0 && positions[0] <= sections[index - 1]) { return Ok(false); }
            sections.push(positions[0]);
        }
        if sections[0] != 1 || lines[sections[0]] != "① 상장종목" || lines[sections[8]] != "⑨ 코드" { return Ok(false); }
        let names = [format!("- {}", self.common_name), format!("- {}", self.preferred_name)];
        if lines[sections[0] + 1..sections[1]] != names { return Ok(false); }
        let codes = &lines[sections[8] + 1..];
        if codes.len() != 3 || !codes[0].starts_with("▶ 업종코드 : ") { return Ok(false); }
        let common = format!("▶ 보통주 표준코드 : {} (단축코드:A{})", self.common_isin, self.common_code);
        let preferred = format!("▶ {} 표준코드 : {} (단축코드:A{})", self.issue_class, self.preferred_isin, self.stock_code);
        Ok(codes[1] == common && codes[2] == preferred)
    }

    pub fn verify_company(&self, candidates: &[Row], directory: &[Row]) -> bool {
        if candidates.len() != 1 { return false; }
        let row = &candidates[0];
        let direct: Vec<_> = directory.iter().filter(|row| field(row, "stock_code") == self.common_code).collect();
        direct.len() == 1 && field(direct[0], "corp_code") == self.corp_code
            && field(row, "repisusrtcd2") == self.common_code && field(row, "repisusrtcd") == format!("A{}", self.common_code)
            && field(row, "repisucd") == self.common_isin && field(row, "fssunqno") == self.corp_code && field(row, "secugrpId") == "ST"
    }

    pub fn evidence(&self) -> String {
        serde_json::json!({
            "source": "KRX KIND listing notice", "source_url": format!("https://kind.krx.co.kr{}", self.path),
            "observed_at": self.observed_at, "issuer": self.issuer, "corp_code": self.corp_code,
            "stock_code": self.stock_code, "isin": self.preferred_isin, "issue_class": self.issue_class,
            "common_stock_code": self.common_code, "common_isin": self.common_isin, "common_issue_class": "보통주",
            "company_source_url": format!("https://kind.krx.co.kr/common/searchcorpname.do?method=searchCorpNameJson&searchCodeType=number&searchCorpName={}", self.common_code),
            "dart_directory": "OpenDART/corpCode.xml",
        }).to_string()
    }
}
