import { useId, useRef, useState } from "react";
import type { LineWidth } from "../../chart/settings";
import { colorName, hexToHsv, hsvToHex, isHexColor, normalizeHex, sameColor, TV_COLOR_MATRIX, TV_GRAY_SWATCHES, type HexColor, type HsvColor } from "../../lib/colors";
import { ChevronIcon, CloseIcon, PlusIcon } from "../icons";
import { Popover } from "../overlay/Popover";
import { belowTopbar } from "../overlay/position";
import { readRecent, rememberColor, resolvedColor } from "./ColorPicker";
import type { ThemeSwatch } from "./ColorTable";

const WIDTHS = [1, 2, 3, 4, 5] as const satisfies readonly LineWidth[];

export interface OpacityControl {
  value: number;
  min: number;
  max: number;
  onChange(opacity: number): void;
}

export function ColorStyleTrigger<T extends string = never>({
  label = "선 색",
  triggerLabel,
  value,
  theme = [],
  width,
  size = "sm",
  opacity,
  onColorChange,
  onWidthChange,
}: {
  label?: string;
  triggerLabel?: string;
  value: HexColor | T;
  theme?: readonly ThemeSwatch<T>[];
  width: LineWidth;
  size?: "sm" | "lg";
  opacity?: OpacityControl;
  onColorChange(color: HexColor | T): void;
  onWidthChange(width: LineWidth): void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const themed = theme.find((swatch) => swatch.value === value);
  const hex = isHexColor(value) ? value : resolvedColor(themed?.css ?? "");
  const css = themed?.css ?? hex;
  const shownName = themed?.name ?? colorName(hex);
  const opacityPct = opacity ? Math.round(opacity.value * 100) : null;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="tv-style-trigger"
        data-size={size}
        aria-label={triggerLabel ?? `${label} 및 굵기 설정`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="tv-style-swatch">
          <i style={{ background: css, opacity: opacity ? opacity.value : 1 }} />
        </span>
        <span className="tv-style-line">
          <i style={{ height: width, background: css, opacity: opacity ? opacity.value : 1 }} />
        </span>
        <span className="tv-style-meta">
          {size === "lg" ? `${shownName} · ${width}px${opacityPct !== null ? ` · ${opacityPct}%` : ""}` : `${width}px`}
        </span>
        <span className="tv-style-caret" aria-hidden="true"><ChevronIcon size={12} /></span>
      </button>
      {open && (
        <ColorStylePopover
          label={label}
          value={value}
          theme={theme}
          width={width}
          opacity={opacity}
          trigger={trigger}
          onColorChange={onColorChange}
          onWidthChange={onWidthChange}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function ColorStylePopover<T extends string = never>({
  label,
  value,
  theme,
  width,
  opacity,
  trigger,
  onColorChange,
  onWidthChange,
  onClose,
}: {
  label: string;
  value: HexColor | T;
  theme: readonly ThemeSwatch<T>[];
  width: LineWidth;
  opacity?: OpacityControl;
  trigger: React.RefObject<HTMLButtonElement | null>;
  onColorChange(color: HexColor | T): void;
  onWidthChange(width: LineWidth): void;
  onClose(): void;
}) {
  const id = useId();
  const themed = theme.find((swatch) => swatch.value === value);
  const currentHex = isHexColor(value) ? value : resolvedColor(themed?.css ?? "");
  const currentCss = themed?.css ?? currentHex;
  const [recent, setRecent] = useState<HexColor[]>(readRecent);
  const [addingCustom, setAddingCustom] = useState(false);
  const [hsv, setHsv] = useState<HsvColor>(() => hexToHsv(currentHex));
  const [hexText, setHexText] = useState<string>(currentHex);
  const customHex = hsvToHex(hsv);
  const customValid = normalizeHex(hexText) !== null;

  const chooseHex = (color: HexColor) => {
    rememberColor(color);
    setRecent(readRecent());
    onColorChange(color);
  };

  const changeHsv = (next: HsvColor) => {
    const nextHex = hsvToHex(next);
    setHsv(next);
    setHexText(nextHex);
    onColorChange(nextHex);
  };

  const saveCustom = () => {
    const normalized = normalizeHex(hexText);
    if (!normalized) return;
    chooseHex(normalized);
    setAddingCustom(false);
  };

  const selectSv = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    changeHsv({
      ...hsv,
      s: Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)),
      v: Math.max(0, Math.min(1, 1 - (e.clientY - box.top) / box.height)),
    });
  };

  const opacityPct = opacity ? Math.round(opacity.value * 100) : 100;

  return (
    <Popover
      data-chart-control=""
      anchor={trigger}
      solid
      minTop={belowTopbar}
      onClose={onClose}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-title`}
      className="tv-style-popover"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
        if (e.key === "Enter" && e.target instanceof HTMLInputElement && addingCustom) {
          e.preventDefault();
          e.stopPropagation();
          saveCustom();
        }
      }}
    >
      <div className="tv-style-head">
        <h3 id={`${id}-title`}>{label}</h3>
        <button type="button" className="icon-btn" aria-label="색상 선택 취소" onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>

      {theme.length > 0 && (
        <div role="group" aria-label="테마 색">
          <div className="tv-style-sec-head">
            <span>테마 색</span>
            <span>{themed ? themed.name : currentHex}</span>
          </div>
          <div className="tv-style-theme">
            {theme.map((swatch) => {
              const hex = resolvedColor(swatch.css);
              return (
                <button
                  key={swatch.value}
                  type="button"
                  className="tv-style-theme-cell"
                  style={{ background: swatch.css }}
                  aria-label={`${swatch.name} ${hex}`}
                  aria-pressed={swatch.value === value}
                  onClick={() => onColorChange(swatch.value)}
                />
              );
            })}
          </div>
        </div>
      )}

      <div role="group" aria-label="색상표">
        <div className="tv-style-grays">
          {TV_GRAY_SWATCHES.map((swatch) => (
            <button
              key={swatch.color}
              type="button"
              className="tv-style-cell"
              style={{ background: swatch.color }}
              aria-label={`${swatch.name} ${swatch.color}`}
              aria-pressed={!themed && sameColor(currentHex, swatch.color)}
              onClick={() => chooseHex(swatch.color)}
            />
          ))}
        </div>
        <div className="tv-style-matrix">
          {TV_COLOR_MATRIX.map((row, rowIndex) =>
            row.swatches.map((swatch) => (
              <button
                key={swatch.color}
                type="button"
                className="tv-style-cell"
                data-edge={rowIndex === 0 ? "top" : rowIndex === TV_COLOR_MATRIX.length - 1 ? "bottom" : undefined}
                style={{ background: swatch.color }}
                aria-label={`${swatch.name} ${swatch.color}`}
                aria-pressed={!themed && sameColor(currentHex, swatch.color)}
                onClick={() => chooseHex(swatch.color)}
              />
            )),
          )}
        </div>
      </div>

      <div className="tv-style-div" />

      <div>
        <div className="tv-style-sec-head">
          <span>사용자 지정 색</span>
        </div>
        <div className="tv-style-custom-row" role="group" aria-label="최근 쓴 색상">
          {recent.map((color) => (
            <button
              key={color}
              type="button"
              className="tv-style-custom-sw"
              style={{ background: color }}
              aria-label={`최근 색상 ${color}`}
              aria-pressed={!themed && sameColor(currentHex, color)}
              onClick={() => chooseHex(color)}
            />
          ))}
          <button
            type="button"
            className="tv-style-add-sw"
            aria-label="직접 고르기"
            aria-expanded={addingCustom}
            onClick={() => {
              setHsv(hexToHsv(currentHex));
              setHexText(currentHex);
              setAddingCustom((open) => !open);
            }}
          >
            <PlusIcon size={12} />
          </button>
        </div>

        {addingCustom && (
          <div className="tv-style-custom-box">
            <div
              className="color-sv"
              style={{ backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }}
              role="group"
              tabIndex={0}
              aria-label="채도와 밝기. 화살표로 조절"
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.focus();
                e.currentTarget.setPointerCapture(e.pointerId);
                selectSv(e);
              }}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) selectSv(e);
              }}
              onPointerUp={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
              }}
            >
              <i style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
            </div>
            <input
              type="range"
              className="color-hue"
              aria-label="색조"
              min={0}
              max={359}
              value={hsv.h}
              onChange={(e) => changeHsv({ ...hsv, h: Number(e.target.value) })}
            />
            <div className="tv-style-custom-hex">
              <input
                type="text"
                aria-label="HEX"
                value={hexText}
                maxLength={7}
                spellCheck={false}
                aria-invalid={!customValid}
                onChange={(e) => {
                  setHexText(e.target.value);
                  const parsed = normalizeHex(e.target.value);
                  if (parsed) {
                    setHsv(hexToHsv(parsed));
                    onColorChange(parsed);
                  }
                }}
                onBlur={() => {
                  if (customValid) setHexText(customHex);
                }}
              />
              <button type="button" className="btn-primary disabled:opacity-50" disabled={!customValid} onClick={saveCustom}>
                선택
              </button>
            </div>
            {!customValid && <p role="alert" className="text-xs text-danger"># 뒤에 6자리 색상 코드를 입력하세요.</p>}
          </div>
        )}
      </div>

      {opacity && (
        <>
          <div className="tv-style-div" />
          <div>
            <div className="tv-style-sec-head">
              <span>불투명도</span>
              <span className="tabular-nums">{opacityPct}%</span>
            </div>
            <div className="tv-style-opacity">
              <div className="tv-style-op-track">
                <div className="tv-style-op-grad" style={{ background: `linear-gradient(to right, transparent, ${currentCss})` }} />
                <input
                  type="range"
                  aria-label="불투명도"
                  min={Math.round(opacity.min * 100)}
                  max={Math.round(opacity.max * 100)}
                  step={1}
                  value={opacityPct}
                  aria-valuetext={`${opacityPct}%`}
                  onChange={(e) => opacity.onChange(Number(e.target.value) / 100)}
                />
              </div>
              <output className="tv-style-op-val">{opacityPct}%</output>
            </div>
          </div>
        </>
      )}

      <div className="tv-style-div" />

      <div>
        <div className="tv-style-sec-head">
          <span>선 굵기</span>
          <span>{width}px</span>
        </div>
        <div role="group" aria-label="굵기" className="tv-style-widths">
          {WIDTHS.map((px) => (
            <button
              key={px}
              type="button"
              className="tv-style-width-btn"
              aria-label={String(px)}
              aria-pressed={width === px}
              onClick={() => onWidthChange(px)}
            >
              <i style={{ height: px, background: currentCss }} />
            </button>
          ))}
        </div>
      </div>
    </Popover>
  );
}
