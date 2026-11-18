use std::num::NonZeroU64;
use std::sync::Arc;

use domain::{StockCode, Symbol, SymbolInfo, Venue};

use super::journal::{Begun, JournalError, Prepared};
use super::request::{BuyOrder, CancelOrder, LimitOrder, ModifyOrder, OrderAck, OrderNumber, OrderRoute, SellOrder, TradingRequest};
use super::service::{OpenEntry, Trading, TradingError};
use super::switch::SwitchRecord;
use super::tick;
use crate::api::{self, OrderCommandKind, OrderCommandState, OrderRejectReason, OrderSide};
use crate::kiwoom::api::StockBasicInfo;
use crate::kiwoom::error::{Category, Failure};
use crate::kiwoom::rest::{Dispatch, KiwoomError, MergeScope, Page, Priority, SendOnce, Transmitted};
use crate::kiwoom::wire::StockBasicInfoResponse;

const DEFAULT_CONFIRM_WON: u64 = 100_000_000;
const DEFAULT_CAP_WON: u64 = 500_000_000;
const COMMAND_ID_LEN: std::ops::RangeInclusive<usize> = 8..=64;

#[derive(Clone, Copy)]
struct OrderLimits {
    confirm_won: u64,
    cap_won: u64,
}

impl OrderLimits {
    fn of(record: &SwitchRecord) -> OrderLimits {
        OrderLimits { confirm_won: record.confirm_won.map_or(DEFAULT_CONFIRM_WON, |won| won.min(DEFAULT_CONFIRM_WON)), cap_won: record.cap_won.map_or(DEFAULT_CAP_WON, |won| won.min(DEFAULT_CAP_WON)) }
    }
}

enum Work {
    Place { code: StockCode, side: OrderSide, quantity: NonZeroU64, price: NonZeroU64, venue: Venue, confirmed: bool },
    Modify { order_no: OrderNumber, price: NonZeroU64, confirmed: bool },
    Cancel { order_no: OrderNumber },
}

enum Outbound {
    Buy(BuyOrder),
    Sell(SellOrder),
    Modify(ModifyOrder),
    Cancel(CancelOrder),
}

enum Stop {
    Refuse(OrderRejectReason),
    Broken(String),
}

impl From<OrderRejectReason> for Stop {
    fn from(reason: OrderRejectReason) -> Stop {
        Stop::Refuse(reason)
    }
}

impl From<JournalError> for Stop {
    fn from(e: JournalError) -> Stop {
        Stop::Broken(e.to_string())
    }
}

impl From<KiwoomError> for Stop {
    fn from(e: KiwoomError) -> Stop {
        Stop::Refuse(kiwoom_reason(&e))
    }
}

impl From<TradingError> for Stop {
    fn from(e: TradingError) -> Stop {
        match e {
            TradingError::Off | TradingError::FileUnusable(_) => Stop::Refuse(OrderRejectReason::OrdersOff),
            TradingError::AccountChanged => Stop::Refuse(OrderRejectReason::AccountChanged),
            TradingError::Kiwoom(e) => e.into(),
            TradingError::Journal(why) => Stop::Broken(why),
            TradingError::TailMismatch | TradingError::Unreadable(_) | TradingError::BadRequest(_) | TradingError::CommandNotFound => Stop::Refuse(OrderRejectReason::KiwoomUnavailable),
        }
    }
}

fn kiwoom_reason(e: &KiwoomError) -> OrderRejectReason {
    match e {
        KiwoomError::NotConnected => OrderRejectReason::NotConnected,
        other if other.failure().is_some_and(|f| f.category() == Category::AuthBlocked) => OrderRejectReason::AuthBlocked,
        _ => OrderRejectReason::KiwoomUnavailable,
    }
}

fn kiwoom_said_no(failure: &Failure) -> bool {
    let refusing = matches!(
        failure.category(),
        Category::RateLimit | Category::TokenInvalid | Category::AuthBlocked | Category::InvalidRequest | Category::SymbolMismatch | Category::BatchLimit | Category::Unsupported | Category::Unknown
    );
    match failure.http_status() {
        Some(429) => true,
        Some(status) if status < 500 => refusing && failure.return_code().is_some_and(|code| code != 0),
        _ => false,
    }
}

struct Settled {
    state: OrderCommandState,
    reason: Option<OrderRejectReason>,
    order_no: Option<String>,
}

