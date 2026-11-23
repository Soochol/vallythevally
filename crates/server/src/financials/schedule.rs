use std::sync::Arc;

use domain::{KstTime, SymbolInfo, TimeOfDay};
use tokio::sync::watch;

use crate::{clock::next_daily, symbols::{Directory, SymbolDirectory}};
use super::{Financials, control::Launch};

pub(super) fn next_check(now: KstTime) -> KstTime { next_daily(now, TimeOfDay::hms(7, 0, 0).unwrap()) }
pub(super) fn due_check(now: KstTime) -> KstTime { next_check(now).plus_secs(-86400) }

fn listed(directory: &Option<Arc<Directory>>) -> Option<Vec<SymbolInfo>> {
    directory.as_ref().map(|directory| directory.all().cloned().collect())
}

pub fn symbol_listings(directory: &SymbolDirectory) -> watch::Receiver<Option<Vec<SymbolInfo>>> {
    let mut source = directory.updates();
    let (sender, receiver) = watch::channel(listed(&source.borrow()));
    tokio::spawn(async move {
        loop {
            tokio::select! {
                changed = source.changed() => if changed.is_err() { break; },
                _ = sender.closed() => break,
            }
            sender.send_replace(listed(&source.borrow_and_update()));
        }
    });
    receiver
}

impl Financials {
    pub fn start_automatic(self: &Arc<Self>, mut listings: watch::Receiver<Option<Vec<SymbolInfo>>>) -> tokio::task::JoinHandle<()> {
        self.control.enable_automatic();
        let service = self.clone();
        tokio::spawn(async move {
            loop {
                let next = next_check(service.clock.now());
                let current = listings.borrow().clone();
                if let Some(current) = current {
                    service.launch_update(current, Launch::Automatic).await;
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
