import { Popover } from "../overlay/Popover";
import { belowTopbar } from "../overlay/position";
import { useId, useRef, useState } from "react";
import { FALLBACK_PICKED_COLOR, hexToHsv, hsvToHex, isHexColor, normalizeHex, type HexColor, type HsvColor } from "../../lib/colors";
import { CheckIcon, ChevronIcon, CloseIcon } from "../icons";
import { ColorGrid } from "./ColorGrid";

const RECENT_KEY = "vv.recent-colors.v1";


export function rememberColor(color: HexColor): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([color, ...readRecent().filter((c) => c !== color)].slice(0, 8))); } catch {}
}

export function readRecent(): HexColor[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(stored) ? [...new Set(stored.filter(isHexColor))].slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function resolvedColor(value: string): HexColor {
  const direct = normalizeHex(value);
  if (direct) return direct;
  const variable = typeof document === "undefined" ? undefined : /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  return (variable ? normalizeHex(getComputedStyle(document.documentElement).getPropertyValue(variable)) : null) ?? FALLBACK_PICKED_COLOR;
}

export interface ColorOpacityControl {
  value: number;
  min?: number;
  max?: number;
  onChange(opacity: number): void;
}

export interface ColorToggleControl {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
}

export function ColorPicker({ label, value, width = 1, compact = false, live = false, opacity, toggle, onChange }: {
  label: string;
  value: string;
  width?: number;
  compact?: boolean;
  live?: boolean;
  opacity?: ColorOpacityControl;
  toggle?: ColorToggleControl;
  onChange(color: HexColor): void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const swatchOpacity = toggle && !toggle.checked ? 0 : opacity ? opacity.value : 1;
  return (
    <div className="color-control" data-compact={compact}>
      <button ref={trigger} type="button" className="color-trigger" aria-label={`${label} 선택`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <i className={opacity || toggle ? "color-swatch-alpha" : undefined} style={opacity || toggle ? undefined : { background: value }}>
          {(opacity || toggle) && <span style={{ background: value, opacity: swatchOpacity }} />}
        </i>
        <span>{isHexColor(value) ? value.toUpperCase() : "색상 선택"}</span>
        <ChevronIcon />
      </button>
      <span className="color-line-sample" role="img" aria-label={`${label} · 굵기 ${width} 선 샘플`}><i style={{ background: value, height: width, opacity: swatchOpacity }} /></span>
      {open && <ColorDialog label={label} initial={resolvedColor(value)} width={width} live={live} opacity={opacity} toggle={toggle} trigger={trigger} onCancel={() => setOpen(false)} onApply={(color) => { onChange(color); setOpen(false); }} onLiveChange={live ? onChange : undefined} />}
    </div>
  );
}

export function ColorDialog({ label, initial, width, trigger, startCustom = false, live = false, opacity, toggle, onCancel, onApply, onLiveChange }: {
  label: string;
  initial: HexColor;
  width: number;
  startCustom?: boolean;
  live?: boolean;
  opacity?: ColorOpacityControl;
  toggle?: ColorToggleControl;
  trigger: React.RefObject<HTMLButtonElement | null>;
  onCancel(): void;
  onApply(color: HexColor): void;
  onLiveChange?(color: HexColor): void;
}) {
  const id = useId();
  const [custom, setCustom] = useState(startCustom);
  const [hsv, setHsv] = useState(() => hexToHsv(initial));
  const [text, setText] = useState<string>(initial);
  const [recent] = useState(readRecent);
  const color = hsvToHex(hsv);
  const valid = normalizeHex(text) !== null;
  const choose = (next: HexColor) => {
    setHsv(hexToHsv(next));
    setText(next);
    if (live && onLiveChange) {
      rememberColor(next);
      onLiveChange(next);
    }
  };
  const changeHsv = (next: HsvColor) => {
    const nextHex = hsvToHex(next);
    setHsv(next);
    setText(nextHex);
    if (live && onLiveChange) onLiveChange(nextHex);
  };

  const apply = () => {
    if (!valid) return;
    rememberColor(color);
    onApply(color);
  };

  const cancel = () => {
    if (live && onLiveChange && color !== initial) onLiveChange(initial);
    onCancel();
  };

  const selectSv = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    changeHsv({ ...hsv, s: Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)), v: Math.max(0, Math.min(1, 1 - (e.clientY - box.top) / box.height)) });
  };

  const swatch = (c: HexColor, name: string) => (
    <button key={c} type="button" className="color-swatch" style={{ background: c }} aria-label={`${name} ${c}`} aria-pressed={c === color} onClick={() => choose(c)}>{c === color && <CheckIcon size={13} />}</button>
  );

  const opacityPct = opacity ? Math.round(opacity.value * 100) : 100;

  return (
    <Popover data-chart-control="" anchor={trigger} solid minTop={belowTopbar} onClose={onCancel} role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} className="color-popover"
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
        if (e.key === "Enter" && e.target instanceof HTMLInputElement) { e.preventDefault(); e.stopPropagation(); apply(); }
        if (e.key === "Tab") {
          const nodes = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),[tabindex='0']")].filter((n) => n.tabIndex >= 0 && n.getClientRects().length > 0);
          const first = nodes[0]; const last = nodes.at(-1);
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
          e.stopPropagation();
        }
      }}>
      <div className="color-picker-head">
        <h3 id={`${id}-title`}>{label}</h3>
        <div className="color-picker-head-actions">
          {toggle && (
            <button type="button" role="switch" aria-checked={toggle.checked} aria-label={toggle.label} className="ui-switch draw-switch" onClick={() => toggle.onChange(!toggle.checked)}>
              <span aria-hidden="true" className="ui-switch-track"><span /></span>
            </button>
          )}
          <button type="button" className="icon-btn" aria-label="색상 선택 취소" onClick={cancel}><CloseIcon size={14} /></button>
        </div>
      </div>
      <div className="color-picker-tabs" role="tablist" aria-label="색상 선택 방식" onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setCustom(!custom); e.currentTarget.querySelector<HTMLElement>(custom ? "[data-tab=palette]" : "[data-tab=custom]")?.focus(); } }}>
        <button type="button" data-tab="palette" id={`${id}-palette-tab`} role="tab" aria-selected={!custom} aria-controls={`${id}-palette`} tabIndex={custom ? -1 : 0} onClick={() => setCustom(false)}>기본 색상</button>
        <button type="button" data-tab="custom" id={`${id}-custom-tab`} role="tab" aria-selected={custom} aria-controls={`${id}-custom`} tabIndex={custom ? 0 : -1} onClick={() => setCustom(true)}>사용자 지정</button>
      </div>
      {custom ? (
        <div id={`${id}-custom`} role="tabpanel" aria-labelledby={`${id}-custom-tab`}>
          <div className="color-sv" style={{ backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }} role="group" tabIndex={0} aria-label="채도와 밝기. 화살표로 조절" onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); selectSv(e); }} onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) selectSv(e); }} onPointerUp={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onKeyDown={(e) => {
            const step = e.shiftKey ? 0.1 : 0.01;
            if (e.key === "ArrowLeft") changeHsv({ ...hsv, s: Math.max(0, hsv.s - step) });
            else if (e.key === "ArrowRight") changeHsv({ ...hsv, s: Math.min(1, hsv.s + step) });
            else if (e.key === "ArrowUp") changeHsv({ ...hsv, v: Math.min(1, hsv.v + step) });
            else if (e.key === "ArrowDown") changeHsv({ ...hsv, v: Math.max(0, hsv.v - step) });
            else return;
            e.preventDefault(); e.stopPropagation();
          }}><i style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} /></div>
          <input type="range" className="color-hue" aria-label="색조" min={0} max={359} value={hsv.h} onChange={(e) => changeHsv({ ...hsv, h: Number(e.target.value) })} />
          <label className="color-hex">HEX<input type="text" aria-label="HEX" value={text} maxLength={7} spellCheck={false} aria-invalid={!valid} aria-describedby={!valid ? `${id}-error` : undefined} onChange={(e) => { setText(e.target.value); const c = normalizeHex(e.target.value); if (c) { setHsv(hexToHsv(c)); if (live && onLiveChange) onLiveChange(c); } }} onBlur={() => { if (valid) setText(color); }} /><i style={{ background: color }} /></label>
          {!valid && <p id={`${id}-error`} role="alert" className="mt-2 text-xs text-danger"># 뒤에 6자리 색상 코드를 입력하세요.</p>}
        </div>
      ) : <div id={`${id}-palette`} role="tabpanel" aria-labelledby={`${id}-palette-tab`}><ColorGrid label="기본 색상" selected={color} onChoose={choose} /></div>}
      {opacity && (
        <div className="color-opacity-row">
          <span>불투명도</span>
          <input type="range" aria-label={`${label} 불투명도`} min={Math.round((opacity.min ?? 0) * 100)} max={Math.round((opacity.max ?? 1) * 100)} step={1} value={opacityPct} onChange={(e) => opacity.onChange(Number(e.target.value) / 100)} />
          <output>{opacityPct}%</output>
        </div>
      )}
      <div className="color-recent"><span>최근</span><div className="color-grid" aria-label="최근 쓴 색상">{recent.length ? recent.map((c) => swatch(c, "최근 색상")) : <p>고른 색이 여기에 모입니다</p>}</div></div>
      <div className="color-picker-sample"><span>선 샘플</span><div><i style={{ background: color, height: width, opacity: opacity ? opacity.value : 1 }} /></div><span>{width} px</span></div>
      <div className="color-picker-foot"><button type="button" className="tb-btn border border-line" onClick={cancel}>취소</button><button type="button" className="btn-primary" disabled={!valid} onClick={apply}>선택</button></div>
    </Popover>
  );
}
