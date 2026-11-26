use std::sync::Arc;
use std::time::Duration;

use domain::KstDate;

use crate::clock::{Clock, kst};

use super::*;

fn day(d: u8) -> KstDate {
    KstDate::new(2026, 11, d).unwrap()
}

fn live_ctx(date: u32) -> MarketContext {
    MarketContext::new(date, MarketPhase::Collecting, MarketObservation::Observed)
}

fn off_hours_ctx(date: u32) -> MarketContext {
    MarketContext::new(date, MarketPhase::OffHours, MarketObservation::Observed)
}

fn holiday_ctx(date: u32) -> MarketContext {
    MarketContext::new(date, MarketPhase::Collecting, MarketObservation::NotObserved)
}

#[test]
fn hysteresis_absorbs_a_transient_flap_and_fires_after_duration() {
    let mut engine = AlertEngine::new();
    let ctx = live_ctx(20261126);
    let t0 = kst(day(26), 9, 0, 0);

    let down = || AlertEvent::active(AlertSource::ServerWatch, AlertCode::DaemonDown, "supervise", "감독 데몬 꺼짐", "소켓 연결 실패");
    let up = || AlertEvent::resolved(AlertSource::ServerWatch, AlertCode::DaemonDown, "supervise", "감독 데몬 복구", "하트비트 재수신");

    assert!(engine.evaluate(down(), ctx, t0).is_empty());
    assert!(engine.tick(ctx, t0.plus_secs(30)).is_empty());
    assert!(engine.evaluate(up(), ctx, t0.plus_secs(35)).is_empty());

    assert!(engine.evaluate(down(), ctx, t0.plus_secs(100)).is_empty());
    let fired = engine.tick(ctx, t0.plus_secs(145));
    assert_eq!(fired.len(), 1);
    assert_eq!(fired[0].kind, DispatchKind::Fired);
    assert!(!fired[0].silent);

    assert!(engine.evaluate(down(), ctx, t0.plus_secs(160)).is_empty());
    let resolved = engine.evaluate(up(), ctx, t0.plus_secs(265));
    assert_eq!(resolved.len(), 1);
    assert_eq!(resolved[0].kind, DispatchKind::Resolved);
    assert_eq!(resolved[0].duration_secs, Some(120));
    assert_eq!(resolved[0].suppressed_count, 1);
    assert!(resolved[0].silent);
}

#[test]
fn fingerprints_isolate_different_keys_and_stages() {
    let mut engine = AlertEngine::new();
    let ctx = live_ctx(20261126);
    let t0 = kst(day(26), 9, 10, 0);

    let key1 = AlertEvent::active(AlertSource::Supervise, AlertCode::KeyAuthHalted, "collect-01", "collect-01 정지", "8050");
    let key2 = AlertEvent::active(AlertSource::Supervise, AlertCode::KeyAuthHalted, "collect-02", "collect-02 정지", "8050");
    let holiday = AlertEvent::active(AlertSource::Supervise, AlertCode::StageDegraded, "holiday_key", "특일정보 키 없음", "캐시 사용");
    let finalize = AlertEvent::active(AlertSource::Supervise, AlertCode::FinalizeFailed, "finalize:20261126", "정리 실패", "종료 코드 1");

    assert_eq!(engine.evaluate(key1.clone(), ctx, t0).len(), 1);
    assert!(engine.evaluate(key1, ctx, t0.plus_secs(10)).is_empty());
    assert_eq!(engine.evaluate(key2, ctx, t0.plus_secs(20)).len(), 1);
    assert_eq!(engine.evaluate(holiday, ctx, t0.plus_secs(30)).len(), 1);
    assert_eq!(engine.evaluate(finalize, ctx, t0.plus_secs(40)).len(), 1);
}

#[test]
fn p1_reminders_follow_backoff_and_p2_escalates_to_p1() {
    let mut engine = AlertEngine::new();
    let ctx = live_ctx(20261126);
    let t0 = kst(day(26), 9, 0, 0);

    let p1 = AlertEvent::active(AlertSource::Supervise, AlertCode::HandoffSkipped, "collect-02", "인계 불가", "예비 키 소진");
    assert_eq!(engine.evaluate(p1, ctx, t0).len(), 1);
    assert!(engine.tick(ctx, t0.plus_secs(1799)).is_empty());
    let first_reminder = engine.tick(ctx, t0.plus_secs(1800));
    assert_eq!(first_reminder.len(), 1);
    assert_eq!(first_reminder[0].kind, DispatchKind::Reminder);

    assert!(engine.tick(ctx, t0.plus_secs(1800 + 7199)).is_empty());
    let second_reminder = engine.tick(ctx, t0.plus_secs(1800 + 7200));
    assert_eq!(second_reminder.len(), 1);
    assert_eq!(second_reminder[0].kind, DispatchKind::Reminder);

    let p2 = AlertEvent::active(AlertSource::Supervise, AlertCode::ChildRestarting, "collect-03", "재시작 반복", "3회 재시작");
    assert_eq!(engine.evaluate(p2, ctx, t0).len(), 1);
    let escalated = engine.tick(ctx, t0.plus_secs(1800));
    assert!(escalated.iter().any(|item| item.fingerprint.target == "collect-03" && item.kind == DispatchKind::Escalated && item.severity == Severity::P1Critical));
}

