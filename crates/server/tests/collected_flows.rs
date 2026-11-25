use std::path::Path;

use domain::{KstDate, StockCode, TimeOfDay};
use duckdb::Connection;
use serde_json::{Value, json};
use server::api::BrokerDaySource;
use server::clock::kst;
use server::collected::Collected;
use server::collected::kind::{
    CollectedExpectedTrade, CollectedKind, CollectedProgramRow, CollectedTradeTick, CollectedViEvent, ExpectedTrades, ProgramFlow, TradeTicks, ViAction,
    ViEvents, ViKind,
};
use server::collected_store::CollectedStore;
use server::market_source::stream::{Exchange, TradeSide};
use server::market_source::vi::{ViDirection, ViMarket};
use server::shared_data::{CollectorPaths, FlowDescription, FlowRow, FlowWriter, flow_links_path, flow_path};

const CLOSED: &str = "20261123";
const TODAY: &str = "20261124";
const BUCKETS: u64 = 64;

fn date_of(day: u8) -> KstDate {
    KstDate::new(2026, 11, day).unwrap()
}

fn at_ms(day: u8, hour: u32, minute: u32, second: u32, ms: i64) -> i64 {
    kst(date_of(day), hour, minute, second).unix() * 1000 + ms
}

fn stock() -> StockCode {
    StockCode::parse("005930").unwrap()
}

fn hms(hour: u32, minute: u32, second: u32) -> TimeOfDay {
    TimeOfDay::hms(hour, minute, second).unwrap()
}

fn bucket_file(symbol: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in symbol.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{:03}.parquet", hash % BUCKETS)
}

fn write_complete(data: &Path, date: &str, gaps: Value) {
    let folder = data.join("store").join(date);
    std::fs::create_dir_all(&folder).unwrap();
    let complete = json!({
        "format_version": 1,
        "verify": {"passed": true, "buckets": BUCKETS},
        "raw_files": {"collect-01/0900-000.jsonl.zst": 10},
        "stocks": [{"code": "005930", "key": "collect-01", "registered": true, "received": true, "gaps": gaps, "handoff": null}],
    });
    std::fs::write(folder.join("complete.json"), complete.to_string()).unwrap();
}

fn write_parquet(data: &Path, date: &str, type_code: &str, symbol_bucket: &str, rows: &[String]) {
    let parquet = data.join("store").join(date).join(type_code).join(bucket_file(symbol_bucket));
    std::fs::create_dir_all(parquet.parent().unwrap()).unwrap();
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(&format!("SET threads = 1; COPY ({}) TO '{}' (FORMAT parquet)", rows.join(" UNION ALL "), parquet.display()))
        .unwrap();
}

fn write_flow<K: CollectedKind>(shared: &Path, date: &str, key: &str, rows: &[FlowRow]) {
    let path = flow_path(shared, date, K::TYPE_CODE, "005930", key);
    FlowWriter::open(&path, FlowDescription::new(K::TYPE_CODE, "005930", date, key, K::fids()))
        .unwrap()
        .append(rows)
        .unwrap();
}

fn write_links(shared: &Path, date: &str, key: &str, lines: &[(i64, &str)]) {
    let path = flow_links_path(shared, date, key);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let text: String = lines.iter().map(|(t_ms, event)| format!("{}\n", json!({"t": t_ms, "event": event}))).collect();
    std::fs::write(path, text).unwrap();
}

fn program_flow_row(recv_ms: i64, hhmmss: &str, price: &str, net_qty: &str) -> FlowRow {
    FlowRow {
        recv_ms,
        values: vec![
            Some(hhmmss.to_owned()),
            Some(price.to_owned()),
            Some("100".to_owned()),
            Some("7".to_owned()),
            Some("250".to_owned()),
            Some("18".to_owned()),
            Some(net_qty.to_owned()),
            Some("+10".to_owned()),
            Some("+11".to_owned()),
            Some("-2".to_owned()),
        ],
    }
}

