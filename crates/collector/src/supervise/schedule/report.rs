use server::clock::Clock;
use tokio::sync::watch;

use crate::supervise::journal::kst_stamp;
use crate::supervise::telegram::AlertTelegram;
use crate::supervise::shared::SharedReport;
use crate::supervise::status::{Alert, AlertKind, DaemonStatus, DayPhase, ObservationDay};
use crate::universe::Diff;

const ALERT_LIMIT: usize = 200;

pub(super) struct Reporter {
    sender: watch::Sender<DaemonStatus>,
    clock: Clock,
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
    pub(super) fn new(clock: Clock, date: u32) -> Reporter {
        let sender = watch::channel(DaemonStatus { date, phase: DayPhase::OffHours, ..DaemonStatus::default() }).0;
        Reporter { sender, clock, date, phase: DayPhase::OffHours, universe_changes: None, observation_day: None, own_alerts: Vec::new(), supervised: None, shared: SharedReport::default(), announced_shared: Vec::new(), telegram: None, announced_supervised: Vec::new(), notes_flushed: false }
    }

    pub(super) fn use_telegram(&mut self, telegram: Option<AlertTelegram>) {
        self.telegram = telegram;
    }

    pub(super) fn close_day(&self) {
        if let Some(telegram) = &self.telegram {
            telegram.close_day(self.date);
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
    }

    pub(super) fn current_phase(&self) -> DayPhase {
        self.phase
    }

    pub(super) fn phase(&mut self, phase: DayPhase) {
        self.phase = phase;
        self.publish();
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
        if let Some(telegram) = &self.telegram {
            let fresh: Vec<Alert> = status.alerts.iter().filter(|alert| !self.announced_supervised.contains(alert)).cloned().collect();
            for alert in fresh {
                telegram.alert(self.date, &alert);
                self.announced_supervised.push(alert);
            }
            if !self.notes_flushed {
                telegram.flush_notes(self.date);
                self.notes_flushed = true;
            }
        }
        self.supervised = Some(status);
        self.publish();
    }

    pub(super) fn shared(&mut self, report: SharedReport) {
        if let Some(telegram) = &self.telegram {
            let fresh: Vec<Alert> = report.alerts.iter().filter(|alert| !self.announced_shared.contains(alert)).cloned().collect();
            for alert in fresh {
                telegram.alert(self.date, &alert);
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
            telegram.alert(self.date, &alert);
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
