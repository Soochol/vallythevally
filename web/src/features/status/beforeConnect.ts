import type { Broker } from "../../api/generated/Broker";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { BROKERS } from "../system-settings/brokers";
import { KEPT_DISCONNECTED_NOTE } from "../system-settings/kiwoomPanel";
import { type LinkAction, linkAction, STEP_NAMES } from "./linkAction";

export interface BeforeConnectStep {
  title: string;
  body: string;
}

export interface BeforeConnect {
  title: string;
  detail: string;
  next: string | null;
  steps: readonly BeforeConnectStep[];
  settingsLabel: string;
  note: string | null;
  waitingUntil: { retryAt: UnixSeconds | null } | null;
  action: LinkAction | null;
  canOpenSettings: boolean;
}

export const OPEN_SETTINGS_LABEL = "시스템 설정 열기";

const base: BeforeConnect = { title: "", detail: "", next: null, steps: [], settingsLabel: OPEN_SETTINGS_LABEL, note: null, waitingUntil: null, action: null, canOpenSettings: false };

const currentBroker = (): Broker => useKiwoomLinkStore.getState().source?.broker ?? "kiwoom";

function failedText(problem: KiwoomLinkStatus["problem"], name: string): Pick<BeforeConnect, "title" | "next"> {
  switch (problem) {
    case "authBlocked8050":
      return { title: `${name}이 이 PC의 IP를 거절했습니다(8050)`, next: `${name} 포털에서 이 PC의 공인 IP를 등록한 뒤 시스템 설정을 여세요.` };
    case "network":
      return { title: `${name}에 닿지 못했습니다`, next: "네트워크를 확인한 뒤 다시 시도하세요." };
    case "pathStopped":
      return { title: "실시간 연결이 멈췄습니다", next: "서버를 다시 켠 뒤 화면을 새로 고치세요." };
    case "keyNeedsCheck":
      return { title: `${name}에 연결하지 못했습니다`, next: "시스템 설정에서 앱키와 시크릿을 다시 확인하세요." };
    case "tokenFileUnusable":
    case "keyFileUnusable":
      return { title: `${name}에 연결하지 못했습니다`, next: "시스템 설정에서 파일 위치와 권한을 확인하세요." };
    default:
      return { title: `${name}에 연결하지 못했습니다`, next: null };
  }
}

export function beforeConnect(link: KiwoomLinkStatus | null, broker: Broker = currentBroker()): BeforeConnect | null {
  if (!link) return null;
  const name = BROKERS[broker].shortName;
  switch (link.state) {
    case "noKey":
      return {
        ...base,
        title: `${name} 키를 넣으면 시세가 보입니다`,
        detail: `세 걸음이면 ${name}에 연결합니다.`,
        steps: [
          { title: `포털에서 앱키 받기`, body: `${name} 포털에서 앱키와 시크릿을 발급받습니다.` },
          { title: "공인 IP 등록", body: "포털에 이 PC의 공인 IP를 등록합니다." },
          { title: "키 붙여넣기", body: "시스템 설정에 앱키와 시크릿을 붙여넣으면 바로 연결합니다." },
        ],
        settingsLabel: "키 등록 시작",
        canOpenSettings: true,
      };
    case "disconnected":
      return {
        ...base,
        title: `${name}에 연결하지 않았습니다`,
        detail: "연결하면 차트와 시세를 볼 수 있습니다.",
        note: link.atStart === "keptDisconnected" ? KEPT_DISCONNECTED_NOTE : null,
        action: linkAction(link),
      };
    case "connecting":
      if (link.step === "issueInterval") return { ...base, title: `${name}에 연결하는 중입니다`, detail: "", note: `기다리는 동안 ${name}에 아무것도 보내지 않습니다`, waitingUntil: { retryAt: link.retryAt } };
      return { ...base, title: `${name}에 연결하는 중입니다`, detail: link.step ? `단계 · ${STEP_NAMES[link.step]}` : "연결되면 차트가 보입니다." };
    case "failed": {
      const action = linkAction(link);
      return { ...base, ...failedText(link.problem, name), detail: link.message, action, canOpenSettings: action === null };
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
