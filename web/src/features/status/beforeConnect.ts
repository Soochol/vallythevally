import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";

export interface BeforeConnect {
  title: string;
  detail: string;
  canOpenSettings: boolean;
}

export function beforeConnect(link: KiwoomLinkStatus | null): BeforeConnect | null {
  if (!link) return null;
  switch (link.state) {
    case "noKey":
      return { title: "키움 키를 넣으면 시세가 보입니다", detail: "시스템 설정에서 키움 앱 키를 넣고 연결하세요.", canOpenSettings: true };
    case "disconnected":
      return { title: "키움에 연결하지 않았습니다", detail: "연결하면 차트와 시세를 볼 수 있습니다.", canOpenSettings: true };
    case "connecting":
      return { title: "키움에 연결하는 중입니다", detail: "연결되면 차트가 보입니다.", canOpenSettings: false };
    case "failed":
      return { title: "키움에 연결하지 못했습니다", detail: link.message, canOpenSettings: true };
    case "connected":
      return null;
    default: {
      const _exhaustive: never = link.state;
      return _exhaustive;
    }
  }
}

export const NOT_CONNECTED_FALLBACK: BeforeConnect = { title: "키움에 연결하지 않았습니다", detail: "연결하면 차트와 시세를 볼 수 있습니다.", canOpenSettings: true };

export function useBeforeConnect(): BeforeConnect | null {
  return beforeConnect(useKiwoomLinkStore((s) => s.status));
}
