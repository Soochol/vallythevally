//! 메모리 종목 목록과 검색(backend.md §6.6, D5, D12).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use domain::{IndexCode, Market, Symbol, SymbolInfo, SymbolKind};
use tokio::sync::watch;

use crate::kiwoom::api::StockList;
use crate::kiwoom::rest::{KiwoomError, KiwoomRest, MergeScope, Priority};
use crate::kiwoom::wire::{Listing, classify};

pub const READY_WAIT: Duration = Duration::from_secs(10);
const MAX_RESULTS: usize = 20;
const MAX_LIST_PAGES: usize = 10;

struct Entry {
    info: SymbolInfo,
    code: String,
    name: String,
    choseong: String,
    name_key: Vec<(u8, char)>,
}

/// 한 번 받은 목록. 통째로 바꾸기만 하고 고치지 않는다.
pub struct Directory {
    entries: Vec<Entry>,
    by_symbol: HashMap<Symbol, usize>,
}

impl Directory {
    /// 코스피·코스닥 지수 두 개는 언제나 넣는다.
    pub fn build(stocks: Vec<SymbolInfo>) -> Directory {
        let fixed = [
            SymbolInfo { symbol: Symbol::Index(IndexCode::KOSPI), name: "코스피".into(), kind: SymbolKind::Index, market: Market::Kospi, nxt_enabled: false },
            SymbolInfo { symbol: Symbol::Index(IndexCode::KOSDAQ), name: "코스닥".into(), kind: SymbolKind::Index, market: Market::Kosdaq, nxt_enabled: false },
        ];
        let mut dir = Directory { entries: Vec::new(), by_symbol: HashMap::new() };
        for info in fixed.into_iter().chain(stocks) {
            if dir.by_symbol.contains_key(&info.symbol) {
                continue;
            }
            let name = normalize(&info.name);
            dir.by_symbol.insert(info.symbol, dir.entries.len());
            dir.entries.push(Entry {
                code: info.symbol.as_wire(),
                choseong: name.chars().map(choseong_of).collect(),
                name_key: name.chars().map(|c| (char_class(c), c)).collect(),
                name,
                info,
            });
        }
        dir
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, symbol: Symbol) -> Option<&SymbolInfo> {
        self.by_symbol.get(&symbol).map(|&i| &self.entries[i].info)
    }

    pub fn search(&self, query: &str) -> Vec<SymbolInfo> {
        let q = normalize(query);
        if q.is_empty() {
            return Vec::new();
        }
        let initials = q.chars().all(is_initial_consonant);
        let mut hits: Vec<(u8, &Entry)> = self.entries.iter().filter_map(|e| rank(e, &q, initials).map(|r| (r, e))).collect();
        hits.sort_by(|(ra, a), (rb, b)| (ra, a.info.kind, &a.name_key, &a.code).cmp(&(rb, b.info.kind, &b.name_key, &b.code)));
        hits.into_iter().take(MAX_RESULTS).map(|(_, e)| e.info.clone()).collect()
    }
}

/// 코드 완전 일치 > 이름 완전 일치 > 코드 접두 > 이름 접두 > 초성 접두 > 이름 포함 > 초성 포함.
fn rank(e: &Entry, q: &str, initials: bool) -> Option<u8> {
    if e.code == q {
        Some(0)
    } else if e.name == q {
        Some(1)
    } else if e.code.starts_with(q) {
        Some(2)
    } else if e.name.starts_with(q) {
        Some(3)
    } else if initials && e.choseong.starts_with(q) {
        Some(4)
    } else if e.name.contains(q) {
        Some(5)
    } else if initials && e.choseong.contains(q) {
        Some(6)
    } else {
        None
    }
}

/// 앞뒤 공백 자르기, 안쪽 공백 지우기, 영문 대문자.
pub fn normalize(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).map(|c| c.to_ascii_uppercase()).collect()
}

/// 글자 종류 순서: 한글 음절 < 라틴 문자 < 숫자 < 그 밖.
fn char_class(c: char) -> u8 {
    match c {
        '가'..='힣' => 0,
        c if c.is_ascii_alphabetic() => 1,
        c if c.is_ascii_digit() => 2,
        _ => 3,
    }
}

fn is_initial_consonant(c: char) -> bool {
    ('ㄱ'..='ㅎ').contains(&c)
}

const INITIALS: [char; 19] = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

/// 한글 음절은 초성 자모로, 나머지 글자는 그대로.
fn choseong_of(c: char) -> char {
    match c {
        '가'..='힣' => INITIALS[((c as u32 - '가' as u32) / 588) as usize],
        c => c,
    }
}

