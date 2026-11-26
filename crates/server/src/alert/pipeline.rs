use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use crate::clock::Clock;

use super::engine::{AlertEngine, AlertState, DayAlertStats, DeferredP2, IncidentRecord};
use super::format::{FormattedMessage, render_dispatch};
use super::model::{AlertCode, AlertEvent, DispatchKind, Fingerprint, MarketContext, PolicyRule};
use super::sink::AlertRouter;
use super::store::StateStore;

enum DeliveryEffect {
    UpsertIncident(IncidentRecord),
    RemoveIncident(Fingerprint),
    RecordDigest { key: String, date: u32 },
}

struct QueuedDelivery {
    message: FormattedMessage,
    effect: DeliveryEffect,
    day_stats: DayAlertStats,
    deferred_p2: Vec<DeferredP2>,
}

fn apply_effect(state: &mut AlertState, item: &QueuedDelivery) {
    state.day_stats = item.day_stats;
    state.deferred_p2 = item.deferred_p2.clone();
    match &item.effect {
        DeliveryEffect::UpsertIncident(record) => {
            state.incidents.insert(record.fingerprint.clone(), record.clone());
        }
        DeliveryEffect::RemoveIncident(fingerprint) => {
            state.incidents.remove(fingerprint);
        }
        DeliveryEffect::RecordDigest { key, date } => {
            state.digest_sent.insert(key.clone(), *date);
        }
    }
}

#[derive(Clone)]
pub struct AlertPipeline {
    engine: Arc<Mutex<AlertEngine>>,
    outbox: mpsc::UnboundedSender<QueuedDelivery>,
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
        let (outbox, mut inbox) = mpsc::unbounded_channel::<QueuedDelivery>();
        tokio::spawn(async move {
            while let Some(item) = inbox.recv().await {
                if router.deliver(&item.message).await {
                    apply_effect(&mut delivered, &item);
                    if let Some(store) = &store {
                        store.save(&delivered);
                    }
                }
            }
        });
        AlertPipeline { engine, outbox, clock }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, AlertEngine> {
        self.engine.lock().expect("알림 엔진 잠금")
    }

    fn enqueue_dispatches(&self, dispatches: Vec<super::model::AlertDispatch>, snapshot: &AlertState) {
        for dispatch in dispatches {
            let effect = match dispatch.kind {
                DispatchKind::Resolved => DeliveryEffect::RemoveIncident(dispatch.fingerprint.clone()),
                DispatchKind::Fired | DispatchKind::Escalated | DispatchKind::Reminder => match snapshot.incidents.get(&dispatch.fingerprint) {
                    Some(record) => DeliveryEffect::UpsertIncident(record.clone()),
                    None => DeliveryEffect::RemoveIncident(dispatch.fingerprint.clone()),
                },
                DispatchKind::Digest => DeliveryEffect::RecordDigest { key: dispatch.fingerprint.target.clone(), date: snapshot.day_stats.date },
            };
            let message = render_dispatch(&dispatch);
            let _ = self.outbox.send(QueuedDelivery {
                message,
                effect,
                day_stats: snapshot.day_stats,
                deferred_p2: snapshot.deferred_p2.clone(),
            });
        }
    }

    pub fn emit(&self, event: AlertEvent, ctx: MarketContext) {
        let now = self.clock.now();
        let (dispatches, snapshot) = {
            let mut engine = self.lock();
            let dispatches = engine.evaluate(event, ctx, now);
            (dispatches, engine.snapshot())
        };
        self.enqueue_dispatches(dispatches, &snapshot);
    }

    pub fn tick(&self, ctx: MarketContext) {
        let now = self.clock.now();
        let (dispatches, snapshot) = {
            let mut engine = self.lock();
            let dispatches = engine.tick(ctx, now);
            (dispatches, engine.snapshot())
        };
        self.enqueue_dispatches(dispatches, &snapshot);
    }

    pub fn emit_digest(&self, digest_key: &str, event: AlertEvent, ctx: MarketContext) -> bool {
        let now = self.clock.now();
        let (dispatch, snapshot) = {
            let mut engine = self.lock();
            let dispatch = engine.emit_digest(digest_key, event, ctx, now);
            (dispatch, engine.snapshot())
        };
        if let Some(dispatch) = dispatch {
            let message = render_dispatch(&dispatch);
            let _ = self.outbox.send(QueuedDelivery {
                message,
                effect: DeliveryEffect::RecordDigest { key: digest_key.to_owned(), date: ctx.date },
                day_stats: snapshot.day_stats,
                deferred_p2: snapshot.deferred_p2,
            });
            true
        } else {
            false
        }
    }

    pub fn take_deferred_p2(&self) -> Vec<DeferredP2> {
        self.lock().take_deferred_p2()
    }

    pub fn active_counts(&self) -> (usize, usize) {
        self.lock().active_counts()
    }

    pub fn has_active(&self, fingerprint: &Fingerprint) -> bool {
        self.lock().has_active(fingerprint)
    }

    pub fn day_stats(&self, date: u32) -> DayAlertStats {
        self.lock().day_stats(date)
    }

    pub fn active_fingerprints(&self) -> Vec<Fingerprint> {
        self.lock().snapshot().incidents.keys().cloned().collect()
    }
}
