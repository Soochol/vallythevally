import { registerWindowReclaim } from "../../stores/windowReclaim";

export type Settlement = "answered" | "unanswered";

export interface Issued {
  readonly id: string;
  readonly send: boolean;
}

type Entry = { readonly id: string; readonly phase: "inflight" | "retry" };

export interface WindowResends {
  readonly queues: Map<string, string[]>;
}

export const newWindowResends = (): WindowResends => ({ queues: new Map() });

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
  const windowRecords = new Map<string, WindowResends>();
  const ownerOfId = new Map<string, WindowResends>();
  const recordOf = (windowId: string): WindowResends => {
    const existing = windowRecords.get(windowId);
    if (existing) return existing;
    const created = newWindowResends();
    windowRecords.set(windowId, created);
    return created;
  };
  return {
    issueEach(windowId, action) {
      const record = recordOf(windowId);
      const queue = record.queues.get(action);
      const resend = queue?.shift();
      if (queue?.length === 0) record.queues.delete(action);
      const id = resend ?? newId(action);
      ownerOfId.set(id, record);
      return id;
    },
    settleEach(_windowId, action, id, settlement) {
      const record = ownerOfId.get(id);
      ownerOfId.delete(id);
      if (!record || settlement !== "unanswered") return;
      const queue = record.queues.get(action);
      if (queue) queue.push(id);
      else record.queues.set(action, [id]);
    },
    takeWindowResends(windowId) {
      const record = recordOf(windowId);
      windowRecords.delete(windowId);
      return record;
    },
    restoreWindowResends(windowId, resends) {
      windowRecords.set(windowId, resends);
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

registerWindowReclaim<WindowResends>({
  empty: newWindowResends,
  take: (_layoutId, windowId) => orderLedger.takeWindowResends(windowId),
  restore: (_layoutId, windowId, resends) => orderLedger.restoreWindowResends(windowId, resends),
});

export const placeAction = (code: string, side: string, price: number, quantity: number, venue: string): string => `place|${code}|${side}|${price}|${quantity}|${venue}`;
export const modifyAction = (orderNo: string, price: number): string => `modify|${orderNo}|${price}`;
export const cancelAction = (orderNo: string): string => `cancel|${orderNo}`;
export const cancelBatchAction = (code: string, side: string, price: number): string => `batch|${code}|${side}|${price}`;

export const actionInAccount = (action: string, accountRef: string | null): string => `${action}|${accountRef ?? ""}`;
