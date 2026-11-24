use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::de::{self, SeqAccess, Visitor};
use serde::ser::SerializeSeq;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::format::file_identity;

pub const SYMBOL_FLOW_FOLDER: &str = "symbol-flow";
pub const FLOW_FORMAT_VERSION: u32 = 1;

const FLOW_EXTENSION: &str = "flow";
const LINKS_FOLDER: &str = "links";
const LINKS_EXTENSION: &str = "jsonl";
const MAGIC: [u8; 4] = *b"SFLW";
const HEADER_LEN: usize = 32;
const KIND_DESCRIPTION: u8 = 1;
const KIND_ROWS: u8 = 2;
const CODEC_RAW: u8 = 0;
const CODEC_ZSTD: u8 = 1;
const ZSTD_LEVEL: i32 = 3;
const MAX_PAYLOAD_LEN: usize = 32 * 1024 * 1024;
const HEAD_FINGERPRINT_LEN: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowDescription {
    pub format_version: u32,
    pub type_code: String,
    pub symbol: String,
    pub date: String,
    pub key: String,
    pub fids: Vec<u32>,
}

impl FlowDescription {
    pub fn new(type_code: &str, symbol: &str, date: &str, key: &str, fids: &[u32]) -> FlowDescription {
        FlowDescription {
            format_version: FLOW_FORMAT_VERSION,
            type_code: type_code.to_owned(),
            symbol: symbol.to_owned(),
            date: date.to_owned(),
            key: key.to_owned(),
            fids: fids.to_vec(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowRow {
    pub recv_ms: i64,
    pub values: Vec<Option<String>>,
}

struct WireRow<'a>(&'a FlowRow);

impl Serialize for WireRow<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(1 + self.0.values.len()))?;
        seq.serialize_element(&self.0.recv_ms)?;
        for value in &self.0.values {
            seq.serialize_element(value)?;
        }
        seq.end()
    }
}

struct OwnedWireRow(FlowRow);

impl<'de> Deserialize<'de> for OwnedWireRow {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct RowVisitor;

        impl<'de> Visitor<'de> for RowVisitor {
            type Value = OwnedWireRow;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a flow row array [recv_ms, ...]")
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let recv_ms = seq.next_element::<i64>()?.ok_or_else(|| de::Error::invalid_length(0, &self))?;
                let mut values = Vec::new();
                while let Some(value) = seq.next_element::<Option<String>>()? {
                    values.push(value);
                }
                Ok(OwnedWireRow(FlowRow { recv_ms, values }))
            }
        }

        deserializer.deserialize_seq(RowVisitor)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowBlock {
    pub description: Arc<FlowDescription>,
    pub first_ms: i64,
    pub last_ms: i64,
    pub rows: Vec<FlowRow>,
}

pub fn flow_folder(shared_dir: &Path, date: &str, type_code: &str, symbol: &str) -> PathBuf {
    shared_dir.join(SYMBOL_FLOW_FOLDER).join(date).join(type_code).join(symbol)
}

pub fn flow_path(shared_dir: &Path, date: &str, type_code: &str, symbol: &str, key: &str) -> PathBuf {
    flow_folder(shared_dir, date, type_code, symbol).join(format!("{key}.{FLOW_EXTENSION}"))
}

pub fn flow_links_path(shared_dir: &Path, date: &str, key: &str) -> PathBuf {
    shared_dir.join(SYMBOL_FLOW_FOLDER).join(date).join(LINKS_FOLDER).join(format!("{key}.{LINKS_EXTENSION}"))
}

#[derive(Debug, Clone, Copy)]
struct BlockHeader {
    kind: u8,
    codec: u8,
    payload_len: u32,
    row_count: u32,
    first_ms: i64,
    last_ms: i64,
}

impl BlockHeader {
    fn encode(self) -> [u8; HEADER_LEN] {
        let mut bytes = [0u8; HEADER_LEN];
        bytes[0..4].copy_from_slice(&MAGIC);
        bytes[4] = self.kind;
        bytes[5] = self.codec;
        bytes[8..12].copy_from_slice(&self.payload_len.to_le_bytes());
        bytes[12..16].copy_from_slice(&self.row_count.to_le_bytes());
        bytes[16..24].copy_from_slice(&self.first_ms.to_le_bytes());
        bytes[24..32].copy_from_slice(&self.last_ms.to_le_bytes());
        bytes
    }