fn program_sql(symbol: &str, recv_ms: i64, hhmmss: &str, price: &str, net_qty: i64) -> String {
    format!(
        "SELECT '{symbol}' AS symbol, {recv_ms}::BIGINT AS recv_ms, '{hhmmss}' AS f20, {price} AS f10, 100::BIGINT AS f202, 7::BIGINT AS f204, 250::BIGINT AS f206, 18::BIGINT AS f208, {net_qty}::BIGINT AS f210, 10::BIGINT AS f211, 11::BIGINT AS f212, (-2)::BIGINT AS f213"
    )
}

#[allow(clippy::too_many_arguments)]
fn vi_flow_row(
    recv_ms: i64,
    f9001: &str,
    kind: &str,
    direction: &str,
    trigger_price: &str,
    triggered: &str,
    released: &str,
    action: &str,
) -> FlowRow {
    FlowRow {
        recv_ms,
        values: vec![
            Some(f9001.to_owned()),
            Some(kind.to_owned()),
            Some(direction.to_owned()),
            Some(trigger_price.to_owned()),
            Some(triggered.to_owned()),
            Some(released.to_owned()),
            Some(action.to_owned()),
            Some("70000".to_owned()),
            Some("70500".to_owned()),
            Some("+2.86".to_owned()),
            Some("-1.50".to_owned()),
            Some("+3.10".to_owned()),
            Some("+2".to_owned()),
        ],
    }
}

#[allow(clippy::too_many_arguments)]
fn vi_sql(
    symbol: &str,
    recv_ms: i64,
    f9001: &str,
    kind: &str,
    direction: &str,
    trigger_price: &str,
    triggered: &str,
    released: &str,
    action: &str,
) -> String {
    format!(
        "SELECT '{symbol}' AS symbol, {recv_ms}::BIGINT AS recv_ms, '{f9001}' AS f9001, '{kind}' AS f9068, '{direction}' AS f9069, {trigger_price} AS f1221, '{triggered}' AS f1223, '{released}' AS f1224, '{action}' AS f1225, 70000::BIGINT AS f1236, 70500::BIGINT AS f1237, 2.86::DOUBLE AS f1238, (-1.5)::DOUBLE AS f1239, 3.1::DOUBLE AS f1489, 2::BIGINT AS f1490"
    )
}

#[allow(clippy::too_many_arguments)]
fn expected_flow_row(recv_ms: i64, hhmmss: &str, price: &str, change: &str, pct: &str, qty: &str, cum: &str, sign: &str) -> FlowRow {
    FlowRow {
        recv_ms,
        values: vec![
            Some(hhmmss.to_owned()),
            Some(price.to_owned()),
            Some(change.to_owned()),
            Some(pct.to_owned()),
            Some(qty.to_owned()),
            Some(cum.to_owned()),
            Some(sign.to_owned()),
        ],
    }
}

#[allow(clippy::too_many_arguments)]
fn expected_sql(symbol: &str, recv_ms: i64, hhmmss: &str, price: i64, change: i64, pct: f64, qty: i64, cum: i64, sign: i64) -> String {
    format!(
        "SELECT '{symbol}' AS symbol, {recv_ms}::BIGINT AS recv_ms, '{hhmmss}' AS f20, {price}::BIGINT AS f10, {change}::BIGINT AS f11, {pct}::DOUBLE AS f12, {qty}::BIGINT AS f15, {cum}::BIGINT AS f13, {sign}::BIGINT AS f25"
    )
}

fn tick_flow_row(recv_ms: i64, hhmmss: &str, price: &str, signed_qty: &str, instant_value: Option<&str>, exchange: &str) -> FlowRow {
    FlowRow {
        recv_ms,
        values: vec![
            Some(hhmmss.to_owned()),
            Some(price.to_owned()),
            Some(signed_qty.to_owned()),
            instant_value.map(str::to_owned),
            Some(exchange.to_owned()),
        ],
    }
}

fn tick_sql(symbol: &str, recv_ms: i64, hhmmss: &str, price: i64, signed_qty: i64, instant_value: &str, exchange: &str) -> String {
    format!(
        "SELECT '{symbol}' AS symbol, {recv_ms}::BIGINT AS recv_ms, '{hhmmss}' AS f20, {price}::BIGINT AS f10, {signed_qty}::BIGINT AS f15, {instant_value} AS f1313, '{exchange}' AS f9081"
    )
}

