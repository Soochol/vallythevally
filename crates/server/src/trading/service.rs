use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use domain::{StockCode, Venue};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;

use super::request::{AccountNumber, Balance, BalanceRow, Executions, OpenOrders, Orderable, OrderableReply, Rows, TradingRequest};
use super::switch::{SwitchRecord, SwitchStore};
use super::kis::{KisDesk, KisOrigin};
use super::kis_account::KisAccountNumber;
use crate::api::{self, Broker, OrderSide};
use crate::clock::Clock;
use crate::config::Secret;
use crate::kiwoom::key_file::KeyId;
use crate::kiwoom::keys::KeyRing;
use crate::kiwoom::rest::{Admission, ContKey, Dispatch, KiwoomError, KiwoomRest, MergeScope, Page, Priority};
use super::journal::Journal;
use super::memory::{FillVenues, PriceBands, RecentOpenOrders};
use crate::symbols::SymbolDirectory;
use crate::kiwoom::stream::{AccountEvent, AccountFeed};
use crate::kis::notice::{FillNotice, KisNotices};
use crate::kis::rest::KisError;

const VERIFY_TTL_SECS: i64 = 60;
const MAX_PAGES: usize = 100;
const ACCOUNT_DIGITS: usize = 10;
const TAIL_DIGITS: usize = 2;
const USER_VISIBLE_DIGITS: usize = 8;
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
    UnknownAccount,
    UnknownKey,
    SameAccount(String),
    Kis(KisError),
    NoKisAccount,
    KisNotConnected,
}

impl fmt::Display for TradingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TradingError::Off => f.write_str("주문 사용이 꺼져 있어 계좌를 조회하지 않습니다. 시스템 설정 증권사 · 계좌에서 켜세요"),
            TradingError::FileUnusable(why) => write!(f, "주문 사용 스위치 파일을 쓸 수 없어 꺼진 것으로 봅니다({why})"),
            TradingError::AccountChanged => f.write_str("확인한 계좌와 지금 계좌가 다릅니다. 시스템 설정에서 주문 사용을 다시 켜 확인하세요"),
            TradingError::TailMismatch => f.write_str("입력한 끝 2자리가 이 키의 계좌번호와 다릅니다"),
            TradingError::Kiwoom(e) => e.fmt(f),
            TradingError::Unreadable(what) => write!(f, "증권사가 준 계좌 자료를 읽지 못했습니다({what})"),
            TradingError::BadRequest(what) => f.write_str(what),
            TradingError::Journal(why) => f.write_str(why),
            TradingError::CommandNotFound => f.write_str("그 command_id의 명령이 없습니다"),
            TradingError::UnknownAccount => f.write_str("알 수 없는 계좌입니다. 시스템 설정 증권사 · 계좌에서 계좌를 확인하세요"),
            TradingError::UnknownKey => f.write_str("그 키가 없습니다"),
            TradingError::SameAccount(alias) => write!(f, "‘{alias}’와 같은 계좌입니다. 주문은 한 줄에서만 씁니다"),
            TradingError::Kis(e) => e.fmt(f),
            TradingError::NoKisAccount => f.write_str("계좌번호를 넣어야 주문 사용을 켤 수 있습니다"),
            TradingError::KisNotConnected => f.write_str("한투에 연결되지 않아 계좌 요청을 보내지 않았습니다. 시스템 설정에서 연결하세요"),
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

