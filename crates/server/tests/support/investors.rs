use server::kiwoom::transport::HttpResponse;
type Response = HttpResponse;
use domain::KstDate;
use serde_json::{Map, Value, json};

use super::krx::{KrxBar, KrxMarket, KrxStock};

pub const PAGE_ROWS: usize = 100;
pub const LISTED_SHARES_WHEN_UNKNOWN: u64 = 10_000_000;

pub const INVESTOR_FIELDS: [&str; 13] = ["ind_invsr", "frgnr_invsr", "orgn", "fnnc_invt", "insrnc", "invtrt", "etc_fnnc", "bank", "penfnd_etc", "samo_fund", "natn", "etc_corp", "natfor"];

const FOREIGN_FIELDS: [&str; 11] = ["dt", "close_pric", "pred_pre", "trde_qty", "chg_qty", "poss_stkcnt", "wght", "gain_pos_stkcnt", "frgnr_limit", "frgnr_limit_irds", "limit_exh_rt"];
const PRICE_FIELDS: [&str; 7] = ["dt", "cur_prc", "pre_sig", "pred_pre", "flu_rt", "acc_trde_qty", "acc_trde_prica"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ForeignDay {
    pub day: KstDate,
    pub shares: u64,
    pub weight_basis_points: u64,
    pub listed_shares: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvestorDay {
    pub day: KstDate,
    pub net_shares: [i64; INVESTOR_FIELDS.len()],
}

pub fn listed_shares(stock: &KrxStock) -> u64 {
    stock.listed_shares.unwrap_or(LISTED_SHARES_WHEN_UNKNOWN)
}

fn seed(stock: &KrxStock) -> u64 {
    stock.code.parse().unwrap_or(0)
}

pub fn foreign_days(stock: &KrxStock) -> Vec<ForeignDay> {
    stock
        .bars
        .iter()
        .enumerate()
        .map(|(i, b)| {
            let listed = listed_shares(stock);
            let shares = listed / 5 + (i as u64 * 7_919 + seed(stock)) % (listed / 20);
            ForeignDay { day: b.day, shares, weight_basis_points: shares * 10_000 / listed, listed_shares: listed }
        })
        .collect()
}

pub fn investor_days(stock: &KrxStock) -> Vec<InvestorDay> {
    stock
        .bars
        .iter()
        .enumerate()
        .map(|(i, b)| {
            let net = |k: usize| ((i as u64 * 104_729 + k as u64 * 7_919 + seed(stock)) % 20_001) as i64 - 10_000;
            InvestorDay { day: b.day, net_shares: std::array::from_fn(|k| net(k) * (k as i64 + 1)) }
        })
        .collect()
}

pub(crate) fn answer(market: &KrxMarket, api_id: &str, body: &Value, next_key: Option<&str>) -> Option<Response> {
    let list = match api_id {
        "ka10008" => "stk_frgnr",
        "ka10059" => "stk_invsr_orgn",
        _ => return None,
    };
    let Some(code) = body["stk_cd"].as_str() else {
        return Some(unsupported(format!("{api_id}에 stk_cd가 없습니다")));
    };
    let Some(stock) = market.stocks.iter().find(|s| s.code == code) else {
        let fields = if api_id == "ka10008" { FOREIGN_FIELDS.to_vec() } else { [PRICE_FIELDS.as_slice(), INVESTOR_FIELDS.as_slice()].concat() };
        let empty_row: Map<String, Value> = fields.iter().map(|f| (f.to_string(), json!(""))).collect();
        return Some(page(list, vec![Value::Object(empty_row)], None));
    };
    let rows: Vec<Value> = if api_id == "ka10008" {
        let foreign = foreign_days(stock);
        foreign.iter().zip(&stock.bars).enumerate().rev().map(|(i, (f, b))| foreign_row(f, b, i.checked_sub(1).map(|older| foreign[older].shares))).collect()
    } else {
        if (body["amt_qty_tp"].as_str(), body["trde_tp"].as_str(), body["unit_tp"].as_str()) != (Some("2"), Some("0"), Some("1")) {
            return Some(unsupported(format!("가짜 키움은 ka10059를 amt_qty_tp=2, trde_tp=0, unit_tp=1로만 흉내 냅니다: {body}")));
        }
        let Some(base_day) = body["dt"].as_str().and_then(KstDate::parse_yyyymmdd) else {
            return Some(unsupported(format!("ka10059의 dt가 YYYYMMDD가 아닙니다: {body}")));
        };
        investor_days(stock).iter().zip(&stock.bars).rev().filter(|(d, _)| d.day <= base_day).map(|(d, b)| investor_row(d, b)).collect()
    };
    let index = match next_key {
        None => 0,
        Some(key) => match key.strip_prefix(code).and_then(|rest| rest.strip_prefix('-')).and_then(|n| n.parse::<usize>().ok()) {
            Some(n) if n >= 1 => n,
            _ => return Some(unsupported(format!("unknown next-key: {key}"))),
        },
    };
    let start = (index * PAGE_ROWS).min(rows.len());
    let end = (start + PAGE_ROWS).min(rows.len());
    let next = (end < rows.len()).then(|| format!("{code}-{}", index + 1));
    Some(page(list, rows[start..end].to_vec(), next))
}

fn unsupported(why: String) -> Response {
    HttpResponse { status: 500, next_key: None, body: why }
}

fn page(list: &str, rows: Vec<Value>, next: Option<String>) -> Response {
    let mut body = json!({"return_code": 0, "return_msg": "정상적으로 처리되었습니다"});
    body[list] = Value::Array(rows);
    let last = next.is_none();
    body["_headers"] = json!({"cont-yn": if last { "N" } else { "Y" }, "next-key": next.unwrap_or_default()});
    super::response(body, last)
}

fn signed(n: i64) -> String {
    if n > 0 { format!("+{n}") } else { n.to_string() }
}

fn signed_close(b: &KrxBar) -> String {
    match b.close.cmp(&b.base) {
        std::cmp::Ordering::Greater => format!("+{}", b.close),
        std::cmp::Ordering::Equal => b.close.to_string(),
        std::cmp::Ordering::Less => format!("-{}", b.close),
    }
}

fn change(b: &KrxBar) -> i64 {
    b.close as i64 - b.base as i64
}

fn percent(basis_points: u64) -> String {
    format!("+{}.{:02}", basis_points / 100, basis_points % 100)
}

fn foreign_row(f: &ForeignDay, b: &KrxBar, older_shares: Option<u64>) -> Value {
    json!({
        "dt": f.day.yyyymmdd(),
        "close_pric": signed_close(b),
        "pred_pre": signed(change(b)),
        "trde_qty": b.volume.to_string(),
        "chg_qty": signed(f.shares as i64 - older_shares.unwrap_or(f.shares) as i64),
        "poss_stkcnt": f.shares.to_string(),
        "wght": percent(f.weight_basis_points),
        "gain_pos_stkcnt": (f.listed_shares - f.shares).to_string(),
        "frgnr_limit": f.listed_shares.to_string(),
        "frgnr_limit_irds": "0",
        "limit_exh_rt": percent(f.weight_basis_points),
    })
}

fn investor_row(d: &InvestorDay, b: &KrxBar) -> Value {
    let sig = match change(b).signum() {
        1 => "2",
        0 => "3",
        _ => "5",
    };
    let mut row = json!({
        "dt": d.day.yyyymmdd(),
        "cur_prc": signed_close(b),
        "pre_sig": sig,
        "pred_pre": signed(change(b)),
        "flu_rt": signed(change(b) * 10_000 / b.base.max(1) as i64),
        "acc_trde_qty": b.volume.to_string(),
        "acc_trde_prica": b.traded_million_won.to_string(),
    });
    for (field, net) in INVESTOR_FIELDS.iter().zip(d.net_shares) {
        row[*field] = json!(signed(net));
    }
    row
}
