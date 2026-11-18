use domain::{KstDate, StockCode};
use serde::{Deserialize, Deserializer, Serialize};

use super::tr::TradingApiId;
use crate::api::OrderSide;
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
    trde_tp: &'static str,
    uv: String,
}

impl Orderable {
    pub fn new(code: StockCode, side: OrderSide, price: u64) -> Orderable {
        let trde_tp = match side {
            OrderSide::Sell => "1",
            OrderSide::Buy => "2",
        };
        Orderable { stk_cd: code.as_str().to_owned(), trde_tp, uv: price.to_string() }
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct OrderableReply {
    #[serde(default)]
    pub profa_100ord_alow_amt: String,
    #[serde(default)]
    pub profa_100ord_alowq: String,
}

trading_request!(Orderable, Kt00010, OrderableReply);

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
