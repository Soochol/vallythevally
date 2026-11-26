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
  up: "text-up font-[600]",
  down: "text-down font-[600]",
  flat: "text-text-3 font-[500]",
};
const RATE_MARK: Record<ChangeDirection, string> = { up: "▲", down: "▼", flat: "" };

export const listRowFill = (active: boolean) => (active ? "bg-accent-soft" : "hover:bg-[var(--hover)]");

interface ListHeadProps {
  template: CSSProperties;
  className?: string;
  title?: string;
  indent?: number;
  children: ReactNode;
}

export function ListHead({ template, className = "", title, indent, children }: ListHeadProps) {
  return (
    <div className={`grid h-7 flex-none items-center border-b border-line bg-bg px-3 ${LIST_HEAD} ${className}`} style={{ ...template, columnGap: LIST_COLUMN_GAP, paddingLeft: indent }} aria-hidden="true" title={title}>
      {children}
    </div>
  );
}

export function SymbolName({ name, code, id }: { name: string; code: SymbolCode; id?: string }) {
  return <b id={id} title={name === code ? code : `${name} ${code}`} className="block min-w-0 truncate text-b font-[600] tracking-[-0.01em] text-text-name">{name}</b>;
}

export function PriceText({ children, direction, id }: { children: ReactNode; direction?: ChangeDirection; id?: string }) {
  return <span id={id} className={`block whitespace-nowrap text-right text-b font-[500] ${direction ? DIRECTION_TEXT[direction] : "text-text-price"}`}>{children}</span>;
}

export function RateBadge({ direction, children: signed, id, cell }: { direction: ChangeDirection; children: string; id?: string; cell?: string }) {
  const magnitude = signed.replace(/^[+−]/, "");
  return (
    <span id={id} data-cell={cell} className={`inline-flex h-[22px] w-full items-center justify-end gap-0.5 whitespace-nowrap rounded-s px-1.5 text-right text-xs leading-none ${RATE_BADGE[direction]}`}>
      <span aria-hidden="true" className="inline-flex items-center gap-0.5">
        {RATE_MARK[direction] && <span className="scale-75 leading-none">{RATE_MARK[direction]}</span>}
        <span>{magnitude}</span>
      </span>
      <span className="sr-only">{signed}</span>
    </span>
  );
}