#[test]
fn quiet_hours_defer_p2_into_morning_brief_while_p1_breaks_through() {
    let mut engine = AlertEngine::new();
    let night = off_hours_ctx(20261126);
    let t0 = kst(day(26), 2, 0, 0);

    let p2 = AlertEvent::active(AlertSource::Financials, AlertCode::FinancialsRateLimited, "opendart", "호출 한도", "다음 확인 09:00");
    assert!(engine.evaluate(p2, night, t0).is_empty());
    assert_eq!(engine.deferred_p2_count(), 1);

    let p1 = AlertEvent::active(AlertSource::Supervise, AlertCode::DaemonCrashed, "vally-collector", "데몬 종료", "SIGKILL");
    let fired = engine.evaluate(p1, night, t0.plus_secs(60));
    assert_eq!(fired.len(), 1);
    assert!(!fired[0].silent);

    let upgraded = AlertEvent::active(AlertSource::Financials, AlertCode::FinancialsRateLimited, "opendart", "승격 장애", "긴급").with_severity(Severity::P1Critical);
    let escalated = engine.evaluate(upgraded, night, t0.plus_secs(120));
    assert_eq!(escalated.len(), 1);
    assert_eq!(escalated[0].kind, DispatchKind::Escalated);
    assert!(!escalated[0].silent);
    assert_eq!(engine.deferred_p2_count(), 0);
}

#[test]
fn digests_send_once_per_observed_day_and_skip_holidays() {
    let mut engine = AlertEngine::new();
    let t0 = kst(day(26), 8, 0, 0);
    let brief = || AlertEvent::active(AlertSource::Supervise, AlertCode::MorningBrief, "daily", "장전 점검", "준비 완료");

    assert!(engine.emit_digest("morning", brief(), holiday_ctx(20261126), t0).is_none());
    let sent = engine.emit_digest("morning", brief(), live_ctx(20261126), t0).unwrap();
    assert!(sent.silent);
    assert!(engine.emit_digest("morning", brief(), live_ctx(20261126), t0.plus_secs(60)).is_none());
    assert!(engine.emit_digest("morning", brief(), live_ctx(20261127), kst(day(27), 8, 0, 0)).is_some());
}

#[test]
fn html_formatter_escapes_special_characters_and_formats_duration() {
    let dispatch = AlertDispatch {
        kind: DispatchKind::Resolved,
        fingerprint: Fingerprint::new(AlertSource::Supervise, AlertCode::KeyStopped, "collect-<1>&2"),
        severity: Severity::P3Info,
        title: "키 <복구> & 확인".to_owned(),
        summary: "정상화 <ok>".to_owned(),
        metrics: [("수신".to_owned(), "190/190".to_owned())].into_iter().collect(),
        impact: "결손 없음".to_owned(),
        action: Some("collector status --state <dir>".to_owned()),
        observed_at: kst(day(26), 9, 54, 0),
        duration_secs: Some(862),
        suppressed_count: 3,
        silent: true,
    };
    let rendered = render_dispatch(&dispatch);
    assert!(rendered.html.contains("<b>[복구 완료] 키 &lt;복구&gt; &amp; 확인</b>"), "{}", rendered.html);
    assert!(rendered.html.contains("지속시간: <b>14분 22초</b> (억제된 중복 3건)"), "{}", rendered.html);
    assert!(rendered.html.contains("<code>collector status --state &lt;dir&gt;</code>"), "{}", rendered.html);
    assert!(rendered.silent);
}

