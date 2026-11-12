use std::sync::Arc;

use domain::{KstTime, TimeOfDay};

use crate::{clock::next_daily, symbols::SymbolDirectory};
use super::{Financials, control::Launch};

pub(super) fn next_check(now: KstTime) -> KstTime { next_daily(now, TimeOfDay::hms(7, 0, 0).unwrap()) }
pub(super) fn due_check(now: KstTime) -> KstTime { next_check(now).plus_secs(-86400) }

impl Financials {
    pub fn start_automatic(self: &Arc<Self>, symbols: Arc<SymbolDirectory>) -> tokio::task::JoinHandle<()> {
        self.control.enable_automatic();
        let service = self.clone();
        tokio::spawn(async move {
            let mut listings = symbols.updates();
            loop {
                let next = next_check(service.clock.now());
                let current = listings.borrow().clone();
                if let Some(current) = current {
                    service.launch_update(current.all().cloned().collect(), Launch::Automatic).await;
                }
                tokio::select! {
                    _ = service.clock.sleep_until(next) => {}
                    changed = listings.changed() => if changed.is_err() { break; },
                    _ = service.control.finished() => {}
                }
            }
        })
    }
}
