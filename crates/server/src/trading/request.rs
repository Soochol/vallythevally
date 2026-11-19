use std::num::NonZeroU64;

use domain::{KstDate, StockCode, Venue};
use serde::{Deserialize, Deserializer, Serialize};

use super::tr::TradingApiId;
use crate::config::Secret;

mod sealed {
    pub trait Sealed {}
}

pub trait TradingRequest: sealed::Sealed + Serialize + Send + Sync {
    const API_ID: TradingApiId;
    type Response: serde::de::DeserializeOwned;
}

pub trait Rows {
    type Row;

    fn into_rows(self) -> Vec<Self::Row>;
}

macro_rules! trading_request {
    ($name:ident, $api:ident, $resp:ty) => {
        impl sealed::Sealed for $name {}
        impl TradingRequest for $name {
            const API_ID: TradingApiId = TradingApiId::$api;
            type Response = $resp;
        }
    };
}

fn secret_text<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Secret<String>>, D::Error> {
    Ok(Option::<String>::deserialize(d)?.map(Secret::new))
}

#[derive(Serialize)]
pub struct AccountNumber {}

#[derive(Debug, Deserialize)]
pub struct AccountNumberReply {
    #[serde(rename = "acctNo", default, deserialize_with = "secret_text")]
    pub account: Option<Secret<String>>,
}

trading_request!(AccountNumber, Ka00001, AccountNumberReply);

#[derive(Serialize)]
pub struct Balance {
    qry_tp: &'static str,
    dmst_stex_tp: &'static str,
}

