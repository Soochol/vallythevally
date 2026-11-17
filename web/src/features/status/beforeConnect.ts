import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { KEPT_DISCONNECTED_NOTE } from "../system-settings/kiwoomPanel";
import { type LinkAction, linkAction, STEP_NAMES } from "./linkAction";

export interface BeforeConnect {
  title: string;
  detail: string;
  note: string | null;
  waitingUntil: { retryAt: UnixSeconds | null } | null;
  action: LinkAction | null;
  canOpenSettings: boolean;
}

const base: BeforeConnect = { title: "", detail: "", note: null, waitingUntil: null, action: null, canOpenSettings: false };

export function beforeConnect(link: KiwoomLinkStatus | null): BeforeConnect | null {
  if (!link) return null;
  switch (link.state) {
    case "noKey":
      return { ...base, title: "키움 키를 넣으면 시세가 보입니다", detail: "시스템 설정에서 키움 앱 키를 넣으면 바로 연결합니다.", canOpenSettings: true };
    case "disconnected":
      return {
        ...base,
        title: "키움에 연결하지 않았습니다",
        detail: "연결하면 차트와 시세를 볼 수 있습니다.",
        note: link.atStart === "keptDisconnected" ? KEPT_DISCONNECTED_NOTE : null,
        action: linkAction(link),
      };
    case "connecting":
      if (link.step === "issueInterval") return { ...base, title: "키움에 연결하는 중입니다", detail: "", note: "기다리는 동안 키움에 아무것도 보내지 않습니다", waitingUntil: { retryAt: link.retryAt } };
      return { ...base, title: "키움에 연결하는 중입니다", detail: link.step ? `단계 · ${STEP_NAMES[link.step]}` : "연결되면 차트가 보입니다." };
    case "failed": {
      const action = linkAction(link);
      return { ...base, title: "키움에 연결하지 못했습니다", detail: link.message, action, canOpenSettings: action === null };
    }
    case "connected":
      return null;
    default: {
      const _exhaustive: never = link.state;
      return _exhaustive;
    }
  }
}

export const NOT_CONNECTED_FALLBACK: BeforeConnect = { ...base, title: "키움에 연결하지 않았습니다", detail: "연결하면 차트와 시세를 볼 수 있습니다.", canOpenSettings: true };

export function useBeforeConnect(): BeforeConnect | null {
  return beforeConnect(useKiwoomLinkStore((s) => s.status));
}
