use std::collections::HashSet;
use std::num::NonZeroU64;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use domain::{KstDate, StockCode, Venue};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::json;

use super::kis_account::KisAccountNumber;
use super::request::{OrderNumber, OrderRoute};
use super::service::{OpenEntry, Trading, TradingError, Verified, centi, integer, non_negative, price, stock_code, unsigned};
use super::tr::KisTradingApiId;
use crate::api::{self, OrderSide};
use crate::config::Secret;
use crate::kis::error::Category;
use crate::kis::market_rest::kis_priority;
use crate::kis::rest::{KisError, KisPage, KisRequest, KisRest, SendOnce};
use crate::kiwoom::rest::Priority;

const MAX_PAGES: usize = 100;
const LIMIT_ORDER: &str = "00";
const BUYABLE_ORDER_KIND: &str = "01";
const ORDINARY_SELL: &str = "01";
const REVISE: &str = "01";
const CANCEL: &str = "02";
const WHOLE_REMAINDER: &str = "Y";
const SELL_CODE: &str = "01";
const BUY_CODE: &str = "02";
const ORDER_NUMBER_MAX_DIGITS: usize = 10;

pub(super) struct KisDesk {
    pub(super) rest: KisRest,
    pub(super) account: KisAccountNumber,
}

impl KisDesk {
    fn account_query(&self) -> Vec<(&'static str, String)> {
        vec![("CANO", self.account.cano().to_owned()), ("ACNT_PRDT_CD", self.account.product().to_owned())]
    }
}

pub(super) fn kis_order_number(text: &str) -> Option<OrderNumber> {
    let text = text.trim();
    (!text.is_empty() && text.len() <= ORDER_NUMBER_MAX_DIGITS && text.bytes().all(|b| b.is_ascii_digit())).then(|| OrderNumber::trusted(text))
}

fn route_of(text: &str) -> Option<OrderRoute> {
    match text.trim() {
        "KRX" => Some(OrderRoute::Krx),
        "NXT" => Some(OrderRoute::Nxt),
        "SOR" => Some(OrderRoute::Sor),
        _ => None,
    }
}

fn route_code(route: OrderRoute) -> &'static str {
    match route {
        OrderRoute::Krx => "KRX",
        OrderRoute::Nxt => "NXT",
        OrderRoute::Sor => "SOR",
    }
}

fn venue_of(route: OrderRoute) -> Venue {
    match route {
        OrderRoute::Krx => Venue::Krx,
        OrderRoute::Nxt => Venue::Nxt,
        OrderRoute::Sor => Venue::Combined,
    }
}

fn side_of(code: &str) -> Result<OrderSide, TradingError> {
    match code.trim() {
        SELL_CODE => Ok(OrderSide::Sell),
        BUY_CODE => Ok(OrderSide::Buy),
        _ => Err(TradingError::Unreadable("매도매수구분")),
    }
}

fn whole_won(text: &str) -> Result<u64, TradingError> {
    let whole = text.trim().split_once('.').map_or(text.trim(), |(whole, _)| whole);
    price(whole)
}

fn clock_text(text: &str) -> String {
    let text = text.trim();
    if text.len() == 6 && text.bytes().all(|b| b.is_ascii_digit()) { format!("{}:{}:{}", &text[0..2], &text[2..4], &text[4..6]) } else { text.to_owned() }
}

trait Paged: DeserializeOwned {
    fn continuation(&self) -> (String, String);
}

#[derive(Deserialize, Default)]
struct BalanceReply {
    #[serde(default)]
    output1: Vec<BalanceRow>,
    #[serde(default)]
    output2: Vec<BalanceSummary>,
    #[serde(default)]
    ctx_area_fk100: String,
    #[serde(default)]
    ctx_area_nk100: String,
}