#[tokio::test(start_paused = true)]
async fn pipeline_persists_only_delivered_alerts_and_recovers_from_corrupt_state() {
    let folder = tempfile::tempdir().unwrap();
    let store = StateStore::in_folder(folder.path(), "supervise");
    std::fs::write(store.path(), "{깨진 파일").unwrap();

    let sink = Arc::new(MemorySink::new());
    sink.set_fail(true);
    let clock = Clock::fake(kst(day(26), 9, 0, 0));
    let failing = AlertPipeline::spawn(AlertRouter::single(sink.clone()), Some(store.clone()), clock.clone());
    let event = AlertEvent::active(AlertSource::Supervise, AlertCode::KeyStopped, "collect-01", "키 멈춤", "재시작 한도 초과");
    failing.emit(event.clone(), live_ctx(20261126));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(sink.messages().is_empty());

    sink.set_fail(false);
    let recovered = AlertPipeline::spawn(AlertRouter::single(sink.clone()), Some(store.clone()), clock.clone());
    recovered.emit(event.clone(), live_ctx(20261126));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(sink.messages().len(), 1);

    let restarted = AlertPipeline::spawn(AlertRouter::single(sink.clone()), Some(store), clock);
    restarted.emit(event, live_ctx(20261126));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(sink.messages().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn deferred_p2_persists_across_restart_for_morning_brief() {
    let folder = tempfile::tempdir().unwrap();
    let store = StateStore::in_folder(folder.path(), "supervise");
    let sink = Arc::new(MemorySink::new());
    let clock = Clock::fake(kst(day(26), 2, 0, 0));

    let first = AlertPipeline::spawn(AlertRouter::single(sink.clone()), Some(store.clone()), clock.clone());
    let p2 = AlertEvent::active(AlertSource::Supervise, AlertCode::StageDegraded, "holiday_key", "특일정보 키 없음", "캐시 사용");
    first.emit(p2, off_hours_ctx(20261126));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(sink.messages().is_empty());
    assert!(store.path().exists());

    let restarted = AlertPipeline::spawn(AlertRouter::single(sink), Some(store), clock);
    let deferred = restarted.peek_deferred_p2();
    assert_eq!(deferred.len(), 1);
    assert_eq!(deferred[0].fingerprint.target, "holiday_key");
}

#[tokio::test(start_paused = true)]
async fn failed_fired_and_digest_deliveries_remain_retryable_in_same_process() {
    let folder = tempfile::tempdir().unwrap();
    let store = StateStore::in_folder(folder.path(), "supervise");
    let sink = Arc::new(MemorySink::new());
    sink.set_fail(true);
    let clock = Clock::fake(kst(day(26), 9, 0, 0));
    let pipeline = AlertPipeline::spawn(AlertRouter::single(sink.clone()), Some(store), clock);

    let p1 = AlertEvent::active(AlertSource::Supervise, AlertCode::KeyStopped, "collect-01", "키 멈춤", "재시작 한도 초과");
    let p2 = AlertEvent::active(AlertSource::Financials, AlertCode::FinancialsRateLimited, "opendart", "호출 한도", "다음 확인 10:00");
    let brief = AlertEvent::active(AlertSource::Supervise, AlertCode::MorningBrief, "morning:20261126", "장전 점검", "준비 완료");

    pipeline.emit(p1.clone(), live_ctx(20261126));
    pipeline.emit(p2.clone(), live_ctx(20261126));
    assert!(pipeline.emit_digest_clearing_deferred("morning_brief", brief.clone(), live_ctx(20261126)));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(sink.messages().is_empty());

    sink.set_fail(false);
    pipeline.emit(p1, live_ctx(20261126));
    pipeline.emit(p2, live_ctx(20261126));
    assert!(pipeline.emit_digest_clearing_deferred("morning_brief", brief, live_ctx(20261126)));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(sink.messages().len(), 3);
}

#[tokio::test(start_paused = true)]
async fn failed_resolved_delivery_does_not_resurrect_zombie_p1_after_restart() {
    let folder = tempfile::tempdir().unwrap();
    let store = StateStore::in_folder(folder.path(), "supervise");
    let sink = Arc::new(MemorySink::new());
    let clock = Clock::fake(kst(day(26), 9, 0, 0));

    let first = AlertPipeline::spawn(AlertRouter::single(sink.clone()), Some(store.clone()), clock.clone());
    let fired = AlertEvent::active(AlertSource::Supervise, AlertCode::KeyStopped, "collect-01", "키 멈춤", "재시작 한도 초과");
    first.emit(fired, live_ctx(20261126));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(sink.messages().len(), 1);

    sink.set_fail(true);
    let resolved = AlertEvent::resolved(AlertSource::Supervise, AlertCode::KeyStopped, "collect-01", "키 복구", "정상 수신");
    first.emit(resolved, live_ctx(20261126));
    tokio::time::sleep(Duration::from_millis(50)).await;

    let after_sink = Arc::new(MemorySink::new());
    let restarted = AlertPipeline::spawn(AlertRouter::single(after_sink.clone()), Some(store), clock.clone());
    clock.jump(2100);
    restarted.tick(live_ctx(20261126));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(after_sink.messages().is_empty());
}
