import type { ReactNode } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";

export type ChangeDirection = "up" | "down" | "flat";

export const LIST_PRICE_WIDTH = 76;
export const LIST_RATE_WIDTH = 60;
export const LIST_COLUMN_GAP = 4;
export const LIST_EDGE = 12;

export const LIST_HEAD = "text-xs text-text-3";
export const LIST_ROW_HEIGHT = "h-[34px]";

const RATE_BADGE: Record<ChangeDirection, string> = { up: "bg-up/10 text-up", down: "bg-down/10 text-down", flat: "bg-raised text-text-2" };

export const listRowFill = (active: boolean) => (active ? "bg-accent-soft" : "hover:bg-[var(--hover)]");

export function SymbolName({ name, code }: { name: string; code: SymbolCode }) {
  return <b title={name === code ? code : `${name} ${code}`} className="block min-w-0 truncate text-m font-[600] text-text-name">{name}</b>;
}

export function PriceText({ children }: { children: ReactNode }) {
  return <span className="block whitespace-nowrap text-right text-m">{children}</span>;
}

export function RateBadge({ direction, children }: { direction: ChangeDirection; children: ReactNode }) {
  return <span className={`block whitespace-nowrap rounded-s px-1 py-0.5 text-right text-s font-[550] ${RATE_BADGE[direction]}`}>{children}</span>;
}
