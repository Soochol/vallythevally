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

const BROKER_FIDS: [u32; 40] = [
    141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160,
    161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180,
];

pub const FLOW_KINDS: &[FlowKindSpec] = &[FlowKindSpec { type_code: "0F", fids: &BROKER_FIDS }];
