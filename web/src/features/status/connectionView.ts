import type { Broker } from "../../api/generated/Broker";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { Connection } from "../../api/socket";
import { formatKstClock, isMarketOpen } from "../../chart/time";
import { BROKERS } from "../system-settings/brokers";
import { linkDotTone } from "../system-settings/linkDot";
import { actionView, connectingText, disconnectedText, type LinkActionView, linkAction } from "./linkAction";

export type ConnectionTone = "gray" | "mint" | "amber" | "red";

export interface ConnectionView {
  tone: ConnectionTone;
  pulse: boolean;
  text: string;
  action: LinkActionView | null;
}

const GO_SETTINGS = "시스템 설정에서 확인하세요";

function failureText(link: KiwoomLinkStatus, name: string): string {
  switch (link.problem) {
    case "authBlocked8050":
      return `${name} 인증 차단: ${GO_SETTINGS}`;
    case "keyNeedsCheck":
      return `${name} 키 확인 필요: ${GO_SETTINGS}`;
    case "tokenFileUnusable":
      return `토큰 파일을 쓸 수 없습니다: ${GO_SETTINGS}`;
    case "keyFileUnusable":
      return `키 파일을 쓸 수 없습니다: ${GO_SETTINGS}`;
    case "issueIntervalWait":
      return `${name} 토큰 발급 간격을 기다리는 중`;
    case "authUncertain":
      return `${name} 인증을 확신할 수 없습니다: ${GO_SETTINGS}`;
    case "network":
      return `${name}에 닿지 못했습니다: 네트워크를 확인하세요`;
    case "pathStopped":
      return "실시간 멈춤: 서버를 다시 켜야 합니다";
    case null:
      return link.message;
    default: {
      const _exhaustive: never = link.problem;
      return _exhaustive;
    }
  }
}

function beforeConnectText(link: KiwoomLinkStatus, now: UnixSeconds, broker: Broker): string | null {
  const name = BROKERS[broker].shortName;
  switch (link.state) {
    case "noKey":
      return `${name} 키가 없습니다: 시스템 설정에서 넣으세요`;
    case "disconnected":
      return disconnectedText(link, broker);
    case "connecting":
      return connectingText(link, now, broker);
    case "failed":
      return failureText(link, name);
    case "connected":
      return null;
    default: {
      const _exhaustive: never = link.state;
      return _exhaustive;
    }
  }
}

/** 상태 줄의 점과 문장(frontend.md §2.2). */
export function connectionView(c: Connection, now: UnixSeconds, link: KiwoomLinkStatus | null = null, broker: Broker = "kiwoom"): ConnectionView {
  const name = BROKERS[broker].shortName;
  if (c.socket !== "open") return { tone: "gray", pulse: false, action: null, text: "서버에 다시 연결하는 중" };
  const linkText = link && beforeConnectText(link, now, broker);
  if (link && linkText) {
    const action = linkAction(link);
    return { tone: linkDotTone(link), pulse: false, text: linkText, action: action && actionView(action, now) };
  }
  const { realtime, since, backfilling } = c.status;
  switch (realtime) {
    case "notConnected":
      return { tone: "gray", pulse: false, action: null, text: `${name}에 연결하지 않았습니다` };
    case "halted":
      return { tone: "red", pulse: false, action: null, text: "실시간 멈춤: 서버를 다시 켜야 합니다" };
    case "reconnecting":
      return { tone: "amber", pulse: false, action: null, text: `${name}에 다시 연결하는 중 (${formatKstClock(since)}부터)` };
    case "live":
      if (backfilling) return { tone: "amber", pulse: false, action: null, text: "끊긴 구간 메우는 중" };
      return isMarketOpen(now)
        ? { tone: "mint", pulse: true, action: null, text: broker === "kiwoom" ? "실시간 연결됨" : `${name} 실시간 연결됨` }
        : { tone: "mint", pulse: false, action: null, text: broker === "kiwoom" ? "장 닫힘: 체결 없음" : `${name} 장 닫힘: 체결 없음` };
    default: {
      const _exhaustive: never = realtime;
      return _exhaustive;
    }
  }
}
