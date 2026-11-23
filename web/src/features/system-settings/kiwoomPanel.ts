import type { Broker } from "../../api/generated/Broker";
import type { KiwoomConnectStep } from "../../api/generated/KiwoomConnectStep";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { BROKERS } from "./brokers";

export const ISSUE_INTERVAL_SECONDS = 600;

export const IN_USE_ELSEWHERE_NOTICE = "다른 프로그램이 이 한투 키로 실시간을 쓰고 있습니다. 그 프로그램을 끈 뒤 다시 연결하세요";

export const inUseElsewhere = (link: KiwoomLinkStatus, broker: Broker = "kiwoom"): boolean => broker === "kis" && link.state === "failed" && link.problem === "network" && link.message.includes("OPSP8996");


export const CONNECT_STEPS: readonly { step: KiwoomConnectStep; label: string }[] = [
  { step: "checkingKey", label: "키 확인" },
  { step: "token", label: "토큰" },
  { step: "symbols", label: "종목 목록" },
  { step: "realtime", label: "실시간" },
];

export type PanelStage =
  | "loading"
  | "noKey"
  | "disconnected"
  | "connecting"
  | "connectingWait"
  | "connected"
  | "wait"
  | "authBlocked"
  | "keyNeedsCheck"
  | "network"
  | "tokenFileUnusable"
  | "keyFileUnusable"
  | "pathStopped"
  | "inUseElsewhere";

export interface Confirmations {
  registeredIp: boolean;
  lockChecked: boolean;
}

export const NO_CONFIRMATIONS: Confirmations = { registeredIp: false, lockChecked: false };

export interface Countdown {
  remainingSeconds: number;
  progress: number;
}

export interface ConnectAction {
  label: string;
  enabled: boolean;
  acknowledged: boolean;
  readyNotice: boolean;
}

export interface PanelView {
  stage: PanelStage;
  countdown: Countdown | null;
  connect: ConnectAction | null;
  disconnect: boolean;
  recheckTokenFile: boolean;
  needsConfirmations: boolean;
  ipHelpOpensByItself: boolean;
  startNote: string | null;
  disconnectNote: string | null;
}

export function connectBlockReason(view: PanelView, confirmations: Confirmations): string | null {
  const connect = view.connect;
  if (!connect || connect.enabled) return null;
  if (view.needsConfirmations && !(confirmations.registeredIp && confirmations.lockChecked)) return "위 확인 두 칸을 모두 체크하면 켜집니다";
  if (view.countdown && view.countdown.remainingSeconds > 0) return "발급 간격이 지나면 누를 수 있습니다";
  return null;
}

export function countdownOf(retryAt: UnixSeconds | null, now: UnixSeconds): Countdown | null {
  if (retryAt === null) return null;
  const remainingSeconds = Math.max(0, Math.ceil(retryAt - now));
  return { remainingSeconds, progress: Math.min(1, Math.max(0, 1 - remainingSeconds / ISSUE_INTERVAL_SECONDS)) };
}

