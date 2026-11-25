use std::collections::BTreeMap;

use domain::{IndexCode, KstTime, TimeOfDay};
use serde::Deserialize;
use server::config::Secret;
use server::kiwoom::api::IndexDailyChart;
use server::kiwoom::rest::{MergeScope, Priority};
use server::kiwoom::wire::index_days;
use tokio::sync::watch;

use super::rest::RestSession;
use super::{Daemon, DayEnd, DayRun, Halt, StageResult, date_number, stoppable};
use crate::calendar::{
    CachedHolidaysOnly, Calendar, CrossCheck, DEFAULT_OPEN_MINUTE, Day, Judgment, Mismatch, Verdict, cross_check, read_service_key,
};
use crate::finalize::{COMPLETE_FILE_NAME, IndexCheckResult, JudgedVerdict, TreatedAs, missing_closed_quote_days, raw_days_without_complete, store_dir};
use crate::shared::Reload;
use crate::plan::{PlanFile, PlanInput, build_plan, plan_path, write_plan};
use crate::raw_write::raw_day_dir;
use crate::supervise::daemon::{Injected, Inputs, Supervisor, load_plan};
use crate::supervise::journal::{JournalEvent, has_event, journal_path};
use crate::supervise::shared::{SharedInjected, SharedInputs, SharedSupervisor};
use crate::supervise::settings::{MarketOpenCheck, Settings};
use crate::supervise::status::{AlertKind, DayPhase, ObservationDay, ObservationVerdict};
use crate::turnover::{TurnoverFile, collect_turnover, latest_turnover, turnover_path};
use crate::universe::{Morning, UniverseFile, after_close_path, collect_after_close, collect_morning, read_universe_if_present};

const FINALIZE_RETRY_NOTE: &str = "같은 날 안에는 다시 하지 않고, 다음 정리 기회(다음 날 시작이나 다음 데몬 시작)에 정리가 안 끝난 날로 다시 시도합니다";

#[derive(Deserialize)]
struct PreviousComplete {
    stocks: Vec<PreviousStock>,
}

#[derive(Deserialize)]
struct PreviousStock {
    code: String,
    messages: u64,
}

struct Summary {
    verdict: JudgedVerdict,
    open_minute: Option<u16>,
    treated_as: TreatedAs,
}

fn summarize(judgment: &Judgment) -> Summary {
    match judgment.verdict {
        Verdict::Observed { open_minute } => Summary { verdict: JudgedVerdict::Observed, open_minute: Some(open_minute), treated_as: TreatedAs::Observed },
        Verdict::Closed => Summary { verdict: JudgedVerdict::Closed, open_minute: None, treated_as: TreatedAs::Closed },
        Verdict::Unknown => Summary { verdict: JudgedVerdict::Unknown, open_minute: None, treated_as: TreatedAs::Observed },
    }
}

fn mismatch_text(mismatch: Mismatch) -> &'static str {
    match mismatch {
        Mismatch::ObservedWithoutIndexCandle => "관측일로 판단했는데 코스피 지수 일봉에 그날 봉이 없습니다",
        Mismatch::ClosedWithIndexCandle => "쉬는 날로 판단했는데 코스피 지수 일봉에 그날 봉이 있습니다",
    }
}

fn kst_of(time: KstTime) -> crate::kst::KstTime {
    crate::kst::KstTime::from_unix_ms(time.unix() * 1000)
}

fn minute_time(day: domain::KstDate, minute: u16) -> KstTime {
    KstTime::from_kst_civil(day, TimeOfDay::hms(u32::from(minute) / 60, u32::from(minute) % 60, 0).expect("분은 하루 안이다"))
}

