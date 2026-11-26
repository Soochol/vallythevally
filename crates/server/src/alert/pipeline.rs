use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use crate::clock::Clock;

use super::engine::{AlertEngine, AlertState, DayAlertStats, DeferredP2, IncidentPhase, IncidentRecord};
use super::format::{FormattedMessage, render_dispatch};
use super::model::{AlertCode, AlertEvent, DispatchKind, Fingerprint, MarketContext, PolicyRule};
use super::sink::AlertRouter;
use super::store::StateStore;

enum DeliveryEffect {
    UpsertIncident { record: IncidentRecord, kind: DispatchKind, previous_last_sent: Option<i64> },
    RemoveIncident(Fingerprint),
    RecordDigest { key: String, date: u32, previous_date: Option<u32>, clear_deferred_p2: bool },
}

struct DeliveryJob {
    message: FormattedMessage,
    effect: DeliveryEffect,
    day_stats: DayAlertStats,
    deferred_p2: Vec<DeferredP2>,
    on_delivered: Option<Box<dyn FnOnce() + Send>>,
}

enum PipelineJob {
    Deliver(Box<DeliveryJob>),
    SyncDeferred {
        incidents: Vec<IncidentRecord>,
        deferred_p2: Vec<DeferredP2>,
        day_stats: DayAlertStats,
    },
    RetireIncident {
        fingerprint: Fingerprint,
        deferred_p2: Vec<DeferredP2>,
    },
}

fn apply_delivered_effect(state: &mut AlertState, effect: &DeliveryEffect, day_stats: DayAlertStats, deferred_p2: &[DeferredP2]) {
    state.day_stats = day_stats;
    state.deferred_p2 = deferred_p2.to_vec();
    match effect {
        DeliveryEffect::UpsertIncident { record, .. } => {
            state.incidents.insert(record.fingerprint.clone(), record.clone());
        }
        DeliveryEffect::RemoveIncident(fingerprint) => {
            state.incidents.remove(fingerprint);
            state.deferred_p2.retain(|item| &item.fingerprint != fingerprint);
        }
        DeliveryEffect::RecordDigest { key, date, clear_deferred_p2, .. } => {
            state.digest_sent.insert(key.clone(), *date);
            if *clear_deferred_p2 {
                state.deferred_p2.clear();
                for record in state.incidents.values_mut() {
                    if let IncidentPhase::Firing { deferred, .. } = &mut record.phase
                        && *deferred
                    {
                        *deferred = false;
                    }
                }
            }
        }
    }
}

fn rollback_in_memory(engine: &Arc<Mutex<AlertEngine>>, effect: &DeliveryEffect) {
    let mut locked = engine.lock().expect("알림 엔진 롤백 잠금");
    match effect {
        DeliveryEffect::UpsertIncident { record, kind, previous_last_sent } => match kind {
            DispatchKind::Fired => locked.rollback_fired(&record.fingerprint),
            DispatchKind::Escalated => locked.rollback_escalation(&record.fingerprint),
            DispatchKind::Reminder => {
                if let Some(prev) = previous_last_sent {
                    locked.rollback_reminder(&record.fingerprint, *prev);
                }
            }
            DispatchKind::Resolved | DispatchKind::Digest => {}
        },
        DeliveryEffect::RecordDigest { key, previous_date, .. } => {
            locked.rollback_digest(key, *previous_date);
        }
        DeliveryEffect::RemoveIncident(_) => {}
    }
}

#[derive(Clone)]
pub struct AlertPipeline {
    engine: Arc<Mutex<AlertEngine>>,
    outbox: mpsc::UnboundedSender<PipelineJob>,
    clock: Clock,
}

impl AlertPipeline {
    pub fn spawn(router: AlertRouter, store: Option<StateStore>, clock: Clock) -> AlertPipeline {
        AlertPipeline::spawn_with_policies(router, store, clock, Vec::new())
    }

