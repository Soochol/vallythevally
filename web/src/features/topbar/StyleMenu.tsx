import { useEffect, useRef, useState } from "react";
import { CHART_STYLE_LABEL, type ChartStyle } from "../../chart/settings";
import { CandleIcon, CheckIcon, ChevronIcon } from "../icons";

const STYLES = Object.keys(CHART_STYLE_LABEL) as ChartStyle[];

/** 봉 모양 메뉴: 캔들·바·라인·영역. */
export function StyleMenu({ value, onChange }: { value: ChartStyle; onChange: (s: ChartStyle) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    items.current[STYLES.indexOf(value)]?.focus();
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, value]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    const i = items.current.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      items.current[(i + step + STYLES.length) % STYLES.length]?.focus();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        className="tb-btn"
        title={`봉 모양: ${CHART_STYLE_LABEL[value]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <CandleIcon />
        <span className="sr-only">봉 모양</span>
        <ChevronIcon />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="봉 모양"
          onKeyDown={onMenuKey}
          className="absolute left-0 top-[calc(100%+4px)] z-40 flex min-w-[120px] flex-col rounded-m border border-line bg-surface p-1 shadow-dialog"
        >
          {STYLES.map((s, i) => (
            <button
              key={s}
              ref={(el) => {
                items.current[i] = el;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={s === value}
              className="flex h-[28px] items-center gap-2 rounded-s px-2 text-left hover:bg-raised focus-visible:bg-raised aria-checked:text-accent"
              onClick={() => {
                onChange(s);
                close();
              }}
            >
              <span className="w-[14px]">{s === value && <CheckIcon />}</span>
              {CHART_STYLE_LABEL[s]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
