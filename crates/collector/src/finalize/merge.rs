use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;

use parquet::arrow::ArrowWriter;
use parquet::basic::{Compression, Encoding, ZstdLevel};
use parquet::file::metadata::KeyValue;
use parquet::file::properties::WriterProperties;
use parquet::schema::types::ColumnPath;

use super::chunk::Chunk;
use super::scan::{SpillLayout, read_blobs};
use super::schema::{self, FORMAT_VERSION};

pub const ROW_GROUP_ROWS: usize = 122_880;
const PARQUET_ZSTD_LEVEL: i32 = 3;

pub const METADATA_FORMAT_VERSION: &str = "vally.format_version";
pub const METADATA_TYPE: &str = "vally.type";
pub const METADATA_BUCKET: &str = "vally.bucket";
pub const METADATA_BUCKETS: &str = "vally.buckets";

#[derive(Debug, Clone)]
pub struct WrittenFile {
    pub type_index: usize,
    pub bucket: usize,
    pub path: PathBuf,
    pub rows: u64,
    pub bytes: u64,
}

pub fn bucket_file(store_dir: &Path, type_code: &str, bucket: usize) -> PathBuf {
    store_dir.join(type_code).join(format!("{bucket:03}.parquet"))
}

pub fn merge(
    store_dir: &Path,
    spill: &SpillLayout,
    workers: usize,
    tasks: &[(usize, usize)],
    buckets: usize,
    threads: usize,
) -> io::Result<Vec<WrittenFile>> {
    let next = AtomicUsize::new(0);
    let failure: Mutex<Option<io::Error>> = Mutex::new(None);
    let written: Mutex<Vec<WrittenFile>> = Mutex::new(Vec::new());
    thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                loop {
                    if failure.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).is_some() {
                        return;
                    }
                    let Some(&(type_index, bucket)) = tasks.get(next.fetch_add(1, Ordering::Relaxed)) else { return };
                    match write_bucket(store_dir, spill, workers, type_index, bucket, buckets) {
                        Ok(file) => written.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(file),
                        Err(error) => {
                            failure.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get_or_insert(error);
                            return;
                        }
                    }
                }
            });
        }
    });
    if let Some(error) = failure.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner()) {
        return Err(error);
    }
    let mut files = written.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner());
    files.sort_by_key(|file| (file.type_index, file.bucket));
    Ok(files)
}

fn write_bucket(
    store_dir: &Path,
    spill: &SpillLayout,
    workers: usize,
    type_index: usize,
    bucket: usize,
    buckets: usize,
) -> io::Result<WrittenFile> {
    let realtime = &schema::types()[type_index];
    let mut chunk = Chunk::new(&realtime.buffer_kinds());
    for worker in 0..workers {
        for blob in read_blobs(&spill.file(worker, type_index, bucket))? {
            chunk.append_encoded(&blob)?;
        }
    }
    let order = chunk.sorted_order()?;
    let path = bucket_file(store_dir, &realtime.code, bucket);
    fs::create_dir_all(path.parent().expect("버킷 파일은 폴더 안에 있다"))?;
    let arrow_schema = realtime.arrow_schema();
    let mut properties = WriterProperties::builder()
        .set_compression(Compression::ZSTD(ZstdLevel::try_new(PARQUET_ZSTD_LEVEL).expect("zstd 수준이 맞다")))
        .set_max_row_group_row_count(Some(ROW_GROUP_ROWS))
        .set_key_value_metadata(Some(vec![
            KeyValue::new(METADATA_FORMAT_VERSION.to_string(), FORMAT_VERSION.to_string()),
            KeyValue::new(METADATA_TYPE.to_string(), realtime.code.clone()),
            KeyValue::new(METADATA_BUCKET.to_string(), bucket.to_string()),
            KeyValue::new(METADATA_BUCKETS.to_string(), buckets.to_string()),
        ]));
    for name in realtime.delta_encoded_columns() {
        let column = ColumnPath::from(name);
        properties = properties
            .set_column_dictionary_enabled(column.clone(), false)
            .set_column_encoding(column, Encoding::DELTA_BINARY_PACKED);
    }
    let file = File::create(&path)?;
    let mut writer = ArrowWriter::try_new(file, arrow_schema.clone(), Some(properties.build())).map_err(into_io)?;
    for rows in order.chunks(ROW_GROUP_ROWS) {
        writer.write(&chunk.record_batch(&arrow_schema, rows)).map_err(into_io)?;
        writer.flush().map_err(into_io)?;
    }
    writer.close().map_err(into_io)?;
    let bytes = fs::metadata(&path)?.len();
    Ok(WrittenFile { type_index, bucket, path, rows: order.len() as u64, bytes })
}

pub fn into_io(error: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> io::Error {
    io::Error::other(error)
}
