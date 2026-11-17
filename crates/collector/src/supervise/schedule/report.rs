use server::clock::Clock;
use tokio::sync::watch;

use crate::supervise::journal::kst_stamp;
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
}

impl Reporter {
    pub(super) fn new(clock: Clock, date: u32) -> Reporter {
        let sender = watch::channel(DaemonStatus { date, phase: DayPhase::OffHours, ..DaemonStatus::default() }).0;
        Reporter { sender, clock, date, phase: DayPhase::OffHours, universe_changes: None, observation_day: None, own_alerts: Vec::new(), supervised: None }
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
        self.supervised = Some(status);
        self.publish();
    }

    pub(super) fn alert(&mut self, kind: AlertKind, message: String) {
        tracing::warn!(?kind, %message, "데몬 경보");
        self.own_alerts.push(Alert { at: kst_stamp(self.clock.now()), kind, message });
        self.publish();
    }

    fn publish(&self) {
        let (today, keys, supervised_alerts) = match &self.supervised {
            Some(status) => (status.today, status.keys.clone(), status.alerts.clone()),
            None => Default::default(),
        };
        let mut alerts = self.own_alerts.clone();
        alerts.extend(supervised_alerts);
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
