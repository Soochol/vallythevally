use std::collections::BTreeSet;

use scraper::{Html, Selector};
use sha2::{Digest, Sha256};

use super::{Client, Row, digits, field};
use crate::{clock::Clock, financials::model::{Failure, Interrupt}};

struct NoticeRef { receipt: String, document: String, issuer: String, published_at: String, supported: bool }
struct Issue { stock: String, isin: String, class: String }
struct Notice { issuer: String, common: Issue, preferred: Issue }

impl Client {
    pub(super) async fn discover_preferred(&self, stock: &str, directory: &[Row]) -> Result<Option<(String, String)>, Interrupt> {
        if stock.len() != 6 || !stock.bytes().all(|b| b.is_ascii_alphanumeric()) { return Ok(None); }
        let observed = Clock::system().now();
        let keyword = format!("{stock} 변경상장");
        let today = observed.kst_date().to_string();
        let params = [
            ("method", "searchTotalInfoSub"), ("forward", "searchtotalinfo_detail"), ("kwd", &keyword),
            ("fdName", "all_mktact_idx"), ("scn", "mktact"), ("srchFd", "2"),
            ("pageIndex", "1"), ("currentPageSize", "15"), ("fromData", "2015-01-01"), ("toData", &today),
        ];
        let search_url = reqwest::Url::parse_with_params("https://kind.krx.co.kr/disclosure/searchtotalinfo.do", params).map_err(|_| Failure::InvalidResponse)?;
        let search = self.kind_bytes("/disclosure/searchtotalinfo.do", &params).await?;
        let Some(reference) = latest_notice(utf8(&search)?)? else { return Ok(None); };
        let contents_params = [("method", "searchContents"), ("docNo", reference.document.as_str())];
        let contents = self.kind_bytes("/common/disclsviewer.do", &contents_params).await?;
        let Some(path) = notice_path(utf8(&contents)?, &reference)? else { return Ok(None); };
        let source = self.kind_bytes(&path, &[]).await?;
        let Some(notice) = parse_notice(utf8(&source)?, stock)? else { return Ok(None); };
        if issuer_name(&notice.issuer) != reference.issuer { return Ok(None); }
        let companies = self.kind_companies(&notice.common.stock).await?;
        if companies.len() != 1 { return Ok(None); }
        let company = &companies[0];
        let corp = field(company, "fssunqno");
        let direct: Vec<_> = directory.iter().filter(|row| field(row, "stock_code") == notice.common.stock).collect();
        if direct.len() != 1 || !digits(corp, 8) || field(direct[0], "corp_code") != corp
            || field(company, "repisusrtcd2") != notice.common.stock || field(company, "repisusrtcd") != format!("A{}", notice.common.stock)
            || field(company, "repisucd") != notice.common.isin || field(company, "secugrpId") != "ST"
            || field(company, "comabbrv") != issuer_name(&notice.issuer) { return Ok(None); }
        let evidence = serde_json::json!({
            "source": "KRX KIND discovered listing notice", "source_url": format!("https://kind.krx.co.kr{path}"),
            "observed_at": format!("{}T{}+09:00", observed.kst_date(), observed.kst_time_of_day()),
            "receipt": reference.receipt, "document": reference.document, "published_at": reference.published_at,
            "search_url": search_url.as_str(), "search_sha256": digest(&search),
            "contents_url": format!("https://kind.krx.co.kr/common/disclsviewer.do?method=searchContents&docNo={}", reference.document),
            "contents_sha256": digest(&contents), "source_sha256": digest(&source),
            "issuer": notice.issuer, "corp_code": corp, "stock_code": notice.preferred.stock,
            "isin": notice.preferred.isin, "issue_class": notice.preferred.class,
            "common_stock_code": notice.common.stock, "common_isin": notice.common.isin, "common_issue_class": notice.common.class,
            "company_source_url": format!("https://kind.krx.co.kr/common/searchcorpname.do?method=searchCorpNameJson&searchCodeType=number&searchCorpName={}", notice.common.stock),
            "company_response": company, "dart_directory": "OpenDART/corpCode.xml",
        }).to_string();
        Ok(Some((corp.into(), evidence)))
    }
}

fn utf8(bytes: &[u8]) -> Result<&str, Failure> { std::str::from_utf8(bytes).map_err(|_| Failure::InvalidResponse) }
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn selector(value: &str) -> Selector { Selector::parse(value).unwrap() }

