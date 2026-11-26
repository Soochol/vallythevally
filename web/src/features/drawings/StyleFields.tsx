import { useState } from "react";
import { Select } from "../menu/Select";
import type { StyleField } from "../../chart/drawings/toolSpec";
import { drawingColor } from "../../chart/drawings/DrawingLayer";
import { TEXT_SIZE } from "../../chart/drawings/styleKit";
import type { Dash, TextStyle, Width } from "../../chart/drawings/types";
import { ColorPicker } from "../color/ColorPicker";

export const INPUT = "draw-input";
export function ColorInput({ label, value, compact = false, onChange }: { label: string; value: string; compact?: boolean; onChange(v: string): void }) {
  const color = drawingColor(value);
  return <ColorPicker label={label} value={color} compact={compact} onChange={onChange} />;
}
function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="ui-switch draw-switch" onClick={() => onChange(!checked)}><span aria-hidden="true" className="ui-switch-track"><span /></span></button>;
}
function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return <div className="draw-toggle"><span>{label}</span><Switch label={label} checked={checked} onChange={onChange} /></div>;
}
function LineSample({ label, color, look }: { label: string; color: string; look: { width: number; dash: Dash } | null }) {
  const dash = look?.dash ?? "solid";
  return <span role="img" aria-label={label} className="draw-line-sample"><i style={{ borderTopColor: drawingColor(color), borderTopWidth: look?.width ?? 1, borderTopStyle: dash === "solid" ? "solid" : dash }} /></span>;
}
function lineLook(style: unknown): { width: number; dash: Dash } | null {
  const line = typeof style === "object" && style !== null && "line" in style ? style.line : null;
  if (typeof line !== "object" || line === null || !("width" in line) || !("dash" in line)) return null;
  const { width, dash } = line;
  return typeof width === "number" && (dash === "solid" || dash === "dashed" || dash === "dotted") ? { width, dash } : null;
}
const WidthGlyph = ({ width }: { width: Width }) => (
  <span className="draw-width-glyph" aria-hidden="true"><i style={{ height: width }} /></span>
);

const DashGlyph = ({ dash }: { dash: Dash }) => (
  <svg viewBox="0 0 22 10" width="22" height="10" aria-hidden="true" className="flex-none">
    <line x1="1" y1="5" x2="21" y2="5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={dash === "dashed" ? "5 4" : dash === "dotted" ? "1.5 4" : undefined} />
  </svg>
);

export function WidthInput({ label, value, onChange }: { label: string; value: Width; onChange(v: Width): void }) {
  return <Select label={label} className={INPUT} value={value} options={([1, 2, 3, 4, 5] as const).map((n) => ({ value: n, label: `${n}px`, icon: <WidthGlyph width={n} /> }))} onChange={onChange} />;
}
export function DashInput({ label, value, onChange }: { label: string; value: Dash; onChange(v: Dash): void }) {
  return <Select label={label} className={INPUT} value={value} options={([
    { value: "solid", label: "실선", icon: <DashGlyph dash="solid" /> },
    { value: "dashed", label: "파선", icon: <DashGlyph dash="dashed" /> },
    { value: "dotted", label: "점선", icon: <DashGlyph dash="dotted" /> },
  ] as const)} onChange={onChange} />;
}
function NumberInput({ label, min, max, step, value, onChange }: { label?: string; min: number; max: number; step?: number; value: number; onChange(v: number): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return <input aria-label={label} className={INPUT} type="number" min={min} max={max} step={step} value={draft ?? value}
    onChange={(e) => { const v = e.target.valueAsNumber; setDraft(e.target.value); if (Number.isFinite(v) && v >= min) onChange(Math.min(max, v)); }}
    onBlur={() => setDraft(null)} />;
}

function TextAppearance({ value, change }: { value: TextStyle; change(v: TextStyle): void }) {
  return <div className="draw-field-stack"><ColorInput label="글자 색" value={value.color} onChange={(color) => change({ ...value, color })} />
    <label>글자 크기<NumberInput min={TEXT_SIZE.min} max={TEXT_SIZE.max} value={value.size} onChange={(size) => change({ ...value, size })} /></label>
    <ToggleRow label="굵게" checked={value.bold} onChange={(bold) => change({ ...value, bold })} />
    <ToggleRow label="기울임" checked={value.italic} onChange={(italic) => change({ ...value, italic })} /></div>;
}
export function StyleFields({ fields, style, text, change, setText }: { fields: readonly StyleField<unknown>[]; style: unknown; text: string | null; change(v: unknown): void; setText(v: string): void }) {
  return fields.map((field) => {
    const set = <V,>(lens: { set(s: unknown, value: V): unknown }, value: V) => change(lens.set(style, value));
    let input: React.ReactNode;
    switch (field.kind) {
      case "color": input = <ColorInput label={field.label} value={field.lens.get(style)} onChange={(v) => set(field.lens, v)} />; break;
      case "width": input = <WidthInput label={field.label} value={field.lens.get(style)} onChange={(v) => set(field.lens, v)} />; break;
      case "dash": input = <DashInput label={field.label} value={field.lens.get(style)} onChange={(v) => set(field.lens, v)} />; break;
      case "toggle": return <div className="draw-field" data-kind="toggle" key={field.label}><span>{field.label}</span><Switch label={field.label} checked={field.lens.get(style)} onChange={(v) => set(field.lens, v)} /></div>;
      case "number": input = <NumberInput label={field.label} min={field.min} max={field.max} step={field.step} value={field.lens.get(style)} onChange={(v) => set(field.lens, v)} />; break;
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
        input = <div className="draw-field-stack"><ToggleRow label="채움 켜기" checked={v.on} onChange={(on) => set(field.lens, { ...v, on })} />
          <ColorInput label={`${field.label} 색`} value={v.color} onChange={(color) => set(field.lens, { ...v, color })} />
          <label>불투명도<input aria-label={`${field.label} 불투명도`} type="range" min={0} max={1} step={0.01} value={v.opacity} onChange={(e) => set(field.lens, { ...v, opacity: Number(e.target.value) })} /></label></div>; break;
      }
      case "levels": {
        const levels = field.lens.get(style); const look = lineLook(style);
        input = <div className="draw-field-stack">{levels.map((level, i) => {
          const replace = (patch: Partial<typeof level>) => set(field.lens, levels.map((l, j) => i === j ? { ...l, ...patch } : l));
          const name = `수준 ${i + 1}`;
          return <div className="draw-level" role="group" aria-label={name} key={i}><Switch label={`${name} 켜기`} checked={level.on} onChange={(on) => replace({ on })} />
            <input aria-label={`${name} 값`} className={INPUT} type="number" step="any" value={level.value} onChange={(e) => { if (Number.isFinite(e.target.valueAsNumber)) replace({ value: e.target.valueAsNumber }); }} />
            <ColorInput compact label={`${name} 색`} value={level.color} onChange={(color) => replace({ color })} />
            <LineSample label={`${name} 선 견본`} color={level.color} look={look} />
            <button type="button" className="icon-btn" aria-label={`${name} 지우기`} onClick={() => set(field.lens, levels.filter((_, j) => j !== i))}>×</button></div>;
        })}<button type="button" className="tb-btn" disabled={levels.length >= field.max} onClick={() => set(field.lens, [...levels, { value: 1, color: "$draw", on: true }])}>수준 추가</button></div>; break;
      }
    }
    return <div className="draw-field" data-kind={field.kind} key={field.label}><span>{field.label}</span><div>{input}</div></div>;
  });
}
