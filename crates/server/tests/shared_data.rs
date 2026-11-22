use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use domain::{KstDate, KstTime};
use server::clock::{Clock, kst};
use server::shared_data::{Broker, DataKind, FORMAT_VERSION, FeedWriter, Header, ProbeBody, ProbeItem, SharedData, SharedDataSettings, SourceKey, write_snapshot};

fn date() -> KstDate {
    KstDate::new(2026, 11, 23).unwrap()
}

fn header(as_of: KstTime) -> Header {
    Header::new(DataKind::Probe, date(), as_of.unix(), as_of.unix(), vec![SourceKey { key_name: "rest-1".into(), broker: Broker::Kiwoom }])
}

fn noon() -> KstTime {
    kst(date(), 12, 0, 0)
}

fn body(value: &str) -> ProbeBody {
    ProbeBody { value: value.into() }
}

fn snapshot_path(dir: &Path) -> std::path::PathBuf {
    dir.join("probe").join("20261123.json")
}

fn feed_path(dir: &Path) -> std::path::PathBuf {
    dir.join("probe").join("20261123.jsonl")
}

#[tokio::test]
async fn atomic_write_shows_on_next_poll_and_temporary_file_keeps_old_version() {
    let tmp = tempfile::tempdir().unwrap();
    let data = SharedData::new();
    write_snapshot(tmp.path(), header(noon()), body("first")).unwrap();
    data.poll_once(tmp.path()).await;
    assert_eq!(data.probe.current().unwrap().body, body("first"));

    std::fs::write(tmp.path().join("probe").join(".20261123.json.tmp-1"), b"{\"header\":").unwrap();
    data.poll_once(tmp.path()).await;
    assert_eq!(data.probe.current().unwrap().body, body("first"));
    assert_eq!(data.error_count(DataKind::Probe), 0);

    write_snapshot(tmp.path(), header(noon().plus_secs(30)), body("second")).unwrap();
    data.poll_once(tmp.path()).await;
    assert_eq!(data.probe.current().unwrap().body, body("second"));
}

#[tokio::test]
async fn unchanged_file_is_not_read_again() {
    let tmp = tempfile::tempdir().unwrap();
    let data = SharedData::new();
    write_snapshot(tmp.path(), header(noon()), body("first")).unwrap();
    data.poll_once(tmp.path()).await;
    let first = data.probe.current().unwrap();
    data.poll_once(tmp.path()).await;
    assert!(std::sync::Arc::ptr_eq(&first, &data.probe.current().unwrap()));
}

#[tokio::test]
async fn broken_file_and_unknown_version_keep_old_version_and_count_errors_once_per_file() {
    let tmp = tempfile::tempdir().unwrap();
    let data = SharedData::new();
    write_snapshot(tmp.path(), header(noon()), body("good")).unwrap();
    data.poll_once(tmp.path()).await;

    std::fs::write(snapshot_path(tmp.path()), b"{not json").unwrap();
    data.poll_once(tmp.path()).await;
    data.poll_once(tmp.path()).await;
    assert_eq!(data.error_count(DataKind::Probe), 1);
    assert_eq!(data.probe.current().unwrap().body, body("good"));

    let mut future = header(noon());
    future.format_version = FORMAT_VERSION + 1;
    std::fs::write(snapshot_path(tmp.path()), serde_json::to_vec(&serde_json::json!({"header": future, "body": {"shape": "new"}})).unwrap()).unwrap();
    data.poll_once(tmp.path()).await;
    assert_eq!(data.error_count(DataKind::Probe), 2);
    assert_eq!(data.probe.current().unwrap().body, body("good"));

    let unknown_kind = serde_json::json!({"header": {"formatVersion": FORMAT_VERSION, "kind": "mystery", "observationDate": "20261123", "asOf": 1, "writtenAt": 1, "sources": []}, "body": {}});
    std::fs::write(snapshot_path(tmp.path()), serde_json::to_vec(&unknown_kind).unwrap()).unwrap();
    data.poll_once(tmp.path()).await;
    assert_eq!(data.error_count(DataKind::Probe), 3);
    assert_eq!(data.probe.current().unwrap().body, body("good"));

    write_snapshot(tmp.path(), header(noon().plus_secs(60)), body("recovered")).unwrap();
    data.poll_once(tmp.path()).await;
    assert_eq!(data.probe.current().unwrap().body, body("recovered"));
}

