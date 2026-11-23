use std::fmt;
use std::io::{Cursor, Read};
use std::time::Duration;

use domain::{Listing, ListingRow, SymbolInfo, classify};
use futures::future::BoxFuture;

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_ARCHIVE_BYTES: usize = 32 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const SHORT_CODE_WIDTH: usize = 9;
const STANDARD_CODE_WIDTH: usize = 12;
const NAME_START: usize = SHORT_CODE_WIDTH + STANDARD_CODE_WIDTH;
const ETN_CODE_PREFIX: char = 'Q';
const SPAC_CLASS_NAME: &str = "스팩";
const FLAG_YES: &str = "Y";
const SHRINK_DENOMINATOR: usize = 2;

const KOSPI_TAIL_WIDTHS: [usize; 69] = [
    2, 1, 4, 4, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 9, 5, 5, 1, 1, 1, 2, 1, 1, 1, 2, 2, 2, 3, 1, 3, 12, 12, 8, 15, 21, 2, 7, 1, 1, 1, 1, 9, 9, 9, 5, 9, 8, 9, 3, 1, 1, 1,
];
const KOSDAQ_TAIL_WIDTHS: [usize; 62] =
    [2, 1, 4, 4, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 9, 5, 5, 1, 1, 1, 2, 1, 1, 1, 2, 2, 2, 3, 1, 3, 12, 12, 8, 15, 21, 2, 7, 1, 1, 1, 1, 9, 9, 9, 5, 9, 8, 9, 3, 1, 1];
const KOSPI_TAIL_CHARS: usize = 227;
const KOSDAQ_TAIL_CHARS: usize = 221;
const GROUP_FIELD: usize = 0;
const KOSPI_SPAC_FIELD: usize = 19;
const KOSDAQ_SPAC_FIELD: usize = 14;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MasterMarket {
    Kospi,
    Kosdaq,
}

impl MasterMarket {
    pub const ALL: [MasterMarket; 2] = [MasterMarket::Kospi, MasterMarket::Kosdaq];

    pub fn archive_path(self) -> &'static str {
        match self {
            MasterMarket::Kospi => "/common/master/kospi_code.mst.zip",
            MasterMarket::Kosdaq => "/common/master/kosdaq_code.mst.zip",
        }
    }

    fn label(self) -> &'static str {
        match self {
            MasterMarket::Kospi => "코스피",
            MasterMarket::Kosdaq => "코스닥",
        }
    }

    fn tail_widths(self) -> &'static [usize] {
        match self {
            MasterMarket::Kospi => &KOSPI_TAIL_WIDTHS,
            MasterMarket::Kosdaq => &KOSDAQ_TAIL_WIDTHS,
        }
    }

    fn tail_chars(self) -> usize {
        match self {
            MasterMarket::Kospi => KOSPI_TAIL_CHARS,
            MasterMarket::Kosdaq => KOSDAQ_TAIL_CHARS,
        }
    }

    fn spac_field(self) -> usize {
        match self {
            MasterMarket::Kospi => KOSPI_SPAC_FIELD,
            MasterMarket::Kosdaq => KOSDAQ_SPAC_FIELD,
        }
    }

    fn stock_market_code(self) -> &'static str {
        match self {
            MasterMarket::Kospi => "0",
            MasterMarket::Kosdaq => "10",
        }
    }

    fn market_code_of_group(self, group: &str) -> Option<&'static str> {
        match (group, self) {
            ("ST", _) => Some(self.stock_market_code()),
            ("EF", MasterMarket::Kospi) => Some("8"),
            ("EN", MasterMarket::Kospi) => Some("60"),
            ("RT", MasterMarket::Kospi) => Some("6"),
            ("IF", MasterMarket::Kospi) => Some("2"),
            ("MF", MasterMarket::Kospi) => Some("4"),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MasterError {
    Download(MasterMarket, String),
    Archive(MasterMarket),
    Encoding(MasterMarket),
    Columns { market: MasterMarket, line: usize },
    Empty(MasterMarket),
    Shrunk { market: MasterMarket, previous: usize, now: usize },
}

impl fmt::Display for MasterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MasterError::Download(market, why) => write!(f, "한투 {} 종목 마스터를 받지 못했습니다: {why}", market.label()),
            MasterError::Archive(market) => write!(f, "한투 {} 종목 마스터 압축 파일을 열지 못했습니다", market.label()),
            MasterError::Encoding(market) => write!(f, "한투 {} 종목 마스터가 cp949 글자가 아닙니다", market.label()),
            MasterError::Columns { market, line } => write!(f, "한투 {} 종목 마스터 {line}번째 줄에 열이 모자랍니다", market.label()),
            MasterError::Empty(market) => write!(f, "한투 {} 종목 마스터에 종목이 없습니다", market.label()),
            MasterError::Shrunk { market, previous, now } => write!(f, "한투 {} 종목 마스터의 종목 수가 {previous}개에서 {now}개로 절반 넘게 줄었습니다", market.label()),
        }
    }
}

