use serde_json::{Value, json};

use crate::KrxBar;

pub fn row(code: &str, bar: KrxBar, trade_time: &str) -> Value {
    json!({
        "stk_cd": code,
        "dt": bar.day.yyyymmdd(),
        "cntr_tm": trade_time,
        "cur_prc": bar.close.to_string(),
        "open_pric": bar.open.to_string(),
        "high_pric": bar.high.to_string(),
        "low_pric": bar.low.to_string(),
        "trde_qty": bar.volume.to_string(),
        "trde_prica": bar.traded_million_won.to_string(),
        "base_pric": bar.base.to_string(),
    })
}

pub fn response(rows: &[Value], request: &Value) -> Value {
    let codes: Vec<&str> = request["stk_cd"].as_str().unwrap_or("").split('|').collect();
    let rows: Vec<_> = rows.iter().filter(|r| r["stk_cd"].as_str().is_some_and(|c| codes.contains(&c))).collect();
    json!({"return_code": 0, "return_msg": "합성 KRX 당일 요약", "atn_stk_infr": rows})
}
