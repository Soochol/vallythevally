import type { AutoOrderList } from "./generated/AutoOrderList";
import type { AutoOrderMasterInput } from "./generated/AutoOrderMasterInput";
import type { AutoOrderMasterState } from "./generated/AutoOrderMasterState";
import type { AutoOrderRule } from "./generated/AutoOrderRule";
import type { AutoOrderUpsertInput } from "./generated/AutoOrderUpsertInput";
import { deleteJson, getJson, putJson, sendJson } from "./http";

export const fetchAutoOrders = (): Promise<AutoOrderList> => getJson<AutoOrderList>("/api/trading/auto-orders");

export const createAutoOrder = (input: AutoOrderUpsertInput): Promise<AutoOrderRule> =>
  sendJson<AutoOrderRule>("POST", "/api/trading/auto-orders", JSON.stringify(input));

export const updateAutoOrder = (id: string, input: AutoOrderUpsertInput): Promise<AutoOrderRule> =>
  putJson<AutoOrderRule>(`/api/trading/auto-orders/${encodeURIComponent(id)}`, input);

export const deleteAutoOrder = (id: string): Promise<void> =>
  deleteJson(`/api/trading/auto-orders/${encodeURIComponent(id)}`);

export const setAutoOrdersMaster = (input: AutoOrderMasterInput): Promise<AutoOrderMasterState> =>
  putJson<AutoOrderMasterState>("/api/trading/auto-orders/master", input);
