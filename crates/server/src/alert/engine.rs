use std::collections::BTreeMap;

use domain::KstTime;
use serde::{Deserialize, Serialize};

use super::model::{AlertDispatch, AlertEvent, DispatchKind, Fingerprint, MarketContext, MarketObservation, PolicyRule, Severity, Signal};

pub const STATE_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum IncidentPhase {
    Pending { first_seen: i64 },
    Firing { fired_at: i64, last_sent_at: i64, reminders_sent: usize, suppressed: u64, deferred: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IncidentRecord {
    pub fingerprint: Fingerprint,
    pub severity: Severity,
    pub phase: IncidentPhase,
    pub title: String,
    pub summary: String,
    pub metrics: BTreeMap<String, String>,
    pub impact: String,
    pub action: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeferredP2 {
    pub fingerprint: Fingerprint,
    pub observed_at: i64,
    pub title: String,
    pub summary: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DayAlertStats {
    pub date: u32,
    pub p1_fired: u64,
    pub p2_fired: u64,
    pub resolved: u64,
}

mod incidents_vec {
    use std::collections::BTreeMap;

    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    use super::{Fingerprint, IncidentRecord};

    pub fn serialize<S: Serializer>(map: &BTreeMap<Fingerprint, IncidentRecord>, serializer: S) -> Result<S::Ok, S::Error> {
        let items: Vec<&IncidentRecord> = map.values().collect();
        items.serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<BTreeMap<Fingerprint, IncidentRecord>, D::Error> {
        let items = Vec::<IncidentRecord>::deserialize(deserializer)?;
        Ok(items.into_iter().map(|record| (record.fingerprint.clone(), record)).collect())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlertState {
    pub format_version: u32,
    #[serde(with = "incidents_vec")]
    pub incidents: BTreeMap<Fingerprint, IncidentRecord>,
    pub deferred_p2: Vec<DeferredP2>,
    pub digest_sent: BTreeMap<String, u32>,
    pub day_stats: DayAlertStats,
}

impl Default for AlertState {
    fn default() -> AlertState {
        AlertState {
            format_version: STATE_FORMAT_VERSION,
            incidents: BTreeMap::new(),
            deferred_p2: Vec::new(),
            digest_sent: BTreeMap::new(),
            day_stats: DayAlertStats::default(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct AlertEngine {
    state: AlertState,
    custom_policies: BTreeMap<super::model::AlertCode, PolicyRule>,
}

impl AlertEngine {
    pub fn new() -> AlertEngine {
        AlertEngine::default()
    }

    pub fn restored(state: AlertState) -> AlertEngine {
        if state.format_version != STATE_FORMAT_VERSION {
            return AlertEngine::default();
        }
        AlertEngine { state, custom_policies: BTreeMap::new() }
    }

    pub fn with_policy(mut self, code: super::model::AlertCode, policy: PolicyRule) -> AlertEngine {
        self.custom_policies.insert(code, policy);
        self
    }

    pub fn snapshot(&self) -> AlertState {
        self.state.clone()
    }

    pub fn apply_snapshot(&mut self, state: AlertState) {
        self.state = state;
    }

    fn policy_for(&self, code: super::model::AlertCode) -> PolicyRule {
        self.custom_policies.get(&code).copied().unwrap_or_else(|| code.policy())
    }

    fn ensure_day(&mut self, date: u32) {
        if self.state.day_stats.date != date {
            self.state.day_stats = DayAlertStats { date, ..DayAlertStats::default() };
        }
    }

    pub fn day_stats(&self, date: u32) -> DayAlertStats {
        if self.state.day_stats.date == date {
            self.state.day_stats
        } else {
            DayAlertStats { date, ..DayAlertStats::default() }
        }
    }

    pub fn active_counts(&self) -> (usize, usize) {
        let mut p1 = 0;
        let mut p2 = 0;
        for record in self.state.incidents.values() {
            if matches!(record.phase, IncidentPhase::Firing { .. }) {
                match record.severity {
                    Severity::P1Critical => p1 += 1,
                    Severity::P2Warning => p2 += 1,
                    Severity::P3Info => {}
                }
            }
        }
        (p1, p2)
    }

    pub fn peek_deferred_p2(&self) -> Vec<DeferredP2> {
        self.state.deferred_p2.clone()
    }

    pub fn take_deferred_p2(&mut self) -> Vec<DeferredP2> {
        std::mem::take(&mut self.state.deferred_p2)
    }

    pub fn clear_deferred_p2(&mut self) {
        self.state.deferred_p2.clear();
    }

    pub fn deferred_p2_count(&self) -> usize {
        self.state.deferred_p2.len()
    }

    pub fn has_active(&self, fingerprint: &Fingerprint) -> bool {
        self.state.incidents.contains_key(fingerprint)
    }

    pub fn has_firing(&self, fingerprint: &Fingerprint) -> bool {
        self.state.incidents.get(fingerprint).is_some_and(|record| matches!(record.phase, IncidentPhase::Firing { .. }))
    }

    pub fn retire_silently(&mut self, fingerprint: &Fingerprint) -> bool {
        self.state.deferred_p2.retain(|item| &item.fingerprint != fingerprint);
        self.state.incidents.remove(fingerprint).is_some()
    }

    pub fn activate_deferred_p2(&mut self) {
        for record in self.state.incidents.values_mut() {
            if let IncidentPhase::Firing { deferred, .. } = &mut record.phase
                && *deferred
            {
                *deferred = false;
            }
        }
        self.state.deferred_p2.clear();
    }

    pub fn rollback_fired(&mut self, fingerprint: &Fingerprint) {
        self.state.incidents.remove(fingerprint);
    }

    pub fn rollback_escalation(&mut self, fingerprint: &Fingerprint) {
        if let Some(record) = self.state.incidents.get_mut(fingerprint) {
            record.severity = Severity::P2Warning;
        }
    }

    pub fn rollback_reminder(&mut self, fingerprint: &Fingerprint, previous_last_sent: i64) {
        if let Some(record) = self.state.incidents.get_mut(fingerprint)
            && let IncidentPhase::Firing { last_sent_at, reminders_sent, .. } = &mut record.phase
        {
            *last_sent_at = previous_last_sent;
            *reminders_sent = reminders_sent.saturating_sub(1);
        }
    }

    pub fn rollback_digest(&mut self, key: &str, previous_date: Option<u32>) {
        match previous_date {
            Some(date) => {
                self.state.digest_sent.insert(key.to_owned(), date);
            }
            None => {
                self.state.digest_sent.remove(key);
            }
        }
    }

    pub fn digest_date(&self, key: &str) -> Option<u32> {
        self.state.digest_sent.get(key).copied()
    }

    pub fn evaluate_immediate(&mut self, event: AlertEvent, ctx: MarketContext, now: KstTime) -> Vec<AlertDispatch> {
        self.ensure_day(ctx.date);
        let code = event.fingerprint.code;
        let saved = self.custom_policies.get(&code).copied();
        let mut policy = self.policy_for(code);
        policy.pending_secs = 0;
        self.custom_policies.insert(code, policy);
        let dispatches = self.evaluate(event, ctx, now);
        match saved {
            Some(old) => {
                self.custom_policies.insert(code, old);
            }
            None => {
                self.custom_policies.remove(&code);
            }
        }
        dispatches
    }

    pub fn record_stat_for_fired(&mut self, severity: Severity) {
        match severity {
            Severity::P1Critical => self.state.day_stats.p1_fired += 1,
            Severity::P2Warning => self.state.day_stats.p2_fired += 1,
            Severity::P3Info => {}
        }
    }

    pub fn evaluate(&mut self, event: AlertEvent, ctx: MarketContext, now: KstTime) -> Vec<AlertDispatch> {
        self.ensure_day(ctx.date);
        match event.signal {
            Signal::Active => self.on_active(event, ctx, now),
            Signal::Resolved => self.on_resolved(event, now),
        }
    }

    fn should_defer_p2(severity: Severity, ctx: MarketContext) -> bool {
        severity == Severity::P2Warning && ctx.is_quiet_hours()
    }

    fn is_silent_for(severity: Severity, ctx: MarketContext) -> bool {
        match severity {
            Severity::P1Critical => false,
            Severity::P2Warning => ctx.is_after_close_window() || ctx.is_quiet_hours(),
            Severity::P3Info => true,
        }
    }

    fn on_active(&mut self, event: AlertEvent, ctx: MarketContext, now: KstTime) -> Vec<AlertDispatch> {
        let now_unix = now.unix();
        let policy = self.policy_for(event.fingerprint.code);
        let key = event.fingerprint.clone();

        if let Some(existing) = self.state.incidents.get_mut(&key) {
            existing.title = event.title.clone();
            existing.summary = event.summary.clone();
            existing.metrics = event.metrics.clone();
            existing.impact = event.impact.clone();
            existing.action = event.action.clone();

            match &mut existing.phase {
                IncidentPhase::Pending { first_seen } => {
                    if event.severity > existing.severity {
                        existing.severity = event.severity;
                    }
                    let elapsed = now_unix.saturating_sub(*first_seen).max(0) as u64;
                    if elapsed >= policy.pending_secs {
                        let severity = existing.severity;
                        let deferred = Self::should_defer_p2(severity, ctx);
                        existing.phase = IncidentPhase::Firing {
                            fired_at: now_unix,
                            last_sent_at: now_unix,
                            reminders_sent: 0,
                            suppressed: 0,
                            deferred,
                        };
                        let record = existing.clone();
                        return self.finalize_firing(&record, deferred, DispatchKind::Fired, ctx, now);
                    }
                    return Vec::new();
                }
                IncidentPhase::Firing { last_sent_at, suppressed, deferred, .. } => {
                    if event.severity > existing.severity {
                        existing.severity = event.severity;
                        *last_sent_at = now_unix;
                        *deferred = false;
                        let record = existing.clone();
                        self.state.deferred_p2.retain(|item| item.fingerprint != key);
                        return self.finalize_firing(&record, false, DispatchKind::Escalated, ctx, now);
                    }
                    *suppressed += 1;
                    return Vec::new();
                }
            }
        }

        if policy.pending_secs > 0 {
            self.state.incidents.insert(
                key,
                IncidentRecord {
                    fingerprint: event.fingerprint,
                    severity: event.severity,
                    phase: IncidentPhase::Pending { first_seen: now_unix },
                    title: event.title,
                    summary: event.summary,
                    metrics: event.metrics,
                    impact: event.impact,
                    action: event.action,
                },
            );
            return Vec::new();
        }

        let deferred = Self::should_defer_p2(event.severity, ctx);
        let record = IncidentRecord {
            fingerprint: event.fingerprint,
            severity: event.severity,
            phase: IncidentPhase::Firing {
                fired_at: now_unix,
                last_sent_at: now_unix,
                reminders_sent: 0,
                suppressed: 0,
                deferred,
            },
            title: event.title,
            summary: event.summary,
            metrics: event.metrics,
            impact: event.impact,
            action: event.action,
        };
        self.state.incidents.insert(key, record.clone());
        self.finalize_firing(&record, deferred, DispatchKind::Fired, ctx, now)
    }

    fn finalize_firing(&mut self, record: &IncidentRecord, deferred: bool, kind: DispatchKind, ctx: MarketContext, now: KstTime) -> Vec<AlertDispatch> {
        self.record_stat_for_fired(record.severity);
        if deferred {
            if !self.state.deferred_p2.iter().any(|item| item.fingerprint == record.fingerprint) {
                self.state.deferred_p2.push(DeferredP2 {
                    fingerprint: record.fingerprint.clone(),
                    observed_at: now.unix(),
                    title: record.title.clone(),
                    summary: record.summary.clone(),
                });
            }
            return Vec::new();
        }
        vec![AlertDispatch {
            kind,
            fingerprint: record.fingerprint.clone(),
            severity: record.severity,
            title: record.title.clone(),
            summary: record.summary.clone(),
            metrics: record.metrics.clone(),
            impact: record.impact.clone(),
            action: record.action.clone(),
            observed_at: now,
            duration_secs: None,
            suppressed_count: 0,
            silent: Self::is_silent_for(record.severity, ctx),
        }]
    }

    fn on_resolved(&mut self, event: AlertEvent, now: KstTime) -> Vec<AlertDispatch> {
        let Some(existing) = self.state.incidents.remove(&event.fingerprint) else {
            return Vec::new();
        };
        self.state.deferred_p2.retain(|item| item.fingerprint != event.fingerprint);
        match existing.phase {
            IncidentPhase::Pending { .. } => Vec::new(),
            IncidentPhase::Firing { fired_at, suppressed, deferred, .. } => {
                self.state.day_stats.resolved += 1;
                if deferred {
                    return Vec::new();
                }
                let duration = now.unix().saturating_sub(fired_at).max(0) as u64;
                vec![AlertDispatch {
                    kind: DispatchKind::Resolved,
                    fingerprint: event.fingerprint,
                    severity: Severity::P3Info,
                    title: if event.title.is_empty() { existing.title } else { event.title },
                    summary: event.summary,
                    metrics: event.metrics,
                    impact: event.impact,
                    action: event.action,
                    observed_at: now,
                    duration_secs: Some(duration),
                    suppressed_count: suppressed,
                    silent: true,
                }]
            }
        }
    }

    pub fn tick(&mut self, ctx: MarketContext, now: KstTime) -> Vec<AlertDispatch> {
        self.ensure_day(ctx.date);
        let now_unix = now.unix();
        let keys: Vec<Fingerprint> = self.state.incidents.keys().cloned().collect();
        let mut dispatches = Vec::new();

        for key in keys {
            let policy = self.policy_for(key.code);
            let action = {
                let Some(record) = self.state.incidents.get_mut(&key) else { continue };
                match &mut record.phase {
                    IncidentPhase::Pending { first_seen } => {
                        let elapsed = now_unix.saturating_sub(*first_seen).max(0) as u64;
                        if elapsed >= policy.pending_secs {
                            let deferred = Self::should_defer_p2(record.severity, ctx);
                            record.phase = IncidentPhase::Firing {
                                fired_at: now_unix,
                                last_sent_at: now_unix,
                                reminders_sent: 0,
                                suppressed: 0,
                                deferred,
                            };
                            Some((record.clone(), deferred, DispatchKind::Fired, None, 0))
                        } else {
                            None
                        }
                    }
                    IncidentPhase::Firing { fired_at, last_sent_at, reminders_sent, suppressed, deferred } => {
                        let suppressed_count = *suppressed;
                        if record.severity == Severity::P2Warning
                            && let Some(limit) = policy.escalate_after_secs
                            && now_unix.saturating_sub(*fired_at).max(0) as u64 >= limit
                        {
                            record.severity = Severity::P1Critical;
                            *last_sent_at = now_unix;
                            *deferred = false;
                            let duration = now_unix.saturating_sub(*fired_at).max(0) as u64;
                            Some((record.clone(), false, DispatchKind::Escalated, Some(duration), suppressed_count))
                        } else if !*deferred && !policy.backoff_secs.is_empty() {
                            let idx = (*reminders_sent).min(policy.backoff_secs.len() - 1);
                            let wait = policy.backoff_secs[idx];
                            if now_unix.saturating_sub(*last_sent_at).max(0) as u64 >= wait {
                                *last_sent_at = now_unix;
                                *reminders_sent += 1;
                                let duration = now_unix.saturating_sub(*fired_at).max(0) as u64;
                                Some((record.clone(), false, DispatchKind::Reminder, Some(duration), suppressed_count))
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    }
                }
            };

            if let Some((record, deferred, kind, duration_secs, suppressed_count)) = action {
                match kind {
                    DispatchKind::Fired => {
                        dispatches.extend(self.finalize_firing(&record, deferred, DispatchKind::Fired, ctx, now));
                    }
                    DispatchKind::Escalated => {
                        self.state.deferred_p2.retain(|item| item.fingerprint != record.fingerprint);
                        self.record_stat_for_fired(Severity::P1Critical);
                        dispatches.push(AlertDispatch {
                            kind: DispatchKind::Escalated,
                            fingerprint: record.fingerprint,
                            severity: Severity::P1Critical,
                            title: record.title,
                            summary: record.summary,
                            metrics: record.metrics,
                            impact: record.impact,
                            action: record.action,
                            observed_at: now,
                            duration_secs,
                            suppressed_count,
                            silent: false,
                        });
                    }
                    DispatchKind::Reminder => {
                        dispatches.push(AlertDispatch {
                            kind: DispatchKind::Reminder,
                            fingerprint: record.fingerprint,
                            severity: record.severity,
                            title: record.title,
                            summary: record.summary,
                            metrics: record.metrics,
                            impact: record.impact,
                            action: record.action,
                            observed_at: now,
                            duration_secs,
                            suppressed_count,
                            silent: Self::is_silent_for(record.severity, ctx),
                        });
                    }
                    DispatchKind::Resolved | DispatchKind::Digest => {}
                }
            }
        }

        dispatches
    }

    pub fn emit_digest(&mut self, digest_key: &str, event: AlertEvent, ctx: MarketContext, now: KstTime) -> Option<AlertDispatch> {
        self.ensure_day(ctx.date);
        if ctx.observation == MarketObservation::NotObserved {
            return None;
        }
        if self.state.digest_sent.get(digest_key).copied() == Some(ctx.date) {
            return None;
        }
        self.state.digest_sent.insert(digest_key.to_owned(), ctx.date);
        Some(AlertDispatch {
            kind: DispatchKind::Digest,
            fingerprint: event.fingerprint,
            severity: Severity::P3Info,
            title: event.title,
            summary: event.summary,
            metrics: event.metrics,
            impact: event.impact,
            action: event.action,
            observed_at: now,
            duration_secs: None,
            suppressed_count: 0,
            silent: true,
        })
    }
}
