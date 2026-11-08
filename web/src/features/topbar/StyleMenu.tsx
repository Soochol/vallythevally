import { useCallback, useRef, useState } from "react";
import { CHART_STYLE_LABEL, type ChartStyle } from "../../chart/settings";
import { CandleIcon, ChevronIcon } from "../icons";
import { RadioMenu } from "../menu/RadioMenu";

const OPTIONS = (Object.keys(CHART_STYLE_LABEL) as ChartStyle[]).map((s) => ({ value: s, label: CHART_STYLE_LABEL[s] }));

/** 봉 모양 메뉴: 캔들·바·라인·영역. */
export function StyleMenu({ value, onChange }: { value: ChartStyle; onChange: (s: ChartStyle) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  }, []);

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
        <RadioMenu
          label="봉 모양"
          options={OPTIONS}
          value={value}
          onChoose={onChange}
          onClose={close}
          root={root}
          className="absolute left-0 top-[calc(100%+4px)]"
        />
      )}
    </div>
  );
}
