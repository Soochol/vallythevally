use std::fs;
use std::sync::Arc;
use std::time::Instant;

use collector::collect::session::WallClock;
use collector::finalize::COMPLETE_FILE_NAME;
use collector::protocol::KeyName;
use collector::shared::flow::{FileFlowStore, remove_finished_days};
use collector::shared::micro::{MICRO_FIDS, MICRO_TYPE_CODE};
use collector::shared::{LiveTapConfig, spawn_live_tap};
use server::shared_data::{FlowCursor, flow_path};
use tempfile::tempdir;
use tokio_tungstenite::tungstenite::Utf8Bytes;

struct FixedWall(i64);

impl WallClock for FixedWall {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

fn key(name: &str) -> KeyName {
    KeyName::parse(name).unwrap()
}

fn book_frame(symbol: &str, ask0: u64, bid0: u64) -> Utf8Bytes {
    Utf8Bytes::from(format!(
        r#"{{"trnm":"REAL","data":[{{"type":"0D","item":"{symbol}_AL","values":{{"21":"090500","41":"+70100","42":"+70200","43":"+70300","44":"+70400","45":"+70500","51":"+70000","52":"+69900","53":"+69800","54":"+69700","55":"+69600","61":"{ask0}","62":"1000","63":"1000","64":"1000","65":"1000","71":"{bid0}","72":"1000","73":"1000","74":"1000","75":"1000"}}}}]}}"#
    ))
}

fn single_price_frame(symbol: &str, qty: u64) -> Utf8Bytes {
    Utf8Bytes::from(format!(
        r#"{{"trnm":"REAL","data":[{{"type":"0D","item":"{symbol}_AL","values":{{"21":"090500","41":"+70100","42":"+70200","43":"+70300","51":"+70000","52":"+69900","53":"+69800","61":"{qty}","62":"100","63":"100","71":"{qty}","72":"100","73":"100"}}}}]}}"#
    ))
}

fn trade_frame(symbol: &str, price: u64, signed_qty: i64) -> Utf8Bytes {
    let sign = if signed_qty >= 0 { "+" } else { "" };
    Utf8Bytes::from(format!(
        r#"{{"trnm":"REAL","data":[{{"type":"0B","item":"{symbol}_AL","values":{{"20":"090501","10":"+{price}","15":"{sign}{signed_qty}","9081":"KRX"}}}}]}}"#
    ))
}

#[tokio::test]
async fn micro_live_tap_persists_spoof_and_iceberg_events_to_me_flow() {
    let dir = tempdir().unwrap();
    let base_ms = 1_795_359_600_000 + 9 * 3_600_000;
    let config = LiveTapConfig {
        micro: Some(FileFlowStore::new(dir.path().to_path_buf(), key("k1"))),
        ..LiveTapConfig::none()
    };
    let (feed, worker) = spawn_live_tap(config, key("k1"), Arc::new(FixedWall(base_ms))).unwrap();
    let stats = worker.micro_stats().unwrap();

    feed.offer_frame(base_ms + 1_000, &book_frame("005930", 5_000, 2_000));
    feed.offer_frame(base_ms + 1_500, &book_frame("005930", 200, 2_000));

    feed.offer_frame(base_ms + 2_000, &book_frame("005930", 1_000, 2_000));
    feed.offer_frame(base_ms + 2_200, &trade_frame("005930", 70_100, 1_800));
    feed.offer_frame(base_ms + 2_500, &book_frame("005930", 800, 2_000));

    feed.offer_frame(base_ms + 3_000, &book_frame("000660", 4_000, 2_000));
    feed.offer_frame(base_ms + 3_200, &trade_frame("000660", 70_100, 3_800));
    feed.offer_frame(base_ms + 3_500, &book_frame("000660", 200, 2_000));

    feed.offer_frame(base_ms + 4_000, &book_frame("035420", 5_000, 5_000));
    feed.offer_frame(base_ms + 4_500, &single_price_frame("035420", 100));
    feed.offer_frame(base_ms + 5_000, &book_frame("035420", 100, 100));

    drop(feed);
    worker.finish().await;

    assert_eq!(stats.dropped(), 0);
    assert_eq!(stats.events(), 2);

    let date = collector::kst::KstTime::from_unix_ms(base_ms).date.to_string();
    let path = flow_path(dir.path(), &date, MICRO_TYPE_CODE, "005930", "k1");
    let mut cursor = FlowCursor::new(path);
    let blocks = cursor.read_new().unwrap();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].description.fids, MICRO_FIDS);
    let rows = &blocks[0].rows;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].values[0].as_deref(), Some("S"));
    assert_eq!(rows[0].values[1].as_deref(), Some("A"));
    assert_eq!(rows[0].values[2].as_deref(), Some("70100"));
    assert_eq!(rows[0].values[3].as_deref(), Some("4800"));
    assert_eq!(rows[0].values[4].as_deref(), Some("5000"));
    assert_eq!(rows[0].values[5].as_deref(), Some("10000"));

    assert_eq!(rows[1].values[0].as_deref(), Some("I"));
    assert_eq!(rows[1].values[1].as_deref(), Some("A"));
    assert_eq!(rows[1].values[2].as_deref(), Some("70100"));
    assert_eq!(rows[1].values[3].as_deref(), Some("1800"));
    assert_eq!(rows[1].values[4].as_deref(), Some("1000"));
    assert_eq!(rows[1].values[5].as_deref(), Some("18000"));

    let no_spoof_path = flow_path(dir.path(), &date, MICRO_TYPE_CODE, "000660", "k1");
    assert!(!no_spoof_path.exists());
    let single_price_path = flow_path(dir.path(), &date, MICRO_TYPE_CODE, "035420", "k1");
    assert!(!single_price_path.exists());
}

