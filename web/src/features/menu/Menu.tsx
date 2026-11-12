import { type ReactNode, type RefObject, useRef } from "react";
import { Popover } from "../overlay/Popover";
import { menuIndex } from "../overlay/position";
import { CheckIcon } from "../icons";

export type MenuItem =
  | { kind: "radio"; label: string; value?: string; checked: boolean; onSelect(): void }
  | { kind: "check"; label: string; value?: string; checked: boolean; onSelect(): void }
  | { kind: "action"; label: string; icon?: ReactNode; hint?: string; disabled?: boolean; onSelect(): void }
  | { kind: "heading"; label: string }
  | { kind: "separator" };

type Focusable = Extract<MenuItem, { onSelect(): void }>;

const ROLE = { radio: "menuitemradio", check: "menuitemcheckbox", action: "menuitem" } as const;

interface Props {
  label: string;
  items: readonly MenuItem[];
  onClose: (restoreFocus: boolean) => void;
  root: RefObject<HTMLElement | null>;
  className?: string;
  style?: React.CSSProperties;
}

export function Menu({ label, items, onClose, root, className, style }: Props) {
  const point = typeof style?.left === "number" && typeof style?.top === "number" ? { x: style.left, y: style.top } : undefined;
  const trigger = useRef<HTMLElement | null>(point ? null : root.current?.querySelector<HTMLElement>("[aria-expanded=true]") ?? root.current?.querySelector<HTMLElement>("button") ?? null);
  const focusTarget = useRef<HTMLElement | null>(point
    ? (typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null)
    : trigger.current);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const typed = useRef({ text: "", at: 0 });
  const focusable = () => buttons.current.filter((b): b is HTMLButtonElement => b !== null && !b.disabled);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const all = focusable();
    const i = all.findIndex((el) => el === document.activeElement);
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      all[menuIndex(all.map((b) => b.textContent ?? ""), i, e.key)]?.focus();
    } else if (e.key === "Tab") onClose(true);
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && e.key !== " ") {
      e.preventDefault();
      const now = Date.now();
      typed.current = { text: now - typed.current.at < 600 ? typed.current.text + e.key : e.key, at: now };
      all[menuIndex(all.map((b) => b.textContent?.trim() ?? ""), i, e.key, typed.current.text)]?.focus();
    }

  };

  buttons.current = [];
  return (
    <Popover
      anchor={trigger}
      point={point}
      focusTarget={focusTarget}
      onClose={() => onClose(true)}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{ minWidth: style?.minWidth }}
      className={`z-40 flex min-w-[120px] flex-col whitespace-nowrap rounded-m border border-line bg-surface p-1 shadow-dialog ${className ?? ""}`}
    >
      {items.map((item, i) => {
        if (item.kind === "separator") return <div key={i} role="separator" className="my-1 border-t border-line" />;
        if (item.kind === "heading") {
          return (
            <div key={i} role="presentation" className="px-2 pb-0.5 pt-1 text-xs text-text-3">
              {item.label}
            </div>
          );
        }
        return <MenuButton key={i} item={item} onClose={onClose} register={(el) => buttons.current.push(el)} />;
      })}
    </Popover>
  );
}

function MenuButton({ item, onClose, register }: { item: Focusable; onClose: Props["onClose"]; register(el: HTMLButtonElement | null): void }) {
  const checkable = item.kind !== "action";
  return (
    <button
      ref={register}
      type="button"
      role={ROLE[item.kind]}
      aria-checked={checkable ? item.checked : undefined}
      data-option-value={checkable ? item.value : undefined}
      disabled={item.kind === "action" ? item.disabled : undefined}
      className="group flex h-[30px] items-center gap-2 rounded-s px-2 text-left hover:bg-raised focus-visible:bg-raised disabled:hover:bg-transparent aria-checked:text-accent max-md:h-[40px]"
      onClick={() => {
        item.onSelect();
        if (item.kind !== "check") onClose(true);
      }}
    >
      <span className="w-[14px]">{item.kind === "action" ? item.icon : item.checked && <CheckIcon />}</span>
      <span className="group-disabled:opacity-40">{item.label}</span>
      {item.kind === "action" && item.hint && <span className="ml-auto pl-4 text-xs text-text-2">{item.hint}</span>}
    </button>
  );
}
