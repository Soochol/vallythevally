mod engine;
mod exact;
mod indicator;
mod line;
pub mod store;
mod update;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::response::Json;
use axum::routing::{get, post};
use domain::{Feed, IndexCode, KstDate, KstTime, Period, SeriesKey, TimeOfDay};

use crate::api::{self, ApiErrorBody, ApiErrorReason, FullHistory, Screen, ScreenerResult, ScreenerStatus, ScreenerUpdate, ScreenerUpdateRequest, UpdatePhase};
use crate::bars::{BarError, BarService};
use crate::clock::Clock;
use crate::http::{ApiFailure, AppState, Lookup};
use crate::kiwoom::rest::{KiwoomRest, Priority};
use crate::symbols::SymbolDirectory;
use crate::user_routes::{JSON_LIMIT, check_screen, read_json};
use engine::{RunnableScreen, Snapshot};
use store::{Store, StoreError};

const CALENDAR_DAYS: usize = 10;
const CALENDAR_FRESH_SECS: i64 = 5 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Progress {
    phase: UpdatePhase,
    done: u32,
    total: u32,
    full: bool,
}

enum Run {
    Idle,
    Running { id: u64, progress: Progress, task: tokio::task::AbortHandle },
    Failed { progress: Progress, error: ApiErrorBody },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CalendarUse {
    Status,
    Update,
}

struct Calendar {
    fetched_at: KstTime,
    days: Vec<KstDate>,
}

impl Calendar {
    fn last_before(&self, day: KstDate) -> Option<KstDate> {
        self.days.iter().rev().find(|d| **d < day).copied()
    }

    fn need_day(&self, now: KstTime) -> Option<KstDate> {
        self.last_before(now.kst_date())
    }

    fn target(&self, now: KstTime) -> Option<KstDate> {
        let today = now.kst_date();
        let today_confirmed = self.days.last() == Some(&today) && Period::Day.bucket(KstTime::from_kst_civil(today, TimeOfDay::MIDNIGHT)).is_confirmed_at(now);
        if today_confirmed { Some(today) } else { self.need_day(now) }
    }
}

pub struct Screener {
    store: Arc<Store>,
    rest: KiwoomRest,
    bars: Arc<BarService>,
    symbols: Arc<SymbolDirectory>,
    clock: Clock,
    run: Mutex<Run>,
    next_run: AtomicU64,
    recents_started: AtomicU64,
    calendar: tokio::sync::Mutex<Option<Arc<Calendar>>>,
}

impl Screener {
    pub fn new(store: Store, rest: KiwoomRest, bars: Arc<BarService>, symbols: Arc<SymbolDirectory>, clock: Clock) -> Self {
        Screener {
            store: Arc::new(store),
            rest,
            bars,
            symbols,
            clock,
            run: Mutex::new(Run::Idle),
            next_run: AtomicU64::new(1),
            recents_started: AtomicU64::new(0),
            calendar: tokio::sync::Mutex::new(None),
        }
    }

    fn run(&self) -> MutexGuard<'_, Run> {
        self.run.lock().expect("업데이트 상태 잠금")
    }

