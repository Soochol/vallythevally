mod read;
mod task;

use domain::{MicroEvent, MicroEventKind, MicroSide};
use server::shared_data::FlowRow;

pub use task::{FLUSH_EVERY, MicroFeed, MicroStats, MicroWorker, spawn};

pub const MICRO_TYPE_CODE: &str = "ME";
pub const MICRO_FIDS: [u32; 6] = [1, 2, 3, 4, 5, 6];

pub fn event_to_flow_row(event: MicroEvent) -> FlowRow {
    let kind = match event.kind {
        MicroEventKind::SpoofCancel => "S",
        MicroEventKind::IcebergAbsorb => "I",
    };
    let side = match event.side {
        MicroSide::Ask => "A",
        MicroSide::Bid => "B",
    };
    FlowRow {
        recv_ms: event.recv_ms,
        values: vec![
            Some(kind.to_owned()),
            Some(side.to_owned()),
            Some(event.price_won.to_string()),
            Some(event.cancelled_or_absorbed_qty.to_string()),
            Some(event.displayed_qty.to_string()),
            Some(event.ratio_bps.to_string()),
        ],
    }
}
