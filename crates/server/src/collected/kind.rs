use std::borrow::Cow;

use crate::api;
use crate::market_source::stream::BrokerEntry;

pub struct FidValues<'a> {
    fids: &'a [u32],
    values: &'a [Option<String>],
}

impl<'a> FidValues<'a> {
    pub fn new(fids: &'a [u32], values: &'a [Option<String>]) -> Self {
        Self { fids, values }
    }

    pub fn get(&self, fid: u32) -> Option<&'a str> {
        let index = self.fids.iter().position(|&candidate| candidate == fid)?;
        self.values.get(index)?.as_deref()
    }
}

pub trait CollectedKind: 'static {
    const TYPE_CODE: &'static str;
    type View: Clone + Send + Sync + 'static;

    fn fids() -> &'static [u32];
    fn decode(recv_ms: i64, values: &FidValues<'_>) -> Option<Self::View>;
}

pub struct Brokers;

const BROKER_FIDS: [u32; 40] = [
    141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160,
    161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180,
];

impl CollectedKind for Brokers {
    const TYPE_CODE: &'static str = "0F";
    type View = api::FeedBrokers;

    fn fids() -> &'static [u32] {
        &BROKER_FIDS
    }

    fn decode(recv_ms: i64, values: &FidValues<'_>) -> Option<Self::View> {
        let (sells, buys) = crate::kiwoom::wire::parse_broker_sides(|fid| values.get(fid).map(Cow::Borrowed)).ok()?;
        let map_side = |entries: Vec<BrokerEntry>| {
            entries
                .into_iter()
                .map(|entry| api::FeedBroker {
                    code: entry.member_code,
                    name: entry.member_name,
                    qty: entry.cumulative_qty.0,
                    qty_change: entry.change_qty,
                })
                .collect()
        };
        Some(api::FeedBrokers {
            t: api::UnixSeconds(recv_ms.div_euclid(1000)),
            sells: map_side(sells),
            buys: map_side(buys),
        })
    }
}
