use serde::Serialize;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;

const BASE_PRICE: f64 = 70_000.0;
const PRICE_STEP: f64 = 100.0;
const PRICE_BAND: u64 = 40;
const SUBSCRIPTION: &str = "bench";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Plan {
    pub per_second: u32,
    pub seconds: u32,
}

impl Plan {
    pub fn new(per_second: u32, seconds: u32) -> Result<Plan, String> {
        if per_second == 0 || seconds == 0 {
            return Err("초당 건수와 시간은 0보다 커야 합니다".into());
        }
        Ok(Plan { per_second, seconds })
    }

    pub fn total(self) -> u64 {
        u64::from(self.per_second) * u64::from(self.seconds)
    }

    fn gap(self) -> Duration {
        Duration::from_secs_f64(1.0 / f64::from(self.per_second))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trade {
    t: u64,
    price: f64,
    qty: i64,
    venue: Option<&'static str>,
    strength: Option<f64>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Message {
    FeedTrades { sub: &'static str, seq: u64, sent_at: f64, trades: [Trade; 1] },
    End { sent: u64 },
}

pub fn epoch_millis() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0)
}

fn trade_message(seq: u64) -> Message {
    let sent_at = epoch_millis();
    let walk = (seq.wrapping_mul(2_654_435_761) >> 7) % PRICE_BAND;
    Message::FeedTrades {
        sub: SUBSCRIPTION,
        seq,
        sent_at,
        trades: [Trade { t: (sent_at / 1000.0) as u64, price: BASE_PRICE + walk as f64 * PRICE_STEP, qty: 1 + (seq % 50) as i64, venue: None, strength: None }],
    }
}

pub fn run(plan: Plan, mut send: impl FnMut(Message) -> bool) -> u64 {
    let start = Instant::now();
    let gap = plan.gap();
    let mut sent = 0;
    for seq in 0..plan.total() {
        if let Some(wait) = (start + gap.mul_f64(seq as f64)).checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        }
        if !send(trade_message(seq)) {
            return sent;
        }
        sent += 1;
    }
    send(Message::End { sent });
    sent
}

#[tauri::command]
pub fn bench_stream(per_second: u32, seconds: u32, events: Channel<Message>) -> Result<(), String> {
    let plan = Plan::new(per_second, seconds)?;
    std::thread::spawn(move || {
        run(plan, |message| events.send(message).is_ok());
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plan_sends_the_exact_total_then_an_end_message_naming_it() {
        let plan = Plan::new(2_000, 1).unwrap();
        let mut trades = 0u64;
        let mut ended = None;
        let sent = run(plan, |message| {
            match message {
                Message::FeedTrades { seq, .. } => {
                    assert_eq!(seq, trades);
                    trades += 1;
                }
                Message::End { sent } => ended = Some(sent),
            }
            true
        });
        assert_eq!((sent, trades, ended), (2_000, 2_000, Some(2_000)));
    }

    #[test]
    fn a_vanished_receiver_stops_the_stream_without_an_end_message() {
        let mut delivered = 0u64;
        let sent = run(Plan::new(1_000, 1).unwrap(), |_| {
            delivered += 1;
            delivered < 10
        });
        assert_eq!(sent, 9);
    }

    #[test]
    fn a_trade_message_has_the_shape_of_the_live_feed_message_plus_the_send_time() {
        let json = serde_json::to_value(trade_message(3)).unwrap();
        assert_eq!(json["type"], "feedTrades");
        assert_eq!(json["sub"], "bench");
        assert!(json["sentAt"].as_f64().unwrap() > 1.0e12);
        let trade = &json["trades"][0];
        assert!(trade["t"].is_u64() && trade["price"].is_f64() && trade["qty"].is_i64());
        assert!(trade["venue"].is_null() && trade["strength"].is_null());
    }

    #[test]
    fn a_plan_with_nothing_to_send_is_refused() {
        assert!(Plan::new(0, 30).is_err());
        assert!(Plan::new(1_000, 0).is_err());
    }
}
