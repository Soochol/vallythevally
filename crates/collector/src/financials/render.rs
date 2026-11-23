use server::api::{FinancialUpdatePhase as Phase, FinancialUpdateStatus as Status, FinancialUpdateStopReason as StopReason};

use super::wire::Reply;
use crate::kst::KstTime;

pub fn kst_text(unix_seconds: i64) -> String {
    let time = KstTime::from_unix_ms(unix_seconds * 1000);
    let seconds = time.ms_of_day / 1000;
    let date = time.date;
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02} KST", date / 10_000, date / 100 % 100, date % 100, seconds / 3600, seconds / 60 % 60, seconds % 60)
}

fn status_name(status: Status) -> (&'static str, &'static str) {
    match status {
        Status::Idle => ("idle", "대기"),
        Status::Planning => ("planning", "계획 중"),
        Status::Collecting => ("collecting", "수집 중"),
        Status::Pausing => ("pausing", "멈추는 중"),
        Status::Paused => ("paused", "일시정지"),
        Status::Stopped => ("stopped", "중단"),
        Status::Checking => ("checking", "확인 중"),
        Status::Ready => ("ready", "완료"),
        Status::PartialFailure => ("partial_failure", "일부 실패"),
        Status::Interrupted => ("interrupted", "중단됨, 이어서 수행"),
        Status::Failed => ("failed", "실패"),
        Status::NotConfigured => ("not_configured", "설정 없음"),
    }
}

fn phase_name(phase: Phase) -> (&'static str, &'static str) {
    match phase {
        Phase::Planning => ("planning", "계획"),
        Phase::Recent => ("recent", "최근"),
        Phase::Changes => ("changes", "정정"),
        Phase::History => ("history", "과거"),
        Phase::Complete => ("complete", "끝"),
    }
}

fn stop_reason_name(reason: StopReason) -> (&'static str, &'static str) {
    match reason {
        StopReason::User => ("user", "운영자 일시정지"),
        StopReason::Storage => ("storage", "저장 실패"),
        StopReason::Interrupted => ("interrupted", "프로세스 중단"),
        StopReason::NotConfigured => ("not_configured", "설정 없음"),
        StopReason::Authentication => ("authentication", "인증 중단"),
        StopReason::RateLimited => ("rate_limited", "호출 한도 중단"),
    }
}

pub fn lines(reply: &Reply) -> String {
    let page = &reply.page;
    let (status, status_label) = status_name(page.status);
    let (phase, phase_label) = phase_name(page.phase);
    let mut text = format!("상태: {status} ({status_label})\n단계: {phase} ({phase_label})\n");
    text.push_str(&format!("회사 진행: {}/{} 완료, 실패 {}\n", page.completed_companies, page.total_companies, page.failed_companies));
    text.push_str(&format!("작업: {}번, 연도 {}~{}, 종목 {}개 중 {}개 처리\n", page.id, page.from_year, page.through_year, page.total_symbols, page.processed_symbols));
    if let Some(reason) = page.stop_reason {
        let (name, label) = stop_reason_name(reason);
        text.push_str(&format!("중단 사유: {name} ({label})\n"));
    }
    if let Some(failure) = &page.failure {
        text.push_str(&format!("실패 종류: {failure}\n"));
    }
    if let Some(at) = page.next_check_at {
        text.push_str(&format!("다음 확인: {}\n", kst_text(at.0)));
    }
    if let Some(at) = page.last_checked_at {
        text.push_str(&format!("마지막 확인: {}\n", kst_text(at.0)));
    }
    match &reply.listing {
        Some(listing) => text.push_str(&format!("종목 목록: {}일자 {}종목\n", listing.date, listing.stocks)),
        None => text.push_str("종목 목록: 없음 (수집 데이터 폴더의 universe 아래에 읽을 수 있는 파일이 없어 OpenDART를 부르지 않습니다)\n"),
    }
    text
}