#[tokio::test]
async fn closed_store_reads_all_four_kinds_and_merges_vi_symbol_buckets() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("hoga");
    let paths = CollectorPaths::hoga_only(data.clone());
    let collected = Collected::new(CollectedStore::new());
    let now = kst(date_of(24), 10, 0, 0);

    assert_ne!(bucket_file("005930_AL"), bucket_file("005930"));
    write_complete(
        &data,
        CLOSED,
        json!([{"from_ms": at_ms(23, 10, 0, 0, 0), "to_ms": at_ms(23, 10, 1, 0, 0)}]),
    );
    write_parquet(
        &data,
        CLOSED,
        "0w",
        "005930_AL",
        &[
            program_sql("005930_AL", at_ms(23, 9, 0, 10, 0), "090010", "71000::BIGINT", 150),
            program_sql("005930_AL", at_ms(23, 9, 0, 20, 0), "090020", "0::BIGINT", -40),
            program_sql("005930_AL", at_ms(23, 9, 0, 30, 0), "bad", "71000::BIGINT", 10),
        ],
    );
    write_parquet(
        &data,
        CLOSED,
        "1h",
        "005930_AL",
        &[
            vi_sql("005930_AL", at_ms(23, 9, 5, 0, 0), "005930_NX", "2", "2", "68000::BIGINT", "090500", "090700", "2"),
            vi_sql("005930_AL", at_ms(23, 9, 6, 0, 0), "005930", "4", "1", "72000::BIGINT", "090600", "000000", "1"),
        ],
    );
    write_parquet(
        &data,
        CLOSED,
        "1h",
        "005930",
        &[
            vi_sql("005930", at_ms(23, 9, 2, 0, 0), "005930", "1", "1", "77000::BIGINT", "090200", "000000", "1"),
            vi_sql("005930", at_ms(23, 9, 10, 0, 0), "005930", "3", "2", "0::BIGINT", "091000", "", ""),
        ],
    );
    write_parquet(
        &data,
        CLOSED,
        "0H",
        "005930_AL",
        &[
            expected_sql("005930_AL", at_ms(23, 8, 55, 0, 0), "085500", 71500, 500, 0.7, 1200, 50000, 2),
            expected_sql("005930_AL", at_ms(23, 8, 56, 0, 0), "085600", 0, 0, 0.0, 100, 50100, 3),
        ],
    );
    write_parquet(
        &data,
        CLOSED,
        "0B",
        "005930_AL",
        &[
            tick_sql("005930_AL", at_ms(23, 9, 0, 1, 100), "090001", 71000, 4, "284::BIGINT", "KRX"),
            tick_sql("005930_AL", at_ms(23, 9, 0, 2, 200), "090002", -70900, -12, "NULL::BIGINT", "NXT"),
            tick_sql("005930_AL", at_ms(23, 9, 0, 3, 300), "090003", 70900, 0, "0::BIGINT", "KRX"),
        ],
    );

    assert_eq!(collected.program_days(paths.clone(), stock(), now).await.unwrap(), vec![CLOSED]);
    assert_eq!(collected.vi_days(paths.clone(), stock(), now).await.unwrap(), vec![CLOSED]);
    assert_eq!(collected.expected_days(paths.clone(), stock(), now).await.unwrap(), vec![CLOSED]);
    assert_eq!(collected.ticks_days(paths.clone(), stock(), now).await.unwrap(), vec![CLOSED]);

    let program = collected.program_day(paths.clone(), stock(), date_of(23), CLOSED, None, now).await.unwrap();
    assert_eq!(program.source, BrokerDaySource::Store);
    assert_eq!(program.gaps, vec![[at_ms(23, 10, 0, 0, 0) / 1000, at_ms(23, 10, 1, 0, 0) / 1000]]);
    assert_eq!(
        program.snapshots,
        vec![
            CollectedProgramRow {
                recv_ms: at_ms(23, 9, 0, 10, 0),
                hhmmss: hms(9, 0, 10),
                price_won: Some(71_000),
                sell_qty: 100,
                sell_amount_million_won: 7,
                buy_qty: 250,
                buy_amount_million_won: 18,
                net_buy_qty: 150,
                net_buy_qty_change: 10,
                net_buy_amount_million_won: 11,
                net_buy_amount_change_million_won: -2,
            },
            CollectedProgramRow {
                recv_ms: at_ms(23, 9, 0, 20, 0),
                hhmmss: hms(9, 0, 20),
                price_won: None,
                sell_qty: 100,
                sell_amount_million_won: 7,
                buy_qty: 250,
                buy_amount_million_won: 18,
                net_buy_qty: -40,
                net_buy_qty_change: 10,
                net_buy_amount_million_won: 11,
                net_buy_amount_change_million_won: -2,
            },
        ]
    );

    let vi = collected.vi_day(paths.clone(), stock(), date_of(23), CLOSED, None, now).await.unwrap();
    assert_eq!(vi.source, BrokerDaySource::Store);
    assert_eq!(vi.snapshots.len(), 3);
    assert_eq!(
        vi.snapshots,
        vec![
            CollectedViEvent {
                recv_ms: at_ms(23, 9, 2, 0, 0),
                market: ViMarket::Krx,
                kind: ViKind::Static,
                direction: ViDirection::Up,
                trigger_price_won: Some(77_000),
                triggered: hms(9, 2, 0),
                released: None,
                action: Some(ViAction::Trigger),
                static_base_won: Some(70_000),
                dynamic_base_won: Some(70_500),
                static_deviation_pct: Some(2.86),
                dynamic_deviation_pct: Some(-1.5),
                trigger_change_pct: Some(3.1),
                trigger_count: Some(2),
            },
            CollectedViEvent {
                recv_ms: at_ms(23, 9, 5, 0, 0),
                market: ViMarket::Nxt,
                kind: ViKind::Dynamic,
                direction: ViDirection::Down,
                trigger_price_won: Some(68_000),
                triggered: hms(9, 5, 0),
                released: Some(hms(9, 7, 0)),
                action: Some(ViAction::Release),
                static_base_won: Some(70_000),
                dynamic_base_won: Some(70_500),
                static_deviation_pct: Some(2.86),
                dynamic_deviation_pct: Some(-1.5),
                trigger_change_pct: Some(3.1),
                trigger_count: Some(2),
            },
            CollectedViEvent {
                recv_ms: at_ms(23, 9, 10, 0, 0),
                market: ViMarket::Krx,
                kind: ViKind::Both,
                direction: ViDirection::Down,
                trigger_price_won: None,
                triggered: hms(9, 10, 0),
                released: None,
                action: None,
                static_base_won: Some(70_000),
                dynamic_base_won: Some(70_500),
                static_deviation_pct: Some(2.86),
                dynamic_deviation_pct: Some(-1.5),
                trigger_change_pct: Some(3.1),
                trigger_count: Some(2),
            },
        ]
    );

    let expected = collected.expected_day(paths.clone(), stock(), date_of(23), CLOSED, None, now).await.unwrap();
    assert_eq!(
        expected.snapshots,
        vec![CollectedExpectedTrade {
            recv_ms: at_ms(23, 8, 55, 0, 0),
            hhmmss: hms(8, 55, 0),
            price_won: 71_500,
            change_won: 500,
            change_pct: Some(0.7),
            expected_qty: 1200,
            cumulative_qty: 50_000,
            change_sign: Some(2),
        }]
    );

    let ticks = collected.ticks_day(paths, stock(), date_of(23), CLOSED, None, now).await.unwrap();
    assert_eq!(ticks.snapshots.len(), 2);
    assert_eq!(ticks.snapshots[0].qty(), 4);
    assert_eq!(ticks.snapshots[0].side(), TradeSide::Buy);
    assert_eq!(ticks.snapshots[0].value_won(), 284_000);
    assert_eq!(ticks.snapshots[0].exchange, Some(Exchange::Krx));
    assert_eq!(ticks.snapshots[0].instant_value_thousand_won, Some(284));
    assert_eq!(ticks.snapshots[1].qty(), 12);
    assert_eq!(ticks.snapshots[1].side(), TradeSide::Sell);
    assert_eq!(ticks.snapshots[1].value_won(), 850_800);
    assert_eq!(ticks.snapshots[1].exchange, Some(Exchange::Nxt));
    assert_eq!(ticks.snapshots[1].instant_value_thousand_won, None);
}

