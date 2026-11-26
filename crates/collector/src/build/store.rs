use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use hoga_format::{DecodeError, EncodeError, Span};

pub use crate::fs_util::write_atomically;

const BROTLI_QUALITY: u32 = 11;
const BROTLI_WINDOW_BITS: u32 = 22;
const BROTLI_BUFFER_BYTES: usize = 64 * 1024;
const SPAN_FILE_SUFFIX: &str = ".hoga.br";

pub fn spans_day_dir(data_dir: &Path, date: u32) -> PathBuf {
    data_dir.join("spans").join(date.to_string())
}

pub fn symbol_dir(data_dir: &Path, date: u32, symbol: &str) -> PathBuf {
    spans_day_dir(data_dir, date).join(symbol)
}

pub fn hhmm(start_minute: u16) -> String {
    format!("{:02}{:02}", start_minute / 60, start_minute % 60)
}

pub fn span_file_name(start_minute: u16, revision: u32) -> String {
    format!("{}-r{revision}{SPAN_FILE_SUFFIX}", hhmm(start_minute))
}

pub fn parse_hhmm(text: &str) -> Option<u16> {
    if text.len() != 4 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let (hour, minute): (u16, u16) = (text[..2].parse().ok()?, text[2..].parse().ok()?);
    (hour < 24 && minute < 60).then_some(hour * 60 + minute)
}

pub fn parse_span_file_name(name: &str) -> Option<(u16, u32)> {
    let stem = name.strip_suffix(SPAN_FILE_SUFFIX)?;
    let (start, revision) = stem.split_once("-r")?;
    if revision.is_empty() || !revision.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let revision: u32 = revision.parse().ok()?;
    (revision >= 1).then_some((parse_hhmm(start)?, revision))
}

pub fn latest_revisions(folder: &Path) -> io::Result<BTreeMap<u16, u32>> {
    let mut latest = BTreeMap::new();
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(latest),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let file_name = entry?.file_name();
        if let Some((start_minute, revision)) = file_name.to_str().and_then(parse_span_file_name) {
            let slot: &mut u32 = latest.entry(start_minute).or_default();
            *slot = (*slot).max(revision);
        }
    }
    Ok(latest)
}

#[derive(Debug)]
pub enum PackError {
    Encode(EncodeError),
    Decode(DecodeError),
    RoundTripMismatch,
    Compress(io::Error),
}

impl fmt::Display for PackError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PackError::Encode(error) => write!(formatter, "인코딩 실패: {error}"),
            PackError::Decode(error) => write!(formatter, "인코딩한 바이트를 풀 수 없다: {error}"),
            PackError::RoundTripMismatch => write!(formatter, "인코딩 뒤 디코딩한 값이 넣은 값과 다르다"),
            PackError::Compress(error) => write!(formatter, "압축 실패: {error}"),
        }
    }
}

impl std::error::Error for PackError {}

pub fn pack(span: &Span) -> Result<Vec<u8>, PackError> {
    let encoded = hoga_format::encode(span).map_err(PackError::Encode)?;
    let decoded = hoga_format::decode(&encoded).map_err(PackError::Decode)?;
    if &decoded != span {
        return Err(PackError::RoundTripMismatch);
    }
    let mut compressed = Vec::new();
    {
        let mut writer = brotli::CompressorWriter::new(
            &mut compressed,
            BROTLI_BUFFER_BYTES,
            BROTLI_QUALITY,
            BROTLI_WINDOW_BITS,
        );
        writer.write_all(&encoded).map_err(PackError::Compress)?;
        writer.flush().map_err(PackError::Compress)?;
    }
    Ok(compressed)
}

#[derive(Debug)]
pub enum UnpackError {
    Decompress(io::Error),
    Format(DecodeError),
}

impl fmt::Display for UnpackError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UnpackError::Decompress(error) => write!(formatter, "brotli를 풀 수 없다: {error}"),
            UnpackError::Format(error) => write!(formatter, "구간 파일 형식 오류: {error}"),
        }
    }
}

impl std::error::Error for UnpackError {}

pub fn unpack(compressed: &[u8]) -> Result<Span, UnpackError> {
    let mut encoded = Vec::new();
    brotli::Decompressor::new(compressed, BROTLI_BUFFER_BYTES)
        .read_to_end(&mut encoded)
        .map_err(UnpackError::Decompress)?;
    hoga_format::decode(&encoded).map_err(UnpackError::Format)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_round_trip() {
        assert_eq!(span_file_name(10 * 60 + 25, 3), "1025-r3.hoga.br");
        assert_eq!(parse_span_file_name("1025-r3.hoga.br"), Some((625, 3)));
        for bad in ["1025-r0.hoga.br", "1025-r.hoga.br", "2560-r1.hoga.br", "1025.hoga.br", "1025-r1.hoga", ".tmpab12"] {
            assert_eq!(parse_span_file_name(bad), None, "{bad}");
        }
    }

    #[test]
    fn pack_then_unpack_returns_the_span() {
        let span = Span { date: 20260720, start_minute: 600, length_minutes: 5, symbol: "005930".into(), streams: vec![] };
        assert_eq!(unpack(&pack(&span).unwrap()).unwrap(), span);
    }
}
