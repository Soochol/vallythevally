import { type RefObject, useEffect, useRef, useState } from "react";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import { Popover } from "../overlay/Popover";
import { menuIndex, type Placement } from "../overlay/position";
import { CANCEL_CONFIRM_MS } from "./orderRules";
import type { OrderDrag } from "./useOrderDrag";

export type OrderListItem =
  | { kind: "heading"; label: string }
  | { kind: "separator" }
  | { kind: "order"; label: string; order: TradingOpenOrder; disabled: boolean; onSelect(): void }
  | { kind: "cancelRow"; label: string; order: TradingOpenOrder; disabled: boolean; onSelect(): void }
  | { kind: "action"; label: string; danger?: boolean; disabled: boolean; confirm?: string; onSelect(): void };

interface Props {
  label: string;
  items: readonly OrderListItem[];
  drag: OrderDrag;
  root: RefObject<HTMLElement | null>;
  point?: { x: number; y: number };
  placement?: Placement;
  onClose: () => void;
}

const ITEM_CLASS = "group flex h-8 shrink-0 items-center gap-2 rounded-m px-2 text-left hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] disabled:hover:bg-transparent max-md:h-[40px]";

export function OrderList({ label, items, drag, root, point, placement, onClose }: Props) {
  const trigger = useRef<HTMLElement | null>(point ? null : root.current?.tagName === "BUTTON" ? root.current : root.current?.querySelector<HTMLElement>("button") ?? null);
  const focusTarget = useRef<HTMLElement | null>(point ? (document.activeElement instanceof HTMLElement ? document.activeElement : null) : trigger.current);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const typed = useRef({ text: "", at: 0 });
  const [armed, setArmed] = useState<number | null>(null);
  useEffect(() => {
    if (armed === null) return;
    const timer = setTimeout(() => setArmed(null), CANCEL_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    const all = buttons.current.filter((b): b is HTMLButtonElement => b !== null && !b.disabled);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      all[menuIndex(all.map((b) => b.textContent ?? ""), all.findIndex((el) => el === document.activeElement), e.key)]?.focus();
    } else if (e.key === "Tab") onClose();
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && e.key !== " ") {
      e.preventDefault();
      const now = Date.now();
      typed.current = { text: now - typed.current.at < 600 ? typed.current.text + e.key : e.key, at: now };
      all[menuIndex(all.map((b) => b.textContent?.trim() ?? ""), all.findIndex((el) => el === document.activeElement), e.key, typed.current.text)]?.focus();
    }
  };

  buttons.current = [];
  const register = (el: HTMLButtonElement | null) => { buttons.current.push(el); };
  return (
    <Popover solid anchor={trigger} point={point} placement={placement} focusTarget={focusTarget} onClose={(reason) => { if (reason === "escape") drag.abort(); onClose(); }} role="menu" aria-label={label} onKeyDown={onKeyDown}
      className="z-40 flex min-w-[120px] flex-col whitespace-nowrap p-1">
      {items.map((item, i) => {
        if (item.kind === "separator") return <div key={i} role="separator" className="my-1 border-t border-line" />;
        if (item.kind === "heading") return <div key={i} role="presentation" className="px-2 pb-0.5 pt-1 text-xs text-text-3">{item.label}</div>;
        const pick = () => { item.onSelect(); onClose(); };
        if (item.kind === "action") {
          const isArmed = armed === i && item.confirm !== undefined;
          return <button key={i} ref={register} type="button" role="menuitem" disabled={item.disabled} data-armed={isArmed ? "" : undefined} className={`${ITEM_CLASS} ${item.danger ? "text-danger" : ""}`}
            onClick={() => { if (item.confirm !== undefined && armed !== i) setArmed(i); else pick(); }}>
            <span className="group-disabled:opacity-40">{isArmed ? item.confirm : item.label}</span>
          </button>;
        }
        if (item.kind === "cancelRow") {
          return <div key={i} role="presentation" className="od-list-row od-list-order" data-testid="order-list-row"
            onPointerDown={(e) => { if (!item.disabled) drag.begin({ source: { kind: "order", order: item.order }, origin: e.currentTarget.closest("[role=menu]")?.getBoundingClientRect() ?? null, onMoved: onClose }, e); }}>
            <span className="od-list-value">{item.label}</span>
            <button ref={register} type="button" role="menuitem" disabled={item.disabled} aria-label={`${item.label} 취소`} className="od-list-cancel" onClick={pick}>취소</button>
          </div>;
        }
        return <button key={i} ref={register} type="button" role="menuitem" disabled={item.disabled} className={`${ITEM_CLASS} od-list-order`} onClick={pick}
          onPointerDown={(e) => { if (!item.disabled) drag.begin({ source: { kind: "order", order: item.order }, origin: e.currentTarget.closest("[role=menu]")?.getBoundingClientRect() ?? null, onMoved: onClose }, e); }}>
          <span className="group-disabled:opacity-40">{item.label}</span>
        </button>;
      })}
    </Popover>
  );
}
