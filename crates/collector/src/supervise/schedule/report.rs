use std::path::PathBuf;

use server::alert::MarketContext;
use server::clock::Clock;
use tokio::sync::watch;

use crate::supervise::journal::kst_stamp;
use crate::supervise::telegram::{AlertTelegram, market_observation, market_phase};
use crate::supervise::shared::SharedReport;
use crate::supervise::status::{Alert, AlertKind, DaemonStatus, DayPhase, ObservationDay};
use crate::universe::Diff;

const ALERT_LIMIT: usize = 200;

pub(super) struct Reporter {
    sender: watch::Sender<DaemonStatus>,
    clock: Clock,
    data_dir: PathBuf,
    date: u32,
    phase: DayPhase,
    universe_changes: Option<Diff>,
    observation_day: Option<ObservationDay>,
    own_alerts: Vec<Alert>,
    supervised: Option<DaemonStatus>,
    shared: SharedReport,
    announced_shared: Vec<Alert>,
    telegram: Option<AlertTelegram>,
    announced_supervised: Vec<Alert>,
    notes_flushed: bool,
}

impl Reporter {
    pub(super) fn new(clock: Clock, data_dir: PathBuf, date: u32) -> Reporter {
        let sender = watch::channel(DaemonStatus { date, phase: DayPhase::OffHours, ..DaemonStatus::default() }).0;
        Reporter { sender, clock, data_dir, date, phase: DayPhase::OffHours, universe_changes: None, observation_day: None, own_alerts: Vec::new(), supervised: None, shared: SharedReport::default(), announced_shared: Vec::new(), telegram: None, announced_supervised: Vec::new(), notes_flushed: false }
    }

    pub(super) fn use_telegram(&mut self, telegram: Option<AlertTelegram>) {
        self.telegram = telegram;
    }

    fn market_context(&self) -> MarketContext {
        MarketContext::new(self.date, market_phase(self.phase), market_observation(self.observation_day.as_ref()))
    }

    pub(super) fn close_day(&self) {
        if let Some(telegram) = &self.telegram {
            let ctx = self.market_context();
            let status = self.sender.borrow().clone();
            telegram.check_disk(&self.data_dir, ctx);
            telegram.close_day(ctx, &status, &self.data_dir);
        }
    }

    pub(super) fn subscribe(&self) -> watch::Receiver<DaemonStatus> {
        self.sender.subscribe()
    }

    pub(super) fn begin_day(&mut self, date: u32) {
        self.date = date;
        self.phase = DayPhase::OffHours;
        self.universe_changes = None;
        self.observation_day = None;
        self.own_alerts.clear();
        self.supervised = None;
        self.shared = SharedReport::default();
        self.announced_shared.clear();
        self.announced_supervised.clear();
        self.notes_flushed = false;
        self.publish();
        if let Some(telegram) = &self.telegram {
            let ctx = self.market_context();
            telegram.retire_previous_day_incidents(date, &self.data_dir);
            telegram.resolve_pending_crash(ctx);
            telegram.check_disk(&self.data_dir, ctx);
            telegram.tick(ctx);
        }
    }

    pub(super) fn housekeeping(&self) {
        if let Some(telegram) = &self.telegram {
            let ctx = self.market_context();
            telegram.check_disk(&self.data_dir, ctx);
            telegram.tick(ctx);
        }
    }

    pub(super) fn resolve_finalize(&self, date: u32) {
        if let Some(telegram) = &self.telegram {
            telegram.resolve_finalize(self.market_context(), date);
        }
    }

    pub(super) fn current_phase(&self) -> DayPhase {
        self.phase
    }

    pub(super) fn phase(&mut self, phase: DayPhase) {
        self.phase = phase;
        self.publish();
        if let Some(telegram) = &self.telegram {
            let ctx = self.market_context();
            telegram.check_disk(&self.data_dir, ctx);
            telegram.tick(ctx);
        }
    }

    pub(super) fn observation_day(&mut self, observation_day: ObservationDay) {
        self.observation_day = Some(observation_day);
        self.publish();
    }

    pub(super) fn universe_changes(&mut self, diff: Diff) {
        self.universe_changes = Some(diff);
        self.publish();
    }

    pub(super) fn supervised(&mut self, status: DaemonStatus) {
        let ctx = self.market_context();
        if let Some(telegram) = &self.telegram {
            let fresh: Vec<Alert> = status.alerts.iter().filter(|alert| !self.announced_supervised.contains(alert)).cloned().collect();
            for alert in fresh {
                telegram.alert(ctx, &alert);
                self.announced_supervised.push(alert);
            }
            telegram.observe_status(ctx, &status);
            telegram.tick(ctx);
        }
        self.supervised = Some(status);
        self.publish();
        if let Some(telegram) = &self.telegram
            && !self.notes_flushed
        {
            let current = self.sender.borrow().clone();
            telegram.morning_brief(ctx, &current, &self.data_dir);
            self.notes_flushed = true;
        }
    }

    pub(super) fn shared(&mut self, report: SharedReport) {
        let ctx = self.market_context();
        if let Some(telegram) = &self.telegram {
            let fresh: Vec<Alert> = report.alerts.iter().filter(|alert| !self.announced_shared.contains(alert)).cloned().collect();
            for alert in fresh {
                telegram.alert(ctx, &alert);
                self.announced_shared.push(alert);
            }
        }
        self.shared = report;
        self.publish();
    }

    pub(super) fn alert(&mut self, kind: AlertKind, message: String) {
        tracing::warn!(?kind, %message, "데몬 경보");
        let alert = Alert { at: kst_stamp(self.clock.now()), kind, message };
        if let Some(telegram) = &self.telegram {
            telegram.alert(self.market_context(), &alert);
        }
        self.own_alerts.push(alert);
        self.publish();
    }

    fn publish(&self) {
        let (today, keys, supervised_alerts) = match &self.supervised {
            Some(status) => (status.today, status.keys.clone(), status.alerts.clone()),
            None => Default::default(),
        };
        let mut keys = keys;
        keys.extend(self.shared.keys.iter().cloned());
        let mut alerts = self.own_alerts.clone();
        alerts.extend(supervised_alerts);
        alerts.extend(self.shared.alerts.iter().cloned());
        alerts.sort_by(|first, second| first.at.cmp(&second.at));
        let surplus = alerts.len().saturating_sub(ALERT_LIMIT);
        alerts.drain(..surplus);
        let status = DaemonStatus {
            date: self.date,
            phase: self.phase,
            today,
            keys,
            universe_changes: self.universe_changes.clone(),
            observation_day: self.observation_day.clone(),
            alerts,
        };
        self.sender.send_if_modified(|current| {
            let changed = *current != status;
            if changed {
                *current = status;
            }
            changed
        });
    }
}
