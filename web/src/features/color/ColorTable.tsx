import { useRef, useState } from "react";
import { colorName, isHexColor, sameColor, type HexColor } from "../../lib/colors";
import { ColorGrid, Swatch } from "./ColorGrid";
import { ColorDialog, readRecent, rememberColor, resolvedColor } from "./ColorPicker";

export interface ThemeSwatch<T extends string> { name: string; value: T; css: string }

export function ColorTable<T extends string = never>({ label, value, theme = [], width = 1, onChange }: {
  label: string;
  value: HexColor | T;
  theme?: readonly ThemeSwatch<T>[];
  width?: number;
  onChange(color: HexColor | T): void;
}) {
  const [recent] = useState(readRecent);
  const [custom, setCustom] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const themed = theme.find((swatch) => swatch.value === value);
  const hex = isHexColor(value) ? value : resolvedColor(themed?.css ?? "");
  const chooseHex = (color: HexColor) => { rememberColor(color); onChange(color); };
  return <div role="group" aria-label={label} className="color-table">
    <div className="color-table-head"><span>{label}</span><span><i style={{ background: themed?.css ?? hex }} />{themed?.name ?? colorName(hex)}</span></div>
    {theme.length > 0 && <>
      <div role="group" aria-label="테마 색" className="color-table-row" data-theme-row="">
        <span aria-hidden="true">테마</span>
        {theme.map((swatch) => <Swatch key={swatch.value} name={swatch.name} css={swatch.css} hex={resolvedColor(swatch.css)} pressed={swatch.value === value} onClick={() => onChange(swatch.value)} />)}
      </div>
      <hr />
    </>}
    <ColorGrid label="색상표" selected={themed ? "" : hex} onChoose={chooseHex} />
    <hr />
    <div role="group" aria-label="최근 쓴 색상" className="color-table-row">
      <span aria-hidden="true">최근</span>
      {recent.length ? recent.map((color) => <Swatch key={color} name="최근 색상" css={color} hex={color} pressed={!themed && sameColor(hex, color)} onClick={() => chooseHex(color)} />) : <p>고른 색이 여기에 모입니다.</p>}
    </div>
    <div className="color-table-foot">
      <span className="ui-field"><span>HEX</span>{hex}</span>
      <button ref={trigger} type="button" className="tb-btn" aria-haspopup="dialog" aria-expanded={custom} onClick={() => setCustom((open) => !open)}>직접 고르기</button>
    </div>
    {custom && <ColorDialog label={label} initial={hex} width={width} trigger={trigger} startCustom onCancel={() => setCustom(false)} onApply={(color) => { onChange(color); setCustom(false); }} />}
  </div>;
}
