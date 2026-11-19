use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use domain::{StockCode, Venue};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;

use super::request::{AccountNumber, Balance, Executions, OpenOrders, Orderable, Rows, TradingRequest};
use super::switch::{SwitchRecord, SwitchStore};
use crate::api::{self, OrderSide};
use crate::clock::Clock;
use crate::config::Secret;
use crate::kiwoom::rest::{Admission, ContKey, Dispatch, KiwoomError, KiwoomRest, MergeScope, Page, Priority};
use super::journal::Journal;
use super::memory::{PriceBand, PriceBands, RecentOpenOrders};
use crate::symbols::SymbolDirectory;
use crate::kiwoom::stream::{AccountEvent, AccountFeed};

const VERIFY_TTL_SECS: i64 = 60;
const MAX_PAGES: usize = 100;
const ACCOUNT_DIGITS: usize = 10;
const TAIL_DIGITS: usize = 2;
const SALT_BYTES: usize = 16;
const REF_HEX_CHARS: usize = 24;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountChanged {
    pub account_ref: String,
}

#[derive(Debug)]
pub enum TradingError {
    Off,
    FileUnusable(String),
    AccountChanged,
    TailMismatch,
    Kiwoom(KiwoomError),
    Unreadable(&'static str),
    BadRequest(&'static str),
    Journal(String),
    CommandNotFound,
}

impl fmt::Display for TradingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TradingError::Off => f.write_str("주문 사용이 꺼져 있어 계좌를 조회하지 않습니다. 시스템 설정 키움 탭에서 켜세요"),
            TradingError::FileUnusable(why) => write!(f, "주문 사용 스위치 파일을 쓸 수 없어 꺼진 것으로 봅니다({why})"),
            TradingError::AccountChanged => f.write_str("확인한 계좌와 지금 키움이 알려 주는 계좌가 다릅니다. 시스템 설정에서 주문 사용을 다시 켜 확인하세요"),
            TradingError::TailMismatch => f.write_str("입력한 끝 2자리가 키움이 알려 준 계좌와 다릅니다"),
            TradingError::Kiwoom(e) => e.fmt(f),
            TradingError::Unreadable(what) => write!(f, "키움이 준 계좌 자료를 읽지 못했습니다({what})"),
            TradingError::BadRequest(what) => f.write_str(what),
            TradingError::Journal(why) => f.write_str(why),
            TradingError::CommandNotFound => f.write_str("그 command_id의 명령이 없습니다"),
        }
    }
}

impl From<super::journal::JournalError> for TradingError {
    fn from(e: super::journal::JournalError) -> Self {
        TradingError::Journal(e.to_string())
    }
}

impl From<KiwoomError> for TradingError {
    fn from(e: KiwoomError) -> Self {
        TradingError::Kiwoom(e)
    }
}

#[derive(Clone)]
pub(super) struct Verified {
    number: Secret<String>,
    pub(super) account_ref: String,
    at: i64,
}

#[derive(Default)]
struct State {
    mismatch: bool,
    verified: Option<Verified>,
}

pub struct Trading {
    pub(super) rest: KiwoomRest,
    pub(super) clock: Clock,
    store: SwitchStore,
    feed: AccountFeed,
    state: Mutex<State>,
    switch_lock: Mutex<()>,
    pub(super) open: Arc<AtomicBool>,
    write: tokio::sync::Mutex<()>,
    changes: broadcast::Sender<AccountChanged>,
    pub(super) journal: Journal,
    pub(super) symbols: Arc<SymbolDirectory>,
    pub(super) recovered: tokio::sync::OnceCell<Result<(), String>>,
    pub(super) turns: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pub(super) bands: PriceBands,
    pub(super) recent_open: RecentOpenOrders,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn account_ref_of(salt: &str, number: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b":");
    hasher.update(number.as_bytes());
    hex(&hasher.finalize())[..REF_HEX_CHARS].to_owned()
}

