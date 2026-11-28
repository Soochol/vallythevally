import { useEffect, useId, useState } from "react";
import type { MaMethod } from "../../api/generated/MaMethod";
import { colorsFrom, INDICATOR_COLORS, indicatorCssColor, shownColor, specName, type IndicatorColor, type IndicatorToken, type SpecOf } from "../../chart/indicators/kinds";
import type { IndicatorConfig, LineWidth } from "../../chart/settings";
import type { WindowId } from "../../layout/kinds";
import { useCell, useLayoutStore } from "../../stores/layout";
import { ColorStyleTrigger } from "../color/ColorStylePopover";
import type { ThemeSwatch } from "../color/ColorTable";
import { Errors } from "../dialog/DialogParts";
import { CloseIcon, EyeIcon, PlusIcon } from "../icons";
import { removeIndicatorWithUndo } from "../indicator-inspector/removalUndo";
import { nextColor } from "./indicatorForm";
import { useValidator } from "./IndicatorSettingsForm";

type MaConfig = IndicatorConfig & { spec: SpecOf<"ma"> };

const THEME_SWATCHES: readonly ThemeSwatch<IndicatorToken>[] = INDICATOR_COLORS.map((token, i) => ({
  name: `테마 ${i + 1}`,
  value: token,
  css: indicatorCssColor(token),
}));

const INT_RE = /^\d+$/;

const SAMPLE_PATHS = [
  "M0 46 C 48 40, 92 16, 152 24 S 250 48, 320 34 S 410 12, 490 16",
  "M0 49 C 56 45, 108 26, 168 30 S 264 46, 336 37 S 420 20, 490 23",
  "M0 52 C 66 50, 126 36, 186 38 S 282 46, 354 41 S 432 28, 490 30",
  "M0 54 C 78 53, 146 44, 210 45 S 306 47, 378 44 S 444 36, 490 37",
  "M0 56 C 92 55, 168 50, 234 50 S 330 50, 400 48 S 456 44, 490 43",
] as const;

export function isMaConfig(config: IndicatorConfig): config is MaConfig {
  return config.spec.kind === "ma";
}

function parseValidPeriod(raw: string, validate: ReturnType<typeof useValidator>, method: MaMethod): number | null {
  const trimmed = raw.trim();
  if (!INT_RE.test(trimmed)) return null;
  const period = Number(trimmed);
  if (period < 1 || period > 65535) return null;
  if (typeof validate === "function" && !validate({ kind: "ma", method, period }).ok) return null;
  return period;
}

