import type { KiwoomConnectStep } from "../../api/generated/KiwoomConnectStep";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";

export const ISSUE_INTERVAL_SECONDS = 600;

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
  | "connected"
  | "wait"
  | "authBlocked"
  | "keyNeedsCheck"
  | "network"
  | "tokenFileUnusable"
  | "keyFileUnusable"
  | "pathStopped";

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

export function panelView(status: KiwoomLinkStatus | null, now: UnixSeconds, confirmations: Confirmations = NO_CONFIRMATIONS): PanelView {
  const view: PanelView = { stage: "loading", countdown: null, connect: null, disconnect: false, recheckTokenFile: false, needsConfirmations: false, ipHelpOpensByItself: false };
  if (!status) return view;
  switch (status.state) {
    case "noKey":
      return { ...view, stage: "noKey", connect: { label: "키움에 연결", enabled: false, acknowledged: false, readyNotice: false } };
    case "disconnected":
      return { ...view, stage: "disconnected", connect: { label: "키움에 연결", enabled: true, acknowledged: false, readyNotice: false } };
    case "connecting":
      return { ...view, stage: "connecting" };
    case "connected":
      return { ...view, stage: "connected", disconnect: true };
    case "failed":
      return failedView(view, status, now, confirmations);
    default: {
      const _exhaustive: never = status.state;
      return _exhaustive;
    }
  }
}

function failedView(base: PanelView, status: KiwoomLinkStatus, now: UnixSeconds, confirmations: Confirmations): PanelView {
  const countdown = countdownOf(status.retryAt, now);
  const elapsed = !countdown || countdown.remainingSeconds === 0;
  switch (status.problem) {
    case "authBlocked8050": {
      const confirmed = confirmations.registeredIp && confirmations.lockChecked;
      return {
        ...base,
        stage: "authBlocked",
        countdown,
        needsConfirmations: true,
        ipHelpOpensByItself: true,
        connect: { label: waitingLabel(countdown), enabled: confirmed && elapsed, acknowledged: true, readyNotice: confirmed && elapsed && countdown !== null },
      };
    }
    case "issueIntervalWait":
    case "authUncertain":
      return { ...base, stage: "wait", countdown, connect: { label: waitingLabel(countdown), enabled: elapsed, acknowledged: false, readyNotice: elapsed } };
    case "network":
      return { ...base, stage: "network", countdown, connect: { label: countdown && !elapsed ? waitingLabel(countdown) : "다시 시도", enabled: elapsed, acknowledged: false, readyNotice: false } };
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
  reveal: boolean;
  editing: boolean;
}

export type KeyFormEvent =
  | { type: "appKey"; value: string }
  | { type: "appSecret"; value: string }
  | { type: "toggleReveal" }
  | { type: "edit" }
  | { type: "cancel" }
  | { type: "saved" };

export const EMPTY_KEY_FORM: KeyForm = { appKey: "", appSecret: "", reveal: false, editing: false };

export function keyFormReducer(form: KeyForm, event: KeyFormEvent): KeyForm {
  switch (event.type) {
    case "appKey":
      return { ...form, appKey: event.value };
    case "appSecret":
      return { ...form, appSecret: event.value };
    case "toggleReveal":
      return { ...form, reveal: !form.reveal };
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
