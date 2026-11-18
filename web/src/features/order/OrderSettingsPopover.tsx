import { useEffect, useRef, useState } from "react";
import type { Venue } from "../../api/generated/Venue";
import { GearIcon } from "../icons";
import { Segmented } from "../market-window/parts";
import { type OrderSettings, type PresetKind, SHARE_PRESET_COUNT, withPresetOf } from "./orderSettings";
import { MOCK_KRX_ONLY_TEXT, REJECT_TEXT } from "./statusText";

const ROUTES = [{ value: "combined", label: "SOR" }, { value: "krx", label: "KRX" }, { value: "nxt", label: "NXT" }] as const;
const MOCK_DISABLED_ROUTES: readonly Venue[] = ["combined", "nxt"];
const routeLabel = (venue: Venue): string => ROUTES.find((route) => route.value === venue)!.label;

interface Props {
  readonly settings: OrderSettings;
  readonly venue: Venue;
  readonly mock: boolean;
  readonly nxtNotTraded: boolean;
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

export function OrderSettingsPopover({ settings, venue, mock, nxtNotTraded, holding, onChange }: Props) {
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
      <button type="button" className="od-gear" data-testid="order-settings-button" aria-label={`호가주문 설정 · 주문 경로 ${routeLabel(venue)}`} aria-expanded={open} data-warn={nxtNotTraded ? "" : undefined} title={nxtNotTraded ? REJECT_TEXT.nxt_unavailable : undefined} onClick={() => setOpen((was) => !was)}>
        <span className="od-gear-route">{routeLabel(venue)}</span>
        <GearIcon size={14} />
      </button>
      {open && (
        <div className="od-settings-pop" role="dialog" aria-label="호가주문 설정" data-testid="order-settings">
          <p className="od-settings-head">모든 호가주문창에 적용</p>
          <fieldset>
            <legend>주문 경로</legend>
            <Segmented label="주문 경로" options={ROUTES} value={venue} disabled={mock ? MOCK_DISABLED_ROUTES : undefined} onChange={(next) => onChange({ ...settings, venue: next })} />
            {mock && <p className="od-route-note" data-testid="order-route-note">{MOCK_KRX_ONLY_TEXT}</p>}
          </fieldset>
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
