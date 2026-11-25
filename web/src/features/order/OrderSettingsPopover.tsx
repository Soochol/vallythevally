import { useRef, useState } from "react";
import type { Venue } from "../../api/generated/Venue";
import { CogIcon } from "../icons";
import { Popover } from "../overlay/Popover";
import { setLadderRate } from "../workspace/canvasCommands";
import { Segmented } from "../market-window/parts";
import { AMOUNT_PRESET_COUNT, KEEP_LAST_ENTRY_LABEL, ORDER_ROUTES, ORDER_SOUND_LABEL, type OrderSettings, routeLabel, withAmountPreset } from "./orderSettings";
import { primeOrderSound } from "./orderSound";
import { MOCK_KRX_ONLY_TEXT, REJECT_TEXT } from "./statusText";

const MOCK_DISABLED_ROUTES: readonly Venue[] = ["combined", "nxt"];

interface Props {
  readonly settings: OrderSettings;
  readonly venue: Venue;
  readonly mock: boolean;
  readonly nxtNotTraded: boolean;
  readonly holding: boolean;
  readonly onChange: (settings: OrderSettings) => void;
}

const FLAGS: readonly { readonly key: "keepLastEntry" | "averageDot" | "divider" | "rate" | "skipSpreadGap" | "maskAccount" | "sound"; readonly label: string; readonly title?: string }[] = [
  { key: "keepLastEntry", label: KEEP_LAST_ENTRY_LABEL, title: "마지막으로 선택한 수량을 그 창의 그 종목마다 기억해 다시 열 때 그 값으로 시작합니다" },
  { key: "averageDot", label: "평단가 점" },
  { key: "divider", label: "구분선" },
  { key: "rate", label: "등락률 표시" },
  { key: "skipSpreadGap", label: "호가 사이 빈 가격 건너뛰기", title: "매도·매수 1호가 사이가 벌어지면 빈 가격 행을 건너뛰어 매도 10단·매수 10단을 채웁니다. 10호가창에도 적용" },
  { key: "maskAccount", label: "계좌번호 가리기" },
  { key: "sound", label: ORDER_SOUND_LABEL, title: "매수 주문 접수, 매도 주문 접수, 주문 체결 시 소리로 알립니다" },
];

interface PresetInputProps {
  readonly settings: OrderSettings;
  readonly index: number;
  readonly label: string;
  readonly onChange: (settings: OrderSettings) => void;
}

function PresetInput({ settings, index, label, onChange }: PresetInputProps) {
  const saved = String(settings.amountPresets[index]);
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      aria-label={label}
      inputMode="numeric"
      value={draft ?? saved}
      onChange={(e) => {
        const text = e.target.value.replace(/[^0-9]/g, "");
        setDraft(text);
        const next = withAmountPreset(settings, index, text);
        if (next !== settings) onChange(next);
      }}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      onBlur={() => setDraft(null)}
    />
  );
}

export function OrderSettingsPopover({ settings, venue, mock, nxtNotTraded, holding, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);

  return (
    <div className="od-settings">
      <button type="button" ref={opener} className="od-gear" data-testid="order-settings-button" aria-label={`호가주문 설정 · 주문 경로 ${routeLabel(venue)}`} aria-expanded={open} data-warn={nxtNotTraded ? "" : undefined} title={nxtNotTraded ? REJECT_TEXT.nxt_unavailable : undefined} onClick={() => setOpen((was) => !was)}>
        <span className="od-gear-route">{routeLabel(venue)}</span>
        <CogIcon size={14} />
      </button>
      {open && (
        <Popover solid anchor={opener} releasesClick={(target) => opener.current?.contains(target) === true} onClose={() => setOpen(false)} role="dialog" aria-label="호가주문 설정" className="od-settings-pop" data-testid="order-settings">
          <p className="od-settings-head">모든 호가주문창에 적용</p>
          <fieldset>
            <legend>주문 경로</legend>
            <Segmented label="주문 경로" options={ORDER_ROUTES} value={venue} disabled={mock ? MOCK_DISABLED_ROUTES : undefined} onChange={(next) => onChange({ ...settings, venue: next })} />
            {mock && <p className="od-route-note" data-testid="order-route-note">{MOCK_KRX_ONLY_TEXT}</p>}
          </fieldset>
          <fieldset>
            <legend>금액 프리셋 (만원)</legend>
            <div className="od-settings-presets">
              {Array.from({ length: AMOUNT_PRESET_COUNT }, (_, index) => (
                <PresetInput key={index} settings={settings} index={index} label={`금액 프리셋 ${index + 1}`} onChange={onChange} />
              ))}
            </div>
          </fieldset>
          {FLAGS.map(({ key, label, title }) => (
            <label key={key} className="od-settings-flag" title={title}>
              <input
                type="checkbox"
                checked={settings[key]}
                onChange={(e) => {
                  const checked = e.target.checked;
                  if (key === "rate") {
                    setLadderRate(checked);
                    return;
                  }
                  onChange({ ...settings, [key]: checked });
                  if (key === "sound" && checked) primeOrderSound();
                }}
              />
              {label}
              {key === "averageDot" && !holding && <small>보유 종목일 때 보입니다</small>}
            </label>
          ))}
        </Popover>
      )}
    </div>
  );
}