impl From<KisError> for TradingError {
    fn from(e: KisError) -> Self {
        TradingError::Kis(e)
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

pub(super) enum Lanes {
    Fixed { rest: KiwoomRest, feed: AccountFeed },
    Keyed { ring: Arc<KeyRing>, key: KeyId },
    Kis { ring: Arc<KeyRing>, key: KeyId },
}

impl Lanes {
    fn broker(&self) -> Broker {
        match self {
            Lanes::Fixed { .. } | Lanes::Keyed { .. } => Broker::Kiwoom,
            Lanes::Kis { .. } => Broker::Kis,
        }
    }

    fn rest(&self) -> Result<KiwoomRest, TradingError> {
        match self {
            Lanes::Fixed { rest, .. } => Ok(rest.clone()),
            Lanes::Keyed { ring, key } => ring.view_of(key).map(|view| view.lane.rest).ok_or(TradingError::UnknownKey),
            Lanes::Kis { .. } => Err(TradingError::UnknownKey),
        }
    }

    fn feed(&self) -> Option<AccountFeed> {
        match self {
            Lanes::Fixed { feed, .. } => Some(feed.clone()),
            Lanes::Keyed { ring, key } => ring.view_of(key).map(|view| view.lane.account),
            Lanes::Kis { .. } => None,
        }
    }

    fn notices(&self) -> Option<(KisNotices, Option<Secret<String>>)> {
        let Lanes::Kis { ring, key } = self else { return None };
        let view = ring.kis_view_of(key)?;
        Some((view.lane.notices, view.account.hts_id.map(|id| Secret::new(id.expose().to_owned()))))
    }

    fn kis_account(&self) -> Result<KisAccountNumber, TradingError> {
        let Lanes::Kis { ring, key } = self else { return Err(TradingError::UnknownKey) };
        ring.kis_view_of(key).ok_or(TradingError::UnknownKey)?.account.number.ok_or(TradingError::NoKisAccount)
    }

    fn kis_desk(&self) -> Result<KisDesk, TradingError> {
        let Lanes::Kis { ring, key } = self else { return Err(TradingError::UnknownKey) };
        let view = ring.kis_view_of(key).ok_or(TradingError::UnknownKey)?;
        let account = view.account.number.ok_or(TradingError::NoKisAccount)?;
        if !view.lane.link.is_connected() {
            return Err(TradingError::KisNotConnected);
        }
        Ok(KisDesk { rest: view.lane.rest, account })
    }
}

pub(super) struct Shared {
    pub(super) clock: Clock,
    pub(super) journal: Journal,
    pub(super) symbols: Arc<SymbolDirectory>,
    pub(super) bands: Arc<PriceBands>,
    pub(super) recovered: Arc<tokio::sync::OnceCell<Result<(), String>>>,
    pub(super) changes: broadcast::Sender<AccountChanged>,
    pub(super) quote_rest: KiwoomRest,
}

impl Shared {
    pub(super) fn new(clock: Clock, db: crate::db::AppDb, symbols: Arc<SymbolDirectory>, quote_rest: KiwoomRest) -> Shared {
        Shared { clock, journal: Journal::new(db), symbols, bands: Arc::default(), recovered: Arc::default(), changes: broadcast::channel(16).0, quote_rest }
    }

    pub(super) fn clone_parts(&self) -> Shared {
        Shared { clock: self.clock.clone(), journal: self.journal.clone(), symbols: self.symbols.clone(), bands: self.bands.clone(), recovered: self.recovered.clone(), changes: self.changes.clone(), quote_rest: self.quote_rest.clone() }
    }
}

pub struct Trading {
    lanes: Lanes,
    pub(super) quote_rest: KiwoomRest,
    pub(super) clock: Clock,
    store: Arc<SwitchStore>,
    pub(super) key: KeyId,
    state: Mutex<State>,
    switch_lock: Mutex<()>,
    pub(super) open: Arc<AtomicBool>,
    write: tokio::sync::Mutex<()>,
    changes: broadcast::Sender<AccountChanged>,
    pub(super) journal: Journal,
    pub(super) symbols: Arc<SymbolDirectory>,
    pub(super) recovered: Arc<tokio::sync::OnceCell<Result<(), String>>>,
    pub(super) turns: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pub(super) bands: Arc<PriceBands>,
    pub(super) recent_open: RecentOpenOrders,
    pub(super) fill_venues: FillVenues,
    feed_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub(super) fn account_ref_of(salt: &str, number: &str) -> String {
    account_ref_for(Broker::Kiwoom, salt, number)
}

pub(super) fn account_ref_for(broker: Broker, salt: &str, number: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(match broker {
        Broker::Kiwoom => b":".as_slice(),
        Broker::Kis => b":kis:".as_slice(),
    });
    hasher.update(number.as_bytes());
    hex(&hasher.finalize())[..REF_HEX_CHARS].to_owned()
}

fn desk_is_verified(desk: &KisAccountNumber, verified: &Verified) -> bool {
    desk.digits().expose() == verified.number.expose()
}

fn desk_has_ref(desk: &KisAccountNumber, salt: &str, account_ref: &str) -> bool {
    account_ref_for(Broker::Kis, salt, desk.digits().expose()) == account_ref
}

fn tail_of(number: &str) -> String {
    number[USER_VISIBLE_DIGITS - TAIL_DIGITS..USER_VISIBLE_DIGITS].to_owned()
}

fn new_salt() -> String {
    let mut bytes = [0u8; SALT_BYTES];
    getrandom::fill(&mut bytes).expect("운영체제 난수를 읽을 수 있어야 한다");
    hex(&bytes)
}

pub const FIXED_KEY_ID: &str = "market";

impl Trading {
    pub fn new(rest: KiwoomRest, clock: Clock, store: SwitchStore, feed: AccountFeed, db: crate::db::AppDb, symbols: Arc<SymbolDirectory>) -> Arc<Trading> {
        let shared = Shared::new(clock, db, symbols, rest.clone());
        let key = KeyId::parse(FIXED_KEY_ID).expect("고정 키 ID는 올바른 키 ID다");
        store.claim_legacy(&key);
        Trading::assemble(Lanes::Fixed { rest, feed }, key, Arc::new(store), shared)
    }

    pub(super) fn assemble(lanes: Lanes, key: KeyId, store: Arc<SwitchStore>, shared: Shared) -> Arc<Trading> {
        let Shared { clock, journal, symbols, bands, recovered, changes, quote_rest } = shared;
        let trading = Arc::new(Trading {
            lanes,
            quote_rest,
            clock,
            store,
            key,
            state: Mutex::new(State::default()),
            switch_lock: Mutex::new(()),
            open: Arc::new(AtomicBool::new(false)),
            write: tokio::sync::Mutex::new(()),
            changes,
            journal,
            symbols,
            recovered,
            turns: Mutex::new(HashMap::new()),
            bands,
            recent_open: RecentOpenOrders::default(),
            fill_venues: FillVenues::default(),
            feed_task: Mutex::new(None),
        });
        if let Err(e) = trading.store.load(&trading.key) {
            tracing::error!(error = %e, "주문 사용 스위치 파일을 읽지 못했습니다. 꺼진 것으로 봅니다");
        }
        drop(trading.enabled_record());
        trading.follow_feed();
        trading.start_recovery();
        trading
    }

    pub(super) fn follow_feed(self: &Arc<Self>) {
        let task = match (self.lanes.feed(), self.lanes.notices()) {
            (Some(feed), _) => tokio::spawn(forward_events(Arc::downgrade(self), feed.subscribe())),
            (None, Some((notices, _))) => tokio::spawn(forward_notices(Arc::downgrade(self), notices.subscribe())),
            (None, None) => return,
        };
        if let Some(old) = self.feed_task.lock().expect("계좌 실시간 작업 잠금").replace(task) {
            old.abort();
        }
    }

    pub(super) fn forget_verified(&self) {
        self.lock().verified = None;
    }

    pub(super) fn republish(&self) {
        drop(self.enabled_record());
    }

    pub(super) fn rest(&self) -> Result<KiwoomRest, TradingError> {
        self.lanes.rest()
    }

    pub(super) fn broker(&self) -> Broker {
        self.lanes.broker()
    }

    pub(super) fn kis_desk(&self) -> Result<KisDesk, TradingError> {
        self.lanes.kis_desk()
    }

    pub(super) fn kis_desk_of(&self, verified: &Verified) -> Result<KisDesk, TradingError> {
        let desk = self.lanes.kis_desk()?;
        if !desk_is_verified(&desk.account, verified) {
            self.forget_verified();
            return Err(TradingError::AccountChanged);
        }
        Ok(desk)
    }

    pub(super) fn kis_desk_for_ref(&self, account_ref: &str) -> Result<KisDesk, TradingError> {
        let desk = self.lanes.kis_desk()?;
        let salt = self.enabled_record()?.salt;
        if !desk_has_ref(&desk.account, &salt, account_ref) {
            self.forget_verified();
            return Err(TradingError::AccountChanged);
        }
        Ok(desk)
    }

    pub fn subscribe_changes(&self) -> broadcast::Receiver<AccountChanged> {
        self.changes.subscribe()
    }

    pub(super) fn record(&self) -> Result<Option<SwitchRecord>, crate::kiwoom::private_file::FileError> {
        self.store.load(&self.key)
    }

    fn save_record(&self, record: &SwitchRecord) -> Result<(), TradingError> {
        self.store.save(&self.key, record).map_err(|e| TradingError::FileUnusable(e.to_string()))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("계좌 상태 잠금")
    }

    pub(super) fn enabled_record(&self) -> Result<SwitchRecord, TradingError> {
        let _switch = self.switch_lock.lock().expect("스위치 잠금");
        let record = match self.record() {
            Err(e) => Err(TradingError::FileUnusable(e.to_string())),
            Ok(Some(record)) if record.enabled => Ok(record),
            Ok(_) => Err(TradingError::Off),
        };
        self.publish(record.is_ok());
        record
    }

    fn publish(&self, enabled: bool) {
        self.open.store(enabled, Ordering::SeqCst);
        if let Some(feed) = self.lanes.feed() {
            feed.set_wanted(enabled);
        }
        if let Some((notices, hts_id)) = self.lanes.notices() {
            notices.want(hts_id.filter(|_| enabled));
        }
    }

    async fn read<R: TradingRequest>(&self, req: &R, cont: Option<&ContKey>, priority: Priority) -> Result<Page<R::Response>, TradingError> {
        self.enabled_record()?;
        self.send(req, cont, true, priority).await
    }

    pub fn status(&self) -> api::OrdersStatus {
        drop(self.enabled_record());
        let record = match self.record() {
            Err(e) => {
                return api::OrdersStatus { state: api::OrdersState::FileUnusable, account_ref: None, account_tail: None, message: TradingError::FileUnusable(e.to_string()).to_string(), accounts: Vec::new() };
            }
            Ok(record) => record,
        };
        let Some(record) = record.filter(|r| r.enabled) else {
            let message = match self.broker() {
                Broker::Kiwoom => "주문 사용이 꺼져 있습니다. 키움에는 계좌 요청을 보내지 않습니다",
                Broker::Kis => "주문 사용이 꺼져 있습니다. 한투에는 계좌 요청을 보내지 않습니다",
            };
            return api::OrdersStatus { state: api::OrdersState::Off, account_ref: None, account_tail: None, message: message.to_owned(), accounts: Vec::new() };
        };
        let (state, message) = if self.lock().mismatch {
            (api::OrdersState::AccountChanged, TradingError::AccountChanged.to_string())
        } else {
            (api::OrdersState::On, "주문 사용이 켜져 있습니다".to_owned())
        };
        api::OrdersStatus { state, account_ref: record.account_ref, account_tail: record.account_tail, message, accounts: Vec::new() }
    }

    pub(super) fn listing(&self, alias: &str, market: bool) -> api::OrdersAccount {
        let state = self.status().state;
        let (account_ref, account_tail) = self.record().ok().flatten().map_or((None, None), |record| (record.account_ref, record.account_tail));
        api::OrdersAccount { key_id: self.key.as_str().to_owned(), broker: self.broker(), alias: alias.to_owned(), market, state, account_ref, account_tail }
    }

    async fn send<R: TradingRequest>(&self, req: &R, cont: Option<&ContKey>, guarded: bool, priority: Priority) -> Result<Page<R::Response>, TradingError> {
        let body = serde_json::to_string(req).expect("요청 타입은 언제나 직렬화된다");
        let open = self.open.clone();
        let admit: Option<Admission> = guarded.then(|| Arc::new(move || open.load(Ordering::SeqCst)) as Admission);
        let rest = self.rest()?;
        match rest.call_endpoint(Dispatch { endpoint: R::API_ID.into(), body, cont, priority, scope: MergeScope::default(), admit, once: None }, |_| true).await {
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

    async fn current_account(&self, guarded: bool, priority: Priority) -> Result<Secret<String>, TradingError> {
        match self.broker() {
            Broker::Kiwoom => self.account_number(guarded, priority).await,
            Broker::Kis => self.lanes.kis_account().map(|number| number.digits()),
        }
    }

    async fn confirm_account(&self) -> Result<Secret<String>, TradingError> {
        match self.broker() {
            Broker::Kiwoom => self.account_number(false, Priority::Screen).await,
            Broker::Kis => {
                self.lanes.kis_account()?;
                let desk = self.kis_desk()?;
                self.kis_balance_reachable(&desk).await?;
                Ok(desk.account.digits())
            }
        }
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
        let number = self.confirm_account().await?;
        Ok(api::OrdersAccountCheck { broker: self.broker(), account_tail: tail_of(number.expose()) })
    }

    pub async fn confirmed_account_number(&self) -> Result<api::TradingAccountNumber, TradingError> {
        let account = self.verified(Priority::Screen).await?;
        Ok(api::TradingAccountNumber { account_number: account.number.expose().clone() })
    }

    pub async fn set_enabled(&self, input: api::OrdersSwitchInput) -> Result<api::OrdersStatus, TradingError> {
        self.set_enabled_unless_taken(input, &|_| None).await
    }

    pub(super) async fn set_enabled_unless_taken(&self, input: api::OrdersSwitchInput, taken_by: &(dyn Fn(&str) -> Option<String> + Sync)) -> Result<api::OrdersStatus, TradingError> {
        let _write = self.write.lock().await;
        self.recent_open.forget();
        if !input.enabled {
            *self.lock() = State::default();
            let switch = self.switch_lock.lock().expect("스위치 잠금");
            self.publish(false);
            let saved = self.record().map_err(|e| TradingError::FileUnusable(e.to_string()))?;
            if let Some(record) = saved.filter(|r| r.enabled) {
                self.save_record(&SwitchRecord { enabled: false, ..record })?;
            }
            drop(switch);
            tracing::info!("주문 사용을 껐습니다");
            return Ok(self.status());
        }
        let saved = self.record().map_err(|e| TradingError::FileUnusable(e.to_string()))?;
        if self.broker() == Broker::Kis {
            self.lanes.kis_account()?;
        }
        let tail = input.confirm_account_tail.ok_or(TradingError::BadRequest("켜려면 확인한 계좌 끝 2자리를 보내야 합니다"))?;
        let number = self.confirm_account().await?;
        if tail_of(number.expose()) != tail.trim() {
            return Err(TradingError::TailMismatch);
        }
        let (confirm_won, cap_won, margin_policy) = saved.as_ref().map_or((None, None, api::MarginPolicy::default()), |r| (r.confirm_won, r.cap_won, r.margin_policy));
        let shared_salt = self.store.shared_salt().map_err(|e| TradingError::FileUnusable(e.to_string()))?;
        let salt = saved.map(|r| r.salt).or(shared_salt).unwrap_or_else(new_salt);
        let account_ref = account_ref_for(self.broker(), &salt, number.expose());
        if let Some(alias) = taken_by(&account_ref) {
            tracing::info!("같은 계좌가 다른 줄에서 주문 사용 중이라 켜지 않았습니다");
            return Err(TradingError::SameAccount(alias));
        }
        let record = SwitchRecord { enabled: true, salt, account_ref: Some(account_ref.clone()), account_tail: Some(tail_of(number.expose())), legacy_product_tail: None, confirm_won, cap_won, margin_policy };
        let switch = self.switch_lock.lock().expect("스위치 잠금");
        self.save_record(&record)?;
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
        let number = self.current_account(true, priority).await?;
        let record = self.enabled_record()?;
        let account_ref = account_ref_for(self.broker(), &record.salt, number.expose());
        let same_account = record.account_ref.as_deref() == Some(account_ref.as_str());
        if same_account && record.account_tail.is_none() {
            self.fill_account_tail(&account_ref, tail_of(number.expose()))?;
        }
        let mut state = self.lock();
        if !same_account {
            state.mismatch = true;
            state.verified = None;
            return Err(TradingError::AccountChanged);
        }
        let verified = Verified { number, account_ref, at: now };
        state.verified = Some(verified.clone());
        Ok(verified)
    }

    fn fill_account_tail(&self, account_ref: &str, tail: String) -> Result<(), TradingError> {
        let _switch = self.switch_lock.lock().expect("스위치 잠금");
        let file_unusable = |e: crate::kiwoom::private_file::FileError| TradingError::FileUnusable(e.to_string());
        match self.record().map_err(file_unusable)? {
            Some(record) if record.enabled && record.account_tail.is_none() && record.account_ref.as_deref() == Some(account_ref) => {
                self.store.save(&self.key, &SwitchRecord { account_tail: Some(tail), legacy_product_tail: None, ..record }).map_err(file_unusable)
            }
            _ => Ok(()),
        }
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
        if self.broker() == Broker::Kis {
            return self.kis_balance(&self.kis_desk_of(&account)?, &account, priority).await;
        }
        let pages = self.pages(&Balance::individual_krx(), priority).await?;
        let first = pages.first().ok_or(TradingError::Unreadable("빈 응답"))?;
        let (total_purchase, total_evaluation, total_profit) = (integer(&first.tot_pur_amt)?, integer(&first.tot_evlt_amt)?, integer(&first.tot_evlt_pl)?);
        let mut holdings = Vec::new();
        let mut credit_holdings = Vec::new();
        for row in pages.into_iter().flat_map(Rows::into_rows) {
            if matches!(row.crd_tp.trim(), "" | "0" | "00") {
                if let Some(holding) = kiwoom_holding(&row)? {
                    holdings.push(holding);
                }
            } else if let Ok(Some(holding)) = kiwoom_holding(&row) {
                credit_holdings.push(holding);
            }
        }
        Ok(api::TradingBalance { account_ref: account.account_ref, holdings, credit_holdings, total_purchase, total_evaluation, total_profit })
    }

    pub async fn open_orders(&self) -> Result<api::TradingOpenOrders, TradingError> {
        let (account_ref, entries) = self.open_entries(Priority::Screen).await?;
        Ok(api::TradingOpenOrders { account_ref, orders: entries.into_iter().map(|e| e.order).collect() })
    }

    pub(super) async fn open_entries(&self, priority: Priority) -> Result<(String, Vec<OpenEntry>), TradingError> {
        let account = self.verified(priority).await?;
        let ticket = self.recent_open.ticket();
        let entries = match self.broker() {
            Broker::Kiwoom => self.kiwoom_open_entries(&account, priority).await?,
            Broker::Kis => self.kis_open_entries(&self.kis_desk_of(&account)?, priority).await?,
        };
        self.recent_open.keep(ticket, &account.account_ref, self.clock.now().unix(), &entries);
        Ok((account.account_ref, entries))
    }

    async fn kiwoom_open_entries(&self, account: &Verified, priority: Priority) -> Result<Vec<OpenEntry>, TradingError> {
        let mut entries = Vec::new();
        for row in self.pages(&OpenOrders::all(), priority).await?.into_iter().flat_map(Rows::into_rows) {
            Self::own_row(account, row.acnt_no.as_ref())?;
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
            entries.push(OpenEntry { order, ordinary_limit: matches!(row.trde_tp.trim(), "보통" | "0"), kis: None });
        }
        Ok(entries)
    }

    pub async fn orderable(&self, code: StockCode, order_side: OrderSide, order_price: u64) -> Result<api::TradingOrderable, TradingError> {
        if order_price == 0 {
            return Err(TradingError::BadRequest("가격은 0보다 커야 합니다"));
        }
        self.orderable_at(code, order_side, order_price, Priority::Screen).await
    }

    pub(super) async fn orderable_at(&self, code: StockCode, order_side: OrderSide, order_price: u64, priority: Priority) -> Result<api::TradingOrderable, TradingError> {
        let account = self.verified(priority).await?;
        if self.broker() == Broker::Kis {
            return self.kis_orderable(&self.kis_desk_of(&account)?, &account, code, order_side, order_price, priority).await;
        }
        let reply = self.read(&Orderable::new(code, order_price), None, priority).await?.body;
        let policy = self.enabled_record()?.margin_policy;
        orderable_of(account.account_ref, code, order_side, order_price, policy, &reply)
    }

    pub fn margin_policy(&self) -> api::OrdersMargin {
        api::OrdersMargin { policy: self.enabled_record().map_or_else(|_| api::MarginPolicy::default(), |record| record.margin_policy) }
    }

    pub async fn set_margin_policy(&self, input: api::OrdersMargin) -> Result<api::OrdersMargin, TradingError> {
        let _write = self.write.lock().await;
        let record = self.enabled_record()?;
        let switch = self.switch_lock.lock().expect("스위치 잠금");
        self.save_record(&SwitchRecord { margin_policy: input.policy, ..record })?;
        drop(switch);
        Ok(input)
    }

    pub async fn executions(&self) -> Result<api::TradingExecutions, TradingError> {
        self.executions_at(Priority::Screen).await
    }

    pub(super) async fn executions_at(&self, priority: Priority) -> Result<api::TradingExecutions, TradingError> {
        let account = self.verified(priority).await?;
        let day = self.clock.now().kst_date();
        if self.broker() == Broker::Kis {
            let executions = self.kis_executions(&self.kis_desk_of(&account)?, day, priority).await?;
            return Ok(api::TradingExecutions { account_ref: account.account_ref, day: api::KstDate(day), executions });
        }
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

    fn on_fill_notice(&self, notice: &FillNotice) {
        let Ok(record) = self.enabled_record() else { return };
        let (Some(account_ref), Ok(number)) = (record.account_ref, self.lanes.kis_account()) else { return };
        let account = notice.account.expose();
        if account != number.digits().expose() && account != number.cano() {
            return;
        }
        if let Some(venue) = notice.venue.filter(|_| notice.filled) {
            self.fill_venues.remember(&notice.order_no, self.clock.now().kst_date(), venue);
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

async fn forward_notices(trading: std::sync::Weak<Trading>, mut notices: broadcast::Receiver<FillNotice>) {
    loop {
        let received = notices.recv().await;
        let Some(trading) = trading.upgrade() else { return };
        match received {
            Ok(notice) => trading.on_fill_notice(&notice),
            Err(broadcast::error::RecvError::Lagged(_)) => trading.on_events_missed(),
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

#[derive(Clone)]
pub(super) struct OpenEntry {
    pub(super) order: api::TradingOpenOrder,
    pub(super) ordinary_limit: bool,
    pub(super) kis: Option<KisOrigin>,
}

pub(super) fn integer(text: &str) -> Result<i64, TradingError> {
    text.trim().parse::<i64>().map_err(|_| TradingError::Unreadable("숫자가 아닌 값"))
}

fn orderable_of(account_ref: String, code: StockCode, side: OrderSide, order_price: u64, policy: api::MarginPolicy, reply: &OrderableReply) -> Result<api::TradingOrderable, TradingError> {
    let (cash_amount, cash_quantity) = (non_negative(&reply.min_ord_alow_amt)?, non_negative(&reply.min_ord_alowq)?);
    let (stock_rate, account_rate, applied_rate) = (percent(&reply.stk_profa_rt), percent(&reply.profa_rt), percent(&reply.aplc_rt));
    let margin = applied_rate.and_then(|rate| reply.margin_columns(rate)).and_then(|(amount, quantity)| Some((non_negative(amount).ok()?, non_negative(quantity).ok()?)));
    let (amount, quantity) = match (policy, margin) {
        (api::MarginPolicy::AllowMargin, Some(limit)) => limit,
        _ => (cash_amount, cash_quantity),
    };
    Ok(api::TradingOrderable {
        account_ref,
        code: code.as_str().to_owned(),
        side,
        price: order_price,
        amount,
        quantity,
        policy,
        cash_amount,
        cash_quantity,
        margin_amount: margin.map(|(amount, _)| amount),
        margin_quantity: margin.map(|(_, quantity)| quantity),
        deposit: non_negative(&reply.entr)?,
        unpaid: non_negative(&reply.uncla)?,
        stock_rate,
        account_rate,
        applied_rate,
    })
}

fn kiwoom_holding(row: &BalanceRow) -> Result<Option<api::TradingHolding>, TradingError> {
    let quantity = unsigned(&row.rmnd_qty)?;
    if quantity == 0 {
        return Ok(None);
    }
    let sellable_quantity = unsigned(&row.trde_able_qty)?;
    if sellable_quantity > quantity {
        return Err(TradingError::Unreadable("매매가능수량이 보유수량보다 큼"));
    }
    Ok(Some(api::TradingHolding {
        code: stock_code(&row.stk_cd)?,
        name: row.stk_nm.trim().to_owned(),
        quantity,
        sellable_quantity,
        average_price: price(&row.pur_pric)?,
        current_price: price(&row.cur_prc)?,
        evaluation_profit: integer(&row.evltv_prft)?,
        profit_rate_centi: centi(&row.prft_rt),
    }))
}

pub(super) fn non_negative(text: &str) -> Result<u64, TradingError> {
    integer(text).map(|value| u64::try_from(value).unwrap_or(0))
}

fn percent(text: &str) -> Option<f64> {
    let text = text.trim();
    let end = text.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(text.len());
    text[..end].parse::<f64>().ok().filter(|value| value.is_finite())
}

pub(super) fn unsigned(text: &str) -> Result<u64, TradingError> {
    u64::try_from(integer(text)?).map_err(|_| TradingError::Unreadable("음수 수량·금액"))
}

pub(super) fn price(text: &str) -> Result<u64, TradingError> {
    integer(text).map(i64::unsigned_abs)
}

pub(super) fn centi(text: &str) -> Option<i64> {
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

pub(super) fn stock_code(text: &str) -> Result<String, TradingError> {
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
    use super::{Verified, account_ref_for, centi, desk_has_ref, desk_is_verified};
    use crate::api::Broker;
    use crate::config::Secret;
    use crate::trading::kis_account::KisAccountNumber;

    fn account(text: &str) -> KisAccountNumber {
        KisAccountNumber::parse(text).unwrap()
    }

    fn verified_of(text: &str) -> Verified {
        let number = account(text).digits();
        Verified { account_ref: account_ref_for(Broker::Kis, "salt", number.expose()), number, at: 0 }
    }

    #[test]
    fn a_desk_for_another_account_than_the_verified_one_is_refused() {
        let verified = verified_of("50012356-01");
        assert!(desk_is_verified(&account("50012356-01"), &verified));
        assert!(!desk_is_verified(&account("50099999-01"), &verified));
        assert!(!desk_is_verified(&account("50012356-02"), &verified));
    }

    #[test]
    fn a_desk_whose_account_no_longer_matches_the_command_reference_is_refused() {
        let reference = account_ref_for(Broker::Kis, "salt", Secret::new("5001235601".to_owned()).expose());
        assert!(desk_has_ref(&account("50012356-01"), "salt", &reference));
        assert!(!desk_has_ref(&account("50099999-01"), "salt", &reference));
        assert!(!desk_has_ref(&account("50012356-01"), "other-salt", &reference));
    }

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
