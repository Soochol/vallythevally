import { COLOR_TABLE, sameColor, type HexColor } from "../../lib/colors";

export function Swatch({ name, css, hex, pressed, onClick }: { name: string; css: string; hex: HexColor; pressed: boolean; onClick(): void }) {
  return <button type="button" className="color-cell" style={{ background: css }} aria-label={`${name} ${hex}`} aria-pressed={pressed} onClick={onClick} />;
}

export function ColorGrid({ label, selected, onChoose }: { label: string; selected: string; onChoose(color: HexColor): void }) {
  return <div role="group" aria-label={label} className="color-table-rows">
    {COLOR_TABLE.map((row) => <div key={row.label} className="color-table-row" role="group" aria-label={row.label}>
      <span aria-hidden="true">{row.label}</span>
      {row.swatches.map((swatch) => <Swatch key={swatch.color} name={swatch.name} css={swatch.color} hex={swatch.color} pressed={sameColor(selected, swatch.color)} onClick={() => onChoose(swatch.color)} />)}
    </div>)}
  </div>;
}
