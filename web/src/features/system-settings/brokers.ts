import type { Broker } from "../../api/generated/Broker";

export interface BrokerEntry {
  name: string;
  shortName: string;
  chipColor: string;
  inputFields: readonly ("alias" | "appKey" | "appSecret")[];
}

export const BROKERS: Record<Broker, BrokerEntry> = {
  kiwoom: { name: "키움증권", shortName: "키움", chipColor: "#9b7fe8", inputFields: ["alias", "appKey", "appSecret"] },
};

export const brokerOrder = (): Broker[] => Object.keys(BROKERS) as Broker[];
