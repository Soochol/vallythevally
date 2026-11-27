import { useRef, useState } from "react";
import { CogIcon } from "../icons";
import { Segmented } from "../market-window/parts";
import { LADDER_DENSITIES, LADDER_DENSITY_LABEL, type OrderSettings } from "../order/orderSettings";
import { Popover } from "../overlay/Popover";
import { setLadderRate } from "../workspace/canvasCommands";

interface Props {
  readonly settings: OrderSettings;
  readonly onChange: (settings: OrderSettings) => void;
}

export function BookSettingsPopover({ settings, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);

  return (
    <div className="bk-settings">
      <button
        type="button"
        ref={opener}
        className="od-gear bk-gear"
        data-testid="book-settings-button"
        aria-label="10호가 설정"
        aria-expanded={open}
        title="10호가 설정"
        onClick={() => setOpen((was) => !was)}
      >
        <CogIcon size={14} />
      </button>
      {open && (
        <Popover
          solid
          anchor={opener}
          releasesClick={(target) => opener.current?.contains(target) === true}
          onClose={() => setOpen(false)}
          role="dialog"
          aria-label="10호가 설정"
          className="od-settings-pop"
          data-testid="book-settings"
        >
          <p className="od-settings-head">10호가·호가주문창에 적용</p>
          <fieldset>
            <legend>{LADDER_DENSITY_LABEL}</legend>
            <Segmented
              label={LADDER_DENSITY_LABEL}
              options={LADDER_DENSITIES}
              value={settings.ladderDensity}
              onChange={(ladderDensity) => onChange({ ...settings, ladderDensity })}
            />
          </fieldset>
          <label className="od-settings-flag">
            <input
              type="checkbox"
              checked={settings.divider}
              onChange={(e) => onChange({ ...settings, divider: e.target.checked })}
            />
            구분선
          </label>
          <label className="od-settings-flag">
            <input
              type="checkbox"
              checked={settings.rate}
              onChange={(e) => setLadderRate(e.target.checked)}
            />
            등락률 표시
          </label>
          <label className="od-settings-flag" title="호가 사이에 빈 가격이 있으면 건너뛰어 매도 10단·매수 10단을 채웁니다">
            <input
              type="checkbox"
              checked={settings.skipSpreadGap}
              onChange={(e) => onChange({ ...settings, skipSpreadGap: e.target.checked })}
            />
            호가 사이 빈 가격 건너뛰기
          </label>
        </Popover>
      )}
    </div>
  );
}
