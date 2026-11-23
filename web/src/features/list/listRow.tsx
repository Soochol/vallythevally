import type { CSSProperties, ReactNode } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";

export type ChangeDirection = "up" | "down" | "flat";

export const LIST_PRICE_WIDTH = 76;
export const LIST_RATE_WIDTH = 64;
export const LIST_COLUMN_GAP = 8;
export const LIST_EDGE = 12;

export const LIST_HEAD = "text-xs text-text-3";
export const LIST_ROW_HEIGHT = "h-[var(--row-h)]";

export const DIRECTION_TEXT: Record<ChangeDirection, string> = { up: "text-up", down: "text-down", flat: "text-text-2" };

const RATE_BADGE: Record<ChangeDirection, string> = {
  up: "bg-[color-mix(in_srgb,var(--up)_14%,var(--surface))] text-up font-[600]",
  down: "bg-[color-mix(in_srgb,var(--down)_14%,var(--surface))] text-down font-[600]",
  flat: "text-text-3 font-[400]",
};
const RATE_MARK: Record<ChangeDirection, string> = { up: "▲", down: "▼", flat: "" };

export const listRowFill = (active: boolean) => (active ? "bg-accent-soft" : "hover:bg-[var(--hover)]");

interface ListHeadProps {
  template: CSSProperties;
  className?: string;
  title?: string;
  children: ReactNode;
}

export function ListHead({ template, className = "", title, children }: ListHeadProps) {
  return (
    <div className={`grid h-7 flex-none items-center border-b border-line px-3 ${LIST_HEAD} ${className}`} style={{ ...template, columnGap: LIST_COLUMN_GAP }} aria-hidden="true" title={title}>
      {children}
    </div>
  );
}

export function SymbolName({ name, code, id }: { name: string; code: SymbolCode; id?: string }) {
  return <b id={id} title={name === code ? code : `${name} ${code}`} className="block min-w-0 truncate text-m font-[600] text-text-name">{name}</b>;
}

export function PriceText({ children, direction, id }: { children: ReactNode; direction?: ChangeDirection; id?: string }) {
  return <span id={id} className={`block whitespace-nowrap text-right text-m ${direction ? DIRECTION_TEXT[direction] : ""}`}>{children}</span>;
}

export function RateBadge({ direction, children: signed, id, cell }: { direction: ChangeDirection; children: string; id?: string; cell?: string }) {
  const magnitude = signed.replace(/^[+−]/, "");
  return (
    <span id={id} data-cell={cell} className={`block whitespace-nowrap rounded-s px-1 py-0.5 text-right text-s ${RATE_BADGE[direction]}`}>
      <span aria-hidden="true">{RATE_MARK[direction]}{RATE_MARK[direction] && " "}{magnitude}</span>
      <span className="sr-only">{signed}</span>
    </span>
  );
}