fn latest_notice(text: &str) -> Result<Option<NoticeRef>, Failure> {
    let html = Html::parse_document(text);
    let totals: Vec<_> = html.select(&selector("section.paging-group div.info em")).collect();
    if totals.len() != 1 { return Err(Failure::InvalidResponse); }
    let total: usize = totals[0].text().collect::<String>().trim().parse().map_err(|_| Failure::InvalidResponse)?;
    let rows: Vec<_> = html.select(&selector("section.total-search dl > :not(dd)")).collect();
    let entries: Vec<_> = html.select(&selector("section.total-search dl > dt.img")).collect();
    if rows.len() != total.min(15) || entries.len() != rows.len() { return Err(Failure::InvalidResponse); }
    if total == 0 {
        return if text.contains("검색결과가 없습니다.") { Ok(None) } else { Err(Failure::InvalidResponse) };
    }
    let mut candidates = Vec::new();
    let mut receipts = BTreeSet::new();
    let mut documents = BTreeSet::new();
    for entry in entries {
        let subjects: Vec<_> = entry.select(&selector("span.subject > a")).collect();
        if subjects.len() != 1 { return Err(Failure::InvalidResponse); }
        let supported = subjects[0].text().collect::<String>() == "변경상장 주식소각";
        let call = subjects[0].value().attr("onclick").ok_or(Failure::InvalidResponse)?;
        let Some(arguments) = call.strip_prefix("openDisclsViewer('").and_then(|s| s.strip_suffix("');return false;")) else { return Err(Failure::InvalidResponse); };
        let Some((receipt, document)) = arguments.split_once("', '") else { return Err(Failure::InvalidResponse); };
        if !digits(receipt, 14) || !digits(document, 14) { return Err(Failure::InvalidResponse); }
        if !receipts.insert(receipt.to_owned()) || !documents.insert(document.to_owned()) { return Ok(None); }
        let names: Vec<_> = entry.select(&selector("strong.name > a")).collect();
        let dates: Vec<_> = entry.select(&selector("em.date")).collect();
        if names.len() != 1 || dates.len() != 1 { return Err(Failure::InvalidResponse); }
        let published_at = dates[0].text().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
        let date = format!("{}-{}-{}", &receipt[..4], &receipt[4..6], &receipt[6..8]);
        if published_at.len() != 16 || !published_at.starts_with(&format!("{date} ")) { return Err(Failure::InvalidResponse); }
        candidates.push(NoticeRef { receipt: receipt.into(), document: document.into(), issuer: names[0].text().collect(), published_at, supported });
    }
    candidates.sort_by(|a,b| b.published_at.cmp(&a.published_at));
    if candidates.len() > 1 && candidates[0].published_at == candidates[1].published_at { return Ok(None); }
    Ok(candidates.into_iter().next().filter(|candidate| candidate.supported))
}

fn notice_path(text: &str, reference: &NoticeRef) -> Result<Option<String>, Failure> {
    let html = Html::parse_document(text);
    let calls: Vec<_> = html.select(&selector("script")).flat_map(|script| script.text()).flat_map(|text| text.split("parent.setPath(").skip(1)).collect();
    if calls.is_empty() { return Err(Failure::InvalidResponse); }
    if calls.len() != 1 { return Ok(None); }
    let path = calls[0].strip_prefix("'','https://kind.krx.co.kr").and_then(|s| s.split_once("','")).map(|(path,_)| path).ok_or(Failure::InvalidResponse)?;
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 8 || parts[1] != "external" || parts[2] != &reference.receipt[..4] || parts[3] != &reference.receipt[4..6]
        || parts[4] != &reference.receipt[6..8] || parts[5] != &reference.receipt[8..] || parts[6] != reference.document || parts[7] != "68155.htm" { return Ok(None); }
    Ok(Some(path.into()))
}

fn issuer_name(issuer: &str) -> &str { issuer.strip_suffix("(주)").unwrap_or(issuer) }