impl std::error::Error for MasterError {}

pub trait MasterDownload: Send + Sync + 'static {
    fn download(&self, market: MasterMarket) -> BoxFuture<'static, Result<Vec<u8>, MasterError>>;
}

pub struct HttpMasterDownload {
    client: reqwest::Client,
    base_url: String,
}

impl HttpMasterDownload {
    pub fn new(base_url: String) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder().tls_backend_rustls().timeout(DOWNLOAD_TIMEOUT).build().map_err(reqwest::Error::without_url)?;
        Ok(HttpMasterDownload { client, base_url })
    }
}

impl MasterDownload for HttpMasterDownload {
    fn download(&self, market: MasterMarket) -> BoxFuture<'static, Result<Vec<u8>, MasterError>> {
        let request = self.client.get(format!("{}{}", self.base_url, market.archive_path()));
        Box::pin(async move {
            let failed = |why: String| MasterError::Download(market, why);
            let response = request.send().await.map_err(|e| failed(if e.is_timeout() { "시간 초과".into() } else { "연결 실패".into() }))?;
            let status = response.status();
            if !status.is_success() {
                return Err(failed(format!("HTTP {}", status.as_u16())));
            }
            let body = response.bytes().await.map_err(|_| failed("본문 읽기 실패".into()))?;
            if body.len() > MAX_ARCHIVE_BYTES {
                return Err(failed("압축 파일이 너무 큽니다".into()));
            }
            Ok(body.to_vec())
        })
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MasterCounts {
    pub kospi: usize,
    pub kosdaq: usize,
}

impl MasterCounts {
    fn of(self, market: MasterMarket) -> usize {
        match market {
            MasterMarket::Kospi => self.kospi,
            MasterMarket::Kosdaq => self.kosdaq,
        }
    }

