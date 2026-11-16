mod decode;
mod encode;
mod error;
mod kind;
mod span;

pub use decode::decode;
pub use encode::encode;
pub use error::{DecodeError, EncodeError};
pub use kind::{ColumnSpec, StreamKind};
pub use span::{Span, Stream};

pub const MAGIC: [u8; 4] = *b"HOGA";
pub const VERSION: u16 = 1;
pub const MAX_SYMBOL_LEN: usize = 255;
