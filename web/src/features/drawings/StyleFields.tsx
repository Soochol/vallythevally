import { type ReactNode, useState } from "react";
import { Select } from "../menu/Select";
import type { StyleField } from "../../chart/drawings/toolSpec";
import { drawingColor } from "../../chart/drawings/DrawingLayer";
import { TEXT_SIZE } from "../../chart/drawings/styleKit";
import type { Dash, TextStyle, Width } from "../../chart/drawings/types";
import { ColorPicker } from "../color/ColorPicker";
import { CloseIcon } from "../icons";
import { Switch } from "../ui/Switch";

export const INPUT = "draw-input";
export function ColorInput({ label, value, compact = false, onChange }: { label: string; value: string; compact?: boolean; onChange(v: string): void }) {
  const color = drawingColor(value);
  return <ColorPicker label={label} value={color} compact={compact} onChange={onChange} />;
}
function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return <Switch label={label} ariaLabel={label} checked={checked} className="draw-toggle" onChange={onChange} />;
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
  return (
    <div className="draw-field-stack">
      <div className="draw-inline-pair">
        <ColorInput label="글자 색" value={value.color} onChange={(color) => change({ ...value, color })} />
        <label className="draw-inline-size">
          <span>크기</span>
          <NumberInput min={TEXT_SIZE.min} max={TEXT_SIZE.max} value={value.size} onChange={(size) => change({ ...value, size })} />
        </label>
      </div>
      <div className="draw-inline-toggles">
        <ToggleRow label="굵게" checked={value.bold} onChange={(bold) => change({ ...value, bold })} />
        <ToggleRow label="기울임" checked={value.italic} onChange={(italic) => change({ ...value, italic })} />
      </div>
    </div>
  );
}

const GOLDEN_LEVELS = new Set([0, 0.382, 0.5, 0.618, 1]);

function strokeTriplePrefix(fields: readonly StyleField<unknown>[], index: number): string | null {
  const f0 = fields[index];
  const f1 = fields[index + 1];
  const f2 = fields[index + 2];
  if (!f0 || !f1 || !f2) return null;
  if (f0.kind !== "color" || f1.kind !== "width" || f2.kind !== "dash") return null;
  if (!f0.label.endsWith(" 색") || !f1.label.endsWith(" 굵기") || !f2.label.endsWith(" 모양")) return null;
  const p0 = f0.label.slice(0, -2);
  const p1 = f1.label.slice(0, -3);
  const p2 = f2.label.slice(0, -3);
  return p0 === p1 && p1 === p2 ? p0 : null;
}