    fn add(&mut self, market: MasterMarket, count: usize) {
        match market {
            MasterMarket::Kospi => self.kospi += count,
            MasterMarket::Kosdaq => self.kosdaq += count,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterListing {
    pub stocks: Vec<SymbolInfo>,
    pub counts: MasterCounts,
    pub unrecognized: Vec<String>,
}

pub async fn load_master(download: &dyn MasterDownload, previous: Option<MasterCounts>) -> Result<MasterListing, MasterError> {
    let (kospi, kosdaq) = futures::future::join(download.download(MasterMarket::Kospi), download.download(MasterMarket::Kosdaq)).await;
    let mut listing = MasterListing { stocks: Vec::new(), counts: MasterCounts::default(), unrecognized: Vec::new() };
    for (market, archive) in [(MasterMarket::Kospi, kospi?), (MasterMarket::Kosdaq, kosdaq?)] {
        let text = unpack(market, &archive)?;
        let rows = parse_master(market, &text)?;
        for row in rows {
            match classify(&row) {
                Listing::Include(info) => {
                    listing.counts.add(market, 1);
                    listing.stocks.push(info);
                }
                Listing::Unknown(why) => listing.unrecognized.push(why),
            }
        }
        if let Some(previous) = previous.map(|counts| counts.of(market)).filter(|previous| listing.counts.of(market) < previous / SHRINK_DENOMINATOR) {
            return Err(MasterError::Shrunk { market, previous, now: listing.counts.of(market) });
        }
    }
    Ok(listing)
}

fn unpack(market: MasterMarket, archive: &[u8]) -> Result<String, MasterError> {
    let mut zip = zip::ZipArchive::new(Cursor::new(archive)).map_err(|_| MasterError::Archive(market))?;
    for index in 0..zip.len() {
        let file = zip.by_index(index).map_err(|_| MasterError::Archive(market))?;
        if !file.name().ends_with(".mst") {
            continue;
        }
        let mut raw = Vec::new();
        file.take(MAX_FILE_BYTES).read_to_end(&mut raw).map_err(|_| MasterError::Archive(market))?;
        let (text, _, had_errors) = encoding_rs::EUC_KR.decode(&raw);
        if had_errors {
            return Err(MasterError::Encoding(market));
        }
        return Ok(text.into_owned());
    }
    Err(MasterError::Archive(market))
}

pub fn parse_master(market: MasterMarket, text: &str) -> Result<Vec<ListingRow>, MasterError> {
    let tail_chars = market.tail_chars();
    let mut rows = Vec::new();
    for (index, line) in text.lines().enumerate().filter(|(_, line)| !line.trim().is_empty()) {
        let chars: Vec<char> = line.chars().collect();
        if chars.len() < NAME_START + tail_chars {
            return Err(MasterError::Columns { market, line: index + 1 });
        }
        let head_end = chars.len() - tail_chars;
        let text_of = |range: std::ops::Range<usize>| chars[range].iter().collect::<String>();
        let tail = |field: usize| tail_field(market, &chars[head_end..], field);
        let Some(market_code) = market.market_code_of_group(tail(GROUP_FIELD).as_str()) else {
            continue;
        };
        let code = normalized_code(text_of(0..SHORT_CODE_WIDTH).trim());
        let name = text_of((NAME_START).min(head_end)..head_end).trim().to_owned();
        let company_class_name = if tail(market.spac_field()) == FLAG_YES { SPAC_CLASS_NAME } else { "" };
        rows.push(ListingRow { code, name, market_code: market_code.into(), company_class_name: company_class_name.into(), ..ListingRow::default() });
    }
    if rows.is_empty() {
        return Err(MasterError::Empty(market));
    }
    Ok(rows)
}

fn tail_field(market: MasterMarket, tail: &[char], field: usize) -> String {
    let widths = market.tail_widths();
    let start: usize = widths[..field].iter().sum();
    tail.get(start..start + widths[field]).map(|chars| chars.iter().collect::<String>().trim().to_owned()).unwrap_or_default()
}

fn normalized_code(code: &str) -> String {
    match code.strip_prefix(ETN_CODE_PREFIX) {
        Some(rest) if rest.len() == 6 => rest.to_owned(),
        _ => code.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(market: MasterMarket, code: &str, name: &str, group: &str, spac: bool) -> String {
        let mut tail = vec![' '; market.tail_chars()];
        for (i, c) in group.chars().enumerate() {
            tail[i] = c;
        }
        if spac {
            let start: usize = market.tail_widths()[..market.spac_field()].iter().sum();
            tail[start] = 'Y';
        }
        format!("{code:<9}{:<12}{name}{}", "KR7000000000", tail.into_iter().collect::<String>())
    }

    #[test]
    fn a_q_prefixed_etn_code_is_normalized_and_other_codes_are_kept() {
        assert_eq!(normalized_code("Q500061"), "500061");
        assert_eq!(normalized_code("005930"), "005930");
        assert_eq!(normalized_code("Q50006"), "Q50006");
        assert_eq!(normalized_code("0000D0"), "0000D0");
    }

    #[test]
    fn groups_outside_the_directory_are_dropped_and_spacs_are_marked() {
        let text = [
            line(MasterMarket::Kospi, "005930", "삼성전자", "ST", false),
            line(MasterMarket::Kospi, "900110", "해외주식", "FS", false),
            line(MasterMarket::Kospi, "Q500061", "가상 ETN", "EN", false),
            line(MasterMarket::Kospi, "069500", "가상 ETF", "EF", false),
        ]
        .join("\r\n");
        let rows = parse_master(MasterMarket::Kospi, &text).unwrap();
        let seen: Vec<_> = rows.iter().map(|r| (r.code.as_str(), r.name.as_str(), r.market_code.as_str())).collect();
        assert_eq!(seen, [("005930", "삼성전자", "0"), ("500061", "가상 ETN", "60"), ("069500", "가상 ETF", "8")]);
        let spac = parse_master(MasterMarket::Kosdaq, &line(MasterMarket::Kosdaq, "467930", "가상스팩", "ST", true)).unwrap();
        assert_eq!(spac[0].company_class_name, SPAC_CLASS_NAME);
    }

    #[test]
    fn a_short_line_rejects_the_whole_file() {
        let text = format!("{}\n005930 짧은 줄", line(MasterMarket::Kospi, "005930", "삼성전자", "ST", false));
        assert_eq!(parse_master(MasterMarket::Kospi, &text), Err(MasterError::Columns { market: MasterMarket::Kospi, line: 2 }));
        assert_eq!(parse_master(MasterMarket::Kospi, "\n \n"), Err(MasterError::Empty(MasterMarket::Kospi)));
    }
}