#[tokio::test]
async fn appended_file_skips_partial_last_line_and_never_rereads() {
    let tmp = tempfile::tempdir().unwrap();
    let data = SharedData::new();
    let mut writer = FeedWriter::open(tmp.path(), header(noon())).unwrap();
    writer.append(&ProbeItem { seq: 1 }).unwrap();
    writer.append(&ProbeItem { seq: 2 }).unwrap();
    data.poll_once(tmp.path()).await;
    assert_eq!(data.probe_feed.read(|items| items.to_vec()), vec![ProbeItem { seq: 1 }, ProbeItem { seq: 2 }]);

    let mut raw = OpenOptions::new().append(true).open(feed_path(tmp.path())).unwrap();
    raw.write_all(b"{\"seq\":").unwrap();
    data.poll_once(tmp.path()).await;
    assert_eq!(data.probe_feed.len(), 2);
    assert_eq!(data.error_count(DataKind::Probe), 0);

    raw.write_all(b"3}\n").unwrap();
    data.poll_once(tmp.path()).await;
    data.poll_once(tmp.path()).await;
    assert_eq!(data.probe_feed.read(|items| items.iter().map(|i| i.seq).collect::<Vec<_>>()), vec![1, 2, 3]);
}

#[tokio::test]
async fn appended_file_restarts_from_the_beginning_when_the_date_folder_changes() {
    let tmp = tempfile::tempdir().unwrap();
    let data = SharedData::new();
    let mut writer = FeedWriter::open(tmp.path(), header(noon())).unwrap();
    writer.append(&ProbeItem { seq: 1 }).unwrap();
    data.poll_once(tmp.path()).await;
    assert_eq!(data.probe_feed.len(), 1);

    let next_day = Header::new(DataKind::Probe, date().add_days(1), noon().unix() + 86_400, noon().unix() + 86_400, vec![]);
    let mut next = FeedWriter::open(tmp.path(), next_day).unwrap();
    next.append(&ProbeItem { seq: 10 }).unwrap();
    next.append(&ProbeItem { seq: 11 }).unwrap();
    data.poll_once(tmp.path()).await;
    assert_eq!(data.probe_feed.read(|items| items.iter().map(|i| i.seq).collect::<Vec<_>>()), vec![10, 11]);
}

#[tokio::test]
async fn reopened_feed_writer_drops_a_torn_tail_and_keeps_the_header() {
    let tmp = tempfile::tempdir().unwrap();
    let mut writer = FeedWriter::open(tmp.path(), header(noon())).unwrap();
    writer.append(&ProbeItem { seq: 1 }).unwrap();
    OpenOptions::new().append(true).open(feed_path(tmp.path())).unwrap().write_all(b"{\"seq\":").unwrap();
    let mut later = header(noon());
    later.written_at += 5;
    let mut again = FeedWriter::open(tmp.path(), later).unwrap();
    again.append(&ProbeItem { seq: 2 }).unwrap();
    let data = SharedData::new();
    data.poll_once(tmp.path()).await;
    assert_eq!(data.probe_feed.read(|items| items.iter().map(|i| i.seq).collect::<Vec<_>>()), vec![1, 2]);
    assert_eq!(data.error_count(DataKind::Probe), 0);
}

#[tokio::test(start_paused = true)]
async fn no_polling_task_without_settings() {
    assert!(SharedData::new().start(None).is_none());
}

#[tokio::test(start_paused = true)]
async fn polling_task_picks_up_a_new_version_every_interval() {
    let tmp = tempfile::tempdir().unwrap();
    let data = SharedData::new();
    let task = data.start(Some(&SharedDataSettings { dir: tmp.path().to_owned(), poll: Duration::from_millis(1000) })).unwrap();
    write_snapshot(tmp.path(), header(noon()), body("v1")).unwrap();
    for _ in 0..200 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if data.probe.current().is_some() {
            break;
        }
    }
    assert_eq!(data.probe.current().unwrap().body, body("v1"));
    task.abort();
}