function MaLineRow({
  cellId,
  line,
  compact,
  onHover,
  validate,
}: {
  cellId: WindowId;
  line: MaConfig;
  compact: boolean;
  onHover(id: string | null): void;
  validate: ReturnType<typeof useValidator>;
}) {
  const [periodText, setPeriodText] = useState(String(line.spec.period));
  const [error, setError] = useState(false);
  const errorId = useId();

  useEffect(() => {
    setPeriodText(String(line.spec.period));
    setError(false);
  }, [line.spec.period]);

  const color = shownColor(line.spec, line.style.colors);
  const name = specName(line.spec);

  const updatePeriod = (raw: string) => {
    setPeriodText(raw);
    const parsed = parseValidPeriod(raw, validate, line.spec.method);
    if (parsed === null) {
      setError(true);
      return;
    }
    setError(false);
    if (parsed !== line.spec.period) {
      useLayoutStore.getState().updateIndicator(cellId, line.id, { spec: { kind: "ma", method: line.spec.method, period: parsed } });
    }
  };

  const updateMethod = (method: MaMethod) => {
    if (method === line.spec.method) return;
    useLayoutStore.getState().updateIndicator(cellId, line.id, { spec: { kind: "ma", method, period: line.spec.period } });
  };

  const updateColor = (next: IndicatorColor) => {
    useLayoutStore.getState().updateIndicator(cellId, line.id, {
      style: { ...line.style, colors: colorsFrom(line.spec, next) },
    });
  };

  const updateWidth = (width: LineWidth) => {
    useLayoutStore.getState().updateIndicator(cellId, line.id, {
      style: { ...line.style, width },
    });
  };

  return (
    <div
      className="ic-ma-row"
      data-hidden={!line.visible || undefined}
      onMouseEnter={() => onHover(line.id)}
      onMouseLeave={() => onHover(null)}
    >
      <button
        type="button"
        className="icon-btn size-6"
        aria-label={`${name} ${line.visible ? "숨기기" : "보이기"}`}
        aria-pressed={!line.visible}
        title={line.visible ? "숨기기" : "보이기"}
        onClick={() => useLayoutStore.getState().updateIndicator(cellId, line.id, { visible: !line.visible })}
      >
        <EyeIcon size={14} off={!line.visible} />
      </button>

      <ColorStyleTrigger
        label="선 색"
        triggerLabel={`${name} 선 색 및 굵기 설정`}
        value={color}
        theme={THEME_SWATCHES}
        width={line.style.width}
        size={compact ? "xs" : "sm"}
        onColorChange={updateColor}
        onWidthChange={updateWidth}
      />

      <span className="ic-ma-period">
        <input
          type="text"
          inputMode="numeric"
          aria-label={`${name} 기간`}
          aria-invalid={error}
          aria-describedby={error ? errorId : undefined}
          value={periodText}
          autoComplete="off"
          className="ui-field ic-ma-period-input"
          onChange={(e) => updatePeriod(e.target.value)}
          onBlur={() => {
            if (error) {
              setPeriodText(String(line.spec.period));
              setError(false);
            }
          }}
        />
        <span className="text-xs text-text-3">봉</span>
      </span>

      <div role="group" aria-label={`${name} 계산 방식`} className="ic-ma-method">
        <button type="button" aria-pressed={line.spec.method === "sma"} onClick={() => updateMethod("sma")}>단순</button>
        <button type="button" aria-pressed={line.spec.method === "ema"} onClick={() => updateMethod("ema")}>지수</button>
      </div>

      <button
        type="button"
        className="icon-btn size-6 text-text-2 hover:text-danger"
        aria-label={`${name} 지우기`}
        title="지우기"
        onClick={() => removeIndicatorWithUndo(cellId, line)}
      >
        <CloseIcon size={14} />
      </button>
      {error && <div className="col-span-full"><Errors id={errorId} messages={["1 이상의 정수를 입력하세요"]} /></div>}
    </div>
  );
}

export function MaGroupEditor({ cellId }: { cellId: WindowId }) {
  const cell = useCell(cellId);
  return <MaGroupEditorView cellId={cellId} allIndicators={cell.chartSettings.indicators} />;
}

