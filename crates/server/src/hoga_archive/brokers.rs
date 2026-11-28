use std::path::Path;

use domain::KstDate;
use duckdb::params;

use crate::api;
use crate::clock::kst;
use crate::collected_store::{file_exists, open_connection, path_str};

use super::{BROKERS_FILE, hhmmss_mmm_to_sec};

const BROKERS_QUERY: &str = "
SELECT
    CAST(ts_ms AS BIGINT),
    CAST(seq AS BIGINT),
    CAST(side AS VARCHAR),
    CAST(rank AS INTEGER),
    CAST(broker AS VARCHAR),
    CAST(qty_today AS BIGINT),
    CAST(qty_delta AS BIGINT)
FROM read_parquet($1)
WHERE ts_ms IS NOT NULL
ORDER BY ts_ms ASC, seq ASC, side ASC, rank ASC
";

pub fn broker_code_and_name(raw: &str) -> Option<(String, String)> {
    let display = raw.trim();
    if display.is_empty() {
        return None;
    }
    let compact: String = display.chars().filter(|ch| !ch.is_whitespace()).collect();
    if compact.is_empty() {
        return None;
    }
    let code = known_member_code(&compact).map_or_else(|| format!("H:{compact}"), str::to_owned);
    Some((code, display.to_owned()))
}

fn known_member_code(compact: &str) -> Option<&'static str> {
    match compact {
        "유진투자증권" | "유진증권" | "유진" => Some("001"),
        "대신" | "대신증권" => Some("002"),
        "한국투자증권" | "한국증권" | "한투" => Some("003"),
        "KB증권" | "케이비증권" => Some("004"),
        "NH투자증권" | "엔에이치투자증권" => Some("005"),
        "신영" | "신영증권" => Some("006"),
        "교보" | "교보증권" => Some("010"),
        "메리츠" | "메리츠증권" => Some("012"),
        "DB증권" | "DB금융투자" | "디비금융투자" => Some("017"),
        "유화" | "유화증권" => Some("019"),
        "한화" | "한화투자증권" => Some("021"),
        "부국" | "부국증권" => Some("022"),
        "유안타" | "유안타증권" => Some("024"),
        "현대차증권" | "현대차투자증권" => Some("025"),
        "한양" | "한양증권" => Some("029"),
        "미래에셋" | "미래에셋증권" | "미래에셋대우" => Some("030"),
        "삼성" | "삼성증권" => Some("031"),
        "다올투자증권" | "KTB투자증권" => Some("032"),
        "JP모간서울" | "JP모간" | "제이피모간" => Some("033"),
        "골드만삭스" | "골드만" => Some("035"),
        "하나증권" | "하나금융투자" | "하나" => Some("036"),
        "아이엠증권" | "하이투자증권" => Some("037"),
        "SK증권" | "에스케이증권" => Some("038"),
        "C.L.S.A증권" | "CLSA증권" | "CLSA" => Some("040"),
        "노무라" | "노무라증권" => Some("041"),
        "메릴린치" | "메릴린치증권" => Some("042"),
        "신한투자증권" | "신한금융투자" | "신한" => Some("043"),
        "모건스탠리" | "모간스탠리" => Some("044"),
        "유비에스증권" | "UBS증권" | "UBS" => Some("045"),
        "다이와" | "다이와증권" => Some("046"),
        "BNK증권" | "BNK투자증권" => Some("048"),
        "키움증권" | "키움" => Some("050"),
        "상상인증권" | "골든브릿지" => Some("052"),
        "씨티그룹" | "씨티" | "씨티글로벌" => Some("054"),
        "HSBC" | "HSBC증권" => Some("056"),
        "리딩투자" | "리딩투자증권" => Some("057"),
        "BNP파리바" | "BNP" => Some("058"),
        "맥쿼리증권" | "맥쿼리" => Some("061"),
        "SG증권" | "소시에테제네랄" => Some("062"),
        "LS증권" | "이베스트투자증권" | "이베스트" => Some("063"),
        "IBK투자증권" | "IBK" => Some("064"),
        "CIMB" | "CIMB증권" => Some("065"),
        "케이프투자증권" | "케이프" => Some("067"),
        "흥국증권중개" | "흥국증권" => Some("071"),
        "디에스투자증권" | "DS투자증권" => Some("072"),
        "코리아에셋" | "코리아에셋투자증권" => Some("078"),
        "한국아이엠씨" | "IMC" => Some("079"),
        "카카오페이증권" | "카카오페이" => Some("087"),
        "토스" | "토스증권" => Some("089"),
        "우리투자증권" | "한국포스증권" => Some("090"),
        _ => None,
    }
}

