import { formatBarTime, formatKstClockSeconds } from "../../chart/time";
import type { CollectorCoverageDay } from "../../api/generated/CollectorCoverageDay";
import type { CollectorDayState } from "../../api/generated/CollectorDayState";
import type { CollectorKey } from "../../api/generated/CollectorKey";
import type { CollectorKeyRole } from "../../api/generated/CollectorKeyRole";
import type { CollectorKeyState } from "../../api/generated/CollectorKeyState";
import type { CollectorPhase } from "../../api/generated/CollectorPhase";
import type { CollectorRest } from "../../api/generated/CollectorRest";
import type { CollectorVerdict } from "../../api/generated/CollectorVerdict";
import type { DaemonJudgment } from "../../api/generated/DaemonJudgment";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";

export type Tone = "ok" | "warn" | "bad" | "idle";

export interface Banner {
  tone: Tone;
  title: string;
  alert: boolean;
}

export const BANNERS: Record<DaemonJudgment, Banner> = {
  healthy: { tone: "ok", title: "감독 데몬이 정상으로 돕니다", alert: false },
  checking: { tone: "idle", title: "감독 데몬 상태를 확인하는 중입니다", alert: false },
  down: { tone: "bad", title: "감독 데몬이 꺼져 있습니다", alert: true },
  unresponsive: { tone: "bad", title: "감독 데몬이 응답하지 않습니다", alert: true },
  version_mismatch: { tone: "warn", title: "감독 데몬과 상태 형식 버전이 달라 상태를 읽지 못합니다", alert: true },
};

export const PHASE_LABEL: Record<CollectorPhase, string> = {
  off_hours: "장 밖 대기",
  morning_prep: "아침 준비",
  collecting: "장중 수집",
  after_close: "마감 뒤 처리",
  finalizing: "정리 중",
  unknown: "알 수 없음",
};

export const KEY_STATE: Record<CollectorKeyState, { label: string; tone: Tone }> = {
  waiting: { label: "대기", tone: "idle" },
  connecting: { label: "연결 중", tone: "warn" },
  receiving: { label: "받는 중", tone: "ok" },
  disconnected: { label: "끊김", tone: "bad" },
  stopped: { label: "멈춤", tone: "bad" },
  handed_off: { label: "인계됨", tone: "warn" },
  unknown: { label: "알 수 없음", tone: "idle" },
};

export const KEY_ROLE: Record<CollectorKeyRole, string> = { collecting: "수집 키", spare: "예비 키", unknown: "알 수 없음" };

export const VERDICT: Record<CollectorVerdict, { label: string; tone: Tone }> = {
  observed: { label: "관측일", tone: "ok" },
  not_observed: { label: "관측일 아님", tone: "idle" },
  unknown: { label: "알 수 없음", tone: "warn" },
};

export const DAY_STATE: Record<CollectorDayState, { label: string; tone: Tone }> = {
  complete: { label: "정리 완료", tone: "ok" },
  incomplete: { label: "정리 전", tone: "warn" },
  in_progress: { label: "정리 중", tone: "warn" },
  verify_failed: { label: "대조 실패", tone: "bad" },
  unreadable: { label: "읽지 못함", tone: "bad" },
  unknown: { label: "알 수 없음", tone: "idle" },
};

export const ALERT_KIND: Record<string, string> = {
  excluded: "제외",
  plan_note: "계획 안내",
  handoff: "인계",
  handoff_skipped: "인계 못 함",
  key_stopped: "키 멈춤",
  register_failed: "등록 실패",
  market_open_missing: "장 시작 신호 없음",
  observation_unknown: "관측일 불명",
  index_mismatch: "지수 대조 어긋남",
  stage_failed: "단계 실패",
};

export const phaseLabel = (phase: CollectorPhase): string => PHASE_LABEL[phase] ?? String(phase);
export const alertKindLabel = (kind: string): string => ALERT_KIND[kind] ?? kind;
export const keyStateOf = (state: CollectorKeyState) => KEY_STATE[state] ?? { label: String(state), tone: "idle" as const };
export const dayStateOf = (state: CollectorDayState) => DAY_STATE[state] ?? { label: String(state), tone: "idle" as const };

export const restText = (rest: CollectorRest): string => (rest.planned_jobs === 0 ? "없음" : `${rest.finished_jobs} / ${rest.planned_jobs}`);

export const messageRateText = (key: CollectorKey): string => (key.messages_per_second === null ? "—" : key.messages_per_second.toLocaleString("ko-KR", { maximumFractionDigits: 1 }));

export function dateText(yyyymmdd: number): string {
  const s = String(yyyymmdd).padStart(8, "0");
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export const receivedAtText = (t: UnixSeconds): string => `${formatBarTime(t, "D")} ${formatKstClockSeconds(t)}`;

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function bytesText(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${UNITS[unit]}`;
}

export const coverageRatio = (day: CollectorCoverageDay): string =>
  day.planned_stocks === null || day.received_stocks === null ? "—" : `${day.received_stocks.toLocaleString("ko-KR")} / ${day.planned_stocks.toLocaleString("ko-KR")}`;

export const daemonAlertText = (judgment: DaemonJudgment): string | null =>
  judgment === "down" ? "수집 감독 데몬이 꺼졌습니다" : judgment === "unresponsive" ? "수집 감독 데몬이 응답하지 않습니다" : null;