export function MaGroupEditorView({ cellId, allIndicators, compact = false }: { cellId: WindowId; allIndicators: readonly IndicatorConfig[]; compact?: boolean }) {
  const validator = useValidator();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [newPeriod, setNewPeriod] = useState("");
  const [addError, setAddError] = useState(false);
  const addErrorId = useId();

  const maLines = allIndicators.filter(isMaConfig);
  const visibleCount = maLines.filter((line) => line.visible).length;

  const setAllMethod = (method: MaMethod) => {
    const store = useLayoutStore.getState();
    const current = store.layout.windows.find((w) => w.id === cellId && w.kind === "chart");
    if (!current || current.kind !== "chart") return;
    const nextIndicators = current.chartSettings.indicators.map((item) =>
      isMaConfig(item) ? { ...item, spec: { ...item.spec, method } } : item,
    );
    store.setChartSettings(cellId, { ...current.chartSettings, indicators: nextIndicators });
  };

  const sortByPeriod = () => {
    const store = useLayoutStore.getState();
    const current = store.layout.windows.find((w) => w.id === cellId && w.kind === "chart");
    if (!current || current.kind !== "chart") return;
    const sorted = current.chartSettings.indicators.filter(isMaConfig).sort((a, b) => a.spec.period - b.spec.period);
    let cursor = 0;
    const nextIndicators = current.chartSettings.indicators.map((item) => (isMaConfig(item) ? sorted[cursor++]! : item));
    store.setChartSettings(cellId, { ...current.chartSettings, indicators: nextIndicators });
  };

  const addLine = () => {
    const method: MaMethod = maLines.length > 0 && maLines.every((line) => line.spec.method === "ema") ? "ema" : "sma";
    const fallbackPeriod = newPeriod.trim() === "" ? "20" : newPeriod;
    const period = parseValidPeriod(fallbackPeriod, validator, method);
    if (period === null) {
      setAddError(true);
      return;
    }
    setAddError(false);
    const spec: SpecOf<"ma"> = { kind: "ma", method, period };
    const color = nextColor(allIndicators);
    useLayoutStore.getState().addIndicator(cellId, spec, { colors: colorsFrom(spec, color), width: 1 }, "price");
    setNewPeriod("");
  };

  return (
    <>
      {!compact && (
        <div className="ic-ed-head">
          <h3 className="text-l font-semibold">이동평균선</h3>
          <span className="ic-place-badge">가격 패널</span>
          <span className="flex-1" />
          <p className="inline-flex items-center gap-1.5 text-s text-accent">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
            자동 저장됨
          </p>
        </div>
      )}

      <div className="ic-ma-preview">
        <div className="ic-ma-preview-tags">
          {maLines.map((line) => (
            <span
              key={line.id}
              className="ic-ma-preview-tag"
              style={{ color: indicatorCssColor(shownColor(line.spec, line.style.colors)), opacity: line.visible ? 1 : 0.35 }}
            >
              {line.spec.method === "ema" ? "지수" : "단순"} {line.spec.period}
            </span>
          ))}
        </div>
        <svg role="img" aria-label="선 미리보기" viewBox="0 0 490 64" preserveAspectRatio="none" fill="none">
          {maLines.map((line, idx) => {
            if (!line.visible) return null;
            const css = indicatorCssColor(shownColor(line.spec, line.style.colors));
            const isHovered = hoveredId === line.id;
            const opacity = hoveredId && !isHovered ? 0.25 : 0.95;
            return (
              <path
                key={line.id}
                d={SAMPLE_PATHS[idx % SAMPLE_PATHS.length]}
                stroke={css}
                strokeWidth={isHovered ? Math.min(5, line.style.width + 1) : line.style.width}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                opacity={opacity}
              />
            );
          })}
        </svg>
      </div>

      <section className="ic-card" aria-label="이동평균선 목록">
        <div className="ic-card-head">
          <h4 className="ic-card-title">
            이동평균선 {visibleCount}/{maLines.length}
          </h4>
          {maLines.length > 1 && (
            <div className="ic-card-tools">
              <button type="button" className="ic-text-action" onClick={() => setAllMethod("sma")}>모두 단순</button>
              <button type="button" className="ic-text-action" onClick={() => setAllMethod("ema")}>모두 지수</button>
              <button type="button" className="ic-text-action" aria-label="기간순 정렬" title="기간순 정렬" onClick={sortByPeriod}>
                {compact ? "정렬" : "기간순 정렬"}
              </button>
            </div>
          )}
        </div>

        <div className="ic-ma-list">
          {maLines.length === 0 ? (
            <p className="py-3 text-center text-s text-text-3">표시할 이동평균선을 추가하세요.</p>
          ) : (
            maLines.map((line) => (
              <MaLineRow key={line.id} cellId={cellId} line={line} compact={compact} onHover={setHoveredId} validate={validator} />
            ))
          )}
        </div>

        <div className="ic-ma-add">
          <input
            type="text"
            inputMode="numeric"
            aria-label="추가할 이동평균 기간"
            aria-invalid={addError}
            aria-describedby={addError ? addErrorId : undefined}
            value={newPeriod}
            placeholder={compact ? "기간 (예: 240)" : "기간 (예: 20)"}
            autoComplete="off"
            className="ui-field ic-ma-add-input"
            onChange={(e) => {
              setNewPeriod(e.target.value);
              if (addError) setAddError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                addLine();
              }
            }}
          />
          <button type="button" className="btn-primary ic-ma-add-btn" aria-label="이동평균선 추가" onClick={addLine}>
            <PlusIcon size={12} />
            {compact ? "추가" : "이동평균선 추가"}
          </button>
        </div>
        {addError && <Errors id={addErrorId} messages={["1 이상의 정수를 입력하세요"]} />}
      </section>
    </>
  );
}