    fn decode(bytes: &[u8; HEADER_LEN]) -> Option<BlockHeader> {
        if bytes[0..4] != MAGIC {
            return None;
        }
        let kind = bytes[4];
        let codec = bytes[5];
        if !matches!(kind, KIND_DESCRIPTION | KIND_ROWS) || !matches!(codec, CODEC_RAW | CODEC_ZSTD) {
            return None;
        }
        let payload_len = u32::from_le_bytes(bytes[8..12].try_into().ok()?);
        if payload_len as usize > MAX_PAYLOAD_LEN {
            return None;
        }
        let row_count = u32::from_le_bytes(bytes[12..16].try_into().ok()?);
        let first_ms = i64::from_le_bytes(bytes[16..24].try_into().ok()?);
        let last_ms = i64::from_le_bytes(bytes[24..32].try_into().ok()?);
        Some(BlockHeader { kind, codec, payload_len, row_count, first_ms, last_ms })
    }
}

fn encode_block(kind: u8, raw: &[u8], row_count: u32, first_ms: i64, last_ms: i64) -> io::Result<Vec<u8>> {
    if raw.len() > MAX_PAYLOAD_LEN {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("흐름 블록 크기가 상한을 넘습니다: {}", raw.len())));
    }
    let (codec, payload): (u8, Vec<u8>) = match zstd::bulk::compress(raw, ZSTD_LEVEL) {
        Ok(compressed) if compressed.len() < raw.len() => (CODEC_ZSTD, compressed),
        _ => (CODEC_RAW, raw.to_vec()),
    };
    let payload_len = u32::try_from(payload.len()).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "흐름 블록 길이가 u32를 넘습니다"))?;
    let header = BlockHeader { kind, codec, payload_len, row_count, first_ms, last_ms }.encode();
    let mut out = Vec::with_capacity(HEADER_LEN + payload.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(&payload);
    Ok(out)
}

fn decode_payload(codec: u8, payload: &[u8]) -> io::Result<Vec<u8>> {
    match codec {
        CODEC_RAW => Ok(payload.to_vec()),
        CODEC_ZSTD => {
            let decoder = zstd::stream::Decoder::new(payload)?;
            let mut decoded = Vec::new();
            decoder.take((MAX_PAYLOAD_LEN + 1) as u64).read_to_end(&mut decoded)?;
            if decoded.len() > MAX_PAYLOAD_LEN {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "압축 해제한 흐름 블록이 상한을 넘습니다"));
            }
            Ok(decoded)
        }
        _ => Err(io::Error::new(io::ErrorKind::InvalidData, format!("모르는 흐름 코덱: {codec}"))),
    }
}

fn encode_rows_block(rows: &[FlowRow]) -> io::Result<Vec<u8>> {
    let first_ms = rows.iter().map(|row| row.recv_ms).min().unwrap_or(0);
    let last_ms = rows.iter().map(|row| row.recv_ms).max().unwrap_or(0);
    let row_count = u32::try_from(rows.len()).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "흐름 행 수가 u32를 넘습니다"))?;
    let wire: Vec<WireRow<'_>> = rows.iter().map(WireRow).collect();
    let raw = serde_json::to_vec(&wire).map_err(io::Error::other)?;
    encode_block(KIND_ROWS, &raw, row_count, first_ms, last_ms)
}

fn write_block_or_rollback(file: &mut File, len: &mut u64, block: &[u8]) -> io::Result<()> {
    let before = *len;
    file.seek(SeekFrom::Start(before))?;
    if let Err(error) = file.write_all(block) {
        let _ = file.set_len(before);
        let _ = file.seek(SeekFrom::Start(before));
        return Err(error);
    }
    *len = before + block.len() as u64;
    Ok(())
}

fn scan_valid_prefix(file: &mut File) -> io::Result<(u64, Option<FlowDescription>)> {
    let file_len = file.metadata()?.len();
    let mut pos = 0u64;
    let mut last_description = None;
    let mut header_bytes = [0u8; HEADER_LEN];
    file.seek(SeekFrom::Start(0))?;
    while pos + HEADER_LEN as u64 <= file_len {
        file.read_exact(&mut header_bytes)?;
        let Some(header) = BlockHeader::decode(&header_bytes) else {
            break;
        };
        let block_end = pos + HEADER_LEN as u64 + u64::from(header.payload_len);
        if block_end > file_len {
            break;
        }
        match header.kind {
            KIND_DESCRIPTION => {
                let mut payload = vec![0u8; header.payload_len as usize];
                file.read_exact(&mut payload)?;
                let Ok(raw) = decode_payload(header.codec, &payload) else {
                    break;
                };
                let Ok(description) = serde_json::from_slice::<FlowDescription>(&raw) else {
                    break;
                };
                if description.format_version != FLOW_FORMAT_VERSION {
                    break;
                }
                last_description = Some(description);
            }
            KIND_ROWS => {
                if last_description.is_none() {
                    break;
                }
                file.seek(SeekFrom::Start(block_end))?;
            }
            _ => break,
        }
        pos = block_end;
    }
    Ok((pos, last_description))
}