fn tail_of(number: &str) -> String {
    number[number.len() - TAIL_DIGITS..].to_owned()
}

fn new_salt() -> String {
    let mut bytes = [0u8; SALT_BYTES];
    getrandom::fill(&mut bytes).expect("운영체제 난수를 읽을 수 있어야 한다");
    hex(&bytes)
}

impl Trading {
    pub fn new(rest: KiwoomRest, clock: Clock, store: SwitchStore, feed: AccountFeed, db: crate::db::AppDb, symbols: Arc<SymbolDirectory>) -> Arc<Trading> {
        let trading = Arc::new(Trading {
            rest,
            clock,
            store,
            feed,
            state: Mutex::new(State::default()),
            switch_lock: Mutex::new(()),
            open: Arc::new(AtomicBool::new(false)),
            write: tokio::sync::Mutex::new(()),
            changes: broadcast::channel(16).0,
            journal: Journal::new(db),
            symbols,
            recovered: tokio::sync::OnceCell::new(),
            turns: Mutex::new(HashMap::new()),
            bands: PriceBands::default(),
            recent_open: RecentOpenOrders::default(),
        });
        if let Err(e) = trading.store.load() {
            tracing::error!(error = %e, "주문 사용 스위치 파일을 읽지 못했습니다. 꺼진 것으로 봅니다");
        }
        drop(trading.enabled_record());
        tokio::spawn(forward_events(Arc::downgrade(&trading), trading.feed.subscribe()));
        trading.start_recovery();
        trading
    }

    pub fn remember_price_band(&self, code: StockCode, upper: Option<u64>, lower: Option<u64>) {
        if let Some(band) = PriceBand::from_limits(upper, lower) {
            self.bands.remember(code, self.clock.now().kst_date(), band);
        }
    }

    pub fn subscribe_changes(&self) -> broadcast::Receiver<AccountChanged> {
        self.changes.subscribe()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("계좌 상태 잠금")
    }

    pub(super) fn enabled_record(&self) -> Result<SwitchRecord, TradingError> {
        let _switch = self.switch_lock.lock().expect("스위치 잠금");
        let record = match self.store.load() {
            Err(e) => Err(TradingError::FileUnusable(e.to_string())),
            Ok(Some(record)) if record.enabled => Ok(record),
            Ok(_) => Err(TradingError::Off),
        };
        self.publish(record.is_ok());
        record
    }

    fn publish(&self, enabled: bool) {
        self.open.store(enabled, Ordering::SeqCst);
        self.feed.set_wanted(enabled);
    }

    async fn read<R: TradingRequest>(&self, req: &R, cont: Option<&ContKey>, priority: Priority) -> Result<Page<R::Response>, TradingError> {
        self.enabled_record()?;
        self.send(req, cont, true, priority).await
    }

    pub fn status(&self) -> api::OrdersStatus {
        drop(self.enabled_record());
        let record = match self.store.load() {
            Err(e) => {
                return api::OrdersStatus { state: api::OrdersState::FileUnusable, account_ref: None, account_tail: None, message: TradingError::FileUnusable(e.to_string()).to_string() };
            }
            Ok(record) => record,
        };
        let Some(record) = record.filter(|r| r.enabled) else {
            return api::OrdersStatus { state: api::OrdersState::Off, account_ref: None, account_tail: None, message: "주문 사용이 꺼져 있습니다. 키움에는 계좌 요청을 보내지 않습니다".to_owned() };
        };
        let (state, message) = if self.lock().mismatch {
            (api::OrdersState::AccountChanged, TradingError::AccountChanged.to_string())
        } else {
            (api::OrdersState::On, "주문 사용이 켜져 있습니다".to_owned())
        };
        api::OrdersStatus { state, account_ref: record.account_ref, account_tail: record.account_tail, message }
    }

