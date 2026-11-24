use std::fs::{self, OpenOptions};
use std::io::Write;
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

fn raw_rows_block(row_count: u32, first_ms: i64, last_ms: i64, payload: &[u8]) -> Vec<u8> {
    let mut header = [0u8; 32];
    header[0..4].copy_from_slice(b"SFLW");
    header[4] = 2;
    header[5] = 0;
    header[8..12].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    header[12..16].copy_from_slice(&row_count.to_le_bytes());
    header[16..24].copy_from_slice(&first_ms.to_le_bytes());
    header[24..32].copy_from_slice(&last_ms.to_le_bytes());
    let mut out = Vec::with_capacity(header.len() + payload.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(payload);
    out
}

#[test]
fn a_failed_read_keeps_the_cursor_and_description_where_they_were() {
    let dir = tempfile::tempdir().unwrap();
    let path = path_in(dir.path());
    let mut writer = FlowWriter::open(&path, describe(&[141])).unwrap();
    writer.append(&[row(500, &["초기"])]).unwrap();

    let mut cursor = FlowCursor::new(path.clone());
    let initial = cursor.read_new().unwrap();
    assert_eq!(initial.len(), 1);
    assert_eq!(initial[0].description.fids, [141]);

    writer.append(&[row(1_000, &["가"])]).unwrap();
    drop(writer);
    drop(FlowWriter::open(&path, describe(&[141, 146])).unwrap());
    let before_corrupt = path.metadata().unwrap().len();

    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(&raw_rows_block(1, 2_000, 2_000, b"not json")).unwrap();
    drop(file);

    assert!(cursor.read_new().is_err());

    let file = OpenOptions::new().write(true).open(&path).unwrap();
    file.set_len(before_corrupt).unwrap();
    drop(file);

    let blocks = cursor.read_new().unwrap();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].description.fids, [141]);
    assert_eq!(blocks[0].rows, [row(1_000, &["가"])]);
}

#[test]
fn a_row_whose_width_does_not_match_the_fids_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = path_in(dir.path());
    let mut writer = FlowWriter::open(&path, describe(&[141, 146])).unwrap();
    let before = fs::read(&path).unwrap();
    assert!(writer.append(&[row(1_000, &["가"])]).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    drop(writer);

    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(&raw_rows_block(1, 1_000, 1_000, r#"[[1000,"가"]]"#.as_bytes())).unwrap();
    drop(file);

    let mut cursor = FlowCursor::new(path);
    assert!(cursor.read_new().is_err());
}

#[test]
fn a_replaced_file_is_read_again_from_the_start() {
    let dir = tempfile::tempdir().unwrap();
    let path = path_in(dir.path());
    FlowWriter::open(&path, describe(&[141])).unwrap().append(&[row(1_000, &["가"])]).unwrap();

    let mut cursor = FlowCursor::new(path.clone());
    let first = cursor.read_new().unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].rows, [row(1_000, &["가"])]);

    fs::remove_file(&path).unwrap();
    FlowWriter::open(&path, describe(&[141, 146]))
        .unwrap()
        .append(&[row(2_000, &["나", "001"]), row(3_000, &["다", "002"])])
        .unwrap();

    let second = cursor.read_new().unwrap();
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].description.fids, [141, 146]);
    assert_eq!(second[0].rows, [row(2_000, &["나", "001"]), row(3_000, &["다", "002"])]);
}
