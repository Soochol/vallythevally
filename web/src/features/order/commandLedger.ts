export type Settlement = "answered" | "unanswered";

export interface Issued {
  readonly id: string;
  readonly send: boolean;
}

type Entry = { readonly id: string; readonly phase: "inflight" | "retry" };

export interface CommandLedger {
  issue(action: string): Issued;
  settle(action: string, settlement: Settlement): void;
  issueEach(action: string): string;
  settleEach(action: string, id: string, settlement: Settlement): void;
}

export function createLedger(newId: (action: string) => string): CommandLedger {
  const entries = new Map<string, Entry>();
  const resendIds = new Map<string, string>();
  return {
    issueEach(action) {
      const resend = resendIds.get(action);
      resendIds.delete(action);
      return resend ?? newId(action);
    },
    settleEach(action, id, settlement) {
      if (settlement === "unanswered") resendIds.set(action, id);
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

export const placeAction = (code: string, side: string, price: number, quantity: number, venue: string): string => `place|${code}|${side}|${price}|${quantity}|${venue}`;
export const modifyAction = (orderNo: string, price: number): string => `modify|${orderNo}|${price}`;
export const cancelAction = (orderNo: string): string => `cancel|${orderNo}`;
export const cancelBatchAction = (code: string, side: string, price: number): string => `batch|${code}|${side}|${price}`;