    async fn send<R: TradingRequest>(&self, req: &R, cont: Option<&ContKey>, guarded: bool, priority: Priority) -> Result<Page<R::Response>, TradingError> {
        let body = serde_json::to_string(req).expect("요청 타입은 언제나 직렬화된다");
        let open = self.open.clone();
        let admit: Option<Admission> = guarded.then(|| Arc::new(move || open.load(Ordering::SeqCst)) as Admission);
        match self.rest.call_endpoint(Dispatch { endpoint: R::API_ID.into(), body, cont, priority, scope: MergeScope::default(), admit, once: None }, |_| true).await {
            Ok(page) => Ok(page),
            Err(e) if guarded => Err(self.enabled_record().err().unwrap_or(TradingError::Kiwoom(e))),
            Err(e) => Err(TradingError::Kiwoom(e)),
        }
    }

    async fn pages<R: TradingRequest>(&self, req: &R, priority: Priority) -> Result<Vec<R::Response>, TradingError> {
        let (mut pages, mut seen, mut cont) = (Vec::new(), HashSet::new(), None::<ContKey>);
        for _ in 0..MAX_PAGES {
            let page = self.read(req, cont.as_ref(), priority).await?;
            pages.push(page.body);
            match page.next {
                None => return Ok(pages),
                Some(next) if seen.insert(next.clone()) => cont = Some(next),
                Some(_) => return Err(TradingError::Unreadable("연속조회 키 반복")),
            }
        }
        Err(TradingError::Unreadable("연속조회 페이지 수 초과"))
    }

