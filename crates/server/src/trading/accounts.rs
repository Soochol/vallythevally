use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use domain::StockCode;
use tokio::sync::{broadcast, watch};

use super::memory::PriceBand;
use super::service::{AccountChanged, FIXED_KEY_ID, Lanes, Shared, Trading, TradingError};
use super::switch::SwitchStore;
use crate::api::{self, OrderSide};
use crate::clock::Clock;
use crate::kiwoom::key_file::KeyId;
use crate::kiwoom::keys::{KeyRing, KeyView};
use crate::kiwoom::rest::KiwoomRest;
use crate::kiwoom::stream::AccountFeed;
use crate::symbols::SymbolDirectory;

const FIXED_ALIAS: &str = "시세";

struct Line {
    alias: String,
    market: bool,
    service: Arc<Trading>,
}

pub struct Accounts {
    ring: Arc<KeyRing>,
    store: Arc<SwitchStore>,
    shared: Shared,
    fixed_feed: AccountFeed,
    services: Mutex<HashMap<String, (u64, Arc<Trading>)>>,
    enabling: tokio::sync::Mutex<()>,
}

fn fixed_id() -> KeyId {
    KeyId::parse(FIXED_KEY_ID).expect("고정 키 ID는 올바른 키 ID다")
}

impl Accounts {
    pub fn new(ring: Arc<KeyRing>, rest: KiwoomRest, feed: AccountFeed, clock: Clock, store: SwitchStore, db: crate::db::AppDb, symbols: Arc<SymbolDirectory>) -> Arc<Accounts> {
        store.claim_legacy(&ring.market().map_or_else(fixed_id, |market| market.id));
        let accounts = Arc::new(Accounts { ring, store: Arc::new(store), shared: Shared::new(clock, db, symbols, rest), fixed_feed: feed, services: Mutex::new(HashMap::new()), enabling: tokio::sync::Mutex::new(()) });
        accounts.sync();
        tokio::spawn(follow_ring(Arc::downgrade(&accounts), accounts.ring.subscribe_changes()));
        accounts
    }

    fn lines(&self) -> Vec<Line> {
        let views = self.ring.views();
        if views.is_empty() {
            return vec![Line { alias: FIXED_ALIAS.to_owned(), market: true, service: self.fixed() }];
        }
        views.into_iter().map(|view| Line { service: self.service_of(&view), alias: view.alias, market: view.market }).collect()
    }

    fn fixed(&self) -> Arc<Trading> {
        let key = fixed_id();
        let mut services = self.services.lock().expect("계좌 서비스 잠금");
        services.entry(key.as_str().to_owned()).or_insert_with(|| (0, Trading::assemble(Lanes::Fixed { rest: self.shared.quote_rest.clone(), feed: self.fixed_feed.clone() }, key, self.store.clone(), self.shared.clone_parts()))).1.clone()
    }

    fn service_of(&self, view: &KeyView) -> Arc<Trading> {
        let mut services = self.services.lock().expect("계좌 서비스 잠금");
        match services.get(view.id.as_str()) {
            Some((serial, service)) if *serial == view.serial => return service.clone(),
            Some(_) => {
                if let Err(e) = self.store.clear_key(&view.id) {
                    tracing::warn!(error = %e, "지운 키와 같은 번호를 쓰는 새 키의 주문 사용 칸을 비우지 못했습니다");
                }
            }
            None => {}
        }
        let service = Trading::assemble(Lanes::Keyed { ring: self.ring.clone(), key: view.id.clone() }, view.id.clone(), self.store.clone(), self.shared.clone_parts());
        services.insert(view.id.as_str().to_owned(), (view.serial, service.clone()));
        service
    }

    pub fn market(&self) -> Arc<Trading> {
        match self.ring.market() {
            Some(market) => self.service_of(&market),
            None => self.fixed(),
        }
    }

    fn by_key(&self, key_id: Option<&str>) -> Result<Arc<Trading>, TradingError> {
        let Some(text) = key_id else { return Ok(self.market()) };
        let key = KeyId::parse(text).ok_or(TradingError::UnknownKey)?;
        if let Some(view) = self.ring.view_of(&key) {
            return Ok(self.service_of(&view));
        }
        if self.ring.views().is_empty() && key == fixed_id() {
            return Ok(self.fixed());
        }
        Err(TradingError::UnknownKey)
    }

    fn by_ref(&self, account: Option<&str>) -> Result<Arc<Trading>, TradingError> {
        let Some(account) = account else { return Ok(self.market()) };
        let mut known = None;
        for line in self.lines() {
            let Some(record) = line.service.record().ok().flatten().filter(|record| record.account_ref.as_deref() == Some(account)) else { continue };
            if record.enabled {
                return Ok(line.service);
            }
            known.get_or_insert(line.service);
        }
        known.ok_or(TradingError::UnknownAccount)
    }

    fn listing(&self) -> Vec<api::OrdersAccount> {
        self.lines().into_iter().map(|line| line.service.listing(&line.alias, line.market)).collect()
    }