    pub fn spawn_with_policies(router: AlertRouter, store: Option<StateStore>, clock: Clock, policies: Vec<(AlertCode, PolicyRule)>) -> AlertPipeline {
        let mut delivered = store.as_ref().map_or_else(AlertState::default, StateStore::load);
        let mut engine = AlertEngine::restored(delivered.clone());
        for (code, rule) in policies {
            engine = engine.with_policy(code, rule);
        }
        let engine = Arc::new(Mutex::new(engine));
        let worker_engine = engine.clone();
        let (outbox, mut inbox) = mpsc::unbounded_channel::<PipelineJob>();
        tokio::spawn(async move {
            while let Some(job) = inbox.recv().await {
                match job {
                    PipelineJob::Deliver(delivery) => {
                        let DeliveryJob { message, effect, day_stats, deferred_p2, on_delivered } = *delivery;
                        let sent = router.deliver(&message).await;
                        if sent {
                            if let DeliveryEffect::RecordDigest { clear_deferred_p2: true, .. } = &effect {
                                worker_engine.lock().expect("알림 엔진 지연 해소 잠금").activate_deferred_p2();
                            }
                            apply_delivered_effect(&mut delivered, &effect, day_stats, &deferred_p2);
                            if let Some(store) = &store {
                                store.save(&delivered);
                            }
                            if let Some(callback) = on_delivered {
                                callback();
                            }
                        } else if let DeliveryEffect::RemoveIncident(fingerprint) = &effect {
                            delivered.incidents.remove(fingerprint);
                            delivered.deferred_p2.retain(|item| &item.fingerprint != fingerprint);
                            delivered.day_stats = day_stats;
                            if let Some(store) = &store {
                                store.save(&delivered);
                            }
                        } else {
                            rollback_in_memory(&worker_engine, &effect);
                        }
                    }
                    PipelineJob::SyncDeferred { incidents, deferred_p2, day_stats } => {
                        delivered.day_stats = day_stats;
                        delivered.deferred_p2 = deferred_p2;
                        for record in incidents {
                            delivered.incidents.insert(record.fingerprint.clone(), record);
                        }
                        if let Some(store) = &store {
                            store.save(&delivered);
                        }
                    }
                    PipelineJob::RetireIncident { fingerprint, deferred_p2 } => {
                        delivered.incidents.remove(&fingerprint);
                        delivered.deferred_p2 = deferred_p2;
                        if let Some(store) = &store {
                            store.save(&delivered);
                        }
                    }
                }
            }
        });
        AlertPipeline { engine, outbox, clock }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, AlertEngine> {
        self.engine.lock().expect("알림 엔진 잠금")
    }

    fn enqueue_dispatches(
        &self,
        dispatches: Vec<super::model::AlertDispatch>,
        snapshot: &AlertState,
        previous_last_sents: &std::collections::BTreeMap<Fingerprint, i64>,
        deferred_changed: bool,
    ) {
        if dispatches.is_empty() {
            if deferred_changed {
                let deferred_incidents: Vec<IncidentRecord> = snapshot
                    .incidents
                    .values()
                    .filter(|record| matches!(record.phase, IncidentPhase::Firing { deferred: true, .. }))
                    .cloned()
                    .collect();
                let _ = self.outbox.send(PipelineJob::SyncDeferred {
                    incidents: deferred_incidents,
                    deferred_p2: snapshot.deferred_p2.clone(),
                    day_stats: snapshot.day_stats,
                });
            }
            return;
        }
        for dispatch in dispatches {
            let effect = match dispatch.kind {
                DispatchKind::Resolved => DeliveryEffect::RemoveIncident(dispatch.fingerprint.clone()),
                DispatchKind::Fired | DispatchKind::Escalated | DispatchKind::Reminder => match snapshot.incidents.get(&dispatch.fingerprint) {
                    Some(record) => DeliveryEffect::UpsertIncident {
                        record: record.clone(),
                        kind: dispatch.kind,
                        previous_last_sent: previous_last_sents.get(&dispatch.fingerprint).copied(),
                    },
                    None => DeliveryEffect::RemoveIncident(dispatch.fingerprint.clone()),
                },
                DispatchKind::Digest => DeliveryEffect::RecordDigest {
                    key: dispatch.fingerprint.target.clone(),
                    date: snapshot.day_stats.date,
                    previous_date: None,
                    clear_deferred_p2: false,
                },
            };
            let message = render_dispatch(&dispatch);
            let _ = self.outbox.send(PipelineJob::Deliver(Box::new(DeliveryJob {
                message,
                effect,
                day_stats: snapshot.day_stats,
                deferred_p2: snapshot.deferred_p2.clone(),
                on_delivered: None,
            })));
        }
    }

    fn capture_last_sents(engine: &AlertEngine) -> std::collections::BTreeMap<Fingerprint, i64> {
        engine
            .snapshot()
            .incidents
            .into_iter()
            .filter_map(|(fp, record)| match record.phase {
                IncidentPhase::Firing { last_sent_at, .. } => Some((fp, last_sent_at)),
                IncidentPhase::Pending { .. } => None,
            })
            .collect()
    }

    pub fn emit(&self, event: AlertEvent, ctx: MarketContext) {
        let now = self.clock.now();
        let (dispatches, snapshot, previous_last_sents, deferred_changed) = {
            let mut engine = self.lock();
            let before_deferred = engine.peek_deferred_p2();
            let before_last_sents = Self::capture_last_sents(&engine);
            let dispatches = engine.evaluate(event, ctx, now);
            let snapshot = engine.snapshot();
            let deferred_changed = snapshot.deferred_p2 != before_deferred;
            (dispatches, snapshot, before_last_sents, deferred_changed)
        };
        self.enqueue_dispatches(dispatches, &snapshot, &previous_last_sents, deferred_changed);
    }

    pub fn emit_immediate(&self, event: AlertEvent, ctx: MarketContext) {
        let now = self.clock.now();
        let (dispatches, snapshot, previous_last_sents, deferred_changed) = {
            let mut engine = self.lock();
            let before_deferred = engine.peek_deferred_p2();
            let before_last_sents = Self::capture_last_sents(&engine);
            let dispatches = engine.evaluate_immediate(event, ctx, now);
            let snapshot = engine.snapshot();
            let deferred_changed = snapshot.deferred_p2 != before_deferred;
            (dispatches, snapshot, before_last_sents, deferred_changed)
        };
        self.enqueue_dispatches(dispatches, &snapshot, &previous_last_sents, deferred_changed);
    }

    pub fn tick(&self, ctx: MarketContext) {
        let now = self.clock.now();
        let (dispatches, snapshot, previous_last_sents, deferred_changed) = {
            let mut engine = self.lock();
            let before_deferred = engine.peek_deferred_p2();
            let before_last_sents = Self::capture_last_sents(&engine);
            let dispatches = engine.tick(ctx, now);
            let snapshot = engine.snapshot();
            let deferred_changed = snapshot.deferred_p2 != before_deferred;
            (dispatches, snapshot, before_last_sents, deferred_changed)
        };
        self.enqueue_dispatches(dispatches, &snapshot, &previous_last_sents, deferred_changed);
    }

    pub fn emit_digest(&self, digest_key: &str, event: AlertEvent, ctx: MarketContext) -> bool {
        self.emit_digest_with_options(digest_key, event, ctx, false, None)
    }

    pub fn emit_digest_clearing_deferred(&self, digest_key: &str, event: AlertEvent, ctx: MarketContext) -> bool {
        self.emit_digest_with_options(digest_key, event, ctx, true, None)
    }

    pub fn emit_digest_with_callback(
        &self,
        digest_key: &str,
        event: AlertEvent,
        ctx: MarketContext,
        on_delivered: Box<dyn FnOnce() + Send>,
    ) -> bool {
        self.emit_digest_with_options(digest_key, event, ctx, false, Some(on_delivered))
    }

    fn emit_digest_with_options(
        &self,
        digest_key: &str,
        event: AlertEvent,
        ctx: MarketContext,
        clear_deferred_p2: bool,
        on_delivered: Option<Box<dyn FnOnce() + Send>>,
    ) -> bool {
        let now = self.clock.now();
        let (dispatch, snapshot, previous_date) = {
            let mut engine = self.lock();
            let previous_date = engine.digest_date(digest_key);
            let dispatch = engine.emit_digest(digest_key, event, ctx, now);
            (dispatch, engine.snapshot(), previous_date)
        };
        if let Some(dispatch) = dispatch {
            let message = render_dispatch(&dispatch);
            let _ = self.outbox.send(PipelineJob::Deliver(Box::new(DeliveryJob {
                message,
                effect: DeliveryEffect::RecordDigest {
                    key: digest_key.to_owned(),
                    date: ctx.date,
                    previous_date,
                    clear_deferred_p2,
                },
                day_stats: snapshot.day_stats,
                deferred_p2: snapshot.deferred_p2,
                on_delivered,
            })));
            true
        } else {
            false
        }
    }

    pub fn retire_silently(&self, fingerprint: &Fingerprint) -> bool {
        let (removed, deferred_p2) = {
            let mut engine = self.lock();
            let removed = engine.retire_silently(fingerprint);
            (removed, engine.peek_deferred_p2())
        };
        if removed {
            let _ = self.outbox.send(PipelineJob::RetireIncident {
                fingerprint: fingerprint.clone(),
                deferred_p2,
            });
        }
        removed
    }

    pub fn peek_deferred_p2(&self) -> Vec<DeferredP2> {
        self.lock().peek_deferred_p2()
    }

    pub fn take_deferred_p2(&self) -> Vec<DeferredP2> {
        self.lock().take_deferred_p2()
    }

    pub fn deferred_p2_count(&self) -> usize {
        self.lock().deferred_p2_count()
    }

    pub fn active_counts(&self) -> (usize, usize) {
        self.lock().active_counts()
    }

    pub fn has_active(&self, fingerprint: &Fingerprint) -> bool {
        self.lock().has_active(fingerprint)
    }

    pub fn has_firing(&self, fingerprint: &Fingerprint) -> bool {
        self.lock().has_firing(fingerprint)
    }

    pub fn day_stats(&self, date: u32) -> DayAlertStats {
        self.lock().day_stats(date)
    }

    pub fn active_fingerprints(&self) -> Vec<Fingerprint> {
        self.lock().snapshot().incidents.keys().cloned().collect()
    }
}