export function StyleFields({ fields, style, text, change, setText }: { fields: readonly StyleField<unknown>[]; style: unknown; text: string | null; change(v: unknown): void; setText(v: string): void }) {
  const set = <V,>(lens: { set(s: unknown, value: V): unknown }, value: V) => change(lens.set(style, value));
  const nodes: ReactNode[] = [];
  for (let idx = 0; idx < fields.length; idx++) {
    const prefix = strokeTriplePrefix(fields, idx);
    if (prefix !== null) {
      const fColor = fields[idx] as Extract<StyleField<unknown>, { kind: "color" }>;
      const fWidth = fields[idx + 1] as Extract<StyleField<unknown>, { kind: "width" }>;
      const fDash = fields[idx + 2] as Extract<StyleField<unknown>, { kind: "dash" }>;
      nodes.push(
        <div className="draw-field" data-kind="stroke-inline" key={`stroke-${prefix}-${idx}`}>
          <span>{prefix}</span>
          <div className="draw-stroke-inline">
            <ColorInput label={fColor.label} value={fColor.lens.get(style)} onChange={(v) => set(fColor.lens, v)} />
            <WidthInput label={fWidth.label} value={fWidth.lens.get(style)} onChange={(v) => set(fWidth.lens, v)} />
            <DashInput label={fDash.label} value={fDash.lens.get(style)} onChange={(v) => set(fDash.lens, v)} />
          </div>
        </div>,
      );
      idx += 2;
      continue;
    }
    const field = fields[idx]!;
    let input: ReactNode;
    switch (field.kind) {
      case "color": input = <ColorInput label={field.label} value={field.lens.get(style)} onChange={(v) => set(field.lens, v)} />; break;
      case "width": input = <WidthInput label={field.label} value={field.lens.get(style)} onChange={(v) => set(field.lens, v)} />; break;
      case "dash": input = <DashInput label={field.label} value={field.lens.get(style)} onChange={(v) => set(field.lens, v)} />; break;
      case "toggle":
        nodes.push(<div className="draw-field" data-kind="toggle" key={field.label}><ToggleRow label={field.label} checked={field.lens.get(style)} onChange={(v) => set(field.lens, v)} /></div>);
        continue;
      case "number": input = <NumberInput label={field.label} min={field.min} max={field.max} step={field.step} value={field.lens.get(style)} onChange={(v) => set(field.lens, v)} />; break;
      case "select": input = <Select label={field.label} className={INPUT} value={field.lens.get(style)} onChange={(value) => set(field.lens, value)} options={field.options} />; break;
      case "text": input = field.multiline ? <textarea aria-label={field.label} className={INPUT} value={text ?? ""} onChange={(e) => setText(e.target.value)} rows={4} /> : <input aria-label={field.label} className={INPUT} value={text ?? ""} onChange={(e) => setText(e.target.value)} />; break;
      case "textStyle": input = <TextAppearance value={field.lens.get(style)} change={(v) => set(field.lens, v)} />; break;
      case "stroke": {
        const v = field.lens.get(style);
        input = (
          <div className="draw-stroke-inline">
            <ColorInput label={`${field.label} 색`} value={v.color} onChange={(color) => set(field.lens, { ...v, color })} />
            <WidthInput label={`${field.label} 굵기`} value={v.width} onChange={(width) => set(field.lens, { ...v, width })} />
            <DashInput label={`${field.label} 모양`} value={v.dash} onChange={(dash) => set(field.lens, { ...v, dash })} />
          </div>
        );
        break;
      }
      case "fill": {
        const v = field.lens.get(style);
        input = (
          <div className="draw-field-stack">
            <div className="draw-inline-pair">
              <ToggleRow label="채움 켜기" checked={v.on} onChange={(on) => set(field.lens, { ...v, on })} />
              <ColorInput label={`${field.label} 색`} value={v.color} onChange={(color) => set(field.lens, { ...v, color })} />
            </div>
            <label className="draw-opacity-row">
              <span>불투명도</span>
              <input aria-label={`${field.label} 불투명도`} type="range" min={0} max={1} step={0.01} value={v.opacity} onChange={(e) => set(field.lens, { ...v, opacity: Number(e.target.value) })} />
              <span className="draw-mono">{Math.round(v.opacity * 100)}%</span>
            </label>
          </div>
        );
        break;
      }
      case "levels": {
        const levels = field.lens.get(style);
        const look = lineLook(style);
        const hasGolden = levels.some((l) => l.value === 0.618);
        input = (
          <div className="draw-field-stack">
            <div className="draw-quick-chips">
              {hasGolden && <button type="button" className="draw-chip-btn" onClick={() => set(field.lens, levels.map((l) => ({ ...l, on: GOLDEN_LEVELS.has(l.value) })))}>황금비만</button>}
              <button type="button" className="draw-chip-btn" onClick={() => set(field.lens, levels.map((l) => ({ ...l, on: true })))}>전체 켜기</button>
              <button type="button" className="draw-chip-btn" onClick={() => set(field.lens, levels.map((l) => ({ ...l, on: false })))}>전체 끄기</button>
            </div>
            {levels.map((level, i) => {
              const replace = (patch: Partial<typeof level>) => set(field.lens, levels.map((l, j) => i === j ? { ...l, ...patch } : l));
              const name = `수준 ${i + 1}`;
              return (
                <div className="draw-level" role="group" aria-label={name} key={i}>
                  <Switch ariaLabel={`${name} 켜기`} checked={level.on} className="draw-switch" onChange={(on) => replace({ on })} />
                  <input aria-label={`${name} 값`} className={INPUT} type="number" step="any" value={level.value} onChange={(e) => { if (Number.isFinite(e.target.valueAsNumber)) replace({ value: e.target.valueAsNumber }); }} />
                  <ColorInput compact label={`${name} 색`} value={level.color} onChange={(color) => replace({ color })} />
                  <LineSample label={`${name} 선 견본`} color={level.color} look={look} />
                  <button type="button" className="icon-btn" aria-label={`${name} 지우기`} onClick={() => set(field.lens, levels.filter((_, j) => j !== i))}><CloseIcon size={14} /></button>
                </div>
              );
            })}
            <button type="button" className="btn self-start" disabled={levels.length >= field.max} onClick={() => set(field.lens, [...levels, { value: 1, color: "$draw", on: true }])}>수준 추가</button>
          </div>
        );
        break;
      }
    }
    nodes.push(<div className="draw-field" data-kind={field.kind} key={field.label}><span>{field.label}</span><div>{input}</div></div>);
  }
  return <>{nodes}</>;
}
