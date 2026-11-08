import { type RefObject, useEffect, useRef } from "react";
import { CheckIcon } from "../icons";

interface Props<T extends string> {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T | null;
  onChoose: (v: T) => void;
  /** restoreFocus면 메뉴를 연 버튼으로 초점을 돌려야 한다(Esc, 고름). 바깥을 누르거나 Tab이면 false. */
  onClose: (restoreFocus: boolean) => void;
  /** 이 안을 누르면 바깥으로 치지 않는다(여는 버튼과 메뉴를 함께 감싼 요소). */
  root: RefObject<HTMLElement | null>;
  className: string;
}

/** 하나를 고르는 펼침 메뉴. 열리면 고른 항목에 초점, ↑↓로 옮기고 Enter로 고르고 Esc로 닫는다. */
export function RadioMenu<T extends string>({ label, options, value, onChoose, onClose, root, className }: Props<T>) {
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const i = options.findIndex((o) => o.value === value);
    items.current[Math.max(0, i)]?.focus();
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node && root.current?.contains(e.target))) onClose(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [options, value, onClose, root]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = items.current.findIndex((el) => el === document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      items.current[(i + step + options.length) % options.length]?.focus();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      onClose(true);
    } else if (e.key === "Tab") {
      onClose(false);
    }
  };

  return (
    <div
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={`z-40 flex min-w-[120px] flex-col rounded-m border border-line bg-surface p-1 shadow-dialog ${className}`}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            items.current[i] = el;
          }}
          type="button"
          role="menuitemradio"
          aria-checked={o.value === value}
          className="flex h-[28px] items-center gap-2 rounded-s px-2 text-left hover:bg-raised focus-visible:bg-raised aria-checked:text-accent max-md:h-[40px]"
          onClick={() => {
            onChoose(o.value);
            onClose(true);
          }}
        >
          <span className="w-[14px]">{o.value === value && <CheckIcon />}</span>
          {o.label}
        </button>
      ))}
    </div>
  );
}
