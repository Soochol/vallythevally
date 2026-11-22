import type { PresetKind } from "./orderSettings";

export const MAX_ORDER_ENTRIES = 300;

export interface OrderEntry {
  readonly presetKind: PresetKind;
  readonly quantity: number;
  readonly usedAt: number;
}

export type OrderEntries = Readonly<Record<string, OrderEntry>>;

export const NO_ORDER_ENTRIES: OrderEntries = {};

export const orderEntryKey = (layoutId: string, windowId: string, code: string): string => `${layoutId}|${windowId}|${code}`;

const isEntry = (x: unknown): x is OrderEntry => {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const { presetKind, quantity, usedAt } = x as Record<string, unknown>;
  return (presetKind === "sharePresets" || presetKind === "amountPresets") && typeof quantity === "number" && Number.isSafeInteger(quantity) && quantity > 0 && typeof usedAt === "number" && Number.isFinite(usedAt);
};

function mostRecent(entries: readonly (readonly [string, OrderEntry])[]): OrderEntries {
  const kept = entries.length > MAX_ORDER_ENTRIES ? [...entries].sort((a, b) => b[1].usedAt - a[1].usedAt).slice(0, MAX_ORDER_ENTRIES) : entries;
  return Object.fromEntries(kept);
}

export function parseOrderEntries(raw: unknown): OrderEntries {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return NO_ORDER_ENTRIES;
  const valid = Object.entries(raw).flatMap(([key, entry]) => (isEntry(entry) ? [[key, { presetKind: entry.presetKind, quantity: entry.quantity, usedAt: entry.usedAt }] as const] : []));
  return mostRecent(valid);
}

export const withOrderEntry = (entries: OrderEntries, key: string, entry: OrderEntry): OrderEntries => mostRecent([...Object.entries(entries).filter(([other]) => other !== key), [key, entry]]);
