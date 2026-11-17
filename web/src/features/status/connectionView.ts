import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { Connection } from "../../api/socket";
import { formatKstClock, isMarketOpen } from "../../chart/time";
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

function failureText(link: KiwoomLinkStatus): string {
  switch (link.problem) {
    case "authBlocked8050":
      return `키움 인증 차단: ${GO_SETTINGS}`;
    case "keyNeedsCheck":
      return `키움 키 확인 필요: ${GO_SETTINGS}`;
    case "tokenFileUnusable":
      return `토큰 파일을 쓸 수 없습니다: ${GO_SETTINGS}`;
    case "keyFileUnusable":
      return `키 파일을 쓸 수 없습니다: ${GO_SETTINGS}`;
    case "issueIntervalWait":
      return "키움 토큰 발급 간격을 기다리는 중";
    case "authUncertain":
      return `키움 인증을 확신할 수 없습니다: ${GO_SETTINGS}`;
    case "network":
      return "키움에 닿지 못했습니다: 네트워크를 확인하세요";
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

function beforeConnectText(link: KiwoomLinkStatus, now: UnixSeconds): string | null {
  switch (link.state) {
    case "noKey":
      return "키움 키가 없습니다: 시스템 설정에서 넣으세요";
    case "disconnected":
      return disconnectedText(link);
    case "connecting":
      return connectingText(link, now);
    case "failed":
      return failureText(link);
    case "connected":
      return null;
    default: {
      const _exhaustive: never = link.state;
      return _exhaustive;
    }
  }
}

/** 상태 줄의 점과 문장(frontend.md §2.2). */
export function connectionView(c: Connection, now: UnixSeconds, link: KiwoomLinkStatus | null = null): ConnectionView {
  if (c.socket !== "open") return { tone: "gray", pulse: false, action: null, text: "서버에 다시 연결하는 중" };
  const linkText = link && beforeConnectText(link, now);
  if (link && linkText) {
    const action = linkAction(link);
    return { tone: linkDotTone(link), pulse: false, text: linkText, action: action && actionView(action, now) };
  }
  const { realtime, since, backfilling } = c.status;
  switch (realtime) {
    case "notConnected":
      return { tone: "gray", pulse: false, action: null, text: "키움에 연결하지 않았습니다" };
    case "halted":
      return { tone: "red", pulse: false, action: null, text: "실시간 멈춤: 서버를 다시 켜야 합니다" };
    case "reconnecting":
      return { tone: "amber", pulse: false, action: null, text: `키움에 다시 연결하는 중 (${formatKstClock(since)}부터)` };
    case "live":
      if (backfilling) return { tone: "amber", pulse: false, action: null, text: "끊긴 구간 메우는 중" };
      return isMarketOpen(now)
        ? { tone: "mint", pulse: true, action: null, text: "실시간 연결됨" }
        : { tone: "mint", pulse: false, action: null, text: "장 닫힘: 체결 없음" };
    default: {
      const _exhaustive: never = realtime;
      return _exhaustive;
    }
  }
}
