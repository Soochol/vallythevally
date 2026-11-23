import type { Broker } from "../../api/generated/Broker";

export interface BrokerEntry {
  name: string;
  shortName: string;
  blurb: string;
  inputFields: readonly ("alias" | "appKey" | "appSecret" | "accountNo" | "htsId")[];
  sourceNote: string | null;
  realtimeLimit: number | null;
}

export const BROKERS: Record<Broker, BrokerEntry> = {
  kiwoom: { name: "키움증권", shortName: "키움", blurb: "앱키와 시크릿으로 연결합니다", inputFields: ["alias", "appKey", "appSecret"], sourceNote: null, realtimeLimit: null },
  kis: { name: "한국투자증권", shortName: "한투", blurb: "앱키·시크릿과 계좌번호로 연결합니다", inputFields: ["alias", "appKey", "appSecret", "accountNo", "htsId"], sourceNote: "한투는 분봉을 1분봉에서 만들고, 실시간은 40건까지입니다", realtimeLimit: 40 },
};

export const brokerOrder = (): Broker[] => ["kiwoom", "kis"];

export const takesAccountNumber = (broker: Broker): boolean => BROKERS[broker].inputFields.includes("accountNo");
