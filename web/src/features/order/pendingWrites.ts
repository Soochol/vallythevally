import type { OrderSide } from "../../api/generated/OrderSide";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";

export const PENDING_MEMORY_MS = 30_000;

export type PendingState = "sending" | "canceling" | "modifying";

interface Stamped {
  readonly code: string;
  readonly since: number;
}

export type PendingWrite = Stamped & (
  | { readonly kind: "sending"; readonly key: string; readonly side: OrderSide; readonly price: number; readonly quantity: number }
  | { readonly kind: "canceling"; readonly key: string; readonly orderNo: string }
  | { readonly kind: "canceling-price"; readonly key: string; readonly side: OrderSide; readonly price: number }
  | { readonly kind: "modifying"; readonly key: string; readonly orderNo: string }
  | { readonly kind: "placed"; readonly order: TradingOpenOrder; readonly replaces?: string }
  | { readonly kind: "gone"; readonly orderNo: string }
);

type Unstamped<T> = T extends unknown ? Omit<T, "since"> : never;

export type PendingDraft = Unstamped<PendingWrite>;

const isRemembered = (write: PendingWrite): boolean => write.kind === "placed" || write.kind === "gone";

export const isExpired = (write: PendingWrite, now: number): boolean => isRemembered(write) && now - write.since > PENDING_MEMORY_MS;

export interface OpenOrdersFetch {
  readonly orders: readonly TradingOpenOrder[];
  readonly at: number;
}

export function settleAgainstOpenOrders(writes: readonly PendingWrite[], code: string, fetched: OpenOrdersFetch): readonly PendingWrite[] {
  const listed = new Set(fetched.orders.map((order) => order.orderNo));
  return writes.filter((write) => {
    if (write.code !== code) return true;
    if (write.kind === "placed") return fetched.at < write.since || (!listed.has(write.order.orderNo) && write.replaces !== undefined && listed.has(write.replaces));
    if (write.kind === "gone") return listed.has(write.orderNo);
    return true;
  });
}

export interface PendingWrites {
  begin(draft: PendingDraft): void;
  resolve(key: string, replacements: readonly PendingDraft[]): void;
  observe(code: string, fetched: OpenOrdersFetch): void;
  has(key: string): boolean;
  clear(code?: string): void;
  sweep(): void;
  subscribe(listener: () => void): () => void;
  snapshot(): readonly PendingWrite[];
}

const keyOf = (write: PendingWrite): string | null => "key" in write ? write.key : null;

export function createPendingWrites(now: () => number = Date.now): PendingWrites {
  let writes: readonly PendingWrite[] = [];
  const listeners = new Set<() => void>();
  const set = (next: readonly PendingWrite[]) => {
    if (next.length === writes.length && next.every((write, index) => write === writes[index])) return;
    writes = next;
    for (const listener of listeners) listener();
  };
  const stamp = (draft: PendingDraft): PendingWrite => ({ ...draft, since: now() }) as PendingWrite;
  const sweep = () => set(writes.filter((write) => !isExpired(write, now())));
  const remember = (drafts: readonly PendingDraft[]) => {
    if (drafts.some((draft) => draft.kind === "placed" || draft.kind === "gone")) setTimeout(sweep, PENDING_MEMORY_MS + 1);
  };
  return {
    begin: (draft) => set([...writes, stamp(draft)]),
    resolve(key, replacements) {
      const live = writes.some((write) => keyOf(write) === key);
      set([...writes.filter((write) => keyOf(write) !== key), ...(live ? replacements.map(stamp) : [])]);
      if (live) remember(replacements);
    },
    observe: (code, fetched) => set(settleAgainstOpenOrders(writes, code, fetched)),
    has: (key) => writes.some((write) => keyOf(write) === key),
    clear: (code) => set(code === undefined ? [] : writes.filter((write) => write.code !== code)),
    sweep,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => writes,
  };
}

export const pendingWrites = createPendingWrites();
