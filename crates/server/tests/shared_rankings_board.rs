use std::path::Path;
use std::sync::Arc;

use domain::{KstDate, KstTime};
use server::api::{Excludes, Ranking, RankingMarket, Venue};
use server::shared_data::{
    Broker, ConditionEntry, ConditionState, DataKind, Header, RankingsBoard, RankingsPartBody, ReceivedRanking, SourceKey, part_path, write_snapshot_at,
};
use server::market_source::rankings::condition_key;

const PERIOD_SECS: u64 = 10;

fn ranking() -> Ranking {
    Ranking::TradeAmount { market: RankingMarket::All, venue: Venue::Combined, excludes: Excludes { etf_etn: false, preferred: false }, exclude_managed: false }
}

fn received(at: i64, broker: Broker) -> ReceivedRanking {
    ReceivedRanking { rows: Vec::new(), pages: 5, end: false, limited: false, received_at: at, broker }
}

fn write(dir: &Path, date: &str, key: &str, broker: Broker, as_of: i64, conditions: Vec<ConditionEntry>) {
    let header = Header::new(DataKind::Rankings, KstDate::parse_yyyymmdd(date).unwrap(), as_of, as_of, vec![SourceKey { key_name: key.to_owned(), broker }]);
    write_snapshot_at(part_path(dir, date, key), header, RankingsPartBody { period_secs: PERIOD_SECS, pages: 5, conditions }).unwrap();
}

fn ready(at: i64, broker: Broker) -> Vec<ConditionEntry> {
    vec![ConditionEntry { key: condition_key(&ranking()), state: ConditionState::Ready, last: Some(received(at, broker)) }]
}

#[test]
fn the_newest_received_value_wins_when_two_parts_hold_the_same_condition() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "20261118", "rest-a", Broker::Kiwoom, 1_000, ready(1_000, Broker::Kiwoom));
    write(dir.path(), "20261118", "rest-b", Broker::Kis, 1_010, ready(1_010, Broker::Kis));
    let board = RankingsBoard::new();
    board.poll(dir.path());
    let found = board.current().unwrap().find(&ranking(), 5).cloned().unwrap();
    assert_eq!((found.part_key.as_str(), found.last.unwrap().broker), ("rest-b", Broker::Kis));
}

#[test]
fn a_part_older_than_two_periods_marks_its_conditions_stale() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "20261118", "rest-a", Broker::Kiwoom, 1_000, ready(1_000, Broker::Kiwoom));
    let board = RankingsBoard::new();
    board.poll(dir.path());
    let merged = board.current().unwrap();
    let found = merged.find(&ranking(), 5).unwrap();
    assert!(!found.is_stale(KstTime::from_unix(1_020)));
    assert!(found.is_stale(KstTime::from_unix(1_021)));
}

#[test]
fn nothing_is_merged_again_until_a_part_file_changes() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "20261118", "rest-a", Broker::Kiwoom, 1_000, ready(1_000, Broker::Kiwoom));
    let board = RankingsBoard::new();
    board.poll(dir.path());
    let first = board.current().unwrap();
    board.poll(dir.path());
    assert!(Arc::ptr_eq(&first, &board.current().unwrap()), "바뀐 파일이 없으면 판을 다시 만들지 않는다");
    write(dir.path(), "20261118", "rest-a", Broker::Kiwoom, 1_010, ready(1_010, Broker::Kiwoom));
    board.poll(dir.path());
    assert!(!Arc::ptr_eq(&first, &board.current().unwrap()));
}

#[test]
fn a_broken_part_keeps_the_previous_one_and_counts_one_error() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "20261118", "rest-a", Broker::Kiwoom, 1_000, ready(1_000, Broker::Kiwoom));
    let board = RankingsBoard::new();
    board.poll(dir.path());
    std::fs::write(part_path(dir.path(), "20261118", "rest-a"), b"{not json").unwrap();
    board.poll(dir.path());
    board.poll(dir.path());
    assert_eq!(board.errors(), 1);
    assert_eq!(board.current().unwrap().find(&ranking(), 5).unwrap().last.as_ref().unwrap().received_at, 1_000);
}

#[test]
fn the_newest_observation_date_wins_and_a_removed_part_leaves_the_board() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "20261117", "rest-a", Broker::Kiwoom, 500, ready(500, Broker::Kiwoom));
    let board = RankingsBoard::new();
    board.poll(dir.path());
    assert_eq!(board.current().unwrap().observation_date, "20261117");
    write(dir.path(), "20261118", "rest-a", Broker::Kiwoom, 1_000, ready(1_000, Broker::Kiwoom));
    write(dir.path(), "20261118", "rest-b", Broker::Kis, 1_005, ready(1_005, Broker::Kis));
    board.poll(dir.path());
    assert_eq!((board.current().unwrap().observation_date.clone(), board.current().unwrap().parts.len()), ("20261118".to_owned(), 2));
    std::fs::remove_file(part_path(dir.path(), "20261118", "rest-b")).unwrap();
    board.poll(dir.path());
    assert_eq!(board.current().unwrap().parts.len(), 1);
}

#[test]
fn the_new_owners_failure_shows_over_a_dead_keys_older_ready_part_and_keeps_its_value() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "20261118", "rest-a", Broker::Kiwoom, 1_000, ready(1_000, Broker::Kiwoom));
    let failed = vec![ConditionEntry { key: condition_key(&ranking()), state: ConditionState::Failed { at: 1_060, message: "받지 못했습니다".to_owned() }, last: None }];
    write(dir.path(), "20261118", "rest-b", Broker::Kiwoom, 1_060, failed);
    let board = RankingsBoard::new();
    board.poll(dir.path());
    let merged = board.current().unwrap();
    let found = merged.find(&ranking(), 5).unwrap();
    assert_eq!((found.part_key.as_str(), matches!(found.state, ConditionState::Failed { .. })), ("rest-b", true));
    assert_eq!(found.last.as_ref().map(|last| last.received_at), Some(1_000), "실패한 조건은 이전 값을 둔다");
    assert!(!found.is_stale(KstTime::from_unix(1_070)));
}

#[test]
fn a_value_that_walked_fewer_pages_than_asked_is_not_offered_unless_its_list_ended() {
    let dir = tempfile::tempdir().unwrap();
    let short = |end: bool| vec![ConditionEntry { key: condition_key(&ranking()), state: ConditionState::Ready, last: Some(ReceivedRanking { pages: 1, end, ..received(1_000, Broker::Kiwoom) }) }];
    let failed_five_pages = vec![ConditionEntry { key: condition_key(&ranking()), state: ConditionState::Failed { at: 1_060, message: "받지 못했습니다".to_owned() }, last: None }];
    write(dir.path(), "20261118", "rest-a", Broker::Kiwoom, 1_000, short(false));
    write(dir.path(), "20261118", "rest-b", Broker::Kiwoom, 1_060, failed_five_pages.clone());
    let board = RankingsBoard::new();
    board.poll(dir.path());
    let found = board.current().unwrap().find(&ranking(), 5).cloned().unwrap();
    assert_eq!((matches!(found.state, ConditionState::Failed { .. }), found.last.is_none()), (true, true), "1쪽만 받은 값은 5쪽 조건의 이전 값이 아니다");

    write(dir.path(), "20261118", "rest-a", Broker::Kiwoom, 1_001, short(true));
    board.poll(dir.path());
    assert!(board.current().unwrap().find(&ranking(), 5).unwrap().last.is_some(), "목록이 끝나 1쪽이 전부면 5쪽 조건도 덮는다");
}