pub fn read_brokers_day(hogaplay_dir: &Path, date: KstDate) -> Result<Vec<api::FeedBrokers>, String> {
    let path = hogaplay_dir.join(BROKERS_FILE);
    if !file_exists(&path)? {
        return Ok(Vec::new());
    }
    let path_text = path_str(&path)?;
    let day_start_sec = kst(date, 0, 0, 0).unix();
    let conn = open_connection()?;
    let mut stmt = conn.prepare(BROKERS_QUERY).map_err(|e| format!("아카이브 거래원 조회 준비 실패({path_text}): {e}"))?;
    let mut rows = stmt.query(params![path_text]).map_err(|e| format!("아카이브 거래원 조회 실행 실패({path_text}): {e}"))?;

    let mut snapshots: Vec<api::FeedBrokers> = Vec::new();
    let mut current_key: Option<(i64, i64)> = None;
    let mut current_sec: i64 = 0;
    let mut sells: Vec<api::FeedBroker> = Vec::new();
    let mut buys: Vec<api::FeedBroker> = Vec::new();

    while let Some(row) = rows.next().map_err(|e| format!("아카이브 거래원 행 읽기 실패({path_text}): {e}"))? {
        let ts_ms = row.get::<_, i64>(0).map_err(|e| format!("ts_ms 읽기 실패({path_text}): {e}"))?;
        let seq = row.get::<_, Option<i64>>(1).map_err(|e| format!("seq 읽기 실패({path_text}): {e}"))?.unwrap_or(0);
        let Some(sec_of_day) = hhmmss_mmm_to_sec(ts_ms) else {
            continue;
        };
        let key = (ts_ms, seq);
        if current_key != Some(key) {
            if current_key.is_some() && (!sells.is_empty() || !buys.is_empty()) {
                snapshots.push(api::FeedBrokers {
                    t: api::UnixSeconds(current_sec),
                    sells: std::mem::take(&mut sells),
                    buys: std::mem::take(&mut buys),
                    foreign_est_net_qty: None,
                    foreign_est_net_change: None,
                });
            } else {
                sells.clear();
                buys.clear();
            }
            current_key = Some(key);
            current_sec = day_start_sec + i64::from(sec_of_day);
        }
        let side = row.get::<_, Option<String>>(2).map_err(|e| format!("side 읽기 실패({path_text}): {e}"))?;
        let broker = row.get::<_, Option<String>>(4).map_err(|e| format!("broker 읽기 실패({path_text}): {e}"))?;
        let qty_today = row.get::<_, Option<i64>>(5).map_err(|e| format!("qty_today 읽기 실패({path_text}): {e}"))?.unwrap_or(0).max(0) as u64;
        let qty_delta = row.get::<_, Option<i64>>(6).map_err(|e| format!("qty_delta 읽기 실패({path_text}): {e}"))?.unwrap_or(0);
        let Some((code, name)) = broker.as_deref().and_then(broker_code_and_name) else {
            continue;
        };
        let entry = api::FeedBroker {
            code,
            name,
            qty: qty_today,
            qty_change: qty_delta,
        };
        match side.as_deref().map(str::trim) {
            Some("sell") => sells.push(entry),
            Some("buy") => buys.push(entry),
            _ => {}
        }
    }

    if current_key.is_some() && (!sells.is_empty() || !buys.is_empty()) {
        snapshots.push(api::FeedBrokers {
            t: api::UnixSeconds(current_sec),
            sells,
            buys,
            foreign_est_net_qty: None,
            foreign_est_net_change: None,
        });
    }

    Ok(snapshots)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_all_known_broker_names_and_handles_whitespace_and_fallback() {
        assert_eq!(broker_code_and_name("한  화"), Some(("021".into(), "한  화".into())));
        assert_eq!(broker_code_and_name("삼  성"), Some(("031".into(), "삼  성".into())));
        assert_eq!(broker_code_and_name("H S B C"), Some(("056".into(), "H S B C".into())));
        assert_eq!(broker_code_and_name("C.L.S.A 증권"), Some(("040".into(), "C.L.S.A 증권".into())));
        assert_eq!(broker_code_and_name("DB금융투자").unwrap().0, broker_code_and_name("DB증권").unwrap().0);
        assert_eq!(broker_code_and_name("신규미등록증권"), Some(("H:신규미등록증권".into(), "신규미등록증권".into())));
        assert_eq!(broker_code_and_name("   "), None);
    }

    #[test]
    fn reads_long_format_brokers_parquet_into_snapshots() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open_connection().unwrap();
        let path = tmp.path().join("brokers.parquet");
        conn.execute_batch(&format!(
            "SET threads = 1; COPY (
                SELECT 90144276::BIGINT AS ts_ms, 10::INTEGER AS seq, 'buy' AS side, 1::TINYINT AS rank, '신한투자증권' AS broker, 1751::INTEGER AS qty_today, 1751::INTEGER AS qty_delta
                UNION ALL
                SELECT 90144276::BIGINT, 10::INTEGER, 'sell', 1::TINYINT, 'JP모간서울', 500::INTEGER, 500::INTEGER
                UNION ALL
                SELECT 90200000::BIGINT, 11::INTEGER, 'buy', 1::TINYINT, '한  화', 2000::INTEGER, 249::INTEGER
            ) TO '{}' (FORMAT parquet)",
            path.display()
        ))
        .unwrap();

        let date = KstDate::new(2024, 8, 27).unwrap();
        let snapshots = read_brokers_day(tmp.path(), date).unwrap();
        assert_eq!(snapshots.len(), 2);
        assert_eq!(snapshots[0].t.0, kst(date, 9, 1, 44).unix());
        assert_eq!(snapshots[0].buys[0].code, "043");
        assert_eq!(snapshots[0].sells[0].code, "033");
        assert_eq!(snapshots[0].foreign_est_net_qty, None);
        assert_eq!(snapshots[1].buys[0].code, "021");
    }
}
