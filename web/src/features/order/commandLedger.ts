export type Settlement = "answered" | "unanswered";

export interface Issued {
  readonly id: string;
  readonly send: boolean;
}

type Entry = { readonly id: string; readonly phase: "inflight" | "retry" };

export type WindowResends = ReadonlyMap<string, readonly string[]>;

export interface CommandLedger {
  issue(action: string): Issued;
  settle(action: string, settlement: Settlement): void;
  issueEach(windowId: string, action: string): string;
  settleEach(windowId: string, action: string, id: string, settlement: Settlement): void;
  takeWindowResends(windowId: string): WindowResends;
  restoreWindowResends(windowId: string, resends: WindowResends): void;
}

export function createLedger(newId: (action: string) => string): CommandLedger {
  const entries = new Map<string, Entry>();
  const resendQueues = new Map<string, Map<string, string[]>>();
  return {
    issueEach(windowId, action) {
      const queues = resendQueues.get(windowId);
      const queue = queues?.get(action);
      const resend = queue?.shift();
      if (queue?.length === 0) queues?.delete(action);
      if (queues?.size === 0) resendQueues.delete(windowId);
      return resend ?? newId(action);
    },
    settleEach(windowId, action, id, settlement) {
      if (settlement !== "unanswered") return;
      const queues = resendQueues.get(windowId) ?? new Map<string, string[]>();
      resendQueues.set(windowId, queues);
      const queue = queues.get(action);
      if (queue) queue.push(id);
      else queues.set(action, [id]);
    },
    takeWindowResends(windowId) {
      const queues = resendQueues.get(windowId) ?? new Map<string, string[]>();
      resendQueues.delete(windowId);
      return queues;
    },
    restoreWindowResends(windowId, resends) {
      if (resends.size === 0) resendQueues.delete(windowId);
      else resendQueues.set(windowId, new Map([...resends].map(([action, ids]) => [action, [...ids]])));
    },
    issue(action) {
      const entry = entries.get(action);
      if (entry?.phase === "inflight") return { id: entry.id, send: false };
      const id = entry?.id ?? newId(action);
      entries.set(action, { id, phase: "inflight" });
      return { id, send: true };
    },
    settle(action, settlement) {
      const entry = entries.get(action);
      if (!entry) return;
      if (settlement === "unanswered") entries.set(action, { id: entry.id, phase: "retry" });
      else entries.delete(action);
    },
  };
}

export const newIdFor = (action: string): string => `${action.startsWith("batch|") ? "batch" : "cmd"}-${crypto.randomUUID()}`;

export const orderLedger: CommandLedger = createLedger(newIdFor);

export const placeAction = (code: string, side: string, price: number, quantity: number, venue: string): string => `place|${code}|${side}|${price}|${quantity}|${venue}`;
export const modifyAction = (orderNo: string, price: number): string => `modify|${orderNo}|${price}`;
export const cancelAction = (orderNo: string): string => `cancel|${orderNo}`;
export const cancelBatchAction = (code: string, side: string, price: number): string => `batch|${code}|${side}|${price}`;

export const actionInAccount = (action: string, accountRef: string | null): string => `${action}|${accountRef ?? ""}`;