#[tokio::test]
async fn intraday_flow_supports_incremental_cursor_two_key_handoff_and_store_rollover() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("hoga");
    let shared = data.join("shared");
    let paths = CollectorPaths::hoga_only(data.clone());
    let collected = Collected::new(CollectedStore::new());
    let t0 = kst(date_of(24), 10, 0, 0);
    let t1 = kst(date_of(24), 10, 0, 2);
    let t2 = kst(date_of(24), 10, 0, 4);

    write_links(&shared, TODAY, "collect-01", &[(at_ms(24, 8, 0, 0, 0), "live"), (at_ms(24, 9, 59, 50, 0), "alive")]);
    write_links(&shared, TODAY, "spare-01", &[(at_ms(24, 8, 0, 0, 0), "live"), (at_ms(24, 9, 59, 50, 0), "alive")]);

    write_flow::<TradeTicks>(
        &shared,
        TODAY,
        "collect-01",
        &[tick_flow_row(at_ms(24, 9, 0, 1, 0), "090001", "+71000", "+4", Some("284"), "KRX")],
    );
    write_flow::<TradeTicks>(
        &shared,
        TODAY,
        "spare-01",
        &[tick_flow_row(at_ms(24, 9, 0, 5, 0), "090005", "-70900", "-12", None, "NXT")],
    );
    write_flow::<ProgramFlow>(
        &shared,
        TODAY,
        "collect-01",
        &[program_flow_row(at_ms(24, 9, 0, 1, 0), "090001", "+71000", "+100")],
    );
    write_flow::<ProgramFlow>(
        &shared,
        TODAY,
        "spare-01",
        &[program_flow_row(at_ms(24, 9, 0, 5, 0), "090005", "+71100", "+250")],
    );
    write_flow::<ViEvents>(
        &shared,
        TODAY,
        "collect-01",
        &[vi_flow_row(at_ms(24, 9, 1, 0, 0), "005930", "1", "1", "77000", "090100", "000000", "1")],
    );
    write_flow::<ViEvents>(
        &shared,
        TODAY,
        "spare-01",
        &[vi_flow_row(at_ms(24, 9, 3, 0, 0), "005930_NX", "2", "2", "68000", "090300", "090500", "2")],
    );
    write_flow::<ExpectedTrades>(
        &shared,
        TODAY,
        "collect-01",
        &[expected_flow_row(at_ms(24, 8, 50, 0, 0), "085000", "+71200", "+200", "+0.28", "500", "1000", "2")],
    );
    write_flow::<ExpectedTrades>(
        &shared,
        TODAY,
        "spare-01",
        &[expected_flow_row(at_ms(24, 8, 55, 0, 0), "085500", "+71500", "+500", "+0.70", "1200", "50000", "2")],
    );

    assert_eq!(collected.ticks_days(paths.clone(), stock(), t0).await.unwrap(), vec![TODAY]);
    assert_eq!(collected.program_days(paths.clone(), stock(), t0).await.unwrap(), vec![TODAY]);
    assert_eq!(collected.vi_days(paths.clone(), stock(), t0).await.unwrap(), vec![TODAY]);
    assert_eq!(collected.expected_days(paths.clone(), stock(), t0).await.unwrap(), vec![TODAY]);

    let first_ticks = collected.ticks_day(paths.clone(), stock(), date_of(24), TODAY, None, t0).await.unwrap();
    assert_eq!((first_ticks.source, first_ticks.reset, first_ticks.live), (BrokerDaySource::Flow, true, true));
    assert_eq!(first_ticks.snapshots.iter().map(|t| t.signed_qty).collect::<Vec<_>>(), [4, -12]);

    let first_prog = collected.program_day(paths.clone(), stock(), date_of(24), TODAY, None, t0).await.unwrap();
    assert_eq!(first_prog.snapshots.iter().map(|r| r.net_buy_qty).collect::<Vec<_>>(), [100, 250]);

    let first_vi = collected.vi_day(paths.clone(), stock(), date_of(24), TODAY, None, t0).await.unwrap();
    assert_eq!(first_vi.snapshots.iter().map(|r| r.market).collect::<Vec<_>>(), [ViMarket::Krx, ViMarket::Nxt]);

    let first_exp = collected.expected_day(paths.clone(), stock(), date_of(24), TODAY, None, t0).await.unwrap();
    assert_eq!(first_exp.snapshots.iter().map(|r| r.price_won).collect::<Vec<_>>(), [71_200, 71_500]);

    write_flow::<TradeTicks>(
        &shared,
        TODAY,
        "spare-01",
        &[tick_flow_row(at_ms(24, 9, 10, 0, 0), "091000", "+71300", "+8", Some("570"), "KRX")],
    );
    let second_ticks = collected
        .ticks_day(paths.clone(), stock(), date_of(24), TODAY, Some(&first_ticks.cursor), t1)
        .await
        .unwrap();
    assert_eq!((second_ticks.source, second_ticks.reset), (BrokerDaySource::Flow, false));
    assert_eq!(second_ticks.snapshots.len(), 1);
    assert_eq!(second_ticks.snapshots[0].signed_qty, 8);

    write_complete(&data, TODAY, json!([]));
    write_parquet(
        &data,
        TODAY,
        "0B",
        "005930_AL",
        &[
            tick_sql("005930_AL", at_ms(24, 9, 0, 1, 0), "090001", 71000, 4, "284::BIGINT", "KRX"),
            tick_sql("005930_AL", at_ms(24, 9, 0, 5, 0), "090005", -70900, -12, "NULL::BIGINT", "NXT"),
            tick_sql("005930_AL", at_ms(24, 9, 10, 0, 0), "091000", 71300, 8, "570::BIGINT", "KRX"),
        ],
    );

    let rolled = collected
        .ticks_day(paths, stock(), date_of(24), TODAY, Some(&second_ticks.cursor), t2)
        .await
        .unwrap();
    assert_eq!((rolled.source, rolled.reset, rolled.live), (BrokerDaySource::Store, true, false));
    assert_eq!(rolled.snapshots.iter().map(|t| t.signed_qty).collect::<Vec<_>>(), [4, -12, 8]);
}

