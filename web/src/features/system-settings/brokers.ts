import type { Broker } from "../../api/generated/Broker";

export interface BrokerEntry {
  name: string;
  shortName: string;
  chipColor: string;
  inputFields: readonly ("alias" | "appKey" | "appSecret")[];
  sourceNote: string | null;
  realtimeLimit: number | null;
}

export const BROKERS: Record<Broker, BrokerEntry> = {
  kiwoom: { name: "키움증권", shortName: "키움", chipColor: "#9b7fe8", inputFields: ["alias", "appKey", "appSecret"], sourceNote: null, realtimeLimit: null },
  kis: { name: "한국투자증권", shortName: "한투", chipColor: "#3f9fd8", inputFields: ["alias", "appKey", "appSecret"], sourceNote: "한투는 분봉을 1분봉에서 만들고, 실시간은 40건까지입니다", realtimeLimit: 40 },
};

export const brokerOrder = (): Broker[] => ["kiwoom", "kis"];