fn settle(result: Result<Page<OrderAck>, KiwoomError>, transmitted: bool, orders_on: bool) -> Settled {
    let rejected = |reason| Settled { state: OrderCommandState::Rejected, reason: Some(reason), order_no: None };
    let unknown = || Settled { state: OrderCommandState::Unknown, reason: None, order_no: None };
    match result {
        Ok(page) => match OrderNumber::parse(&page.body.ord_no) {
            Some(number) => Settled { state: OrderCommandState::Accepted, reason: None, order_no: Some(number.as_str().to_owned()) },
            None => unknown(),
        },
        Err(KiwoomError::NotConnected) if !transmitted && !orders_on => rejected(OrderRejectReason::OrdersOff),
        Err(e) if !transmitted => rejected(kiwoom_reason(&e)),
        Err(e) if e.failure().is_some_and(kiwoom_said_no) => rejected(OrderRejectReason::KiwoomRejected),
        Err(_) => unknown(),
    }
}

fn valid_command_id(id: &str) -> bool {
    COMMAND_ID_LEN.contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn positive(value: u64, what: &'static str) -> Result<NonZeroU64, TradingError> {
    NonZeroU64::new(value).ok_or(TradingError::BadRequest(what))
}

impl Trading {
    async fn ready(&self) -> Result<(), TradingError> {
        self.recovered.get_or_init(|| async { self.journal.recover(self.clock.now().unix()).await.map_err(|e| e.to_string()) }).await.clone().map_err(TradingError::Journal)
    }

    pub(super) fn start_recovery(self: &Arc<Self>) {
        let trading = self.clone();
        tokio::spawn(async move {
            if let Err(e) = trading.ready().await {
                tracing::error!(error = %e, "명령 저널을 복구하지 못했습니다");
            }
        });
    }

    fn turn_of(&self, account_ref: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.turns.lock().expect("명령 줄 잠금").entry(account_ref.to_owned()).or_default().clone()
    }

    fn account_ref_of_record(record: SwitchRecord) -> Result<String, TradingError> {
        record.account_ref.ok_or(TradingError::Off)
    }

    pub async fn place(self: &Arc<Self>, input: api::OrderPlaceInput) -> Result<api::OrderCommand, TradingError> {
        if !valid_command_id(&input.command_id) {
            return Err(TradingError::BadRequest("command_id는 영문자·숫자·`-`·`_` 8~64자여야 합니다"));
        }
        let code = StockCode::parse(&input.code).map_err(|_| TradingError::BadRequest("종목코드가 올바르지 않습니다"))?;
        let (quantity, price) = (positive(input.quantity, "수량은 0보다 커야 합니다")?, positive(input.price, "가격은 0보다 커야 합니다")?);
        let venue = input.venue.map_or(Venue::Krx, Into::into);
        let account_ref = Self::account_ref_of_record(self.enabled_record()?)?;
        let kind = match input.side {
            OrderSide::Buy => OrderCommandKind::Buy,
            OrderSide::Sell => OrderCommandKind::Sell,
        };
        let prepared = Prepared { command_id: input.command_id, account_ref, kind, code: Some(code.as_str().to_owned()), venue: Some(venue), quantity: Some(quantity.get()), price: Some(price.get()), target_order_no: None };
        let work = Work::Place { code, side: input.side, quantity, price, venue, confirmed: input.confirm_high_value };
        self.run_one(prepared, work).await
    }

    pub async fn modify(self: &Arc<Self>, input: api::OrderModifyInput) -> Result<api::OrderCommand, TradingError> {
        if !valid_command_id(&input.command_id) {
            return Err(TradingError::BadRequest("command_id는 영문자·숫자·`-`·`_` 8~64자여야 합니다"));
        }
        let order_no = OrderNumber::parse(&input.order_no).ok_or(TradingError::BadRequest("주문번호는 7자리 숫자여야 합니다"))?;
        let price = positive(input.price, "가격은 0보다 커야 합니다")?;
        let account_ref = Self::account_ref_of_record(self.enabled_record()?)?;
        let prepared = Prepared { command_id: input.command_id, account_ref, kind: OrderCommandKind::Modify, code: None, venue: None, quantity: None, price: Some(price.get()), target_order_no: Some(order_no.as_str().to_owned()) };
        self.run_one(prepared, Work::Modify { order_no, price, confirmed: input.confirm_high_value }).await
    }

    pub async fn cancel(self: &Arc<Self>, input: api::OrderCancelInput) -> Result<api::OrderCommand, TradingError> {
        if !valid_command_id(&input.command_id) {
            return Err(TradingError::BadRequest("command_id는 영문자·숫자·`-`·`_` 8~64자여야 합니다"));
        }
        let order_no = OrderNumber::parse(&input.order_no).ok_or(TradingError::BadRequest("주문번호는 7자리 숫자여야 합니다"))?;
        let account_ref = Self::account_ref_of_record(self.enabled_record()?)?;
        let prepared = Prepared { command_id: input.command_id, account_ref, kind: OrderCommandKind::Cancel, code: None, venue: None, quantity: None, price: None, target_order_no: Some(order_no.as_str().to_owned()) };
        self.run_one(prepared, Work::Cancel { order_no }).await
    }

    pub async fn cancel_batch(self: &Arc<Self>, input: api::OrderCancelBatchInput) -> Result<api::OrderCommands, TradingError> {
        if !valid_command_id(&input.batch_id) {
            return Err(TradingError::BadRequest("batch_id는 영문자·숫자·`-`·`_` 8~64자여야 합니다"));
        }
        let code = StockCode::parse(&input.code).map_err(|_| TradingError::BadRequest("종목코드가 올바르지 않습니다"))?;
        positive(input.price, "가격은 0보다 커야 합니다")?;
        self.ready().await?;
        let account_ref = Self::account_ref_of_record(self.enabled_record()?)?;
        let (_, entries) = self.open_entries(Priority::Order).await?;
        let mut targets: Vec<String> = entries.into_iter().filter(|e| e.order.code == code.as_str() && e.order.side == input.side && e.order.price == input.price && e.order.open_quantity > 0).map(|e| e.order.order_no).collect();
        targets.sort();
        let mut commands = Vec::new();
        let mut created = Vec::new();
        for order_no in targets {
            let command_id = format!("{}_{order_no}", input.batch_id);
            let target = OrderNumber::parse(&order_no).expect("목록에서 읽은 주문번호는 형식을 이미 확인했다");
            let prepared = Prepared { command_id, account_ref: account_ref.clone(), kind: OrderCommandKind::Cancel, code: None, venue: None, quantity: None, price: None, target_order_no: Some(order_no) };
            match self.journal.begin(&prepared, self.clock.now().unix()).await? {
                Begun::Created(command) => {
                    created.push((command.command_id.clone(), Work::Cancel { order_no: target }));
                    commands.push(command);
                }
                Begun::Existing(command) => commands.push(command),
                Begun::DifferentRequest => return Err(TradingError::BadRequest("같은 batch_id가 다른 내용으로 왔습니다")),
            }
        }
        let this = self.clone();
        let turn = self.turn_of(&account_ref);
        let ids: Vec<String> = created.iter().map(|(id, _)| id.clone()).collect();
        let account = account_ref.clone();
        tokio::spawn(async move {
            let _turn = turn.lock().await;
            for (id, work) in created {
                if let Err(e) = this.execute(&id, &account, work).await {
                    tracing::error!(error = %e, "일괄 취소의 한 명령이 저널 오류로 끝났습니다");
                }
            }
            this.notify(account);
        })
        .await
        .map_err(|_| TradingError::Journal("일괄 취소 작업이 끝나지 못했습니다".to_owned()))?;
        for command in &mut commands {
            if ids.contains(&command.command_id)
                && let Some(done) = self.journal.get(&command.command_id).await?
            {
                *command = done;
            }
        }
        let blocked = self.journal.blocking_unknown(&account_ref).await? > 0;
        Ok(api::OrderCommands { account_ref, blocked, commands })
    }

    pub async fn command(&self, command_id: &str) -> Result<api::OrderCommand, TradingError> {
        self.ready().await?;
        self.journal.get(command_id).await?.ok_or(TradingError::CommandNotFound)
    }

    pub async fn commands(&self) -> Result<api::OrderCommands, TradingError> {
        self.ready().await?;
        let account_ref = Self::account_ref_of_record(self.enabled_record()?)?;
        let commands = self.journal.recent(&account_ref).await?;
        let blocked = self.journal.blocking_unknown(&account_ref).await? > 0;
        Ok(api::OrderCommands { account_ref, blocked, commands })
    }

    pub async fn reconcile(self: &Arc<Self>) -> Result<api::OrderReconciliation, TradingError> {
        self.ready().await?;
        let account_ref = Self::account_ref_of_record(self.enabled_record()?)?;
        let turn = self.turn_of(&account_ref);
        let _turn = turn.lock().await;
        let (_, entries) = self.open_entries(Priority::Order).await?;
        let executions = self.executions_at(Priority::Order).await?;
        let cleared = self.journal.mark_reconciled(&account_ref, self.clock.now().unix()).await?;
        tracing::info!(cleared, "미체결과 당일 체결을 다시 조회해 결과 불명 명령을 대조했습니다");
        self.notify(account_ref.clone());
        Ok(api::OrderReconciliation { account_ref, cleared, open_orders: entries.into_iter().map(|e| e.order).collect(), executions: executions.executions })
    }

    async fn run_one(self: &Arc<Self>, prepared: Prepared, work: Work) -> Result<api::OrderCommand, TradingError> {
        self.ready().await?;
        let command = match self.journal.begin(&prepared, self.clock.now().unix()).await? {
            Begun::Created(command) => command,
            Begun::Existing(command) => return Ok(command),
            Begun::DifferentRequest => return Err(TradingError::BadRequest("같은 command_id가 다른 내용으로 왔습니다")),
        };
        let this = self.clone();
        let turn = self.turn_of(&command.account_ref);
        tokio::spawn(async move {
            let _turn = turn.lock().await;
            let done = this.execute(&command.command_id, &command.account_ref, work).await;
            this.notify(command.account_ref.clone());
            done
        })
        .await
        .map_err(|_| TradingError::Journal("명령 작업이 끝나지 못했습니다".to_owned()))?
    }

    async fn execute(&self, command_id: &str, account_ref: &str, work: Work) -> Result<api::OrderCommand, TradingError> {
        let now = || self.clock.now().unix();
        let outbound = match self.vet(command_id, account_ref, &work).await {
            Ok(outbound) => outbound,
            Err(Stop::Refuse(reason)) => {
                self.journal.reject(command_id, reason, now()).await?;
                return self.journal.get(command_id).await?.ok_or(TradingError::CommandNotFound);
            }
            Err(Stop::Broken(why)) => return Err(TradingError::Journal(why)),
        };
        self.journal.mark_sending(command_id, now()).await?;
        let (result, transmitted) = self.send_once(outbound).await;
        let settled = settle(result, transmitted.happened(), self.open.load(std::sync::atomic::Ordering::SeqCst));
        if let Err(e) = self.journal.finish_sending(command_id, settled.state, settled.reason, settled.order_no.as_deref(), now()).await {
            tracing::error!(error = %e, "보낸 뒤 결과를 저널에 쓰지 못했습니다. 결과 불명으로 남깁니다");
            let _ = self.journal.finish_sending(command_id, OrderCommandState::Unknown, None, None, now()).await;
            return Err(e.into());
        }
        self.journal.get(command_id).await?.ok_or(TradingError::CommandNotFound)
    }

    async fn send_once(&self, outbound: Outbound) -> (Result<Page<OrderAck>, KiwoomError>, Transmitted) {
        match outbound {
            Outbound::Buy(order) => self.dispatch_once(&order).await,
            Outbound::Sell(order) => self.dispatch_once(&order).await,
            Outbound::Modify(order) => self.dispatch_once(&order).await,
            Outbound::Cancel(order) => self.dispatch_once(&order).await,
        }
    }

    async fn dispatch_once<R: TradingRequest<Response = OrderAck>>(&self, request: &R) -> (Result<Page<OrderAck>, KiwoomError>, Transmitted) {
        let body = serde_json::to_string(request).expect("요청 타입은 언제나 직렬화된다");
        let open = self.open.clone();
        let transmitted = Transmitted::default();
        let call = Dispatch {
            endpoint: R::API_ID.into(),
            body,
            cont: None,
            priority: Priority::Order,
            scope: MergeScope::default(),
            admit: Some(Arc::new(move || open.load(std::sync::atomic::Ordering::SeqCst))),
            once: Some(SendOnce { transmitted: transmitted.clone() }),
        };
        (self.rest.call_endpoint(call, |_| true).await, transmitted)
    }

    fn info_of(&self, code: StockCode) -> Result<SymbolInfo, Stop> {
        let directory = self.symbols.updates().borrow().clone();
        directory.and_then(|dir| dir.get(Symbol::Stock(code)).cloned()).ok_or(Stop::Refuse(OrderRejectReason::UnknownSymbol))
    }

    async fn vet(&self, command_id: &str, account_ref: &str, work: &Work) -> Result<Outbound, Stop> {
        let record = self.enabled_record()?;
        if record.account_ref.as_deref() != Some(account_ref) {
            return Err(OrderRejectReason::AccountChanged.into());
        }
        let limits = OrderLimits::of(&record);
        if let Some(blocked) = self.rest.blocked() {
            return Err(blocked.into());
        }
        if self.journal.blocking_unknown(account_ref).await? > 0 {
            return Err(OrderRejectReason::UnknownPending.into());
        }
        match work {
            Work::Place { code, side, quantity, price, venue, confirmed } => {
                let info = self.info_of(*code)?;
                if *venue == Venue::Nxt && !info.nxt_enabled {
                    return Err(OrderRejectReason::NxtUnavailable.into());
                }
                let amount = price.get().checked_mul(quantity.get()).ok_or(OrderRejectReason::InvalidOrder)?;
                check_terms(price.get(), amount, info.kind, *confirmed, limits)?;
                self.verified(Priority::Order).await?;
                self.check_price_band(*code, price.get()).await?;
                match side {
                    OrderSide::Sell => {
                        let balance = self.balance_at(Priority::Order).await?;
                        let sellable = balance.holdings.iter().find(|h| h.code == code.as_str()).map_or(0, |h| h.sellable_quantity);
                        if quantity.get() > sellable {
                            return Err(OrderRejectReason::SellOverSellable.into());
                        }
                    }
                    OrderSide::Buy => {
                        let orderable = self.orderable_at(*code, OrderSide::Buy, price.get(), Priority::Order).await?;
                        if amount > orderable.amount {
                            return Err(OrderRejectReason::BuyOverBuyingPower.into());
                        }
                    }
                }
                let order = LimitOrder::new(OrderRoute::from(*venue), *code, *quantity, *price);
                Ok(match side {
                    OrderSide::Buy => Outbound::Buy(BuyOrder(order)),
                    OrderSide::Sell => Outbound::Sell(SellOrder(order)),
                })
            }
            Work::Modify { order_no, price, confirmed } => {
                let (code, venue, remaining) = self.resolve_target(command_id, order_no, true).await?;
                let info = self.info_of(code)?;
                if venue == Venue::Nxt && !info.nxt_enabled {
                    return Err(OrderRejectReason::NxtUnavailable.into());
                }
                let amount = price.get().checked_mul(remaining.get()).ok_or(OrderRejectReason::InvalidOrder)?;
                check_terms(price.get(), amount, info.kind, *confirmed, limits)?;
                self.check_price_band(code, price.get()).await?;
                Ok(Outbound::Modify(ModifyOrder::new(OrderRoute::from(venue), order_no, code, remaining, *price)))
            }
            Work::Cancel { order_no } => {
                let (code, venue, remaining) = self.resolve_target(command_id, order_no, false).await?;
                Ok(Outbound::Cancel(CancelOrder::new(OrderRoute::from(venue), order_no, code, remaining)))
            }
        }
    }

    async fn resolve_target(&self, command_id: &str, order_no: &OrderNumber, needs_limit_order: bool) -> Result<(StockCode, Venue, NonZeroU64), Stop> {
        let (_, entries) = self.open_entries(Priority::Order).await?;
        let found: Option<OpenEntry> = entries.into_iter().find(|e| e.order.order_no == order_no.as_str());
        let entry = found.filter(|e| e.order.open_quantity > 0).ok_or(OrderRejectReason::OrderNotFound)?;
        if needs_limit_order && !entry.ordinary_limit {
            return Err(OrderRejectReason::InvalidOrder.into());
        }
        let code = StockCode::parse(&entry.order.code).map_err(|_| OrderRejectReason::InvalidOrder)?;
        let remaining = NonZeroU64::new(entry.order.open_quantity).ok_or(OrderRejectReason::OrderNotFound)?;
        let venue: Venue = entry.order.venue.into();
        self.journal.resolve_target(command_id, code.as_str(), venue, remaining.get(), self.clock.now().unix()).await?;
        Ok((code, venue, remaining))
    }

    async fn check_price_band(&self, code: StockCode, price: u64) -> Result<(), Stop> {
        let reply = self.rest.call(&StockBasicInfo::new(code), None, Priority::Order, MergeScope::default()).await?;
        let StockBasicInfoResponse::Found { fundamentals, .. } = reply.body else {
            return Err(OrderRejectReason::UnknownSymbol.into());
        };
        let (Some(upper), Some(lower)) = (fundamentals.upper_limit_won.filter(|v| *v > 0), fundamentals.lower_limit_won.filter(|v| *v > 0)) else {
            return Err(OrderRejectReason::LimitsUnavailable.into());
        };
        if price > upper || price < lower {
            return Err(OrderRejectReason::OutOfLimit.into());
        }
        Ok(())
    }
}

fn check_terms(price: u64, amount: u64, kind: domain::SymbolKind, confirmed: bool, limits: OrderLimits) -> Result<(), Stop> {
    if !tick::is_on_tick(price, kind) {
        return Err(OrderRejectReason::OffTick.into());
    }
    if amount > limits.cap_won {
        return Err(OrderRejectReason::OverSingleOrderCap.into());
    }
    if amount >= limits.confirm_won && !confirmed {
        return Err(OrderRejectReason::HighValueUnconfirmed.into());
    }
    Ok(())
}