#[tokio::test]
async fn flow_and_parquet_decode_identically_for_all_four_kinds() {
    let flow_tmp = tempfile::tempdir().unwrap();
    let store_tmp = tempfile::tempdir().unwrap();
    let flow_paths = CollectorPaths::shared_only(flow_tmp.path().to_path_buf());
    let store_paths = CollectorPaths::hoga_only(store_tmp.path().to_path_buf());
    let collected = Collected::new(CollectedStore::new());
    let now = kst(date_of(24), 11, 0, 0);

    let t_prog = at_ms(24, 9, 5, 0, 250);
    let t_vi_krx = at_ms(24, 9, 6, 0, 100);
    let t_vi_nxt = at_ms(24, 9, 7, 0, 500);
    let t_exp = at_ms(24, 8, 55, 0, 0);
    let t_buy = at_ms(24, 9, 0, 1, 10);
    let t_sell = at_ms(24, 9, 0, 2, 20);

    write_flow::<ProgramFlow>(flow_tmp.path(), TODAY, "collect-01", &[program_flow_row(t_prog, "090500", "+71000", "+150")]);
    write_flow::<ViEvents>(
        flow_tmp.path(),
        TODAY,
        "collect-01",
        &[
            vi_flow_row(t_vi_krx, "005930", "1", "1", "+77000", "090600", "000000", "1"),
            vi_flow_row(t_vi_nxt, "005930_NX", "2", "2", "-68000", "090700", "090900", "2"),
        ],
    );
    write_flow::<ExpectedTrades>(
        flow_tmp.path(),
        TODAY,
        "collect-01",
        &[expected_flow_row(t_exp, "085500", "+71500", "+500", "+0.70", "+1200", "+50000", "+2")],
    );
    write_flow::<TradeTicks>(
        flow_tmp.path(),
        TODAY,
        "collect-01",
        &[
            tick_flow_row(t_buy, "090001", "+71000", "+4", Some("+284"), "KRX"),
            tick_flow_row(t_sell, "090002", "-70900", "-12", Some("-851"), "NXT"),
        ],
    );

    write_complete(store_tmp.path(), TODAY, json!([]));
    write_parquet(
        store_tmp.path(),
        TODAY,
        "0w",
        "005930_AL",
        &[program_sql("005930_AL", t_prog, "090500", "71000::BIGINT", 150)],
    );
    write_parquet(
        store_tmp.path(),
        TODAY,
        "1h",
        "005930",
        &[vi_sql("005930", t_vi_krx, "005930", "1", "1", "77000::BIGINT", "090600", "000000", "1")],
    );
    write_parquet(
        store_tmp.path(),
        TODAY,
        "1h",
        "005930_AL",
        &[vi_sql("005930_AL", t_vi_nxt, "005930_NX", "2", "2", "(-68000)::BIGINT", "090700", "090900", "2")],
    );
    write_parquet(
        store_tmp.path(),
        TODAY,
        "0H",
        "005930_AL",
        &[expected_sql("005930_AL", t_exp, "085500", 71500, 500, 0.7, 1200, 50000, 2)],
    );
    write_parquet(
        store_tmp.path(),
        TODAY,
        "0B",
        "005930_AL",
        &[
            tick_sql("005930_AL", t_buy, "090001", 71000, 4, "284::BIGINT", "KRX"),
            tick_sql("005930_AL", t_sell, "090002", -70900, -12, "(-851)::BIGINT", "NXT"),
        ],
    );

    let flow_prog = collected.program_day(flow_paths.clone(), stock(), date_of(24), TODAY, None, now).await.unwrap();
    let store_prog = collected.program_day(store_paths.clone(), stock(), date_of(24), TODAY, None, now).await.unwrap();
    assert_eq!(flow_prog.snapshots, store_prog.snapshots);

    let flow_vi = collected.vi_day(flow_paths.clone(), stock(), date_of(24), TODAY, None, now).await.unwrap();
    let store_vi = collected.vi_day(store_paths.clone(), stock(), date_of(24), TODAY, None, now).await.unwrap();
    assert_eq!(flow_vi.snapshots, store_vi.snapshots);

    let flow_exp = collected.expected_day(flow_paths.clone(), stock(), date_of(24), TODAY, None, now).await.unwrap();
    let store_exp = collected.expected_day(store_paths.clone(), stock(), date_of(24), TODAY, None, now).await.unwrap();
    assert_eq!(flow_exp.snapshots, store_exp.snapshots);

    let flow_ticks = collected.ticks_day(flow_paths, stock(), date_of(24), TODAY, None, now).await.unwrap();
    let store_ticks = collected.ticks_day(store_paths, stock(), date_of(24), TODAY, None, now).await.unwrap();
    assert_eq!(flow_ticks.snapshots, store_ticks.snapshots);
    assert_eq!(
        flow_ticks.snapshots,
        vec![
            CollectedTradeTick {
                recv_ms: t_buy,
                hhmmss: hms(9, 0, 1),
                price_won: 71_000,
                signed_qty: 4,
                instant_value_thousand_won: Some(284),
                exchange: Some(Exchange::Krx),
            },
            CollectedTradeTick {
                recv_ms: t_sell,
                hhmmss: hms(9, 0, 2),
                price_won: 70_900,
                signed_qty: -12,
                instant_value_thousand_won: Some(-851),
                exchange: Some(Exchange::Nxt),
            },
        ]
    );
}