    async fn account_number(&self, guarded: bool, priority: Priority) -> Result<Secret<String>, TradingError> {
        let number = self.send(&AccountNumber {}, None, guarded, priority).await?.body.account.ok_or(TradingError::Unreadable("계좌번호 없음"))?;
        let digits = number.expose();
        if digits.len() != ACCOUNT_DIGITS || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return Err(TradingError::Unreadable("계좌번호 형식"));
        }
        Ok(number)
    }

    pub async fn check_account(&self) -> Result<api::OrdersAccountCheck, TradingError> {
        let number = self.account_number(false, Priority::Screen).await?;
        Ok(api::OrdersAccountCheck { account_tail: tail_of(number.expose()) })
    }

    pub async fn confirmed_account_number(&self) -> Result<api::TradingAccountNumber, TradingError> {
        let account = self.verified(Priority::Screen).await?;
        Ok(api::TradingAccountNumber { account_number: account.number.expose().clone() })
    }

    pub async fn set_enabled(&self, input: api::OrdersSwitchInput) -> Result<api::OrdersStatus, TradingError> {
        let _write = self.write.lock().await;
        if !input.enabled {
            *self.lock() = State::default();
            let switch = self.switch_lock.lock().expect("스위치 잠금");
            self.publish(false);
            let saved = self.store.load().map_err(|e| TradingError::FileUnusable(e.to_string()))?;
            if let Some(record) = saved.filter(|r| r.enabled) {
                self.store.save(&SwitchRecord { enabled: false, ..record }).map_err(|e| TradingError::FileUnusable(e.to_string()))?;
            }
            drop(switch);
            tracing::info!("주문 사용을 껐습니다");
            return Ok(self.status());
        }
        let saved = self.store.load().map_err(|e| TradingError::FileUnusable(e.to_string()))?;
        let tail = input.confirm_account_tail.ok_or(TradingError::BadRequest("켜려면 확인한 계좌 끝 2자리를 보내야 합니다"))?;
        let number = self.account_number(false, Priority::Screen).await?;
        if tail_of(number.expose()) != tail.trim() {
            return Err(TradingError::TailMismatch);
        }
        let (confirm_won, cap_won) = saved.as_ref().map_or((None, None), |r| (r.confirm_won, r.cap_won));
        let salt = saved.map_or_else(new_salt, |r| r.salt);
        let account_ref = account_ref_of(&salt, number.expose());
        let record = SwitchRecord { enabled: true, salt, account_ref: Some(account_ref.clone()), account_tail: Some(tail_of(number.expose())), confirm_won, cap_won };
        let switch = self.switch_lock.lock().expect("스위치 잠금");
        self.store.save(&record).map_err(|e| TradingError::FileUnusable(e.to_string()))?;
        *self.lock() = State { mismatch: false, verified: Some(Verified { number, account_ref, at: self.clock.now().unix() }) };
        self.publish(true);
        drop(switch);
        tracing::info!("주문 사용을 켰습니다");
        Ok(self.status())
    }

    pub(super) async fn verified(&self, priority: Priority) -> Result<Verified, TradingError> {
        self.enabled_record()?;
        let now = self.clock.now().unix();
        {
            let state = self.lock();
            if state.mismatch {
                return Err(TradingError::AccountChanged);
            }
            if let Some(v) = state.verified.as_ref().filter(|v| now - v.at < VERIFY_TTL_SECS) {
                return Ok(v.clone());
            }
        }
        let number = self.account_number(true, priority).await?;
        let record = self.enabled_record()?;
        let account_ref = account_ref_of(&record.salt, number.expose());
        let mut state = self.lock();
        if record.account_ref.as_deref() != Some(account_ref.as_str()) {
            state.mismatch = true;
            state.verified = None;
            return Err(TradingError::AccountChanged);
        }
        let verified = Verified { number, account_ref, at: now };
        state.verified = Some(verified.clone());
        Ok(verified)
    }

    fn own_row(verified: &Verified, row_account: Option<&Secret<String>>) -> Result<(), TradingError> {
        match row_account {
            Some(number) if number.expose() != verified.number.expose() => Err(TradingError::Unreadable("다른 계좌의 행")),
            _ => Ok(()),
        }
    }

    pub async fn balance(&self) -> Result<api::TradingBalance, TradingError> {
        self.balance_at(Priority::Screen).await
    }

    pub(super) async fn balance_at(&self, priority: Priority) -> Result<api::TradingBalance, TradingError> {
        let account = self.verified(priority).await?;
        let pages = self.pages(&Balance::individual_krx(), priority).await?;
        let first = pages.first().ok_or(TradingError::Unreadable("빈 응답"))?;
        let (total_purchase, total_evaluation, total_profit) = (integer(&first.tot_pur_amt)?, integer(&first.tot_evlt_amt)?, integer(&first.tot_evlt_pl)?);
        let mut holdings = Vec::new();
        for row in pages.into_iter().flat_map(Rows::into_rows) {
            let quantity = unsigned(&row.rmnd_qty)?;
            if quantity == 0 || !matches!(row.crd_tp.trim(), "" | "0" | "00") {
                continue;
            }
            let sellable_quantity = unsigned(&row.trde_able_qty)?;
            if sellable_quantity > quantity {
                return Err(TradingError::Unreadable("매매가능수량이 보유수량보다 큼"));
            }
            holdings.push(api::TradingHolding {
                code: stock_code(&row.stk_cd)?,
                name: row.stk_nm.trim().to_owned(),
                quantity,
                sellable_quantity,
                average_price: price(&row.pur_pric)?,
                current_price: price(&row.cur_prc)?,
                evaluation_profit: integer(&row.evltv_prft)?,
                profit_rate_centi: centi(&row.prft_rt),
            });
        }
        Ok(api::TradingBalance { account_ref: account.account_ref, holdings, total_purchase, total_evaluation, total_profit })
    }

    pub async fn open_orders(&self) -> Result<api::TradingOpenOrders, TradingError> {
        let (account_ref, entries) = self.open_entries(Priority::Screen).await?;
        Ok(api::TradingOpenOrders { account_ref, orders: entries.into_iter().map(|e| e.order).collect() })
    }

    pub(super) async fn open_entries(&self, priority: Priority) -> Result<(String, Vec<OpenEntry>), TradingError> {
        let account = self.verified(priority).await?;
        let ticket = self.recent_open.ticket();
        let mut entries = Vec::new();
        for row in self.pages(&OpenOrders::all(), priority).await?.into_iter().flat_map(Rows::into_rows) {
            Self::own_row(&account, row.acnt_no.as_ref())?;
            let (quantity, open_quantity) = (unsigned(&row.ord_qty)?, unsigned(&row.oso_qty)?);
            if open_quantity > quantity {
                return Err(TradingError::Unreadable("미체결수량이 주문수량보다 큼"));
            }
            let original = row.orig_ord_no.trim();
            let order = api::TradingOpenOrder {
                order_no: order_no(&row.ord_no)?,
                code: stock_code(&row.stk_cd)?,
                name: row.stk_nm.trim().to_owned(),
                side: side(&[&row.io_tp_nm, &row.trde_tp])?,
                quantity,
                price: price(&row.ord_pric)?,
                open_quantity,
                status: row.ord_stt.trim().to_owned(),
                ordered_at: row.tm.trim().to_owned(),
                original_order_no: (!original.is_empty() && original != "0000000").then(|| original.to_owned()),
                venue: if row.sor_yn.trim() == "Y" { Venue::Combined } else { venue(&[&row.stex_tp, &row.stex_tp_txt])? }.into(),
            };
            entries.push(OpenEntry { order, ordinary_limit: matches!(row.trde_tp.trim(), "보통" | "0") });
        }
        self.recent_open.keep(ticket, &account.account_ref, self.clock.now().unix(), &entries);
        Ok((account.account_ref, entries))
    }

    pub async fn orderable(&self, code: StockCode, order_side: OrderSide, order_price: u64) -> Result<api::TradingOrderable, TradingError> {
        if order_price == 0 {
            return Err(TradingError::BadRequest("가격은 0보다 커야 합니다"));
        }
        self.orderable_at(code, order_side, order_price, Priority::Screen).await
    }

    pub(super) async fn orderable_at(&self, code: StockCode, order_side: OrderSide, order_price: u64, priority: Priority) -> Result<api::TradingOrderable, TradingError> {
        let account = self.verified(priority).await?;
        let reply = self.read(&Orderable::new(code, order_side, order_price), None, priority).await?.body;
        Ok(api::TradingOrderable { account_ref: account.account_ref, code: code.as_str().to_owned(), side: order_side, price: order_price, amount: unsigned(&reply.profa_100ord_alow_amt)?, quantity: unsigned(&reply.profa_100ord_alowq)? })
    }

    pub async fn executions(&self) -> Result<api::TradingExecutions, TradingError> {
        self.executions_at(Priority::Screen).await
    }

    pub(super) async fn executions_at(&self, priority: Priority) -> Result<api::TradingExecutions, TradingError> {
        let account = self.verified(priority).await?;
        let day = self.clock.now().kst_date();
        let mut executions = Vec::new();
        for row in self.pages(&Executions::of_day(day), priority).await?.into_iter().flat_map(Rows::into_rows) {
            let quantity = unsigned(&row.cntr_qty)?;
            if quantity == 0 {
                continue;
            }
            let time = if row.cnfm_tm.trim().is_empty() { &row.ord_tm } else { &row.cnfm_tm };
            executions.push(api::TradingExecution {
                order_no: order_no(&row.ord_no)?,
                code: stock_code(&row.stk_cd)?,
                name: row.stk_nm.trim().to_owned(),
                side: side(&[&row.io_tp_nm, &row.trde_tp])?,
                quantity,
                price: price(&row.cntr_uv)?,
                time: time.trim().to_owned(),
                venue: venue(&[&row.dmst_stex_tp])?.into(),
            });
        }
        Ok(api::TradingExecutions { account_ref: account.account_ref, day: api::KstDate(day), executions })
    }

    fn on_account_event(&self, event: &AccountEvent) {
        let Ok(record) = self.enabled_record() else { return };
        let Some(account_ref) = record.account_ref else { return };
        if account_ref_of(&record.salt, event.account.expose()) != account_ref {
            return;
        }
        self.recent_open.forget();
        self.notify(account_ref);
    }

    pub(super) fn notify(&self, account_ref: String) {
        let _ = self.changes.send(AccountChanged { account_ref });
    }

    fn on_events_missed(&self) {
        self.recent_open.forget();
        if let Ok(Some(account_ref)) = self.enabled_record().map(|r| r.account_ref) {
            self.notify(account_ref);
        }
    }
}

