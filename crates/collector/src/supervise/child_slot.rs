use std::time::Duration;

use tokio::sync::mpsc;
use tokio::time::{Instant, sleep_until};

use super::process::{ChildMessage, ChildProcess, Spawned};
use super::settings::Settings;
use super::status::KeyState;
use crate::protocol::{Command, KeyName};

pub(super) const HASH_PREFIX_LEN: usize = 8;

pub(super) fn hash_prefix(app_key_hash: &str) -> String {
    app_key_hash.strip_prefix("sha256:").unwrap_or(app_key_hash).chars().take(HASH_PREFIX_LEN).collect()
}

pub(super) async fn sleep_until_option(at: Option<Instant>) {
    match at {
        Some(at) => sleep_until(at).await,
        None => std::future::pending().await,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SlotTimer {
    Launch,
    HeartbeatLost(Duration),
    Killed,
    Nothing,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum GoneOutcome<S> {
    Stop(S),
    Backoff { restart: u32, delay: Duration },
}

struct RetiringChild<S> {
    stop: Option<S>,
    kill_at: Instant,
    killed: bool,
}

struct RunningChild<S> {
    process: Box<dyn ChildProcess>,
    last_heard: Instant,
    said_hello: bool,
    retiring: Option<RetiringChild<S>>,
}

enum ChildPhase<S> {
    Backoff { until: Instant },
    Running(RunningChild<S>),
    Stopped,
}

pub(super) struct ChildSlot<S> {
    phase: ChildPhase<S>,
    incarnation: u64,
    restarts: u32,
}

impl<S> ChildSlot<S> {
    pub(super) fn new(start_at: Instant) -> ChildSlot<S> {
        ChildSlot { phase: ChildPhase::Backoff { until: start_at }, incarnation: 0, restarts: 0 }
    }

    pub(super) fn restarts(&self) -> u32 {
        self.restarts
    }

    pub(super) fn is_running(&self) -> bool {
        matches!(self.phase, ChildPhase::Running(_))
    }

    pub(super) fn is_stopped(&self) -> bool {
        matches!(self.phase, ChildPhase::Stopped)
    }

    pub(super) fn matches_incarnation(&self, incarnation: u64) -> bool {
        self.is_running() && self.incarnation == incarnation
    }

    pub(super) fn next_deadline(&self, heartbeat_timeout: Duration) -> Option<Instant> {
        match &self.phase {
            ChildPhase::Backoff { until } => Some(*until),
            ChildPhase::Running(running) => match &running.retiring {
                Some(retiring) if !retiring.killed => Some(retiring.kill_at),
                Some(_) => None,
                None => Some(running.last_heard + heartbeat_timeout),
            },
            ChildPhase::Stopped => None,
        }
    }

    pub(super) fn poll_timer(&mut self, now: Instant, heartbeat_timeout: Duration) -> SlotTimer {
        match &mut self.phase {
            ChildPhase::Backoff { until } if *until <= now => SlotTimer::Launch,
            ChildPhase::Running(running) => match &mut running.retiring {
                Some(retiring) if !retiring.killed && retiring.kill_at <= now => {
                    running.process.kill();
                    retiring.killed = true;
                    SlotTimer::Killed
                }
                None if running.last_heard + heartbeat_timeout <= now => SlotTimer::HeartbeatLost(now - running.last_heard),
                _ => SlotTimer::Nothing,
            },
            _ => SlotTimer::Nothing,
        }
    }

    pub(super) fn attach_spawned<M: Send + 'static>(
        &mut self,
        mut spawned: Spawned,
        now: Instant,
        inbox: &mpsc::UnboundedSender<M>,
        wrap: impl Fn(u64, ChildMessage) -> M + Send + 'static,
    ) -> (Option<u32>, u32) {
        self.incarnation += 1;
        let incarnation = self.incarnation;
        let restarts = self.restarts;
        let pid = spawned.pid;
        self.phase = ChildPhase::Running(RunningChild {
            process: spawned.process,
            last_heard: now,
            said_hello: false,
            retiring: None,
        });
        let inbox = inbox.clone();
        tokio::spawn(async move {
            while let Some(message) = spawned.messages.recv().await {
                if inbox.send(wrap(incarnation, message)).is_err() {
                    return;
                }
            }
        });
        (pid, restarts)
    }

    pub(super) fn mark_hello(&mut self, now: Instant) {
        if let ChildPhase::Running(running) = &mut self.phase {
            running.said_hello = true;
            running.last_heard = now;
        }
    }

    pub(super) fn touch(&mut self, now: Instant) {
        if let ChildPhase::Running(running) = &mut self.phase {
            running.last_heard = now;
        }
    }

    pub(super) fn is_ready(&self) -> bool {
        matches!(&self.phase, ChildPhase::Running(running) if running.said_hello && running.retiring.is_none())
    }

    pub(super) fn send_if_ready(&mut self, command: &Command) -> bool {
        let ChildPhase::Running(running) = &mut self.phase else { return false };
        if !running.said_hello || running.retiring.is_some() {
            return false;
        }
        running.process.send(command);
        true
    }

    pub(super) fn retire(&mut self, stop: Option<S>, now: Instant, grace: Duration) {
        let ChildPhase::Running(running) = &mut self.phase else { return };
        match &mut running.retiring {
            None => {
                running.process.terminate();
                running.retiring = Some(RetiringChild { stop, kill_at: now + grace, killed: false });
            }
            Some(retiring) if stop.is_some() && retiring.stop.is_none() => retiring.stop = stop,
            Some(_) => {}
        }
    }

    pub(super) fn take_exit(&mut self) -> Option<Option<S>> {
        if !self.is_running() {
            return None;
        }
        let ChildPhase::Running(running) = std::mem::replace(&mut self.phase, ChildPhase::Stopped) else { return None };
        Some(running.retiring.and_then(|retiring| retiring.stop))
    }

    pub(super) fn on_gone(&mut self, stop: Option<S>, now: Instant, settings: &Settings, restart_limit_stop: S) -> GoneOutcome<S> {
        match stop {
            Some(reason) => {
                self.phase = ChildPhase::Stopped;
                GoneOutcome::Stop(reason)
            }
            None if self.restarts >= settings.restart_limit => {
                self.phase = ChildPhase::Stopped;
                GoneOutcome::Stop(restart_limit_stop)
            }
            None => {
                let delay = settings.restart_delay(self.restarts);
                self.restarts += 1;
                self.phase = ChildPhase::Backoff { until: now + delay };
                GoneOutcome::Backoff { restart: self.restarts, delay }
            }
        }
    }

    pub(super) fn stop(&mut self) {
        self.phase = ChildPhase::Stopped;
    }

    pub(super) fn can_accept_work(&self) -> bool {
        match &self.phase {
            ChildPhase::Backoff { .. } => true,
            ChildPhase::Running(running) => running.retiring.as_ref().is_none_or(|retiring| retiring.stop.is_none()),
            ChildPhase::Stopped => false,
        }
    }

    pub(super) fn key_state(&self, receiving: bool, down: bool, has_token: bool) -> KeyState {
        match &self.phase {
            ChildPhase::Stopped => KeyState::Stopped,
            ChildPhase::Backoff { .. } if self.incarnation > 0 => KeyState::Disconnected,
            ChildPhase::Backoff { .. } => KeyState::Waiting,
            ChildPhase::Running(running) if running.retiring.is_some() || down => KeyState::Disconnected,
            ChildPhase::Running(_) if receiving => KeyState::Receiving,
            ChildPhase::Running(_) if !has_token => KeyState::Waiting,
            ChildPhase::Running(_) => KeyState::Connecting,
        }
    }

    pub(super) fn send_shutdown(&mut self) {
        if let ChildPhase::Running(running) = &mut self.phase {
            running.process.send(&Command::Shutdown);
        }
    }

    pub(super) fn terminate_running(&mut self) {
        if let ChildPhase::Running(running) = &mut self.phase {
            running.process.terminate();
        }
    }

    pub(super) fn kill_running(&mut self) {
        if let ChildPhase::Running(running) = &mut self.phase {
            running.process.kill();
        }
    }
}

pub(super) trait SupervisedSlot {
    type Stop;

    fn name(&self) -> KeyName;
    fn slot(&self) -> &ChildSlot<Self::Stop>;
    fn slot_mut(&mut self) -> &mut ChildSlot<Self::Stop>;
}

pub(super) fn next_slot_deadline<K: SupervisedSlot>(slots: &[K], heartbeat_timeout: Duration) -> Option<Instant> {
    slots.iter().filter_map(|item| item.slot().next_deadline(heartbeat_timeout)).min()
}

pub(super) async fn shut_down_slots<K: SupervisedSlot, M>(
    slots: &mut [K],
    inbox: &mut mpsc::UnboundedReceiver<M>,
    extract_exit: impl Fn(M) -> Option<(usize, u64, Option<i32>)>,
    grace: Duration,
    mut on_exit: impl FnMut(KeyName, Option<i32>),
    timeout_message: &str,
) {
    for item in slots.iter_mut() {
        item.slot_mut().send_shutdown();
    }
    let mut stage = 0;
    let mut deadline = Instant::now() + grace;
    while slots.iter().any(|item| item.slot().is_running()) {
        tokio::select! {
            Some(inbound) = inbox.recv() => {
                if let Some((index, incarnation, code)) = extract_exit(inbound)
                    && slots[index].slot().matches_incarnation(incarnation)
                {
                    let key = slots[index].name();
                    slots[index].slot_mut().stop();
                    on_exit(key, code);
                }
            }
            () = sleep_until(deadline) => {
                stage += 1;
                deadline = Instant::now() + grace;
                for item in slots.iter_mut() {
                    match stage {
                        1 => item.slot_mut().terminate_running(),
                        2 => item.slot_mut().kill_running(),
                        _ => {}
                    }
                }
                if stage > 2 {
                    tracing::error!("{timeout_message}");
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Default)]
    struct FakeState {
        sent: Vec<String>,
        terminated: u32,
        killed: u32,
    }

    struct FakeProcess(Arc<Mutex<FakeState>>);

    impl ChildProcess for FakeProcess {
        fn send(&mut self, command: &Command) {
            let label = match command {
                Command::Token { generation, .. } => format!("token:{generation}"),
                Command::Shutdown => "shutdown".to_owned(),
                Command::Register(_) => "register".to_owned(),
                Command::Unregister(_) => "unregister".to_owned(),
                Command::Assign { .. } => "assign".to_owned(),
            };
            self.0.lock().unwrap().sent.push(label);
        }

        fn terminate(&mut self) {
            self.0.lock().unwrap().terminated += 1;
        }

        fn kill(&mut self) {
            self.0.lock().unwrap().killed += 1;
        }
    }

    fn fake_spawned() -> (Spawned, Arc<Mutex<FakeState>>, mpsc::UnboundedSender<ChildMessage>) {
        let state = Arc::new(Mutex::new(FakeState::default()));
        let (tx, rx) = mpsc::unbounded_channel();
        let spawned = Spawned { pid: Some(42), process: Box::new(FakeProcess(state.clone())), messages: rx };
        (spawned, state, tx)
    }

    #[tokio::test(start_paused = true)]
    async fn send_if_ready_blocks_before_hello_and_while_retiring() {
        let now = Instant::now();
        let mut slot: ChildSlot<&'static str> = ChildSlot::new(now);
        let (spawned, state, _tx) = fake_spawned();
        let (inbox, _rx) = mpsc::unbounded_channel();
        slot.attach_spawned(spawned, now, &inbox, |inc, msg| (inc, msg));

        let cmd = Command::Token { token: server::config::Secret::new("t".to_owned()), generation: 1, expires_at: None };
        assert!(!slot.send_if_ready(&cmd));

        slot.mark_hello(now);
        assert!(slot.send_if_ready(&cmd));
        assert_eq!(state.lock().unwrap().sent, ["token:1"]);

        slot.retire(None, now, Duration::from_secs(5));
        assert!(!slot.is_ready());
        assert!(!slot.send_if_ready(&cmd));
        assert_eq!(state.lock().unwrap().sent, ["token:1"]);
        assert_eq!(state.lock().unwrap().terminated, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn retire_upgrades_restart_to_stop_and_kills_once_after_grace() {
        let now = Instant::now();
        let mut slot: ChildSlot<&'static str> = ChildSlot::new(now);
        let (spawned, state, _tx) = fake_spawned();
        let (inbox, _rx) = mpsc::unbounded_channel();
        slot.attach_spawned(spawned, now, &inbox, |inc, msg| (inc, msg));

        slot.retire(None, now, Duration::from_secs(5));
        slot.retire(Some("halted"), now + Duration::from_secs(1), Duration::from_secs(5));
        slot.retire(Some("later"), now + Duration::from_secs(2), Duration::from_secs(5));
        assert_eq!(state.lock().unwrap().terminated, 1);

        assert_eq!(slot.poll_timer(now + Duration::from_secs(4), Duration::from_secs(30)), SlotTimer::Nothing);
        assert_eq!(slot.poll_timer(now + Duration::from_secs(5), Duration::from_secs(30)), SlotTimer::Killed);
        assert_eq!(state.lock().unwrap().killed, 1);
        assert_eq!(slot.poll_timer(now + Duration::from_secs(6), Duration::from_secs(30)), SlotTimer::Nothing);
        assert_eq!(slot.take_exit(), Some(Some("halted")));
    }

    #[tokio::test(start_paused = true)]
    async fn on_gone_backs_off_until_restart_limit_is_reached() {
        let now = Instant::now();
        let settings = Settings { restart_limit: 2, ..Settings::default() };
        let mut slot: ChildSlot<&'static str> = ChildSlot::new(now);

        assert!(matches!(slot.on_gone(None, now, &settings, "limit"), GoneOutcome::Backoff { restart: 1, .. }));
        assert!(matches!(slot.on_gone(None, now, &settings, "limit"), GoneOutcome::Backoff { restart: 2, .. }));
        assert_eq!(slot.on_gone(None, now, &settings, "limit"), GoneOutcome::Stop("limit"));
        assert!(slot.is_stopped());
    }

    struct Entry {
        name: KeyName,
        slot: ChildSlot<()>,
    }

    impl SupervisedSlot for Entry {
        type Stop = ();

        fn name(&self) -> KeyName {
            self.name.clone()
        }

        fn slot(&self) -> &ChildSlot<()> {
            &self.slot
        }

        fn slot_mut(&mut self) -> &mut ChildSlot<()> {
            &mut self.slot
        }
    }

    #[tokio::test(start_paused = true)]
    async fn shut_down_slots_escalates_shutdown_terminate_kill_and_ignores_stale_incarnation() {
        let now = Instant::now();
        let (spawned, state, _child_tx) = fake_spawned();
        let (inbox, mut inbox_rx) = mpsc::unbounded_channel();
        let mut entry = Entry { name: KeyName::parse("k1").unwrap(), slot: ChildSlot::new(now) };
        entry.slot.attach_spawned(spawned, now, &inbox, |inc, msg| (0usize, inc, msg));
        let mut slots = vec![entry];

        let _ = inbox.send((0, 999, ChildMessage::Exited(Some(0))));

        let mut exited = Vec::new();
        shut_down_slots(
            &mut slots,
            &mut inbox_rx,
            |(index, inc, msg)| match msg {
                ChildMessage::Exited(code) => Some((index, inc, code)),
                _ => None,
            },
            Duration::from_secs(2),
            |name, code| exited.push((name, code)),
            "timeout",
        )
        .await;

        assert!(exited.is_empty());
        let state = state.lock().unwrap();
        assert_eq!(state.sent, ["shutdown"]);
        assert_eq!(state.terminated, 1);
        assert_eq!(state.killed, 1);
    }
}
