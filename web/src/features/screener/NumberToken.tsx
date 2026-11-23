import { useRef, useState } from "react";
import type { ScreenPeriod } from "../../api/generated/ScreenPeriod";
import { UNIT } from "../../lib/screener";
import { Select } from "../menu/Select";
import { Popover } from "../overlay/Popover";

interface Props {
  label: string;
  meaning: string;
  value: string;
  error?: string;
  describedBy?: string;
  presets: readonly string[];
  period?: ScreenPeriod;
  onChange(value: string, period?: ScreenPeriod): void;
}

const PERIOD_OPTIONS = [{ value: "D", label: "일" }, { value: "W", label: "주" }, { value: "M", label: "월" }] as const;

export function NumberToken({ label, meaning, value, error, describedBy, presets, period, onChange }: Props) {
  const token = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const open = useRef(false);
  const start = () => { open.current = true; setDraft(value); };
  const settle = (next: string | null, refocus: boolean, nextPeriod = period) => {
    if (!open.current) return;
    open.current = false;
    setDraft(null);
    if (next !== null && (next !== value || nextPeriod !== period)) onChange(next, nextPeriod);
    if (refocus) requestAnimationFrame(() => token.current?.focus());
  };
  if (draft === null) {
    return <button ref={token} type="button" aria-label={label} title={meaning} aria-invalid={!!error} aria-describedby={describedBy} className="sentence-token" onClick={start}>{value || "값"}</button>;
  }
  return <>
    <input ref={input} autoFocus aria-label={label} title={meaning} aria-invalid={!!error} aria-describedby={describedBy} inputMode="decimal" autoComplete="off" size={Math.max(2, draft.length + 1)} value={draft}
      className="sentence-token sentence-token-input"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => { if (!(e.relatedTarget instanceof Node && pop.current?.contains(e.relatedTarget))) settle(draft, false); }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") { e.preventDefault(); settle(draft, true); }
      }} />
    <Popover anchor={input} placement="bottom" focus={false} restoreFocus={false} role="dialog" aria-label={`${label} 자주 쓰는 값`} onClose={(reason) => settle(reason === "escape" ? null : draft, reason === "escape")} className="p-2">
      <div ref={pop} className="flex flex-col gap-2">
      {period && <Select label="봉 주기" value={period} options={PERIOD_OPTIONS} className="ui-field px-2" onChange={(next) => settle(draft, true, next)} />}
      {presets.length > 0 && <div className="flex flex-wrap gap-1">{presets.map((preset) => <button key={preset} type="button" className="btn btn-sm" onMouseDown={(e) => e.preventDefault()} onClick={() => settle(preset, true)}>{preset}{period ? UNIT[period] : ""}</button>)}</div>}
      <p className="text-xs text-text-2">Enter 적용 · Esc 취소</p>
      </div>
    </Popover>
  </>;
}
