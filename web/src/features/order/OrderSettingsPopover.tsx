import { useEffect, useRef, useState } from "react";
import { type OrderSettings, type PresetKind, SHARE_PRESET_COUNT, withPresetOf } from "./orderSettings";

interface Props {
  readonly settings: OrderSettings;
  readonly holding: boolean;
  readonly onChange: (settings: OrderSettings) => void;
}

const FLAGS = [
  { key: "averageDot", label: "평단가 점" },
  { key: "divider", label: "구분선" },
  { key: "rate", label: "등락률 표시" },
] as const;

const PRESET_GROUPS = [
  { kind: "sharePresets", legend: "수량 프리셋 (주)", ariaPrefix: "프리셋" },
  { kind: "amountPresets", legend: "금액 프리셋 (만원)", ariaPrefix: "금액 프리셋" },
] as const;

interface PresetInputProps {
  readonly settings: OrderSettings;
  readonly kind: PresetKind;
  readonly index: number;
  readonly label: string;
  readonly onChange: (settings: OrderSettings) => void;
}

function PresetInput({ settings, kind, index, label, onChange }: PresetInputProps) {
  const saved = String(settings[kind][index]);
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      aria-label={label}
      inputMode="numeric"
      value={draft ?? saved}
      onChange={(e) => {
        const text = e.target.value.replace(/[^0-9]/g, "");
        setDraft(text);
        const next = withPresetOf(settings, kind, index, text);
        if (next !== settings) onChange(next);
      }}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      onBlur={() => setDraft(null)}
    />
  );
}

export function OrderSettingsPopover({ settings, holding, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onPointer = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div className="od-settings" ref={root}>
      <button type="button" className="od-gear" data-testid="order-settings-button" aria-label="호가주문 설정" aria-expanded={open} onClick={() => setOpen((was) => !was)}>⚙</button>
      {open && (
        <div className="od-settings-pop" role="dialog" aria-label="호가주문 설정" data-testid="order-settings">
          <p className="od-settings-head">모든 호가주문창에 적용</p>
          {PRESET_GROUPS.map(({ kind, legend, ariaPrefix }) => (
            <fieldset key={kind}>
              <legend>{legend}</legend>
              <div className="od-settings-presets">
                {Array.from({ length: SHARE_PRESET_COUNT }, (_, index) => (
                  <PresetInput key={index} settings={settings} kind={kind} index={index} label={`${ariaPrefix} ${index + 1}`} onChange={onChange} />
                ))}
              </div>
            </fieldset>
          ))}
          {FLAGS.map(({ key, label }) => (
            <label key={key} className="od-settings-flag">
              <input type="checkbox" checked={settings[key]} onChange={(e) => onChange({ ...settings, [key]: e.target.checked })} />
              {label}
              {key === "averageDot" && !holding && <small>보유 종목일 때 보입니다</small>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