    async fn with_store<T: Send + 'static>(&self, f: impl FnOnce(&Store) -> Result<T, StoreError> + Send + 'static) -> Result<T, StoreError> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || f(&store)).await.map_err(|e| StoreError(format!("저장소 작업이 끝나지 못했습니다: {e}")))?
    }

    pub fn start(self: &Arc<Self>, full: bool) {
        let mut run = self.run();
        if matches!(*run, Run::Running { .. }) {
            return;
        }
        let id = self.next_run.fetch_add(1, Ordering::SeqCst);
        let me = self.clone();
        let task = tokio::spawn(async move {
            let outcome = me.update(id, full).await;
            me.finish(id, outcome);
        });
        *run = Run::Running { id, progress: Progress { phase: UpdatePhase::Symbols, done: 0, total: 0, full }, task: task.abort_handle() };
    }

    pub fn cancel(&self) {
        let mut run = self.run();
        if let Run::Running { task, .. } = &*run {
            task.abort();
            tracing::info!("스크리너 업데이트를 취소했습니다");
            *run = Run::Idle;
        }
    }

    fn report(&self, id: u64, phase: UpdatePhase, done: usize, total: usize) {
        if let Run::Running { id: running, progress, .. } = &mut *self.run()
            && *running == id
        {
            if phase == UpdatePhase::Recent && progress.phase != UpdatePhase::Recent {
                self.recents_started.fetch_add(1, Ordering::SeqCst);
            }
            *progress = Progress { phase, done: done as u32, total: total as u32, full: progress.full };
        }
    }

    pub async fn update_if_behind(self: &Arc<Self>) {
        let calendar = match self.calendar(CalendarUse::Update).await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, "코스피 일봉을 받지 못해 서버를 켤 때의 스크리너 업데이트를 건너뜁니다");
                return;
            }
        };
        let Some(target) = calendar.target(self.clock.now()) else {
            tracing::warn!("코스피 일봉에 관측일이 없어 서버를 켤 때의 스크리너 업데이트를 건너뜁니다");
            return;
        };
        let last_day = match self.with_store(Store::summary).await {
            Ok(summary) => summary.last_day,
            Err(e) => {
                tracing::error!(error = %e, "스크리너 저장소를 읽지 못해 서버를 켤 때의 업데이트를 건너뜁니다");
                return;
            }
        };
        if last_day.is_some_and(|last| last >= target) {
            tracing::info!(%target, "스크리너 저장소가 목표 관측일까지 차 있어 업데이트를 시작하지 않습니다");
            return;
        }
        tracing::info!(last_day = ?last_day, %target, "스크리너 저장소가 목표 관측일보다 뒤처져 업데이트를 시작합니다");
        self.start(false);
    }

    fn finish(&self, id: u64, outcome: Result<(), BarError>) {
        let mut run = self.run();
        let Run::Running { id: running, progress, .. } = &*run else {
            return;
        };
        if *running != id {
            return;
        }
        let progress = *progress;
        *run = match outcome {
            Ok(()) => {
                tracing::info!(full = progress.full, "스크리너 업데이트를 마쳤습니다");
                Run::Idle
            }
            Err(e) => Run::Failed { progress, error: Lookup::ScreenerUpdate.failure(e, self.clock.now()).into_body() },
        };
    }

    async fn calendar(&self, using: CalendarUse) -> Result<Arc<Calendar>, BarError> {
        let mut cached = self.calendar.lock().await;
        let now = self.clock.now();
        let (reuse, priority) = match using {
            CalendarUse::Status => (true, Priority::Screen),
            CalendarUse::Update => (false, Priority::Background),
        };
        if let Some(c) = cached.as_ref().filter(|c| reuse && c.fetched_at.kst_date() == now.kst_date() && now.unix() - c.fetched_at.unix() < CALENDAR_FRESH_SECS) {
            return Ok(c.clone());
        }
        let page = self.bars.page_with(SeriesKey { feed: Feed::Index(IndexCode::KOSPI), period: Period::Day }, None, CALENDAR_DAYS, priority).await?;
        let days = page.bars.iter().map(|b| b.bucket).chain(page.current.map(|c| c.bucket)).map(|b| b.start().kst_date()).collect();
        let calendar = Arc::new(Calendar { fetched_at: now, days });
        *cached = Some(calendar.clone());
        Ok(calendar)
    }

    pub async fn status(&self) -> Result<ScreenerStatus, StoreError> {
        let summary = self.with_store(Store::summary).await?;
        let calendar = match self.calendar(CalendarUse::Status).await {
            Ok(c) => Some(c),
            Err(e) => {
                tracing::warn!(error = %e, "코스피 일봉을 받지 못해 필요 관측일을 모릅니다");
                None
            }
        };
        let now = self.clock.now();
        let today = now.kst_date();
        let update = match &*self.run() {
            Run::Idle => None,
            Run::Running { progress, .. } => Some(update_view(progress, None)),
            Run::Failed { progress, error } => Some(update_view(progress, Some(error.clone()))),
        };
        Ok(ScreenerStatus {
            last_day: summary.last_day.map(api::KstDate),
            need_day: calendar.as_ref().and_then(|c| c.need_day(now)).map(api::KstDate),
            today_available: calendar.as_ref().and_then(|c| c.target(now)) == Some(today) && summary.last_day < Some(today),
            full_history: FullHistory { done: summary.complete, total: summary.listed },
            unconfirmed: summary.unconfirmed,
            update,
        })
    }

    async fn run_screen(self: &Arc<Self>, screen: RunnableScreen) -> Result<ScreenerResult, ApiFailure> {
        let now = self.clock.now();
        let need_day = self.calendar(CalendarUse::Status).await.map_err(|e| Lookup::ScreenerRun.failure(e, now))?.need_day(now);
        let me = self.clone();
        tokio::task::spawn_blocking(move || me.judge(&screen, need_day)).await.map_err(|e| StoreError(format!("실행 작업이 끝나지 못했습니다: {e}")))?
    }

    fn judge(&self, screen: &RunnableScreen, need_day: Option<KstDate>) -> Result<ScreenerResult, ApiFailure> {
        let mut conn = self.store.reader()?;
        let recents_before = self.recents_started_outside_recent()?;
        let snapshot = Snapshot::begin(&mut conn)?;
        if self.recents_started_outside_recent()? != recents_before {
            return Err(updating());
        }
        let Some(as_of) = snapshot.last_day.filter(|last| need_day.is_none_or(|need| *last >= need)) else {
            let message = match need_day {
                Some(need) => format!("저장소에 필요 관측일 {need}의 자료가 없습니다. 업데이트하세요"),
                None => "스크리너 저장소가 비어 있습니다. 업데이트하세요".to_owned(),
            };
            return Err(ApiFailure::screener_not_ready(ApiErrorReason::MissingDay, message));
        };
        Ok(snapshot.screen(screen, as_of)?)
    }

    fn recents_started_outside_recent(&self) -> Result<u64, ApiFailure> {
        let run = self.run();
        if matches!(&*run, Run::Running { progress, .. } if progress.phase == UpdatePhase::Recent) {
            return Err(updating());
        }
        Ok(self.recents_started.load(Ordering::SeqCst))
    }
}

