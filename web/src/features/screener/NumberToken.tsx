import { useRef, useState } from "react";
import type { ScreenPeriod } from "../../api/generated/ScreenPeriod";
import { UNIT } from "../../lib/screener";
import { Select } from "../menu/Select";
import { Popover } from "../overlay/Popover";

interface Props {
  label: string;
  value: string;
  error?: string;
  describedBy?: string;
  presets: readonly string[];
  period?: ScreenPeriod;
  onChange(value: string, period?: ScreenPeriod): void;
}

export function NumberToken({ label, value, error, describedBy, presets, period, onChange }: Props) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<{ value: string; period: ScreenPeriod | undefined } | null>(null);
  const apply = (next: string) => {
    onChange(next, editing?.period);
    setEditing(null);
  };
  return <span className="inline-flex">
    <button ref={anchor} type="button" aria-label={label} aria-haspopup="dialog" aria-expanded={editing !== null} aria-invalid={!!error} aria-describedby={describedBy} className="sentence-token" onClick={() => setEditing({ value, period })}>{value || "값"}</button>
    {editing && <Popover anchor={anchor} placement="bottom" role="dialog" aria-label={`${label} 편집`} onClose={() => setEditing(null)} className="p-3">
      <form className="flex w-[220px] flex-col gap-2" onSubmit={(e) => { e.preventDefault(); apply(editing.value); }}>
        <label className="text-s text-text-2">{label}
          <input autoFocus aria-label={label} className="ui-field mt-1 w-full px-2" inputMode="decimal" autoComplete="off" value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} />
        </label>
        {editing.period && <Select label="봉 주기" value={editing.period} options={[{ value: "D", label: "일" }, { value: "W", label: "주" }, { value: "M", label: "월" }]} className="ui-field px-2" onChange={(period) => setEditing({ ...editing, period })} />}
        {presets.length > 0 && <div aria-label="자주 쓰는 값" className="flex flex-wrap gap-1">{presets.map((preset) => <button key={preset} type="button" className="tb-btn h-7 px-2 text-s" onClick={() => setEditing({ ...editing, value: preset })}>{preset}{editing.period ? UNIT[editing.period] : ""}</button>)}</div>}
        <p className="text-xs text-text-3">Enter로 적용 · Esc로 취소</p>
        <button type="submit" className="btn-primary h-8">적용</button>
      </form>
    </Popover>}
  </span>;
}