impl Balance {
    pub fn individual_krx() -> Balance {
        Balance { qry_tp: "2", dmst_stex_tp: "KRX" }
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct BalanceReply {
    #[serde(default)]
    pub tot_pur_amt: String,
    #[serde(default)]
    pub tot_evlt_amt: String,
    #[serde(default)]
    pub tot_evlt_pl: String,
    #[serde(default)]
    pub acnt_evlt_remn_indv_tot: Vec<BalanceRow>,
}

#[derive(Debug, Deserialize, Default)]
pub struct BalanceRow {
    #[serde(default)]
    pub stk_cd: String,
    #[serde(default)]
    pub stk_nm: String,
    #[serde(default)]
    pub evltv_prft: String,
    #[serde(default)]
    pub prft_rt: String,
    #[serde(default)]
    pub pur_pric: String,
    #[serde(default)]
    pub rmnd_qty: String,
    #[serde(default)]
    pub trde_able_qty: String,
    #[serde(default)]
    pub cur_prc: String,
    #[serde(default)]
    pub crd_tp: String,
}

impl Rows for BalanceReply {
    type Row = BalanceRow;

    fn into_rows(self) -> Vec<BalanceRow> {
        self.acnt_evlt_remn_indv_tot
    }
}

trading_request!(Balance, Kt00018, BalanceReply);

#[derive(Serialize)]
pub struct OpenOrders {
    all_stk_tp: &'static str,
    trde_tp: &'static str,
    stk_cd: &'static str,
    stex_tp: &'static str,
}

impl OpenOrders {
    pub fn all() -> OpenOrders {
        OpenOrders { all_stk_tp: "0", trde_tp: "0", stk_cd: "", stex_tp: "0" }
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct OpenOrdersReply {
    #[serde(default)]
    pub oso: Vec<OpenOrderRow>,
}

#[derive(Debug, Deserialize, Default)]
pub struct OpenOrderRow {
    #[serde(default, deserialize_with = "secret_text")]
    pub acnt_no: Option<Secret<String>>,
    #[serde(default)]
    pub ord_no: String,
    #[serde(default)]
    pub stk_cd: String,
    #[serde(default)]
    pub stk_nm: String,
    #[serde(default)]
    pub ord_stt: String,
    #[serde(default)]
    pub ord_qty: String,
    #[serde(default)]
    pub ord_pric: String,
    #[serde(default)]
    pub oso_qty: String,
    #[serde(default)]
    pub orig_ord_no: String,
    #[serde(default)]
    pub io_tp_nm: String,
    #[serde(default)]
    pub trde_tp: String,
    #[serde(default)]
    pub tm: String,
    #[serde(default)]
    pub stex_tp: String,
    #[serde(default)]
    pub stex_tp_txt: String,
    #[serde(default)]
    pub sor_yn: String,
}

impl Rows for OpenOrdersReply {
    type Row = OpenOrderRow;

    fn into_rows(self) -> Vec<OpenOrderRow> {
        self.oso
    }
}

trading_request!(OpenOrders, Ka10075, OpenOrdersReply);

#[derive(Serialize)]
pub struct Orderable {
    stk_cd: String,
    uv: String,
}

impl Orderable {
    pub fn new(code: StockCode, price: u64) -> Orderable {
        Orderable { stk_cd: code.as_str().to_owned(), uv: price.to_string() }
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct OrderableReply {
    #[serde(default)]
    pub stk_profa_rt: String,
    #[serde(default)]
    pub profa_rt: String,
    #[serde(default)]
    pub aplc_rt: String,
    #[serde(default)]
    pub min_ord_alow_amt: String,
    #[serde(default)]
    pub min_ord_alowq: String,
    #[serde(default)]
    pub profa_20ord_alow_amt: String,
    #[serde(default)]
    pub profa_20ord_alowq: String,
    #[serde(default)]
    pub profa_30ord_alow_amt: String,
    #[serde(default)]
    pub profa_30ord_alowq: String,
    #[serde(default)]
    pub profa_40ord_alow_amt: String,
    #[serde(default)]
    pub profa_40ord_alowq: String,
    #[serde(default)]
    pub profa_50ord_alow_amt: String,
    #[serde(default)]
    pub profa_50ord_alowq: String,
    #[serde(default)]
    pub profa_60ord_alow_amt: String,
    #[serde(default)]
    pub profa_60ord_alowq: String,
    #[serde(default)]
    pub profa_100ord_alow_amt: String,
    #[serde(default)]
    pub profa_100ord_alowq: String,
    #[serde(default)]
    pub entr: String,
    #[serde(default)]
    pub uncla: String,
}

impl OrderableReply {
    pub fn margin_columns(&self, applied_rate: f64) -> Option<(&str, &str)> {
        let columns = match applied_rate {
            20.0 => (&self.profa_20ord_alow_amt, &self.profa_20ord_alowq),
            30.0 => (&self.profa_30ord_alow_amt, &self.profa_30ord_alowq),
            40.0 => (&self.profa_40ord_alow_amt, &self.profa_40ord_alowq),
            50.0 => (&self.profa_50ord_alow_amt, &self.profa_50ord_alowq),
            60.0 => (&self.profa_60ord_alow_amt, &self.profa_60ord_alowq),
            100.0 => (&self.profa_100ord_alow_amt, &self.profa_100ord_alowq),
            _ => return None,
        };
        Some((columns.0, columns.1))
    }
}

trading_request!(Orderable, Kt00011, OrderableReply);

#[derive(Serialize)]
pub struct Executions {
    ord_dt: String,
    qry_tp: &'static str,
    stk_bond_tp: &'static str,
    sell_tp: &'static str,
    stk_cd: &'static str,
    fr_ord_no: &'static str,
    dmst_stex_tp: &'static str,
}

impl Executions {
    pub fn of_day(day: KstDate) -> Executions {
        Executions { ord_dt: day.yyyymmdd(), qry_tp: "4", stk_bond_tp: "1", sell_tp: "0", stk_cd: "", fr_ord_no: "", dmst_stex_tp: "%" }
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct ExecutionsReply {
    #[serde(default)]
    pub acnt_ord_cntr_prps_dtl: Vec<ExecutionRow>,
}

#[derive(Debug, Deserialize, Default)]
pub struct ExecutionRow {
    #[serde(default)]
    pub ord_no: String,
    #[serde(default)]
    pub stk_cd: String,
    #[serde(default)]
    pub stk_nm: String,
    #[serde(default)]
    pub trde_tp: String,
    #[serde(default)]
    pub io_tp_nm: String,
    #[serde(default)]
    pub cntr_qty: String,
    #[serde(default)]
    pub cntr_uv: String,
    #[serde(default)]
    pub ord_tm: String,
    #[serde(default)]
    pub cnfm_tm: String,
    #[serde(default)]
    pub dmst_stex_tp: String,
}

impl Rows for ExecutionsReply {
    type Row = ExecutionRow;

    fn into_rows(self) -> Vec<ExecutionRow> {
        self.acnt_ord_cntr_prps_dtl
    }
}

trading_request!(Executions, Kt00007, ExecutionsReply);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum OrderRoute {
    #[serde(rename = "SOR")]
    Sor,
    #[serde(rename = "KRX")]
    Krx,
    #[serde(rename = "NXT")]
    Nxt,
}

impl From<Venue> for OrderRoute {
    fn from(venue: Venue) -> OrderRoute {
        match venue {
            Venue::Combined => OrderRoute::Sor,
            Venue::Krx => OrderRoute::Krx,
            Venue::Nxt => OrderRoute::Nxt,
        }
    }
}

struct LimitOrdinary;

impl Serialize for LimitOrdinary {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str("0")
    }
}

#[derive(Serialize)]
pub struct LimitOrder {
    dmst_stex_tp: OrderRoute,
    stk_cd: String,
    ord_qty: String,
    ord_uv: String,
    trde_tp: LimitOrdinary,
}

impl LimitOrder {
    pub fn new(route: OrderRoute, code: StockCode, quantity: NonZeroU64, price: NonZeroU64) -> LimitOrder {
        LimitOrder { dmst_stex_tp: route, stk_cd: code.as_str().to_owned(), ord_qty: quantity.to_string(), ord_uv: price.to_string(), trde_tp: LimitOrdinary }
    }
}

#[derive(Serialize)]
#[serde(transparent)]
pub struct BuyOrder(pub LimitOrder);

#[derive(Serialize)]
#[serde(transparent)]
pub struct SellOrder(pub LimitOrder);

#[derive(Serialize)]
pub struct ModifyOrder {
    dmst_stex_tp: OrderRoute,
    orig_ord_no: String,
    stk_cd: String,
    mdfy_qty: String,
    mdfy_uv: String,
}

impl ModifyOrder {
    pub fn new(route: OrderRoute, original: &OrderNumber, code: StockCode, remaining: NonZeroU64, price: NonZeroU64) -> ModifyOrder {
        ModifyOrder { dmst_stex_tp: route, orig_ord_no: original.as_str().to_owned(), stk_cd: code.as_str().to_owned(), mdfy_qty: remaining.to_string(), mdfy_uv: price.to_string() }
    }
}

#[derive(Serialize)]
pub struct CancelOrder {
    dmst_stex_tp: OrderRoute,
    orig_ord_no: String,
    stk_cd: String,
    cncl_qty: String,
}

impl CancelOrder {
    pub fn new(route: OrderRoute, original: &OrderNumber, code: StockCode, remaining: NonZeroU64) -> CancelOrder {
        CancelOrder { dmst_stex_tp: route, orig_ord_no: original.as_str().to_owned(), stk_cd: code.as_str().to_owned(), cncl_qty: remaining.to_string() }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderNumber(String);

impl OrderNumber {
    pub fn parse(text: &str) -> Option<OrderNumber> {
        let text = text.trim();
        (text.len() == 7 && text.bytes().all(|b| b.is_ascii_digit())).then(|| OrderNumber(text.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct OrderAck {
    #[serde(default)]
    pub ord_no: String,
}

trading_request!(BuyOrder, Kt10000, OrderAck);
trading_request!(SellOrder, Kt10001, OrderAck);
trading_request!(ModifyOrder, Kt10002, OrderAck);
trading_request!(CancelOrder, Kt10003, OrderAck);