fn updating() -> ApiFailure {
    ApiFailure::screener_not_ready(ApiErrorReason::Updating, "최근 관측일을 채우는 동안에는 실행할 수 없습니다. 과거 이어 받기로 넘어가거나 업데이트가 끝나면 실행하세요")
}

fn update_view(p: &Progress, error: Option<ApiErrorBody>) -> ScreenerUpdate {
    ScreenerUpdate { phase: p.phase, done: p.done, total: p.total, error, full: p.full }
}

impl From<StoreError> for ApiFailure {
    fn from(e: StoreError) -> Self {
        tracing::error!(error = %e, "스크리너 저장소 오류");
        ApiFailure::new(api::ApiErrorCode::Internal, "스크리너 저장소를 읽거나 쓰지 못했습니다")
    }
}

impl From<StoreError> for BarError {
    fn from(e: StoreError) -> Self {
        BarError::Internal(format!("스크리너 저장소 오류: {e}"))
    }
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/screener/update", post(start_update))
        .route("/api/screener/update/cancel", post(cancel_update))
        .route("/api/screener/status", get(status))
        .route("/api/screener/run", post(run_screen))
}

async fn start_update(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<ScreenerStatus>, ApiFailure> {
    let request: ScreenerUpdateRequest = read_json(body, JSON_LIMIT, "업데이트 본문").await?;
    st.screener.start(request.full);
    Ok(Json(st.screener.status().await?))
}

async fn cancel_update(State(st): State<Arc<AppState>>) -> Result<Json<ScreenerStatus>, ApiFailure> {
    st.screener.cancel();
    Ok(Json(st.screener.status().await?))
}

async fn status(State(st): State<Arc<AppState>>) -> Result<Json<ScreenerStatus>, ApiFailure> {
    Ok(Json(st.screener.status().await?))
}

async fn run_screen(State(st): State<Arc<AppState>>, body: Body) -> Result<Json<ScreenerResult>, ApiFailure> {
    let screen: Screen = read_json(body, JSON_LIMIT, "조건식 본문").await?;
    check_screen(&screen)?;
    let screen = RunnableScreen::of(&screen).map_err(ApiFailure::bad_request)?;
    Ok(Json(st.screener.run_screen(screen).await?))
}