#[derive(Deserialize, Default)]
struct BalanceRow {
    #[serde(default)]
    pdno: String,
    #[serde(default)]
    prdt_name: String,
    #[serde(default)]
    hldg_qty: String,
    #[serde(default)]
    ord_psbl_qty: String,
    #[serde(default)]
    pchs_avg_pric: String,
    #[serde(default)]
    prpr: String,
    #[serde(default)]
    evlu_pfls_amt: String,
    #[serde(default)]
    evlu_pfls_rt: String,
    #[serde(default)]
    loan_amt: String,
}

#[derive(Deserialize, Default)]
struct BalanceSummary {
    #[serde(default)]
    pchs_amt_smtl_amt: String,
    #[serde(default)]
    evlu_amt_smtl_amt: String,
    #[serde(default)]
    evlu_pfls_smtl_amt: String,
}

impl Paged for BalanceReply {
    fn continuation(&self) -> (String, String) {
        (self.ctx_area_fk100.clone(), self.ctx_area_nk100.clone())
    }
}

#[derive(Deserialize, Default)]
struct RevisableReply {
    #[serde(default)]
    output: Vec<RevisableRow>,
    #[serde(default)]
    ctx_area_fk100: String,
    #[serde(default)]
    ctx_area_nk100: String,
}

#[derive(Deserialize, Default)]
struct RevisableRow {
    #[serde(default)]
    ord_gno_brno: String,
    #[serde(default)]
    odno: String,
    #[serde(default)]
    orgn_odno: String,
    #[serde(default)]
    ord_dvsn_name: String,
    #[serde(default)]
    pdno: String,
    #[serde(default)]
    prdt_name: String,
    #[serde(default)]
    rvse_cncl_dvsn_name: String,
    #[serde(default)]
    ord_qty: String,
    #[serde(default)]
    ord_unpr: String,
    #[serde(default)]
    ord_tmd: String,
    #[serde(default)]
    psbl_qty: String,
    #[serde(default)]
    sll_buy_dvsn_cd: String,
    #[serde(default)]
    ord_dvsn_cd: String,
    #[serde(default)]
    excg_id_dvsn_cd: String,
}

impl Paged for RevisableReply {
    fn continuation(&self) -> (String, String) {
        (self.ctx_area_fk100.clone(), self.ctx_area_nk100.clone())
    }
}

#[derive(Deserialize, Default)]
struct BuyableReply {
    #[serde(default)]
    output: BuyableOutput,
}

#[derive(Deserialize, Default)]
struct BuyableOutput {
    #[serde(default)]
    ord_psbl_cash: String,
    #[serde(default)]
    nrcvb_buy_amt: String,
    #[serde(default)]
    nrcvb_buy_qty: String,
    #[serde(default)]
    max_buy_amt: String,
    #[serde(default)]
    max_buy_qty: String,
}

#[derive(Deserialize, Default)]
struct DailyFillsReply {
    #[serde(default)]
    output1: Vec<DailyFillRow>,
    #[serde(default)]
    ctx_area_fk100: String,
    #[serde(default)]
    ctx_area_nk100: String,
}

#[derive(Deserialize, Default)]
struct DailyFillRow {
    #[serde(default)]
    odno: String,
    #[serde(default)]
    pdno: String,
    #[serde(default)]
    prdt_name: String,
    #[serde(default)]
    sll_buy_dvsn_cd: String,
    #[serde(default)]
    tot_ccld_qty: String,
    #[serde(default)]
    avg_prvs: String,
    #[serde(default)]
    ord_tmd: String,
    #[serde(default, rename = "excg_id_dvsn_Cd", alias = "excg_id_dvsn_cd")]
    excg_id_dvsn_cd: String,
}

impl Paged for DailyFillsReply {
    fn continuation(&self) -> (String, String) {
        (self.ctx_area_fk100.clone(), self.ctx_area_nk100.clone())
    }
}

#[derive(Deserialize, Default)]
struct WriteReply {
    #[serde(default)]
    output: WriteOutput,
}