impl Daemon {
    pub(super) async fn judge(&mut self, day: &mut DayRun, shutdown: &mut watch::Receiver<bool>) -> Result<(), DayEnd> {
        let (service_key, cached_only) = match read_service_key(&self.holiday_key_path) {
            Ok(key) => (key, false),
            Err(error) => {
                self.reporter.alert(AlertKind::StageFailed, format!("특일정보 서비스 키를 읽지 못해 캐시만 씁니다: {error}"));
                (Secret::new(String::new()), true)
            }
        };
        let now_ms = self.clock.now().unix() * 1000;
        let (data_dir, holidays) = (self.data_dir.clone(), self.holidays.clone());
        let loading = async move {
            if cached_only {
                Calendar::load(&data_dir, &CachedHolidaysOnly, &service_key, now_ms).await
            } else {
                Calendar::load(&data_dir, holidays.as_ref(), &service_key, now_ms).await
            }
        };
        let calendar = stoppable(shutdown, loading).await.map_err(|_| DayEnd::Stopped)?;
        let calendar_day = Day::from_yyyymmdd(day.date).expect("오늘 날짜는 달력에 있다");
        let judgment = calendar.judge(calendar_day);
        let summary = summarize(&judgment);
        day.journal.append(
            self.clock.now(),
            &JournalEvent::ObservationJudged {
                day: day.date,
                verdict: summary.verdict,
                open_minute: summary.open_minute,
                treated_as: summary.treated_as,
                evidence: judgment.evidence.clone(),
            },
        );
        let mut reasons: Vec<String> = judgment.evidence.iter().map(|evidence| evidence.detail.clone()).collect();
        let (status_verdict, closed) = match judgment.verdict {
            Verdict::Observed { .. } => (ObservationVerdict::Observed, false),
            Verdict::Closed => (ObservationVerdict::NotObserved, true),
            Verdict::Unknown => {
                let unknown: Vec<&str> = judgment.evidence.iter().filter(|evidence| evidence.finding == crate::calendar::Finding::Unknown).map(|evidence| evidence.detail.as_str()).collect();
                self.reporter.alert(AlertKind::ObservationUnknown, format!("관측일인지 알 수 없어 관측일로 보고 돌립니다: {}", unknown.join("; ")));
                reasons.push("관측일로 보고 돌린다".to_owned());
                (ObservationVerdict::Unknown, false)
            }
        };
        self.reporter.observation_day(ObservationDay { verdict: status_verdict, reasons });
        day.open_minute = summary.open_minute.or_else(|| (!closed).then(|| calendar.open_minute_of(calendar_day)));
        day.calendar = Some(calendar);
        day.judgment = Some(judgment);
        if closed {
            return Err(DayEnd::Done);
        }
        if !self.rest_key().1 {
            self.reporter.alert(AlertKind::PlanNote, "예비 키가 없어 첫 활성 키로 REST를 부릅니다".to_owned());
        }
        Ok(())
    }

    pub(super) async fn morning_universe(&mut self, day: &mut DayRun, shutdown: &mut watch::Receiver<bool>) -> Result<Option<UniverseFile>, DayEnd> {
        let existing = read_universe_if_present(&self.data_dir, day.date).ok().flatten();
        let universe = match existing {
            Some(file) => Some(file),
            None if plan_path(&self.data_dir, day.date).exists() => None,
            None => {
                let fetched = self.fetch_morning(day, shutdown).await;
                let morning = self.soft("종목 목록", fetched)?.ok_or(DayEnd::Done)?;
                if let Some(moved) = &morning.moved_aside {
                    let message = format!(
                        "종목 목록: 읽을 수 없는 그날 목록 파일을 {}로 옮기고 {}의 목록으로 대체했습니다: {}",
                        moved.path.display(),
                        morning.file.replaced.as_ref().map_or(0, |replaced| replaced.source_date),
                        moved.cause
                    );
                    self.reporter.alert(AlertKind::StageFailed, message);
                }
                Some(morning.file)
            }
        };
        if let Some(file) = &universe {
            self.reporter.universe_changes(file.diff.clone());
        }
        Ok(universe)
    }

    async fn fetch_morning(&self, day: &DayRun, shutdown: &mut watch::Receiver<bool>) -> StageResult<Morning> {
        let session = self.open_rest(shutdown).await?;
        let collected = collect_morning(session.rest(), &self.data_dir, day.date, kst_of(self.clock.now()));
        let morning = stoppable(shutdown, collected).await?.map_err(|error| Halt::Failed(error.to_string()))?;
        Ok(morning)
    }

    pub(super) fn reload_shared_assignment(&mut self) {
        let Some(shared) = &mut self.shared else { return };
        let outcome = shared.store.reload(&self.rest_keys);
        match outcome {
            Reload::NoFile | Reload::Loaded => {}
            Reload::KeptPrevious(error) => self.reporter.alert(AlertKind::StageFailed, format!("키 배정표를 읽지 못해 전날 배정을 씁니다: {error}")),
            Reload::Unusable(error) => self.reporter.alert(AlertKind::StageFailed, format!("키 배정표를 읽지 못해 공용 자료 일을 돌리지 않습니다: {error}")),
        }
    }

