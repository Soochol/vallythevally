import { useState } from "react";
import { type OrderSettings, SHARE_PRESET_COUNT, withPreset } from "./orderSettings";

interface Props {
  readonly settings: OrderSettings;
  readonly onChange: (settings: OrderSettings) => void;
}

const FLAGS = [
  { key: "averageDot", label: "평단가 점" },
  { key: "divider", label: "구분선" },
  { key: "rate", label: "등락률 표시" },
] as const;

export function OrderSettingsPopover({ settings, onChange }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="od-settings">
      <button type="button" className="od-gear" data-testid="order-settings-button" aria-label="호가주문 설정" aria-expanded={open} onClick={() => setOpen((was) => !was)}>⚙</button>
      {open && (
        <div className="od-settings-pop" role="dialog" aria-label="호가주문 설정" data-testid="order-settings">
          <fieldset>
            <legend>수량 프리셋 (주)</legend>
            <div className="od-settings-presets">
              {Array.from({ length: SHARE_PRESET_COUNT }, (_, index) => (
                <input
                  key={index}
                  aria-label={`프리셋 ${index + 1}`}
                  inputMode="numeric"
                  defaultValue={settings.sharePresets[index]}
                  onBlur={(e) => {
                    const next = withPreset(settings, index, e.target.value);
                    e.target.value = String(next.sharePresets[index]);
                    if (next !== settings) onChange(next);
                  }}
                />
              ))}
            </div>
          </fieldset>
          {FLAGS.map(({ key, label }) => (
            <label key={key} className="od-settings-flag">
              <input type="checkbox" checked={settings[key]} onChange={(e) => onChange({ ...settings, [key]: e.target.checked })} />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