export function formatRemaining(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const waitingLabel = (countdown: Countdown | null) =>
  countdown && countdown.remainingSeconds > 0 ? `다시 연결 (${formatRemaining(countdown.remainingSeconds)} 뒤 가능)` : "다시 연결";

export function panelView(status: KiwoomLinkStatus | null, now: UnixSeconds, confirmations: Confirmations = NO_CONFIRMATIONS, broker: Broker = "kiwoom"): PanelView {
  const view: PanelView = { stage: "loading", countdown: null, connect: null, disconnect: false, recheckTokenFile: false, needsConfirmations: false, ipHelpOpensByItself: false, startNote: null, disconnectNote: null };
  if (!status) return view;
  switch (status.state) {
    case "noKey":
      return { ...view, stage: "noKey" };
    case "disconnected":
      return { ...view, stage: "disconnected", startNote: disconnectedNote(status), connect: { label: `${BROKERS[broker].shortName}에 연결`, enabled: true, acknowledged: false, readyNotice: false } };
    case "connecting":
      if (status.step === "issueInterval") return { ...view, stage: "connectingWait", countdown: countdownOf(status.retryAt, now), disconnect: true };
      return { ...view, stage: "connecting" };
    case "connected":
      return { ...view, stage: "connected", disconnect: true, startNote: "서버를 다시 켜도 자동으로 연결합니다", disconnectNote: "끊으면 다음에 서버를 켤 때도 연결하지 않습니다" };
    case "failed":
      return failedView(view, status, now, confirmations, broker);
    default: {
      const _exhaustive: never = status.state;
      return _exhaustive;
    }
  }
}

export const KEPT_DISCONNECTED_NOTE = "연결하면 다음부터 서버를 켤 때 자동으로 연결합니다";

function disconnectedNote(status: KiwoomLinkStatus): string | null {
  switch (status.atStart) {
    case "keptDisconnected":
      return `연결을 끊어 두었습니다. ${KEPT_DISCONNECTED_NOTE}`;
    case "connects":
      return "키는 저장됨 · 연결하지 않았습니다";
    case null:
      return null;
    default: {
      const _exhaustive: never = status.atStart;
      return _exhaustive;
    }
  }
}

export type KeySaveNote = "connectsAtOnce" | "blockedBy8050" | "kisConnectsAtOnce" | null;

export function keySaveNote(status: KiwoomLinkStatus | null, broker: Broker = "kiwoom"): KeySaveNote {
  if (!status || status.keySource === "env") return null;
  if (broker === "kis") return "kisConnectsAtOnce";
  return status.problem === "authBlocked8050" ? "blockedBy8050" : "connectsAtOnce";
}

function failedView(base: PanelView, status: KiwoomLinkStatus, now: UnixSeconds, confirmations: Confirmations, broker: Broker): PanelView {
  if (inUseElsewhere(status, broker)) return { ...base, stage: "inUseElsewhere", connect: { label: "다시 연결", enabled: true, acknowledged: false, readyNotice: false } };
  const countdown = countdownOf(status.retryAt, now);
  const elapsed = !countdown || countdown.remainingSeconds === 0;
  const acknowledging = status.problem === "authBlocked8050" || status.needsAcknowledgement;
  const confirmed = confirmations.registeredIp && confirmations.lockChecked;
  const retry = (label: string, enabled: boolean, readyNotice: boolean): ConnectAction => ({ label, enabled, acknowledged: acknowledging, readyNotice });
  const withConfirmations = { needsConfirmations: acknowledging, ipHelpOpensByItself: acknowledging };
  switch (status.problem) {
    case "authBlocked8050":
      return { ...base, ...withConfirmations, stage: "authBlocked", countdown, startNote: "서버를 다시 켜도 차단은 풀리지 않고 자동 연결도 하지 않습니다", connect: retry(waitingLabel(countdown), confirmed && elapsed, confirmed && elapsed && countdown !== null) };
    case "issueIntervalWait":
    case "authUncertain": {
      const enabled = elapsed && (!acknowledging || confirmed);
      return { ...base, ...withConfirmations, stage: "wait", countdown, connect: retry(waitingLabel(countdown), enabled, enabled) };
    }
    case "network": {
      const enabled = elapsed && (!acknowledging || confirmed);
      return { ...base, ...withConfirmations, stage: "network", countdown, connect: retry(countdown && !elapsed ? waitingLabel(countdown) : "다시 시도", enabled, false) };
    }
    case "keyNeedsCheck":
      return { ...base, stage: "keyNeedsCheck", countdown };
    case "tokenFileUnusable":
      return { ...base, stage: "tokenFileUnusable", recheckTokenFile: true };
    case "keyFileUnusable":
      return { ...base, stage: "keyFileUnusable" };
    case "pathStopped":
    case null:
      return { ...base, stage: "pathStopped" };
    default: {
      const _exhaustive: never = status.problem;
      return _exhaustive;
    }
  }
}

export function keyLocked(status: KiwoomLinkStatus | null): boolean {
  return status === null || status.keySource === "env" || status.state === "connecting";
}

export function maskedAppKey(tail: string | null): string {
  return `${"•".repeat(12)}${tail ?? ""}`;
}

export interface KeyForm {
  appKey: string;
  appSecret: string;
  editing: boolean;
}

export type KeyFormEvent =
  | { type: "appKey"; value: string }
  | { type: "appSecret"; value: string }
  | { type: "edit" }
  | { type: "cancel" }
  | { type: "saved" };

export const EMPTY_KEY_FORM: KeyForm = { appKey: "", appSecret: "", editing: false };

export function keyFormReducer(form: KeyForm, event: KeyFormEvent): KeyForm {
  switch (event.type) {
    case "appKey":
      return { ...form, appKey: event.value };
    case "appSecret":
      return { ...form, appSecret: event.value };
    case "edit":
      return { ...EMPTY_KEY_FORM, editing: true };
    case "cancel":
    case "saved":
      return EMPTY_KEY_FORM;
  }
}

export const canSaveKey = (form: KeyForm) => form.appKey.trim() !== "" && form.appSecret.trim() !== "";

export function ipDiffers(checkedIp: string | null, status: KiwoomLinkStatus | null): boolean {
  return checkedIp !== null && status?.registeredIp != null && status.registeredIp.ip !== checkedIp;
}