#[derive(Deserialize, Default)]
struct WriteOutput {
    #[serde(default, rename = "ODNO", alias = "odno")]
    odno: String,
}

#[derive(Clone, Debug)]
pub(super) struct KisOrigin {
    pub(super) branch: String,
    pub(super) route: Option<OrderRoute>,
}

pub(super) struct KisTarget {
    branch: String,
    route: OrderRoute,
    original: OrderNumber,
    remaining: NonZeroU64,
}

impl KisTarget {
    pub(super) fn of(origin: Option<&KisOrigin>, original: &OrderNumber, remaining: NonZeroU64) -> Option<KisTarget> {
        let origin = origin?;
        Some(KisTarget { branch: origin.branch.clone(), route: origin.route?, original: original.clone(), remaining })
    }
}

pub(super) enum KisOutbound {
    Place { side: OrderSide, route: OrderRoute, code: StockCode, quantity: NonZeroU64, price: NonZeroU64 },
    Modify { target: KisTarget, price: NonZeroU64 },
    Cancel { target: KisTarget },
}

impl KisOutbound {
    pub(super) fn place(side: OrderSide, venue: Venue, code: StockCode, quantity: NonZeroU64, price: NonZeroU64) -> KisOutbound {
        KisOutbound::Place { side, route: OrderRoute::from(venue), code, quantity, price }
    }

    fn api(&self) -> KisTradingApiId {
        match self {
            KisOutbound::Place { side: OrderSide::Buy, .. } => KisTradingApiId::CashBuy,
            KisOutbound::Place { side: OrderSide::Sell, .. } => KisTradingApiId::CashSell,
            KisOutbound::Modify { .. } | KisOutbound::Cancel { .. } => KisTradingApiId::ReviseCancel,
        }
    }

    fn body(&self, account: &KisAccountNumber) -> serde_json::Value {
        let revise = |target: &KisTarget, kind: &str, price: u64| {
            json!({
                "CANO": account.cano(), "ACNT_PRDT_CD": account.product(), "KRX_FWDG_ORD_ORGNO": target.branch, "ORGN_ODNO": target.original.as_str(),
                "ORD_DVSN": LIMIT_ORDER, "RVSE_CNCL_DVSN_CD": kind, "ORD_QTY": target.remaining.to_string(), "ORD_UNPR": price.to_string(),
                "QTY_ALL_ORD_YN": WHOLE_REMAINDER, "EXCG_ID_DVSN_CD": route_code(target.route),
            })
        };
        match self {
            KisOutbound::Place { side, route, code, quantity, price } => json!({
                "CANO": account.cano(), "ACNT_PRDT_CD": account.product(), "PDNO": code.as_str(), "ORD_DVSN": LIMIT_ORDER,
                "ORD_QTY": quantity.to_string(), "ORD_UNPR": price.to_string(), "EXCG_ID_DVSN_CD": route_code(*route),
                "SLL_TYPE": if *side == OrderSide::Sell { ORDINARY_SELL } else { "" }, "CNDT_PRIC": "",
            }),
            KisOutbound::Modify { target, price } => revise(target, REVISE, price.get()),
            KisOutbound::Cancel { target } => revise(target, CANCEL, 0),
        }
    }
}

pub(super) fn kis_reason(error: &KisError) -> api::OrderRejectReason {
    match error {
        KisError::NotAdmitted => api::OrderRejectReason::OrdersOff,
        KisError::Stopped(failure) | KisError::Failed(failure) if failure.category() == Category::AuthBlocked => api::OrderRejectReason::AuthBlocked,
        KisError::TokenFile(_) => api::OrderRejectReason::AuthBlocked,
        _ => api::OrderRejectReason::KiwoomUnavailable,
    }
}

fn kis_said_no(error: &KisError) -> bool {
    match error {
        KisError::Failed(failure) | KisError::Stopped(failure) => matches!(failure.category(), Category::RateLimited | Category::TokenInvalid | Category::IssueLimited | Category::AuthBlocked | Category::BusinessRejected),
        _ => false,
    }
}

