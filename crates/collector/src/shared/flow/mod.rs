mod read;
mod store;
mod task;

pub use store::{FileFlowStore, remove_finished_days};
pub use task::{FLUSH_EVERY, FlowFeed, FlowStats, FlowWorker, spawn};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FlowKindSpec {
    pub type_code: &'static str,
    pub fids: &'static [u32],
}

const BROKER_FIDS: [u32; 46] = [
    141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160,
    161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180,
    261, 262, 263, 264, 267, 268,
];

const PROGRAM_FIDS: [u32; 10] = [20, 10, 202, 204, 206, 208, 210, 211, 212, 213];
const VI_FIDS: [u32; 13] = [9001, 9068, 9069, 1221, 1223, 1224, 1225, 1236, 1237, 1238, 1239, 1489, 1490];
const EXPECTED_FIDS: [u32; 7] = [20, 10, 11, 12, 15, 13, 25];
const TRADE_TICK_FIDS: [u32; 5] = [20, 10, 15, 1313, 9081];

pub const FLOW_KINDS: &[FlowKindSpec] = &[
    FlowKindSpec { type_code: "0F", fids: &BROKER_FIDS },
    FlowKindSpec { type_code: "0w", fids: &PROGRAM_FIDS },
    FlowKindSpec { type_code: "1h", fids: &VI_FIDS },
    FlowKindSpec { type_code: "0H", fids: &EXPECTED_FIDS },
    FlowKindSpec { type_code: "0B", fids: &TRADE_TICK_FIDS },
];
