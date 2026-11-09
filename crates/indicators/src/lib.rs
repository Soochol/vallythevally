//! 지표 종류 일곱 가지(backend.md §9). 브라우저는 `wasm` feature로, 서버는 그대로 같은 계산을 쓴다(ADR 0002).

mod engine;
mod spec;
mod state;
#[cfg(feature = "wasm")]
mod wasm;

pub use engine::{BarInput, Columns, ColumnsError, Engine, Line, Output, Tail, compute};
pub use spec::{LineId, MaMethod, Spec, SpecError};