    fn start_shared(&mut self, day: &DayRun, settings: &Settings) -> Option<SharedSupervisor> {
        let shared = self.shared.as_ref()?;
        let assignment = shared.store.current().filter(|assignment| !assignment.is_empty())?.clone();
        let inputs = SharedInputs { keys: self.rest_keys.clone(), assignment, date: day.date, data_dir: self.data_dir.clone(), settings: settings.clone() };
        let injected = SharedInjected { launcher: self.launcher.clone(), transport: self.transport.clone(), kis_transport: shared.kis_transport.clone(), clock: self.clock.clone() };
        match SharedSupervisor::start(inputs, injected) {
            Ok(supervisor) => Some(supervisor),
            Err(error) => {
                self.reporter.alert(AlertKind::StageFailed, format!("공용 자료 자식 띄우기: {error}"));
                None
            }
        }
    }

    pub(super) fn plan(&mut self, day: &DayRun, universe: Option<UniverseFile>) -> Result<PlanFile, DayEnd> {
        let built = self.plan_file(day, universe.as_ref());
        self.soft("계획", built)?.ok_or(DayEnd::Done)
    }

    fn plan_file(&self, day: &DayRun, universe: Option<&UniverseFile>) -> StageResult<PlanFile> {
        let failed = |error: &dyn std::fmt::Display| Halt::Failed(error.to_string());
        if plan_path(&self.data_dir, day.date).exists() {
            return load_plan(&self.data_dir, day.date).map_err(|error| failed(&error));
        }
        let universe = universe.ok_or_else(|| Halt::Failed("종목 목록이 없어 계획을 세울 수 없습니다".to_owned()))?;
        let identities: Vec<_> = self.keys.iter().map(|key| key.identity.clone()).collect();
        let previous_messages = self.previous_messages(day);
        let turnover = self.recent_turnover(day);
        let plan = build_plan(&PlanInput {
            date: day.date,
            created_at: kst_of(self.clock.now()),
            keys: &identities,
            universe,
            previous_messages: &previous_messages,
            turnover: turnover.as_ref().map(|file| &file.traded_million_won),
        })
        .map_err(|error| failed(&error))?;
        match write_plan(&self.data_dir, &plan) {
            Ok(()) => Ok(plan),
            Err(crate::plan::PlanError::AlreadyExists { .. }) => load_plan(&self.data_dir, day.date).map_err(|error| failed(&error)),
            Err(error) => Err(failed(&error)),
        }
    }

    fn recent_turnover(&self, day: &DayRun) -> Option<TurnoverFile> {
        let today = Day::from_yyyymmdd(day.date)?;
        let oldest = day
            .calendar
            .as_ref()
            .and_then(|calendar| calendar.observation_days_before(today, 3).ok())
            .unwrap_or_else(|| today.plus_days(-10))
            .yyyymmdd();
        latest_turnover(&self.data_dir, oldest, day.date)
    }

