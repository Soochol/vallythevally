mod engine;
mod spec;
mod state;

pub use engine::{BarError, BarInput, Columns, Engine, Line, Output, Tail, compute};
pub use spec::{Input, LineId, MaMethod, Memory, Spec, SpecError, ValidSpec};