fn parse_notice(text: &str, stock: &str) -> Result<Option<Notice>, Failure> {
    let doc = roxmltree::Document::parse(text).map_err(|_| Failure::InvalidResponse)?;
    let root = doc.root_element();
    let blocks: Vec<_> = doc.descendants().filter(|node| node.has_tag_name("PRE")).collect();
    if !root.has_tag_name("HTML") || blocks.is_empty() { return Err(Failure::InvalidResponse); }
    if blocks.len() != 1 { return Ok(None); }
    let block = blocks[0];
    if block.parent() != Some(root) || block.children().any(|n| !n.is_text()) || root.children().any(|n| (n.is_element() && !n.has_tag_name("HEAD") && !n.has_tag_name("PRE")) || (n.is_text() && n.text().is_some_and(|s| !s.trim().is_empty()))) { return Err(Failure::InvalidResponse); }
    let body: String = block.children().filter_map(|node| node.text()).collect();
    let lines: Vec<_> = body.lines().map(|line| line.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|line| !line.is_empty()).collect();
    let issuer = lines.first().and_then(|line| line.strip_prefix("◎ ")).and_then(|s| s.strip_suffix(" 변경상장(주식소각)")).filter(|s| !s.is_empty()).ok_or(Failure::InvalidResponse)?;
    if lines.iter().filter(|line| line.contains('◎')).count() != 1 { return Ok(None); }
    let mut sections = Vec::new();
    for marker in ['①','②','③','④','⑤','⑥','⑦','⑧','⑨'] {
        let positions: Vec<_> = lines.iter().enumerate().filter(|(_,line)| line.starts_with(marker)).map(|(i,_)| i).collect();
        if positions.is_empty() { return Err(Failure::InvalidResponse); }
        if positions.len() != 1 { return Ok(None); }
        if sections.last().is_some_and(|last| last >= &positions[0]) { return Err(Failure::InvalidResponse); }
        sections.push(positions[0]);
    }
    if sections[0] != 1 || lines[sections[0]] != "① 상장종목" || lines[sections[8]] != "⑨ 코드" { return Err(Failure::InvalidResponse); }
    let mut issues = Vec::new();
    let mut stocks = BTreeSet::new();
    let mut isins = BTreeSet::new();
    let mut classes = BTreeSet::new();
    let mut industry = 0;
    for line in &lines[sections[8] + 1..] {
        if line.strip_prefix("▶ 업종코드 : ").is_some_and(|s| !s.is_empty()) { industry += 1; continue; }
        let (class, codes) = line.strip_prefix("▶ ").and_then(|s| s.split_once(" 표준코드 : ")).ok_or(Failure::InvalidResponse)?;
        let (isin, code) = codes.split_once(" (단축코드:A").ok_or(Failure::InvalidResponse)?;
        let code = code.strip_suffix(')').ok_or(Failure::InvalidResponse)?;
        if isin.len() != 12 || !isin.starts_with("KR") || !isin.bytes().all(|b| b.is_ascii_alphanumeric()) || code.len() != 6 || !code.bytes().all(|b| b.is_ascii_alphanumeric()) { return Err(Failure::InvalidResponse); }
        if class != "보통주" && !matches!(class, "1우선주"|"2우선주"|"3우선주"|"4우선주"|"5우선주"|"6우선주"|"7우선주"|"8우선주"|"9우선주") { return Ok(None); }
        if !stocks.insert(code) || !isins.insert(isin) || !classes.insert(class) { return Ok(None); }
        issues.push(Issue { stock: code.into(), isin: isin.into(), class: class.into() });
    }
    if industry != 1 || issues.len() < 2 { return Err(Failure::InvalidResponse); }
    let listed = &lines[sections[0] + 1..sections[1]];
    if listed.len() != issues.len() { return Ok(None); }
    for (line, issue) in listed.iter().zip(&issues) {
        let name = format!("- {}{}", issuer_name(issuer), issue.class);
        if line != &name && (issue.class == "보통주" || line != &format!("{name}(신형)")) { return Ok(None); }
    }
    let quantities: Vec<_> = lines[sections[1] + 1..sections[2]].iter().filter(|line| line.starts_with("▶ ")).collect();
    if quantities.len() != issues.len() || quantities.iter().zip(&issues).any(|(line,issue)| !line.starts_with(&format!("▶ 기명식 {} ", issue.class))) { return Ok(None); }
    let common = issues.iter().position(|issue| issue.class == "보통주");
    let preferred = issues.iter().position(|issue| issue.stock == stock && issue.class != "보통주");
    let (Some(common), Some(_)) = (common, preferred) else { return Ok(None); };
    let common = issues.remove(common);
    let preferred = issues.into_iter().find(|issue| issue.stock == stock).unwrap();
    Ok(Some(Notice { issuer: issuer.into(), common, preferred }))
}
