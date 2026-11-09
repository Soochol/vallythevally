import { type RefObject, useEffect, useRef } from "react";
import { CheckIcon } from "../icons";

export type MenuItem =
  | { kind: "radio"; label: string; checked: boolean; onSelect(): void }
  | { kind: "check"; label: string; checked: boolean; onSelect(): void }
  | { kind: "action"; label: string; disabled?: boolean; onSelect(): void }
  | { kind: "heading"; label: string }
  | { kind: "separator" };

type Focusable = Extract<MenuItem, { onSelect(): void }>;

const ROLE = { radio: "menuitemradio", check: "menuitemcheckbox", action: "menuitem" } as const;

interface Props {
  label: string;
  items: readonly MenuItem[];
  /** restoreFocus면 메뉴를 연 버튼으로 초점을 돌려야 한다(Esc, 고름). 바깥을 누르거나 Tab이면 false. */
  onClose: (restoreFocus: boolean) => void;
  /** 이 안을 누르면 바깥으로 치지 않는다(여는 버튼과 메뉴를 함께 감싼 요소). */
  root: RefObject<HTMLElement | null>;
  className: string;
  style?: React.CSSProperties;
}

/** 펼침 메뉴. 열리면 고른 항목(없으면 첫 항목)에 초점, ↑↓로 옮기고 Enter로 고르고 Esc로 닫는다. 체크 항목은 눌러도 닫지 않는다. */
export function Menu({ label, items, onClose, root, className, style }: Props) {
  const self = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const focusable = () => buttons.current.filter((b): b is HTMLButtonElement => b !== null && !b.disabled);

  useEffect(() => {
    const all = focusable();
    (all.find((b) => b.getAttribute("role") === "menuitemradio" && b.getAttribute("aria-checked") === "true") ?? all[0])?.focus();
  }, []);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const inside = e.target instanceof Node && (root.current?.contains(e.target) || self.current?.contains(e.target));
      if (!inside) onClose(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose, root]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const all = focusable();
    const i = all.findIndex((el) => el === document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      all[(i + step + all.length) % all.length]?.focus();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      onClose(true);
    } else if (e.key === "Tab") {
      onClose(false);
    }
  };

  buttons.current = [];
  return (
    <div
      ref={self}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={style}
      className={`z-40 flex min-w-[120px] flex-col whitespace-nowrap rounded-m border border-line bg-surface p-1 shadow-dialog ${className}`}
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
      disabled={item.kind === "action" ? item.disabled : undefined}
      className="flex h-[28px] items-center gap-2 rounded-s px-2 text-left hover:bg-raised focus-visible:bg-raised disabled:opacity-40 disabled:hover:bg-transparent aria-checked:text-accent max-md:h-[40px]"
      onClick={() => {
        item.onSelect();
        if (item.kind !== "check") onClose(true);
      }}
    >
      <span className="w-[14px]">{checkable && item.checked && <CheckIcon />}</span>
      {item.label}
    </button>
  );
}