    fn previous_messages(&self, day: &DayRun) -> BTreeMap<String, u64> {
        let previous = day
            .calendar
            .as_ref()
            .zip(Day::from_yyyymmdd(day.date))
            .and_then(|(calendar, today)| calendar.observation_days_before(today, 1).ok());
        let Some(previous) = previous else { return BTreeMap::new() };
        let path = store_dir(&self.data_dir, previous.yyyymmdd()).join(COMPLETE_FILE_NAME);
        let Some(complete) = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<PreviousComplete>(&bytes).ok()) else {
            return BTreeMap::new();
        };
        let mut messages = BTreeMap::new();
        for stock in complete.stocks {
            *messages.entry(stock.code).or_insert(0) += stock.messages;
        }
        messages
    }

    pub(super) async fn collect(&mut self, day: &mut DayRun, plan: PlanFile, shutdown: &mut watch::Receiver<bool>) -> Result<(), DayEnd> {
        self.reporter.phase(DayPhase::Collecting);
        let opens_at = minute_time(day.day, day.open_minute.unwrap_or(DEFAULT_OPEN_MINUTE));
        let deadline = opens_at.plus_secs(self.schedule.market_open_grace.as_secs() as i64);
        let settings = Settings {
            end_at: Some(self.schedule.close_at),
            status_socket: None,
            market_open_check: Some(MarketOpenCheck { opens_at, deadline }),
            ..self.supervisor.clone()
        };
        let shared_supervisor = self.start_shared(day, &settings);
        let inputs = Inputs { plan, keys: self.keys.clone(), data_dir: self.data_dir.clone(), settings };
        let injected = Injected { launcher: self.launcher.clone(), transport: self.transport.clone(), clock: self.clock.clone() };
        let supervisor = match Supervisor::start(inputs, injected) {
            Ok(supervisor) => supervisor,
            Err(error) => {
                self.reporter.alert(AlertKind::StageFailed, format!("자식 띄우기: {error}"));
                return Err(DayEnd::Done);
            }
        };
        let mut status = supervisor.status();
        let mut task = tokio::spawn(supervisor.run(shutdown.clone()));
        let mut shared_report = shared_supervisor.as_ref().map(SharedSupervisor::report);
        let mut shared_task = shared_supervisor.map(|shared| tokio::spawn(shared.run(shutdown.clone())));
        loop {
            tokio::select! {
                Some(Ok(())) = async { match shared_report.as_mut() { Some(report) => Some(report.changed().await), None => std::future::pending().await } } => {
                    if let Some(report) = shared_report.as_mut() {
                        let snapshot = report.borrow_and_update().clone();
                        self.reporter.shared(snapshot);
                    }
                }
                finished = &mut task => {
                    if let Err(error) = finished {
                        self.reporter.alert(AlertKind::StageFailed, format!("장중 수집이 비정상으로 끝났습니다: {error}"));
                    }
                    break;
                }
                changed = status.changed() => match changed {
                    Ok(()) => {
                        let snapshot = status.borrow_and_update().clone();
                        self.reporter.supervised(snapshot);
                    }
                    Err(_) => {
                        let _ = (&mut task).await;
                        break;
                    }
                },
            }
        }
        if let Some(task) = shared_task.take()
            && let Err(error) = task.await
        {
            self.reporter.alert(AlertKind::StageFailed, format!("공용 자료 감독이 비정상으로 끝났습니다: {error}"));
        }
        if let Some(report) = shared_report.as_mut() {
            let last = report.borrow().clone();
            self.reporter.shared(last);
        }
        let last = status.borrow().clone();
        self.reporter.supervised(last);
        if *shutdown.borrow() { Err(DayEnd::Stopped) } else { Ok(()) }
    }

    pub(super) async fn after_close(&mut self, day: &mut DayRun, shutdown: &mut watch::Receiver<bool>) -> Result<(), DayEnd> {
        self.after_close_rest(day, shutdown).await?;
        let turnover = self.after_close_turnover(day, shutdown).await;
        self.soft("거래대금", turnover)?;
        self.reissue_tokens(day, shutdown).await
    }

    async fn after_close_rest(&mut self, day: &mut DayRun, shutdown: &mut watch::Receiver<bool>) -> Result<(), DayEnd> {
        let opened = self.open_rest(shutdown).await;
        let Some(session) = self.soft("마감 뒤 REST 준비", opened)? else { return Ok(()) };
        let listed = self.after_close_list(&session, day, shutdown).await;
        self.soft("마감 뒤 목록", listed)?;
        let checked = self.index_check(&session, day, shutdown).await;
        self.soft("지수 일봉 대조", checked)?;
        Ok(())
    }

    async fn after_close_turnover(&self, day: &DayRun, shutdown: &mut watch::Receiver<bool>) -> StageResult<()> {
        if turnover_path(&self.data_dir, day.date).is_file() {
            return Ok(());
        }
        let universe = read_universe_if_present(&self.data_dir, day.date)
            .map_err(|error| Halt::Failed(error.to_string()))?
            .ok_or_else(|| Halt::Failed(format!("{} 종목 목록이 없습니다", day.date)))?;
        let codes: Vec<String> = universe.stocks.into_iter().map(|entry| entry.code).collect();
        let session = self.open_rest(shutdown).await?;
        let collected = collect_turnover(session.rest(), &self.data_dir, day.date, kst_of(self.clock.now()), &codes);
        stoppable(shutdown, collected).await?.map_err(|error| Halt::Failed(error.to_string()))?;
        Ok(())
    }

    async fn after_close_list(&self, session: &RestSession, day: &DayRun, shutdown: &mut watch::Receiver<bool>) -> StageResult<()> {
        if after_close_path(&self.data_dir, day.date).is_file() {
            return Ok(());
        }
        let collected = collect_after_close(session.rest(), &self.data_dir, day.date, kst_of(self.clock.now()));
        stoppable(shutdown, collected).await?.map_err(|error| Halt::Failed(error.to_string()))?;
        Ok(())
    }

    async fn index_check(&mut self, session: &RestSession, day: &mut DayRun, shutdown: &mut watch::Receiver<bool>) -> StageResult<()> {
        if has_event(&journal_path(&self.data_dir, day.date), "index_checked") {
            return Ok(());
        }
        let Some(judgment) = day.judgment.clone() else { return Ok(()) };
        let request = IndexDailyChart::new(IndexCode::KOSPI, day.day);
        let fetched = stoppable(shutdown, session.rest().call(&request, None, Priority::Background, MergeScope::default())).await?;
        let days = fetched.map_err(|error| error.to_string()).and_then(|page| index_days(page.body).map_err(|error| error.to_string()));
        let event = match days {
            Err(detail) => {
                self.reporter.alert(AlertKind::StageFailed, format!("지수 일봉 대조: 지수 일봉을 받지 못했습니다: {detail}"));
                JournalEvent::IndexChecked { result: IndexCheckResult::Failed, mismatch: None, detail: Some(detail) }
            }
            Ok(dates) => {
                let candle_days: Vec<Day> = dates.into_iter().filter_map(|date| Day::from_yyyymmdd(date_number(date))).collect();
                match cross_check(&judgment, &candle_days) {
                    CrossCheck::Agrees => JournalEvent::IndexChecked { result: IndexCheckResult::Agrees, mismatch: None, detail: None },
                    CrossCheck::Undetermined => JournalEvent::IndexChecked { result: IndexCheckResult::Undetermined, mismatch: None, detail: None },
                    CrossCheck::Disagrees { mismatch } => {
                        self.reporter.alert(AlertKind::IndexMismatch, mismatch_text(mismatch).to_owned());
                        JournalEvent::IndexChecked { result: IndexCheckResult::Disagrees, mismatch: Some(mismatch), detail: Some(mismatch_text(mismatch).to_owned()) }
                    }
                }
            }
        };
        day.journal.append(self.clock.now(), &event);
        Ok(())
    }

    async fn reissue_tokens(&mut self, day: &mut DayRun, shutdown: &mut watch::Receiver<bool>) -> Result<(), DayEnd> {
        let start = self.clock.now();
        let mut order: Vec<usize> = (0..self.keys.len()).collect();
        order.sort_by(|first, second| self.keys[*first].identity.name.cmp(&self.keys[*second].identity.name));
        for (position, index) in order.into_iter().enumerate() {
            let at = start.plus_secs(position as i64 * self.schedule.reissue_spacing.as_secs() as i64);
            self.wait(shutdown, at).await?;
            let name = self.keys[index].identity.name.clone();
            let reissued = self.reissue_key(day, index, shutdown).await;
            self.soft(&format!("토큰 재발급 {name}"), reissued)?;
        }
        Ok(())
    }

    async fn reissue_key(&self, day: &mut DayRun, index: usize, shutdown: &mut watch::Receiver<bool>) -> StageResult<()> {
        let key = &self.keys[index];
        let tokens = crate::supervise::tokens::KeyTokens::open(key, self.transport.clone(), self.clock.clone())
            .map_err(|error| Halt::Failed(format!("잠금을 잡지 못했습니다: {error}")))?;
        tokens.mark_current_stale();
        for _ in 0..3 {
            if let Some(generation) = self.issue_with_retry(&tokens, shutdown).await? {
                day.journal.append(self.clock.now(), &JournalEvent::TokenIssued { key: key.identity.name.clone(), generation });
                return Ok(());
            }
        }
        Err(Halt::Failed("토큰을 받지 못했습니다".to_owned()))
    }

    pub(super) async fn finalize_backlog(&mut self, today: u32, start_before: KstTime, shutdown: &mut watch::Receiver<bool>) -> Result<(), DayEnd> {
        let pending = match raw_days_without_complete(&self.data_dir, today) {
            Ok(pending) => pending,
            Err(error) => {
                self.reporter.alert(AlertKind::StageFailed, format!("정리: 밀린 날을 찾지 못했습니다: {error}"));
                return Ok(());
            }
        };
        let total = pending.len();
        for (finished, date) in pending.into_iter().enumerate() {
            if self.clock.now().unix() >= start_before.unix() {
                tracing::warn!(left = total - finished, "밀린 날 정리를 아침 일정 앞에서 멈춥니다. 남은 날은 다음 정리 기회에 이어서 정리합니다");
                break;
            }
            self.finalize_date(date, false, shutdown).await?;
        }
        Ok(())
    }

    pub(super) async fn backfill_quote_minutes(&mut self, start_before: KstTime, shutdown: &mut watch::Receiver<bool>) -> Result<(), DayEnd> {
        let missing = match missing_closed_quote_days(&self.data_dir, &self.shared_dir) {
            Ok(missing) => missing,
            Err(error) => {
                self.reporter.alert(AlertKind::StageFailed, format!("분 호가 채우기: 빠진 날을 찾지 못했습니다: {error}"));
                return Ok(());
            }
        };
        let total = missing.len();
        for (finished, date) in missing.into_iter().enumerate() {
            if self.clock.now().unix() >= start_before.unix() {
                tracing::warn!(left = total - finished, "분 호가 채우기를 아침 일정 앞에서 멈춥니다. 남은 날은 다음 기회에 이어서 채웁니다");
                break;
            }
            let arguments = super::quotes_backfill_arguments(&self.data_dir, &self.shared_dir, date, &self.schedule);
            let finalizer = self.finalizer.clone();
            let outcome = stoppable(shutdown, async move { finalizer.run_quotes_backfill(arguments).await }).await.map_err(|_| DayEnd::Stopped)?;
            match outcome {
                Ok(0) => {}
                Ok(code) => self.reporter.alert(AlertKind::StageFailed, format!("분 호가 채우기: {date}일이 종료 코드 {code}로 실패했습니다")),
                Err(error) => self.reporter.alert(AlertKind::StageFailed, format!("분 호가 채우기: {date}일을 돌리지 못했습니다: {error}")),
            }
        }
        Ok(())
    }

    pub(super) async fn finalize(&mut self, day: &DayRun, collected: bool, shutdown: &mut watch::Receiver<bool>) -> Result<(), DayEnd> {
        self.finalize_date(day.date, collected, shutdown).await
    }

    pub(super) async fn finalize_date(&mut self, date: u32, collected: bool, shutdown: &mut watch::Receiver<bool>) -> Result<(), DayEnd> {
        if store_dir(&self.data_dir, date).join(COMPLETE_FILE_NAME).is_file() {
            return Ok(());
        }
        if !raw_day_dir(&self.data_dir, date).is_dir() {
            if collected {
                self.reporter.alert(AlertKind::StageFailed, format!("정리: {date}일 원문이 없어 정리하지 않습니다"));
            }
            return Ok(());
        }
        let previous_phase = self.reporter.current_phase();
        self.reporter.phase(DayPhase::Finalizing);
        if let Some(note) = self.finalizer.priority_note() {
            self.reporter.alert(AlertKind::StageFailed, format!("정리: {note}"));
        }
        let mut arguments = super::finalize_arguments(&self.data_dir, date, &self.schedule);
        if self.shared_dir != self.data_dir.join("shared") {
            arguments.push("--shared".to_owned());
            arguments.push(self.shared_dir.to_string_lossy().into_owned());
        }
        let finalizer = self.finalizer.clone();
        let outcome = stoppable(shutdown, async move { finalizer.run(arguments).await }).await.map_err(|_| DayEnd::Stopped)?;
        match outcome {
            Ok(0) => {}
            Ok(3) => self.reporter.alert(AlertKind::StageFailed, format!("정리: 분 호가를 만들지 못했습니다({date}). 다음 정리 때 다시 만듭니다")),
            Ok(code) => self.reporter.alert(AlertKind::StageFailed, format!("정리: finalize가 종료 코드 {code}로 끝났습니다. {FINALIZE_RETRY_NOTE}")),
            Err(error) => self.reporter.alert(AlertKind::StageFailed, format!("정리: finalize를 돌리지 못했습니다: {error}. {FINALIZE_RETRY_NOTE}")),
        }
        self.reporter.phase(previous_phase);
        Ok(())
    }
}
