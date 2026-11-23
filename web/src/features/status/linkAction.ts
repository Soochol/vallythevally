import type { KiwoomConnectStep } from "../../api/generated/KiwoomConnectStep";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { Broker } from "../../api/generated/Broker";
import { BROKERS } from "../system-settings/brokers";
import { countdownOf, formatRemaining } from "../system-settings/kiwoomPanel";

export type LinkActionKind = "connect" | "retry";

export interface LinkAction {
  kind: LinkActionKind;
  retryAt: UnixSeconds | null;
}

export interface LinkActionView {
  kind: LinkActionKind;
  label: string;
  enabled: boolean;
}

export const STEP_NAMES: Record<KiwoomConnectStep, string> = {
  checkingKey: "키 확인",
  token: "토큰",
  issueInterval: "발급 간격 대기",
  symbols: "종목 목록",
  realtime: "실시간",
};

export const isWaitingStep = (link: KiwoomLinkStatus): boolean => link.state === "connecting" && link.step === "issueInterval";

export function linkAction(link: KiwoomLinkStatus): LinkAction | null {
  if (link.state === "disconnected") return { kind: "connect", retryAt: null };
  if (link.state === "failed" && link.problem === "network" && !link.needsAcknowledgement) return { kind: "retry", retryAt: link.retryAt };
  return null;
}

export function actionView(action: LinkAction, now: UnixSeconds): LinkActionView {
  if (action.kind === "connect") return { kind: "connect", label: "연결", enabled: true };
  const countdown = countdownOf(action.retryAt, now);
  if (countdown && countdown.remainingSeconds > 0) return { kind: "retry", label: `${formatRemaining(countdown.remainingSeconds)} 뒤 다시 시도`, enabled: false };
  return { kind: "retry", label: "다시 시도", enabled: true };
}

export function waitText(retryAt: UnixSeconds | null, now: UnixSeconds): string {
  const countdown = countdownOf(retryAt, now);
  if (!countdown || countdown.remainingSeconds === 0) return "발급 간격 대기 · 곧 저절로 연결";
  return `발급 간격 대기 · ${formatRemaining(countdown.remainingSeconds)} 뒤 저절로 연결`;
}

export function connectingText(link: KiwoomLinkStatus, now: UnixSeconds, broker: Broker = "kiwoom"): string {
  if (isWaitingStep(link)) return waitText(link.retryAt, now);
  const name = BROKERS[broker].shortName;
  return link.step ? `${name}에 연결하는 중 · ${STEP_NAMES[link.step]}` : `${name}에 연결하는 중`;
}

export function disconnectedText(link: KiwoomLinkStatus, broker: Broker = "kiwoom"): string {
  switch (link.atStart) {
    case "keptDisconnected":
      return "연결을 끊어 두었습니다";
    case "connects":
      return "키는 저장됨 · 연결하지 않았습니다";
    case null:
      return `${BROKERS[broker].shortName}에 연결하지 않았습니다`;
    default: {
      const _exhaustive: never = link.atStart;
      return _exhaustive;
    }
  }
}
