import { Select } from "../menu/Select";
import type { StyleField } from "../../chart/drawings/toolSpec";
import { drawingColor } from "../../chart/drawings/DrawingLayer";
import type { Dash, TextStyle, Width } from "../../chart/drawings/types";
import { ColorPicker } from "../color/ColorPicker";

export const INPUT = "draw-input";
export function ColorInput({ label, value, onChange }: { label: string; value: string; onChange(v: string): void }) {
  const color = drawingColor(value);
  return <ColorPicker label={label} value={color} onChange={onChange} />;
}
export function WidthInput({ label, value, onChange }: { label: string; value: Width; onChange(v: Width): void }) {
  return <Select label={label} className={INPUT} value={value} options={([1, 2, 3, 4, 5] as const).map((n) => ({ value: n, label: `${n}px` }))} onChange={onChange} />;
}
export function DashInput({ label, value, onChange }: { label: string; value: Dash; onChange(v: Dash): void }) {
  return <Select label={label} className={INPUT} value={value} options={[{ value: "solid", label: "실선" }, { value: "dashed", label: "파선" }, { value: "dotted", label: "점선" }]} onChange={onChange} />;
}

function TextAppearance({ value, change }: { value: TextStyle; change(v: TextStyle): void }) {
  return <div className="draw-field-stack"><ColorInput label="글자 색" value={value.color} onChange={(color) => change({ ...value, color })} />
    <label>글자 크기<input className={INPUT} type="number" min={8} max={72} value={value.size} onChange={(e) => change({ ...value, size: Math.max(8, Math.min(72, Number(e.target.value))) })} /></label>
    <label><input type="checkbox" checked={value.bold} onChange={(e) => change({ ...value, bold: e.target.checked })} /> 굵게</label>
    <label><input type="checkbox" checked={value.italic} onChange={(e) => change({ ...value, italic: e.target.checked })} /> 기울임</label></div>;
}
export function StyleFields({ fields, style, text, change, setText }: { fields: readonly StyleField<unknown>[]; style: unknown; text: string | null; change(v: unknown): void; setText(v: string): void }) {
  return fields.map((field) => {
    const set = <V,>(lens: { set(s: unknown, value: V): unknown }, value: V) => change(lens.set(style, value));
    let input: React.ReactNode;
    switch (field.kind) {
      case "color": input = <ColorInput label={field.label} value={field.lens.get(style)} onChange={(v) => set(field.lens, v)} />; break;
      case "width": input = <WidthInput label={field.label} value={field.lens.get(style)} onChange={(v) => set(field.lens, v)} />; break;
      case "dash": input = <DashInput label={field.label} value={field.lens.get(style)} onChange={(v) => set(field.lens, v)} />; break;
      case "toggle": input = <input aria-label={field.label} type="checkbox" checked={field.lens.get(style)} onChange={(e) => set(field.lens, e.target.checked)} />; break;
      case "number": input = <input aria-label={field.label} className={INPUT} type="number" min={field.min} max={field.max} step={field.step} value={field.lens.get(style)} onChange={(e) => { const v = e.target.valueAsNumber; if (Number.isFinite(v)) set(field.lens, Math.max(field.min, Math.min(field.max, v))); }} />; break;
      case "select": input = <Select label={field.label} className={INPUT} value={field.lens.get(style)} onChange={(value) => set(field.lens, value)} options={field.options} />; break;
      case "text": input = field.multiline ? <textarea aria-label={field.label} className={INPUT} value={text ?? ""} onChange={(e) => setText(e.target.value)} rows={3} /> : <input aria-label={field.label} className={INPUT} value={text ?? ""} onChange={(e) => setText(e.target.value)} />; break;
      case "textStyle": input = <TextAppearance value={field.lens.get(style)} change={(v) => set(field.lens, v)} />; break;
      case "stroke": {
        const v = field.lens.get(style);
        input = <div className="draw-field-stack"><ColorInput label={`${field.label} 색`} value={v.color} onChange={(color) => set(field.lens, { ...v, color })} />
          <WidthInput label={`${field.label} 굵기`} value={v.width} onChange={(width) => set(field.lens, { ...v, width })} />
          <DashInput label={`${field.label} 모양`} value={v.dash} onChange={(dash) => set(field.lens, { ...v, dash })} /></div>; break;
      }
      case "fill": {
        const v = field.lens.get(style);
        input = <div className="draw-field-stack"><label><input type="checkbox" checked={v.on} onChange={(e) => set(field.lens, { ...v, on: e.target.checked })} /> 채움 켜기</label>
          <ColorInput label={`${field.label} 색`} value={v.color} onChange={(color) => set(field.lens, { ...v, color })} />
          <label>불투명도<input aria-label={`${field.label} 불투명도`} type="range" min={0} max={1} step={0.01} value={v.opacity} onChange={(e) => set(field.lens, { ...v, opacity: Number(e.target.value) })} /></label></div>; break;
      }
      case "levels": {
        const levels = field.lens.get(style);
        input = <div className="draw-field-stack">{levels.map((level, i) => {
          const replace = (patch: Partial<typeof level>) => set(field.lens, levels.map((l, j) => i === j ? { ...l, ...patch } : l));
          return <div className="draw-level" key={i}><input aria-label={`수준 ${i + 1} 켜기`} type="checkbox" checked={level.on} onChange={(e) => replace({ on: e.target.checked })} />
            <input aria-label={`수준 ${i + 1} 값`} className={INPUT} type="number" step="any" value={level.value} onChange={(e) => { if (Number.isFinite(e.target.valueAsNumber)) replace({ value: e.target.valueAsNumber }); }} />
            <ColorInput label={`수준 ${i + 1} 색`} value={level.color} onChange={(color) => replace({ color })} />
            <button type="button" className="icon-btn" aria-label={`수준 ${i + 1} 지우기`} onClick={() => set(field.lens, levels.filter((_, j) => j !== i))}>×</button></div>;
        })}<button type="button" className="tb-btn" disabled={levels.length >= field.max} onClick={() => set(field.lens, [...levels, { value: 1, color: "$draw", on: true }])}>수준 추가</button></div>; break;
      }
    }
    return <div className="draw-field" key={field.label}><span>{field.label}</span><div>{input}</div></div>;
  });
}
