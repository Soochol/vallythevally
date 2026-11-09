import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { Connection } from "../../api/socket";
import { formatKstClock, isMarketOpen } from "../../chart/time";

export type ConnectionTone = "gray" | "mint" | "amber" | "red";

export interface ConnectionView {
  tone: ConnectionTone;
  pulse: boolean;
  text: string;
}

/** 상태 줄의 점과 문장(frontend.md §2.2). */
export function connectionView(c: Connection, now: UnixSeconds): ConnectionView {
  if (c.socket !== "open") return { tone: "gray", pulse: false, text: "서버에 다시 연결하는 중" };
  const { realtime, since, backfilling } = c.status;
  switch (realtime) {
    case "halted":
      return { tone: "red", pulse: false, text: "키움 인증 실패: 서버 설정을 확인하세요" };
    case "reconnecting":
      return { tone: "amber", pulse: false, text: `키움에 다시 연결하는 중 (${formatKstClock(since)}부터)` };
    case "live":
      if (backfilling) return { tone: "amber", pulse: false, text: "끊긴 구간 메우는 중" };
      return isMarketOpen(now)
        ? { tone: "mint", pulse: true, text: "실시간 연결됨" }
        : { tone: "mint", pulse: false, text: "장 닫힘: 체결 없음" };
    default: {
      const _exhaustive: never = realtime;
      return _exhaustive;
    }
  }
}