pub struct FlowWriter {
    file: File,
    len: u64,
}

impl FlowWriter {
    pub fn open(path: &Path, description: FlowDescription) -> io::Result<FlowWriter> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)?;
        let file_len = file.metadata()?.len();
        let (mut len, last_description) = scan_valid_prefix(&mut file)?;
        if len < file_len {
            file.set_len(len)?;
        }
        if len == 0 || last_description.as_ref() != Some(&description) {
            let raw = serde_json::to_vec(&description).map_err(io::Error::other)?;
            let block = encode_block(KIND_DESCRIPTION, &raw, 0, 0, 0)?;
            write_block_or_rollback(&mut file, &mut len, &block)?;
        }
        Ok(FlowWriter { file, len })
    }

    pub fn open_verified(path: &Path) -> io::Result<FlowWriter> {
        let mut file = OpenOptions::new().write(true).open(path)?;
        let len = file.seek(SeekFrom::End(0))?;
        Ok(FlowWriter { file, len })
    }

    pub fn append(&mut self, rows: &[FlowRow]) -> io::Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let block = encode_rows_block(rows)?;
        write_block_or_rollback(&mut self.file, &mut self.len, &block)
    }
}

pub struct FlowCursor {
    path: PathBuf,
    identity: Option<u64>,
    offset: u64,
    head: Vec<u8>,
    description: Option<Arc<FlowDescription>>,
}

impl FlowCursor {
    pub fn new(path: PathBuf) -> FlowCursor {
        FlowCursor { path, identity: None, offset: 0, head: Vec::new(), description: None }
    }

    pub fn read_new(&mut self) -> io::Result<Vec<FlowBlock>> {
        let mut file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.reset();
                return Ok(Vec::new());
            }
            Err(error) => return Err(error),
        };
        let meta = file.metadata()?;
        let (len, identity) = (meta.len(), file_identity(&meta));
        let replaced = self.identity != Some(identity) || len < self.offset || (!self.head.is_empty() && !head_matches(&mut file, &self.head));
        if replaced {
            self.identity = Some(identity);
            self.offset = 0;
            self.head.clear();
            self.description = None;
        }
        if len == self.offset {
            return Ok(Vec::new());
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut chunk = Vec::new();
        file.read_to_end(&mut chunk)?;
        let mut pos = 0usize;
        let mut blocks = Vec::new();
        while pos + HEADER_LEN <= chunk.len() {
            let header_bytes: &[u8; HEADER_LEN] = chunk[pos..pos + HEADER_LEN].try_into().expect("머리 길이 확인함");
            let Some(header) = BlockHeader::decode(header_bytes) else {
                break;
            };
            let payload_start = pos + HEADER_LEN;
            let payload_end = payload_start + header.payload_len as usize;
            if payload_end > chunk.len() {
                break;
            }
            let payload = &chunk[payload_start..payload_end];
            match header.kind {
                KIND_DESCRIPTION => {
                    let raw = decode_payload(header.codec, payload)?;
                    let description: FlowDescription = serde_json::from_slice(&raw).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                    if description.format_version != FLOW_FORMAT_VERSION {
                        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("모르는 흐름 형식 버전: {}", description.format_version)));
                    }
                    self.description = Some(Arc::new(description));
                }
                KIND_ROWS => {
                    let description = self
                        .description
                        .as_ref()
                        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "설명 블록 전에 행 블록이 나왔습니다"))?;
                    let raw = decode_payload(header.codec, payload)?;
                    let owned: Vec<OwnedWireRow> = serde_json::from_slice(&raw).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                    let rows: Vec<FlowRow> = owned.into_iter().map(|row| row.0).collect();
                    blocks.push(FlowBlock {
                        description: Arc::clone(description),
                        first_ms: header.first_ms,
                        last_ms: header.last_ms,
                        rows,
                    });
                }
                _ => break,
            }
            pos = payload_end;
        }
        if self.offset == 0 && pos > 0 {
            self.head = chunk[..pos.min(HEAD_FINGERPRINT_LEN)].to_vec();
        }
        self.offset += pos as u64;
        Ok(blocks)
    }

    fn reset(&mut self) {
        self.identity = None;
        self.offset = 0;
        self.head.clear();
        self.description = None;
    }
}

fn head_matches(file: &mut File, head: &[u8]) -> bool {
    let mut seen = vec![0; head.len()];
    file.seek(SeekFrom::Start(0)).and_then(|_| file.read_exact(&mut seen)).is_ok() && seen == head
}
