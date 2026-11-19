import { type ReactNode, type RefObject, useEffect, useId, useRef } from "react";
import { Popover } from "../overlay/Popover";
import { menuIndex, type Placement } from "../overlay/position";
import { CheckIcon } from "../icons";

export type MenuItem =
  | { kind: "radio"; label: string; value?: string; icon?: ReactNode; hint?: string; checked: boolean; onSelect(): void }
  | { kind: "check"; label: string; value?: string; checked: boolean; onSelect(): void }
  | { kind: "action"; label: string; icon?: ReactNode; hint?: string; disabled?: boolean; danger?: boolean; onSelect(): void }
  | { kind: "heading"; label: string }
  | { kind: "group"; label: string; labelShown: boolean; items: readonly Focusable[] }
  | { kind: "separator" };

type Focusable = Extract<MenuItem, { kind: "radio" | "check" | "action" }>;

const ROLE = { radio: "menuitemradio", check: "menuitemcheckbox", action: "menuitem" } as const;

export interface MenuFilter {
  label: string;
  placeholder: string;
  value: string;
  onChange(value: string): void;
}

interface Props {
  label: string;
  items: readonly MenuItem[];
  onClose: (restoreFocus: boolean) => void;
  root: RefObject<HTMLElement | null>;
  className?: string;
  placement?: Placement;
  style?: React.CSSProperties;
  filter?: MenuFilter;
  children?: ReactNode;
}

export function Menu({ label, items, onClose, root, className, placement, style, filter, children }: Props) {
  const point = typeof style?.left === "number" && typeof style?.top === "number" ? { x: style.left, y: style.top } : undefined;
  const trigger = useRef<HTMLElement | null>(point ? null : root.current?.tagName === "BUTTON" ? root.current : root.current?.querySelector<HTMLElement>("[aria-expanded=true]") ?? root.current?.querySelector<HTMLElement>("button") ?? null);
  const focusTarget = useRef<HTMLElement | null>(point
    ? (typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null)
    : trigger.current);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const typed = useRef({ text: "", at: 0 });
  const focusable = () => buttons.current.filter((b): b is HTMLButtonElement => b !== null && !b.disabled);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const all = focusable();
    const i = all.findIndex((el) => el === document.activeElement);
    const typing = e.target instanceof HTMLInputElement;
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (typing && e.key === "Enter") {
      e.preventDefault();
      all[0]?.click();
    } else if (["ArrowDown", "ArrowUp"].includes(e.key) || (!typing && ["Home", "End"].includes(e.key))) {
      e.preventDefault();
      all[menuIndex(all.map((b) => b.textContent ?? ""), i, typing && i < 0 && e.key === "ArrowUp" ? "End" : e.key)]?.focus();
    } else if (e.key === "Tab" && (!children || e.shiftKey || document.activeElement !== all.at(-1))) onClose(true);
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && e.key !== " " && !typing) {
      e.preventDefault();
      if (filter) {
        filter.onChange(filter.value + e.key);
        e.currentTarget.querySelector("input")?.focus();
        return;
      }
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
      placement={placement}
      focusTarget={focusTarget}
      onClose={() => onClose(true)}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{ minWidth: style?.minWidth }}
      className={`z-40 flex min-w-[120px] flex-col whitespace-nowrap p-1 ${className ?? ""}`}
    >
      {filter && <MenuFilterInput filter={filter} />}
      {items.map((item, i) => {
        if (item.kind === "separator") return <div key={i} role="separator" className="my-1 border-t border-line" />;
        if (item.kind === "heading") {
          return (
            <div key={i} role="presentation" className="px-2 pb-0.5 pt-1 text-xs text-text-3">
              {item.label}
            </div>
          );
        }
        const register = (el: HTMLButtonElement | null) => buttons.current.push(el);
        if (item.kind === "group") return <MenuGroup key={i} item={item} onClose={onClose} register={register} />;
        return <MenuButton key={i} item={item} onClose={onClose} register={register} />;
      })}
      {children}
    </Popover>
  );
}

function MenuFilterInput({ filter }: { filter: MenuFilter }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return <input ref={input} type="text" aria-label={filter.label} placeholder={filter.placeholder} value={filter.value} autoComplete="off" spellCheck={false}
    onChange={(e) => filter.onChange(e.target.value)}
    className="mb-1 h-8 flex-none rounded-m border border-line bg-transparent px-2 text-s text-text outline-none placeholder:text-text-3 focus:border-accent max-md:h-10" />;
}

function MenuGroup({ item, onClose, register }: { item: Extract<MenuItem, { kind: "group" }>; onClose: Props["onClose"]; register(el: HTMLButtonElement | null): void }) {
  const labelId = useId();
  return (
    <div role="group" className="flex flex-col" {...(item.labelShown ? { "aria-labelledby": labelId } : { "aria-label": item.label })}>
      {item.labelShown && (
        <div id={labelId} className="px-2 pb-0.5 pt-1 text-xs text-text-3">
          {item.label}
        </div>
      )}
      {item.items.map((entry, i) => (
        <MenuButton key={i} item={entry} onClose={onClose} register={register} />
      ))}
    </div>
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
      className={`group flex h-8 shrink-0 items-center gap-2 rounded-m px-2 text-left hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] disabled:hover:bg-transparent aria-checked:text-accent max-md:h-[40px] ${item.kind === "action" && item.danger ? "text-danger" : ""}`}
      onClick={() => {
        item.onSelect();
        if (item.kind !== "check") onClose(true);
      }}
    >
      <span className="grid w-4 place-items-center">{item.kind === "action" ? item.icon : item.checked && <CheckIcon />}</span>
      {item.kind === "radio" && item.icon}
      <span className="group-disabled:opacity-40">{item.label}</span>
      {"hint" in item && item.hint && <span className="ml-auto pl-4 text-xs text-text-2">{item.hint}</span>}
    </button>
  );
}
