use std::fs::OpenOptions;
use std::path::Path;

use server::shared_data::{FlowCursor, FlowDescription, FlowRow, FlowWriter, flow_path};

const DATE: &str = "20261124";

fn describe(fids: &[u32]) -> FlowDescription {
    FlowDescription::new("0F", "005930", DATE, "collect-01", fids)
}

fn row(recv_ms: i64, values: &[&str]) -> FlowRow {
    FlowRow { recv_ms, values: values.iter().map(|value| Some((*value).to_owned())).collect() }
}

fn path_in(dir: &Path) -> std::path::PathBuf {
    flow_path(dir, DATE, "0F", "005930", "collect-01")
}

#[test]
fn a_reader_gets_only_blocks_appended_since_its_last_read() {
    let dir = tempfile::tempdir().unwrap();
    let path = path_in(dir.path());
    assert_eq!(path, dir.path().join("symbol-flow/20261124/0F/005930/collect-01.flow"));
    let mut cursor = FlowCursor::new(path.clone());
    assert!(cursor.read_new().unwrap().is_empty());

    let mut writer = FlowWriter::open(&path, describe(&[141, 161])).unwrap();
    writer.append(&[row(1_000, &["키움", "10"])]).unwrap();
    let first = cursor.read_new().unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(*first[0].description, describe(&[141, 161]));
    assert_eq!(first[0].rows, [row(1_000, &["키움", "10"])]);

    let later = [row(2_000, &["키움", "20"]), FlowRow { recv_ms: 2_500, values: vec![Some("삼  성".into()), None] }];
    writer.append(&later).unwrap();
    let second = cursor.read_new().unwrap();
    assert_eq!(second.len(), 1);
    assert_eq!((second[0].first_ms, second[0].last_ms), (2_000, 2_500));
    assert_eq!(second[0].rows, later);
    assert!(cursor.read_new().unwrap().is_empty());
}

#[test]
fn a_torn_tail_is_not_read_and_is_cut_when_the_writer_reopens() {
    let dir = tempfile::tempdir().unwrap();
    let path = path_in(dir.path());
    let mut writer = FlowWriter::open(&path, describe(&[141])).unwrap();
    writer.append(&[row(1_000, &["가"])]).unwrap();
    writer.append(&[row(2_000, &["나"])]).unwrap();
    drop(writer);
    let file = OpenOptions::new().write(true).open(&path).unwrap();
    file.set_len(file.metadata().unwrap().len() - 7).unwrap();

    let mut cursor = FlowCursor::new(path.clone());
    let seen = cursor.read_new().unwrap();
    assert_eq!(seen.iter().flat_map(|block| &block.rows).map(|row| row.recv_ms).collect::<Vec<_>>(), [1_000]);

    let mut writer = FlowWriter::open(&path, describe(&[141])).unwrap();
    writer.append(&[row(3_000, &["다"])]).unwrap();
    let seen = cursor.read_new().unwrap();
    assert_eq!(seen.iter().flat_map(|block| &block.rows).map(|row| row.recv_ms).collect::<Vec<_>>(), [3_000]);
    let fresh = FlowCursor::new(path).read_new().unwrap();
    assert_eq!(fresh.iter().flat_map(|block| &block.rows).map(|row| row.recv_ms).collect::<Vec<_>>(), [1_000, 3_000]);
}

#[test]
fn a_changed_fid_list_writes_a_new_description() {
    let dir = tempfile::tempdir().unwrap();
    let path = path_in(dir.path());
    FlowWriter::open(&path, describe(&[141, 146])).unwrap().append(&[row(1_000, &["가", "001"])]).unwrap();
    FlowWriter::open(&path, describe(&[141, 146, 161])).unwrap().append(&[row(2_000, &["가", "001", "5"])]).unwrap();
    let blocks = FlowCursor::new(path).read_new().unwrap();
    let seen: Vec<(Vec<u32>, usize)> = blocks.iter().map(|block| (block.description.fids.clone(), block.rows[0].values.len())).collect();
    assert_eq!(seen, [(vec![141, 146], 2), (vec![141, 146, 161], 3)]);
}

#[test]
fn a_large_block_is_compressed() {
    let dir = tempfile::tempdir().unwrap();
    let path = path_in(dir.path());
    let rows: Vec<FlowRow> = (0..500).map(|i| row(i, &["한국투자증권", "미래에셋증권", "1234567", "7654321"])).collect();
    FlowWriter::open(&path, describe(&[141, 142, 161, 162])).unwrap().append(&rows).unwrap();
    let letters: usize = rows.iter().flat_map(|row| &row.values).flatten().map(String::len).sum();
    assert!((path.metadata().unwrap().len() as usize) < letters / 2);
    assert_eq!(FlowCursor::new(path).read_new().unwrap()[0].rows, rows);
}

#[test]
fn a_file_of_an_unknown_version_is_refused_and_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let path = path_in(dir.path());
    let newer = FlowDescription { format_version: 2, ..describe(&[141]) };
    FlowWriter::open(&path, newer).unwrap().append(&[row(1_000, &["가"])]).unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(FlowWriter::open(&path, describe(&[141])).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
}