async fn forward_events(trading: std::sync::Weak<Trading>, mut events: broadcast::Receiver<AccountEvent>) {
    loop {
        let received = events.recv().await;
        let Some(trading) = trading.upgrade() else { return };
        match received {
            Ok(event) => trading.on_account_event(&event),
            Err(broadcast::error::RecvError::Lagged(_)) => trading.on_events_missed(),
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

#[derive(Clone)]
pub(super) struct OpenEntry {
    pub(super) order: api::TradingOpenOrder,
    pub(super) ordinary_limit: bool,
}

fn integer(text: &str) -> Result<i64, TradingError> {
    text.trim().parse::<i64>().map_err(|_| TradingError::Unreadable("숫자가 아닌 값"))
}

fn unsigned(text: &str) -> Result<u64, TradingError> {
    u64::try_from(integer(text)?).map_err(|_| TradingError::Unreadable("음수 수량·금액"))
}

fn price(text: &str) -> Result<u64, TradingError> {
    integer(text).map(i64::unsigned_abs)
}

fn centi(text: &str) -> Option<i64> {
    let text = text.trim();
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    if !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let fraction = format!("{fraction:0<2}");
    let value = whole.parse::<i64>().ok()?.checked_mul(100)?.checked_add(fraction[..2].parse::<i64>().ok()?)?;
    Some(if negative { -value } else { value })
}

fn stock_code(text: &str) -> Result<String, TradingError> {
    let text = text.trim();
    let bare = if text.len() == 7 && matches!(text.as_bytes()[0], b'A' | b'J' | b'Q') { &text[1..] } else { text };
    StockCode::parse(bare).map(|code| code.as_str().to_owned()).map_err(|_| TradingError::Unreadable("종목코드"))
}

fn order_no(text: &str) -> Result<String, TradingError> {
    let text = text.trim();
    if text.len() == 7 && text.bytes().all(|b| b.is_ascii_digit()) { Ok(text.to_owned()) } else { Err(TradingError::Unreadable("주문번호")) }
}

fn side(labels: &[&str]) -> Result<OrderSide, TradingError> {
    let joined = labels.concat();
    if joined.contains("매도") {
        Ok(OrderSide::Sell)
    } else if joined.contains("매수") {
        Ok(OrderSide::Buy)
    } else {
        Err(TradingError::Unreadable("매매구분"))
    }
}

fn venue(labels: &[&str]) -> Result<Venue, TradingError> {
    for label in labels.iter().map(|l| l.trim()) {
        match label {
            "0" | "통합" | "SOR" => return Ok(Venue::Combined),
            "1" | "KRX" => return Ok(Venue::Krx),
            "2" | "NXT" => return Ok(Venue::Nxt),
            _ => {}
        }
    }
    Err(TradingError::Unreadable("거래소구분"))
}

#[cfg(test)]
mod tests {
    use super::centi;

    #[test]
    fn centi_reads_ascii_decimals_and_nothing_else() {
        assert_eq!(centi("+10.00"), Some(1000));
        assert_eq!(centi("1.5"), Some(150));
        assert_eq!(centi("-0.5"), Some(-50));
        assert_eq!(centi("7"), Some(700));
        assert_eq!(centi("1.가"), None);
        assert_eq!(centi(""), None);
        assert_eq!(centi("x.10"), None);
    }
}
