export type Settlement = "answered" | "unanswered";

export interface Issued {
  readonly id: string;
  readonly send: boolean;
}

type Entry = { readonly id: string; readonly phase: "inflight" | "retry" };

export interface WindowResends {
  readonly queues: ReadonlyMap<string, readonly string[]>;
  readonly issued: ReadonlySet<string>;
}

export const NO_WINDOW_RESENDS: WindowResends = { queues: new Map(), issued: new Set() };

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
  const issuedIds = new Map<string, Set<string>>();
  return {
    issueEach(windowId, action) {
      const queues = resendQueues.get(windowId);
      const queue = queues?.get(action);
      const resend = queue?.shift();
      if (queue?.length === 0) queues?.delete(action);
      if (queues?.size === 0) resendQueues.delete(windowId);
      const id = resend ?? newId(action);
      const issued = issuedIds.get(windowId) ?? new Set<string>();
      issued.add(id);
      issuedIds.set(windowId, issued);
      return id;
    },
    settleEach(windowId, action, id, settlement) {
      const issued = issuedIds.get(windowId);
      if (!issued?.delete(id)) return;
      if (issued.size === 0) issuedIds.delete(windowId);
      if (settlement !== "unanswered") return;
      const queues = resendQueues.get(windowId) ?? new Map<string, string[]>();
      resendQueues.set(windowId, queues);
      const queue = queues.get(action);
      if (queue) queue.push(id);
      else queues.set(action, [id]);
    },
    takeWindowResends(windowId) {
      const taken = { queues: resendQueues.get(windowId) ?? new Map<string, string[]>(), issued: issuedIds.get(windowId) ?? new Set<string>() };
      resendQueues.delete(windowId);
      issuedIds.delete(windowId);
      return taken;
    },
    restoreWindowResends(windowId, resends) {
      if (resends.queues.size === 0) resendQueues.delete(windowId);
      else resendQueues.set(windowId, new Map([...resends.queues].map(([action, ids]) => [action, [...ids]])));
      if (resends.issued.size === 0) issuedIds.delete(windowId);
      else issuedIds.set(windowId, new Set(resends.issued));
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