pub(super) struct KisSettled {
    pub(super) state: api::OrderCommandState,
    pub(super) reason: Option<api::OrderRejectReason>,
    pub(super) order_no: Option<String>,
}

pub(super) fn settle_kis(result: Result<KisPage, KisError>, transmitted: bool, orders_on: bool) -> KisSettled {
    let rejected = |reason| KisSettled { state: api::OrderCommandState::Rejected, reason: Some(reason), order_no: None };
    let unknown = || KisSettled { state: api::OrderCommandState::Unknown, reason: None, order_no: None };
    match result {
        Ok(page) => match serde_json::from_str::<WriteReply>(&page.body).ok().and_then(|reply| kis_order_number(&reply.output.odno)) {
            Some(number) => KisSettled { state: api::OrderCommandState::Accepted, reason: None, order_no: Some(number.as_str().to_owned()) },
            None => unknown(),
        },
        Err(KisError::NotAdmitted) if !transmitted && !orders_on => rejected(api::OrderRejectReason::OrdersOff),
        Err(e) if !transmitted => rejected(kis_reason(&e)),
        Err(e) if kis_said_no(&e) => rejected(api::OrderRejectReason::KiwoomRejected),
        Err(_) => unknown(),
    }
}

impl Trading {
    async fn kis_pages<T: Paged>(&self, desk: &KisDesk, api: KisTradingApiId, query: Vec<(&'static str, String)>, guarded: bool, priority: Priority) -> Result<Vec<T>, TradingError> {
        let (mut pages, mut seen, mut cont) = (Vec::new(), HashSet::new(), None::<(String, String)>);
        for _ in 0..MAX_PAGES {
            if guarded {
                self.enabled_record()?;
            }
            let (fk, nk) = cont.clone().unwrap_or_default();
            let mut paged = desk.account_query();
            paged.extend(query.iter().cloned());
            paged.extend([("CTX_AREA_FK100", fk), ("CTX_AREA_NK100", nk)]);
            let request = KisRequest::new(api, paged, kis_priority(priority));
            let request = if cont.is_some() { request.next_page() } else { request };
            let page = match desk.rest.call(request).await {
                Ok(page) => page,
                Err(e) if guarded => return Err(self.enabled_record().err().unwrap_or(TradingError::Kis(e))),
                Err(e) => return Err(TradingError::Kis(e)),
            };
            let body: T = serde_json::from_str(&page.body).map_err(|_| TradingError::Unreadable("한투 응답 형식"))?;
            let next = body.continuation();
            pages.push(body);
            if !page.more {
                return Ok(pages);
            }
            if !seen.insert(next.clone()) {
                return Err(TradingError::Unreadable("연속조회 키 반복"));
            }
            cont = Some(next);
        }
        Err(TradingError::Unreadable("연속조회 페이지 수 초과"))
    }

    fn balance_query() -> Vec<(&'static str, String)> {
        [("AFHR_FLPR_YN", "N"), ("OFL_YN", ""), ("INQR_DVSN", "02"), ("UNPR_DVSN", "01"), ("FUND_STTL_ICLD_YN", "N"), ("FNCG_AMT_AUTO_RDPT_YN", "N"), ("PRCS_DVSN", "00")].into_iter().map(|(k, v)| (k, v.to_owned())).collect()
    }

    pub(super) async fn kis_balance_reachable(&self, desk: &KisDesk) -> Result<(), TradingError> {
        self.kis_pages::<BalanceReply>(desk, KisTradingApiId::Balance, Self::balance_query(), false, Priority::Screen).await.map(drop)
    }

    pub(super) async fn kis_balance(&self, desk: &KisDesk, account: &Verified, priority: Priority) -> Result<api::TradingBalance, TradingError> {
        let pages = self.kis_pages::<BalanceReply>(desk, KisTradingApiId::Balance, Self::balance_query(), true, priority).await?;
        let summary = pages.first().and_then(|page| page.output2.first()).ok_or(TradingError::Unreadable("빈 응답"))?;
        let (total_purchase, total_evaluation, total_profit) = (integer(&summary.pchs_amt_smtl_amt)?, integer(&summary.evlu_amt_smtl_amt)?, integer(&summary.evlu_pfls_smtl_amt)?);
        let mut holdings = Vec::new();
        for row in pages.into_iter().flat_map(|page| page.output1) {
            let quantity = unsigned(&row.hldg_qty)?;
            let on_loan = !row.loan_amt.trim().is_empty() && integer(&row.loan_amt)? != 0;
            if quantity == 0 || on_loan {
                continue;
            }
            let sellable_quantity = unsigned(&row.ord_psbl_qty)?;
            if sellable_quantity > quantity {
                return Err(TradingError::Unreadable("주문가능수량이 보유수량보다 큼"));
            }
            holdings.push(api::TradingHolding {
                code: stock_code(&row.pdno)?,
                name: row.prdt_name.trim().to_owned(),
                quantity,
                sellable_quantity,
                average_price: whole_won(&row.pchs_avg_pric)?,
                current_price: price(&row.prpr)?,
                evaluation_profit: integer(&row.evlu_pfls_amt)?,
                profit_rate_centi: centi(&row.evlu_pfls_rt),
            });
        }
        Ok(api::TradingBalance { account_ref: account.account_ref.clone(), holdings, total_purchase, total_evaluation, total_profit })
    }

    pub(super) async fn kis_open_entries(&self, desk: &KisDesk, priority: Priority) -> Result<Vec<OpenEntry>, TradingError> {
        let query = vec![("INQR_DVSN_1", "0".to_owned()), ("INQR_DVSN_2", "0".to_owned())];
        let mut entries = Vec::new();
        for row in self.kis_pages::<RevisableReply>(desk, KisTradingApiId::Revisable, query, true, priority).await?.into_iter().flat_map(|page| page.output) {
            let (quantity, open_quantity) = (unsigned(&row.ord_qty)?, unsigned(&row.psbl_qty)?);
            if open_quantity > quantity {
                return Err(TradingError::Unreadable("가능수량이 주문수량보다 큼"));
            }
            let order_no = kis_order_number(&row.odno).ok_or(TradingError::Unreadable("주문번호"))?;
            let original = row.orgn_odno.trim();
            let route = route_of(&row.excg_id_dvsn_cd);
            let status = if row.rvse_cncl_dvsn_name.trim().is_empty() { row.ord_dvsn_name.trim() } else { row.rvse_cncl_dvsn_name.trim() };
            let order = api::TradingOpenOrder {
                order_no: order_no.as_str().to_owned(),
                code: stock_code(&row.pdno)?,
                name: row.prdt_name.trim().to_owned(),
                side: side_of(&row.sll_buy_dvsn_cd)?,
                quantity,
                price: whole_won(&row.ord_unpr)?,
                open_quantity,
                status: status.to_owned(),
                ordered_at: clock_text(&row.ord_tmd),
                original_order_no: (!original.is_empty() && original.bytes().any(|b| b != b'0')).then(|| original.to_owned()),
                venue: route.map_or(Venue::Combined, venue_of).into(),
            };
            entries.push(OpenEntry { order, ordinary_limit: row.ord_dvsn_cd.trim() == LIMIT_ORDER, kis: Some(KisOrigin { branch: row.ord_gno_brno.trim().to_owned(), route }) });
        }
        Ok(entries)
    }

    pub(super) async fn kis_orderable(&self, desk: &KisDesk, account: &Verified, code: StockCode, side: OrderSide, order_price: u64, priority: Priority) -> Result<api::TradingOrderable, TradingError> {
        self.enabled_record()?;
        let mut query = desk.account_query();
        query.extend([("PDNO", code.as_str().to_owned()), ("ORD_UNPR", order_price.to_string()), ("ORD_DVSN", BUYABLE_ORDER_KIND.to_owned()), ("CMA_EVLU_AMT_ICLD_YN", "N".to_owned()), ("OVRS_ICLD_YN", "N".to_owned())]);
        let page = match desk.rest.call(KisRequest::new(KisTradingApiId::Buyable, query, kis_priority(priority))).await {
            Ok(page) => page,
            Err(e) => return Err(self.enabled_record().err().unwrap_or(TradingError::Kis(e))),
        };
        let reply: BuyableReply = serde_json::from_str(&page.body).map_err(|_| TradingError::Unreadable("한투 응답 형식"))?;
        let policy = self.enabled_record()?.margin_policy;
        let output = reply.output;
        let (cash_amount, cash_quantity) = (non_negative(&output.nrcvb_buy_amt)?, non_negative(&output.nrcvb_buy_qty)?);
        let margin = non_negative(&output.max_buy_amt).ok().zip(non_negative(&output.max_buy_qty).ok());
        let (amount, quantity) = match (policy, margin) {
            (api::MarginPolicy::AllowMargin, Some(limit)) => limit,
            _ => (cash_amount, cash_quantity),
        };
        Ok(api::TradingOrderable {
            account_ref: account.account_ref.clone(),
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
            deposit: non_negative(&output.ord_psbl_cash)?,
            unpaid: 0,
            stock_rate: None,
            account_rate: None,
            applied_rate: None,
        })
    }

    pub(super) async fn kis_executions(&self, desk: &KisDesk, day: KstDate, priority: Priority) -> Result<Vec<api::TradingExecution>, TradingError> {
        let day_text = day.yyyymmdd();
        let query = [
            ("INQR_STRT_DT", day_text.as_str()),
            ("INQR_END_DT", day_text.as_str()),
            ("SLL_BUY_DVSN_CD", "00"),
            ("PDNO", ""),
            ("CCLD_DVSN", "01"),
            ("INQR_DVSN", "00"),
            ("INQR_DVSN_3", "00"),
            ("ORD_GNO_BRNO", ""),
            ("ODNO", ""),
            ("INQR_DVSN_1", ""),
            ("EXCG_ID_DVSN_CD", "ALL"),
        ]
        .into_iter()
        .map(|(k, v)| (k, v.to_owned()))
        .collect();
        let mut executions = Vec::new();
        for row in self.kis_pages::<DailyFillsReply>(desk, KisTradingApiId::DailyFills, query, true, priority).await?.into_iter().flat_map(|page| page.output1) {
            let quantity = unsigned(&row.tot_ccld_qty)?;
            if quantity == 0 {
                continue;
            }
            let order_no = kis_order_number(&row.odno).ok_or(TradingError::Unreadable("주문번호"))?;
            let venue = self.fill_venues.of(order_no.as_str(), day).or_else(|| route_of(&row.excg_id_dvsn_cd).map(venue_of)).ok_or(TradingError::Unreadable("거래소구분"))?;
            executions.push(api::TradingExecution {
                order_no: order_no.as_str().to_owned(),
                code: stock_code(&row.pdno)?,
                name: row.prdt_name.trim().to_owned(),
                side: side_of(&row.sll_buy_dvsn_cd)?,
                quantity,
                price: whole_won(&row.avg_prvs)?,
                time: clock_text(&row.ord_tmd),
                venue: venue.into(),
            });
        }
        Ok(executions)
    }

    pub(super) async fn kis_send_once(&self, desk: &KisDesk, outbound: &KisOutbound) -> (Result<KisPage, KisError>, bool) {
        let body = outbound.body(&desk.account);
        let open = self.open.clone();
        let once = SendOnce::new(Arc::new(move || open.load(Ordering::SeqCst)));
        let result = desk.rest.call(KisRequest::write_once(outbound.api(), Secret::new(body.to_string()), once.clone())).await;
        (result, once.happened())
    }
}