#[tokio::test]
async fn micro_remove_finished_days_cleans_up_me_flow_directory() {
    let dir = tempdir().unwrap();
    let shared = dir.path().join("shared");
    let data = dir.path().join("data");
    let old_ms = 1_795_273_200_000 + 9 * 3_600_000;
    let old_date = collector::kst::KstTime::from_unix_ms(old_ms).date;
    let newer_date = old_date + 1;

    let config = LiveTapConfig {
        micro: Some(FileFlowStore::new(shared.clone(), key("k1"))),
        ..LiveTapConfig::none()
    };
    let (feed, worker) = spawn_live_tap(config, key("k1"), Arc::new(FixedWall(old_ms))).unwrap();
    feed.offer_frame(old_ms + 1_000, &book_frame("005930", 5_000, 2_000));
    feed.offer_frame(old_ms + 1_500, &book_frame("005930", 100, 2_000));
    drop(feed);
    worker.finish().await;

    let me_path = flow_path(&shared, &old_date.to_string(), MICRO_TYPE_CODE, "005930", "k1");
    assert!(me_path.exists());

    for date in [old_date, newer_date] {
        let store_day = data.join("store").join(date.to_string());
        fs::create_dir_all(&store_day).unwrap();
        fs::write(store_day.join(COMPLETE_FILE_NAME), "{}").unwrap();
    }

    let removed = remove_finished_days(&shared, &data).unwrap();
    assert_eq!(removed, vec![old_date]);
    assert!(!me_path.exists());
}

#[ignore]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn micro_perf_probe_50k_interleaved_frames_through_live_tap() {
    const TOTAL_FRAMES: usize = 50_000;
    const SYMBOLS: usize = 20;
    const TRIALS: usize = 3;

    let base_ms = 1_795_359_600_000 + 9 * 3_600_000;
    let mut frames = Vec::with_capacity(TOTAL_FRAMES);
    for idx in 0..TOTAL_FRAMES {
        let symbol = format!("{:06}", 5900 + (idx % SYMBOLS));
        if idx % 2 == 0 {
            let ask0 = if (idx / (2 * SYMBOLS)) % 10 == 5 { 200 } else { 3_000 };
            let bid0 = 2_000 + ((idx % 7) as u64) * 50;
            frames.push((base_ms + idx as i64 * 10, book_frame(&symbol, ask0, bid0)));
        } else {
            let qty = if idx % 3 == 0 { 150 } else { -120 };
            frames.push((base_ms + idx as i64 * 10, trade_frame(&symbol, 70_100, qty)));
        }
    }

    async fn run_once(frames: &[(i64, Utf8Bytes)], base_ms: i64, with_micro: bool) -> (f64, u64, u64) {
        const CHUNK_SIZE: usize = 10_000;
        let dir = tempdir().unwrap();
        let mut total_elapsed_ms = 0.0;
        let mut total_dropped = 0u64;
        let mut total_events = 0u64;
        for chunk in frames.chunks(CHUNK_SIZE) {
            let mut config = LiveTapConfig::for_shared_dir(dir.path().to_path_buf(), &key("perf"));
            if !with_micro {
                config.micro = None;
            }
            let (feed, worker) = spawn_live_tap(config, key("perf"), Arc::new(FixedWall(base_ms))).unwrap();
            let micro_stats = worker.micro_stats();
            let started = Instant::now();
            for (recv_ms, frame) in chunk {
                feed.offer_frame(*recv_ms, frame);
            }
            drop(feed);
            worker.finish().await;
            total_elapsed_ms += started.elapsed().as_secs_f64() * 1000.0;
            if let Some(stats) = micro_stats {
                total_dropped += stats.dropped();
                total_events += stats.events();
            }
        }
        (total_elapsed_ms, total_dropped, total_events)
    }

    let _ = run_once(&frames, base_ms, false).await;
    let _ = run_once(&frames, base_ms, true).await;

    let mut base_times = Vec::with_capacity(TRIALS);
    let mut micro_times = Vec::with_capacity(TRIALS);
    let mut total_dropped = 0u64;
    let mut last_events = 0u64;
    for _ in 0..TRIALS {
        let (b, _, _) = run_once(&frames, base_ms, false).await;
        let (m, dropped, events) = run_once(&frames, base_ms, true).await;
        base_times.push(b);
        micro_times.push(m);
        total_dropped += dropped;
        last_events = events;
    }
    base_times.sort_by(|a, b| a.total_cmp(b));
    micro_times.sort_by(|a, b| a.total_cmp(b));
    let base_median = base_times[TRIALS / 2];
    let micro_median = micro_times[TRIALS / 2];
    let base_fps = (TOTAL_FRAMES as f64) / (base_median / 1000.0);
    let micro_fps = (TOTAL_FRAMES as f64) / (micro_median / 1000.0);
    let overhead_pct = ((micro_median - base_median) / base_median) * 100.0;
    println!(
        "perf_probe: frames={TOTAL_FRAMES} trials={TRIALS} base_ms={base_times:?} micro_ms={micro_times:?} base_median_ms={base_median:.1} micro_median_ms={micro_median:.1} base_fps={base_fps:.0} micro_fps={micro_fps:.0} overhead_pct={overhead_pct:.2}% dropped={total_dropped} micro_events={last_events}"
    );
    assert_eq!(total_dropped, 0, "micro worker dropped frames");
    assert!(last_events > 0, "expected micro events to be detected");
    assert!(overhead_pct <= 10.0, "throughput regression exceeded 10%: {overhead_pct:.2}%");
}