/// 브라우저 요청이 기다리는 목록. 처음 받기 전에는 비어 있다.
pub struct SymbolDirectory {
    current: watch::Sender<Option<Arc<Directory>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotReady;

impl Default for SymbolDirectory {
    fn default() -> Self {
        SymbolDirectory { current: watch::channel(None).0 }
    }
}

impl SymbolDirectory {
    pub fn replace(&self, dir: Directory) {
        self.current.send_replace(Some(Arc::new(dir)));
    }

    /// 새 목록을 받아 통째로 바꾼다. 실패하면 이전 목록을 그대로 둔다.
    pub async fn refresh(&self, rest: &KiwoomRest, priority: Priority) -> Result<(), KiwoomError> {
        let dir = fetch_directory(rest, priority).await?;
        self.replace(dir);
        Ok(())
    }

    /// 목록이 아직 없으면 최대 10초 기다린다.
    pub async fn ready(&self) -> Result<Arc<Directory>, NotReady> {
        let mut rx = self.current.subscribe();
        let wait = rx.wait_for(Option::is_some);
        match tokio::time::timeout(READY_WAIT, wait).await {
            Ok(Ok(dir)) => Ok(dir.clone().expect("wait_for가 Some을 기다렸다")),
            _ => Err(NotReady),
        }
    }
}

/// ka10099를 `mrkt_tp=0`, `10`으로 불러 목록을 만든다.
pub async fn fetch_directory(rest: &KiwoomRest, priority: Priority) -> Result<Directory, KiwoomError> {
    let mut stocks = Vec::new();
    let mut unknown = Vec::new();
    for req in [StockList::EXCHANGE, StockList::KOSDAQ] {
        let mut cont = None;
        for _ in 0..MAX_LIST_PAGES {
            let page = rest.call(&req, cont.as_ref(), priority, MergeScope::default()).await?;
            for row in &page.body.list {
                match classify(row) {
                    Listing::Include(info) => stocks.push(info),
                    Listing::Exclude => {}
                    Listing::Unknown(why) => unknown.push(why),
                }
            }
            cont = page.next;
            if cont.is_none() {
                break;
            }
        }
    }
    if !unknown.is_empty() {
        tracing::warn!(count = unknown.len(), first = %unknown[0], "종목 목록에 표에 없는 행이 있어 넣지 않았습니다");
    }
    let dir = Directory::build(stocks);
    tracing::info!(count = dir.len(), "종목 목록을 받았습니다");
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::StockCode;

    fn stock(code: &str, name: &str, kind: SymbolKind) -> SymbolInfo {
        let market = if kind == SymbolKind::Etf { Market::Kospi } else { Market::Kosdaq };
        SymbolInfo { symbol: Symbol::Stock(StockCode::parse(code).unwrap()), name: name.into(), kind, market, nxt_enabled: false }
    }

    fn dir() -> Directory {
        use SymbolKind::*;
        Directory::build(vec![
            stock("006400", "삼성SDI", Common),
            stock("005930", "삼성전자", Common),
            stock("005935", "삼성전자우", Preferred),
            stock("028260", "삼성물산", Common),
            stock("102780", "KODEX 삼성그룹", Etf),
            stock("0193W0", "KODEX 삼성전자단일종목레버리지", Etf),
            stock("0030R0", "대신밸류리츠", Reit),
            stock("035420", "NAVER", Common),
            stock("000020", "동화약품", Common),
            stock("001360", "삼성제약", Common),
            stock("009150", "삼성전기", Common),
            stock("123450", "삼성1호", Common),
            stock("123460", "삼성-호", Common),
            stock("003550", "LG", Common),
            stock("034220", "LG디스플레이", Common),
        ])
    }

    fn codes(q: &str) -> Vec<String> {
        dir().search(q).iter().map(|i| i.symbol.as_wire()).collect()
    }

    #[test]
    fn search_ranking_table() {
        let cases: &[(&str, &[&str])] = &[
            ("", &[]),
            ("   ", &[]),
            ("005930", &["005930"]),
            ("00593", &["005930", "005935"]),
            ("삼성전자", &["005930", "005935", "0193W0"]),
            ("삼성", &["028260", "009150", "005930", "001360", "006400", "123450", "123460", "005935", "102780", "0193W0"]),
            ("ㅅㅅㅈㅈ", &["005930", "005935", "0193W0"]),
            ("ㄷㅎ", &["000020"]),
            ("naver", &["035420"]),
            (" Na ver ", &["035420"]),
            ("lg", &["003550", "034220"]),
            ("리츠", &["0030R0"]),
            ("코스", &["IDX:101", "IDX:001"]),
            ("IDX:001", &["IDX:001"]),
            ("없는종목", &[]),
        ];
        for (q, want) in cases {
            assert_eq!(codes(q), *want, "q={q:?}");
        }
    }

    #[test]
    fn name_order_puts_hangul_before_latin_before_digits() {
        let mut names = ["삼성SDI", "삼성전자", "삼성1호", "삼성-호", "삼성물산"].map(|n| {
            let n = normalize(n);
            (n.chars().map(|c| (char_class(c), c)).collect::<Vec<_>>(), n)
        });
        names.sort();
        assert_eq!(names.map(|(_, n)| n), ["삼성물산", "삼성전자", "삼성SDI", "삼성1호", "삼성-호"]);
    }

    #[test]
    fn exact_name_beats_prefix_and_kind_breaks_ties() {
        let d = Directory::build(vec![stock("111110", "가나", SymbolKind::Etf), stock("222220", "가나다", SymbolKind::Common)]);
        let r: Vec<_> = d.search("가나").into_iter().map(|i| i.name).collect();
        assert_eq!(r, ["가나", "가나다"]);
        let d = Directory::build(vec![stock("111110", "가다", SymbolKind::Etf), stock("222220", "가라", SymbolKind::Common)]);
        let r: Vec<_> = d.search("가").into_iter().map(|i| i.name).collect();
        assert_eq!(r, ["가라", "가다"], "같은 순위면 보통주가 ETF보다 앞");
    }

    #[test]
    fn at_most_twenty() {
        let many = (0..30).map(|i| stock(&format!("{:05}0", 10000 + i), &format!("테스트{i:02}"), SymbolKind::Common)).collect();
        assert_eq!(Directory::build(many).search("테스트").len(), 20);
    }

    #[test]
    fn choseong_only_for_all_consonant_input() {
        assert_eq!(choseong_of('삼'), 'ㅅ');
        assert_eq!(choseong_of('까'), 'ㄲ');
        assert_eq!(choseong_of('힣'), 'ㅎ');
        assert_eq!(codes("ㅅㅅ전자"), Vec::<String>::new());
        assert_eq!(dir().get(Symbol::Index(IndexCode::KOSDAQ)).unwrap().name, "코스닥");
    }

    #[tokio::test(start_paused = true)]
    async fn refresh_loads_both_lists_and_keeps_the_old_one_on_failure() {
        use crate::kiwoom::rest::testing::{FakeTransport, ok, token};
        use crate::kiwoom::api::ApiId;
        use std::sync::atomic::{AtomicBool, Ordering};
        let fixture = |name: &str| -> serde_json::Value {
            let path = format!("{}/tests/fixtures/kiwoom/{name}.json", env!("CARGO_MANIFEST_DIR"));
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
        };
        let (exchange, kosdaq) = (fixture("ka10099_0"), fixture("ka10099_10"));
        let down = Arc::new(AtomicBool::new(false));
        let down2 = down.clone();
        let fake = Arc::new(FakeTransport::new(Duration::ZERO, move |s| {
            if s.api_id == ApiId::Au10001 {
                return token(1);
            }
            if down2.load(Ordering::SeqCst) {
                return Err(crate::kiwoom::transport::TransportError("점검".into()));
            }
            ok(if s.body.contains("\"10\"") { kosdaq.clone() } else { exchange.clone() }, None)
        }));
        let clock = crate::clock::Clock::fake(crate::clock::kst(domain::KstDate::new(2026, 11, 9).unwrap(), 7, 45, 0));
        let auth = crate::kiwoom::auth::KiwoomAuth::new(crate::config::Secret::new("k".into()), crate::config::Secret::new("s".into()));
        let rest = KiwoomRest::new(Arc::new(fake.clone()), auth, clock);
        let symbols = SymbolDirectory::default();
        symbols.refresh(&rest, Priority::Screen).await.unwrap();
        let d = symbols.ready().await.unwrap();
        assert_eq!(d.len(), 2 + 15 + 11, "ETN·인프라·뮤추얼펀드 다섯 행은 빠진다");
        assert_eq!(d.search("03481K")[0].kind, SymbolKind::Preferred);
        assert_eq!(d.search("삼성전자")[0].symbol.as_wire(), "005930");
        down.store(true, Ordering::SeqCst);
        assert!(symbols.refresh(&rest, Priority::Background).await.is_err());
        assert_eq!(symbols.ready().await.unwrap().len(), 28, "실패하면 이전 목록을 쓴다");
    }

    #[tokio::test(start_paused = true)]
    async fn requests_wait_for_the_first_list_up_to_ten_seconds() {
        let symbols = Arc::new(SymbolDirectory::default());
        let early = {
            let s = symbols.clone();
            tokio::spawn(async move { s.ready().await.map(|d| d.len()) })
        };
        tokio::time::sleep(Duration::from_secs(3)).await;
        symbols.replace(dir());
        assert_eq!(early.await.unwrap(), Ok(17));

        let empty = SymbolDirectory::default();
        let started = tokio::time::Instant::now();
        assert_eq!(empty.ready().await.err(), Some(NotReady));
        assert_eq!(started.elapsed(), READY_WAIT);
    }
}