#[tokio::test(start_paused = true)]
async fn age_counts_from_as_of_with_the_fake_clock() {
    let tmp = tempfile::tempdir().unwrap();
    let clock = Clock::fake(noon());
    let data = SharedData::new();
    assert_eq!(data.age_secs(DataKind::Probe, clock.now()), None);
    write_snapshot(tmp.path(), header(noon().plus_secs(-20)), body("v")).unwrap();
    data.poll_once(tmp.path()).await;
    assert_eq!(data.age_secs(DataKind::Probe, clock.now()), Some(20));
    clock.jump(45);
    assert_eq!(data.age_secs(DataKind::Probe, clock.now()), Some(65));
}

fn seqs(data: &SharedData) -> Vec<u64> {
    data.probe_feed.read(|items| items.iter().map(|i| i.seq).collect())
}

#[tokio::test]
async fn appended_file_with_unknown_version_is_never_read_and_counts_one_error() {
    let tmp = tempfile::tempdir().unwrap();
    let data = SharedData::new();
    let mut future = header(noon());
    future.format_version = FORMAT_VERSION + 1;
    std::fs::create_dir_all(tmp.path().join("probe")).unwrap();
    std::fs::write(feed_path(tmp.path()), format!("{}\n{{\"seq\":", serde_json::to_string(&future).unwrap())).unwrap();
    data.poll_once(tmp.path()).await;
    OpenOptions::new().append(true).open(feed_path(tmp.path())).unwrap().write_all(b"7}\n{\"seq\":1}\n").unwrap();
    data.poll_once(tmp.path()).await;
    assert_eq!(seqs(&data), Vec::<u64>::new());
    assert_eq!(data.error_count(DataKind::Probe), 1);
}

#[tokio::test]
async fn new_day_file_with_bad_header_keeps_previous_items() {
    let tmp = tempfile::tempdir().unwrap();
    let data = SharedData::new();
    let mut writer = FeedWriter::open(tmp.path(), header(noon())).unwrap();
    writer.append(&ProbeItem { seq: 1 }).unwrap();
    data.poll_once(tmp.path()).await;
    std::fs::write(tmp.path().join("probe").join("20261124.jsonl"), b"garbage\n{\"seq\":9}\n").unwrap();
    data.poll_once(tmp.path()).await;
    data.poll_once(tmp.path()).await;
    assert_eq!(seqs(&data), vec![1]);
    assert_eq!(data.error_count(DataKind::Probe), 1);
}

#[tokio::test]
async fn recreated_file_at_the_same_path_is_read_from_the_start() {
    let tmp = tempfile::tempdir().unwrap();
    let data = SharedData::new();
    let mut writer = FeedWriter::open(tmp.path(), header(noon())).unwrap();
    for seq in 0..3 {
        writer.append(&ProbeItem { seq }).unwrap();
    }
    data.poll_once(tmp.path()).await;
    drop(writer);
    std::fs::remove_file(feed_path(tmp.path())).unwrap();
    let mut later = header(noon());
    later.written_at += 5;
    let mut again = FeedWriter::open(tmp.path(), later).unwrap();
    for seq in 100..110 {
        again.append(&ProbeItem { seq }).unwrap();
    }
    data.poll_once(tmp.path()).await;
    assert_eq!(seqs(&data), (100..110).collect::<Vec<_>>());
    assert_eq!(data.error_count(DataKind::Probe), 0);
}

#[tokio::test]
async fn bad_header_file_rewritten_in_place_with_a_good_header_is_read() {
    let tmp = tempfile::tempdir().unwrap();
    let data = SharedData::new();
    std::fs::create_dir_all(tmp.path().join("probe")).unwrap();
    std::fs::write(feed_path(tmp.path()), b"garbage that is longer than the good header line ................................................................................................................................\n{\"seq\":1}\n").unwrap();
    data.poll_once(tmp.path()).await;
    assert_eq!(data.error_count(DataKind::Probe), 1);
    std::fs::write(feed_path(tmp.path()), format!("{}\n{{\"seq\":7}}\n", serde_json::to_string(&header(noon())).unwrap())).unwrap();
    data.poll_once(tmp.path()).await;
    assert_eq!(seqs(&data), vec![7]);
}