    fn sync(&self) {
        let views = self.ring.views();
        let present: Vec<KeyId> = if views.is_empty() { vec![fixed_id()] } else { views.iter().map(|view| view.id.clone()).collect() };
        if let Err(e) = self.store.clear_except(&present) {
            tracing::warn!(error = %e, "목록에서 빠진 키의 주문 사용 칸을 비우지 못했습니다");
        }
        let kept: Vec<Arc<Trading>> = {
            let mut services = self.services.lock().expect("계좌 서비스 잠금");
            services.retain(|id, _| present.iter().any(|key| key.as_str() == id));
            services.values().map(|(_, service)| service.clone()).collect()
        };
        for view in &views {
            view.lane.account.set_wanted(false);
        }
        for service in &kept {
            service.follow_feed();
            service.forget_verified();
            service.republish();
        }
        if views.is_empty() {
            drop(self.fixed());
        }
        for view in &views {
            drop(self.service_of(view));
        }
    }

    pub fn subscribe_changes(&self) -> broadcast::Receiver<AccountChanged> {
        self.shared.changes.subscribe()
    }

    pub fn remember_price_band(&self, code: StockCode, upper: Option<u64>, lower: Option<u64>) {
        if let Some(band) = PriceBand::from_limits(upper, lower) {
            self.shared.bands.remember(code, self.shared.clock.now().kst_date(), band);
        }
    }

    pub fn status(&self, account: Option<&str>) -> Result<api::OrdersStatus, TradingError> {
        let mut status = self.by_ref(account)?.status();
        status.accounts = self.listing();
        Ok(status)
    }

    pub async fn set_enabled(&self, input: api::OrdersSwitchInput) -> Result<api::OrdersStatus, TradingError> {
        let service = self.by_key(input.key_id.as_deref())?;
        let _one_at_a_time = self.enabling.lock().await;
        let taken_by = |account_ref: &str| {
            self.lines().into_iter().find(|line| line.service.key != service.key && line.service.record().ok().flatten().is_some_and(|record| record.enabled && record.account_ref.as_deref() == Some(account_ref))).map(|line| line.alias)
        };
        let mut status = service.set_enabled_unless_taken(input, &taken_by).await?;
        status.accounts = self.listing();
        Ok(status)
    }

    pub async fn check_account(&self, key_id: Option<&str>) -> Result<api::OrdersAccountCheck, TradingError> {
        self.by_key(key_id)?.check_account().await
    }

    pub fn margin_policy(&self, account: Option<&str>) -> Result<api::OrdersMargin, TradingError> {
        Ok(self.by_ref(account)?.margin_policy())
    }

    pub async fn set_margin_policy(&self, input: api::OrdersMarginInput) -> Result<api::OrdersMargin, TradingError> {
        self.by_ref(input.account.as_deref())?.set_margin_policy(api::OrdersMargin { policy: input.policy }).await
    }

    pub async fn confirmed_account_number(&self, account: Option<&str>) -> Result<api::TradingAccountNumber, TradingError> {
        self.by_ref(account)?.confirmed_account_number().await
    }

    pub async fn balance(&self, account: Option<&str>) -> Result<api::TradingBalance, TradingError> {
        self.by_ref(account)?.balance().await
    }

    pub async fn open_orders(&self, account: Option<&str>) -> Result<api::TradingOpenOrders, TradingError> {
        self.by_ref(account)?.open_orders().await
    }

    pub async fn orderable(&self, account: Option<&str>, code: StockCode, side: OrderSide, price: u64) -> Result<api::TradingOrderable, TradingError> {
        self.by_ref(account)?.orderable(code, side, price).await
    }

    pub async fn executions(&self, account: Option<&str>) -> Result<api::TradingExecutions, TradingError> {
        self.by_ref(account)?.executions().await
    }

    pub async fn place(&self, input: api::OrderPlaceInput) -> Result<api::OrderCommand, TradingError> {
        self.by_ref(input.account.as_deref())?.place(input).await
    }

    pub async fn modify(&self, input: api::OrderModifyInput) -> Result<api::OrderCommand, TradingError> {
        self.by_ref(input.account.as_deref())?.modify(input).await
    }

    pub async fn cancel(&self, input: api::OrderCancelInput) -> Result<api::OrderCommand, TradingError> {
        self.by_ref(input.account.as_deref())?.cancel(input).await
    }

    pub async fn cancel_batch(&self, input: api::OrderCancelBatchInput) -> Result<api::OrderCommands, TradingError> {
        self.by_ref(input.account.as_deref())?.cancel_batch(input).await
    }

    pub async fn reconcile(&self, account: Option<&str>) -> Result<api::OrderReconciliation, TradingError> {
        self.by_ref(account)?.reconcile().await
    }

    pub async fn commands(&self, account: Option<&str>) -> Result<api::OrderCommands, TradingError> {
        self.by_ref(account)?.commands().await
    }

    pub async fn command(&self, command_id: &str) -> Result<api::OrderCommand, TradingError> {
        self.market().command(command_id).await
    }
}

async fn follow_ring(accounts: std::sync::Weak<Accounts>, mut changes: watch::Receiver<u64>) {
    while changes.changed().await.is_ok() {
        let Some(accounts) = accounts.upgrade() else { return };
        accounts.sync();
    }
}
