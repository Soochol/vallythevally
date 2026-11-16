use std::fmt;

use crate::kind::StreamKind;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncodeError {
    SymbolNotAscii,
    SymbolTooLong { len: usize },
    DuplicateStream { kind: StreamKind },
    ColumnCount { kind: StreamKind, expected: usize, found: usize },
    ColumnLength { kind: StreamKind, column: String, expected: usize, found: usize },
    OutOfRange { kind: StreamKind, column: String, row: usize, value: i64 },
    TooLarge { kind: StreamKind },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    Truncated { offset: usize },
    BadMagic,
    UnsupportedVersion { version: u16 },
    SymbolNotAscii,
    UnknownKind { code: u8 },
    DuplicateStream { kind: StreamKind },
    ColumnCount { kind: StreamKind, expected: usize, found: usize },
    DeltaFlagsMismatch { kind: StreamKind },
    BodyLength { kind: StreamKind, expected: u64, found: u64 },
    NonZeroPadding,
    TrailingBytes { count: usize },
}

impl fmt::Display for EncodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EncodeError::SymbolNotAscii => write!(f, "종목이 ASCII가 아니다"),
            EncodeError::SymbolTooLong { len } => write!(f, "종목이 {len}글자로 255자를 넘는다"),
            EncodeError::DuplicateStream { kind } => {
                write!(f, "{} 흐름이 두 번 들었다", kind.name())
            }
            EncodeError::ColumnCount { kind, expected, found } => {
                write!(f, "{} 흐름의 열이 {found}개다. 규격은 {expected}개다", kind.name())
            }
            EncodeError::ColumnLength { kind, column, expected, found } => write!(
                f,
                "{} 흐름 {column} 열의 행이 {found}개다. 첫 열은 {expected}개다",
                kind.name()
            ),
            EncodeError::OutOfRange { kind, column, row, value } => write!(
                f,
                "{} 흐름 {column} 열 {row}행의 값 {value}이 i32 범위를 넘는다",
                kind.name()
            ),
            EncodeError::TooLarge { kind } => {
                write!(f, "{} 흐름의 본문이 u32 바이트를 넘는다", kind.name())
            }
        }
    }
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DecodeError::Truncated { offset } => write!(f, "{offset}바이트 근처에서 파일이 잘렸다"),
            DecodeError::BadMagic => write!(f, "magic이 HOGA가 아니다"),
            DecodeError::UnsupportedVersion { version } => {
                write!(f, "버전 {version}은 받지 않는다")
            }
            DecodeError::SymbolNotAscii => write!(f, "종목이 ASCII가 아니다"),
            DecodeError::UnknownKind { code } => write!(f, "알 수 없는 흐름 종류 {code}"),
            DecodeError::DuplicateStream { kind } => {
                write!(f, "{} 흐름이 두 번 들었다", kind.name())
            }
            DecodeError::ColumnCount { kind, expected, found } => {
                write!(f, "{} 흐름의 열이 {found}개다. 규격은 {expected}개다", kind.name())
            }
            DecodeError::DeltaFlagsMismatch { kind } => {
                write!(f, "{} 흐름의 차분 여부가 규격과 다르다", kind.name())
            }
            DecodeError::BodyLength { kind, expected, found } => write!(
                f,
                "{} 흐름의 본문이 {found}바이트다. 행 수와 열 수로는 {expected}바이트다",
                kind.name()
            ),
            DecodeError::NonZeroPadding => write!(f, "채움 바이트가 0이 아니다"),
            DecodeError::TrailingBytes { count } => write!(f, "끝에 {count}바이트가 남았다"),
        }
    }
}

impl std::error::Error for EncodeError {}
impl std::error::Error for DecodeError {}
