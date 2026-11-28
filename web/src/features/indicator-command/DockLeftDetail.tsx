import { useMemo, useState } from "react";
import { colorLine, indicatorCssColor, KINDS, shownColor, specName } from "../../chart/indicators/kinds";
import { barOpacityOf, ichimokuStyleOf, placementOfConfig, sameIchimokuStyle, type IndicatorConfig } from "../../chart/settings";
import type { WindowId } from "../../layout/kinds";
import { chartWindows, useCell, useLayoutStore } from "../../stores/layout";
import { ArrowLeftIcon, EyeIcon, TrashIcon, UndoIcon } from "../icons";
import { IndicatorSettingsForm } from "../indicator-dialog/IndicatorSettingsForm";
import { useLiveIndicatorDraft } from "../indicator-dialog/liveDraft";
import { isMaConfig, MaGroupEditorView } from "../indicator-dialog/MaGroupEditor";
import { removeIndicatorWithUndo } from "../indicator-inspector/removalUndo";
import type { DockSelectionTarget } from "./DockLayerList";

interface SwitcherItem {
  key: string;
  label: string;
  target: NonNullable<DockSelectionTarget>;
}

function buildSwitcherItems(indicators: readonly IndicatorConfig[]): SwitcherItem[] {
  const items: SwitcherItem[] = [];
  const maLines = indicators.filter(isMaConfig);
  if (maLines.length > 0) {
    items.push({ key: "maGroup", label: "이동평균", target: { kind: "maGroup" } });
  }
  const nonMa = indicators.filter((item) => !isMaConfig(item));
  const counts = new Map<string, number>();
  for (const item of nonMa) counts.set(item.spec.kind, (counts.get(item.spec.kind) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const item of nonMa) {
    const base = KINDS[item.spec.kind].label;
    const total = counts.get(item.spec.kind) ?? 1;
    const idx = (seen.get(item.spec.kind) ?? 0) + 1;
    seen.set(item.spec.kind, idx);
    const label = total > 1 ? `${base} #${idx}` : base;
    items.push({ key: item.id, label, target: { kind: "indicator", id: item.id } });
  }
  return items;
}

function sameTarget(a: NonNullable<DockSelectionTarget>, b: NonNullable<DockSelectionTarget>): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "maGroup") return true;
  return b.kind === "indicator" && a.id === b.id;
}

function DetailSwitcher({
  indicators,
  target,
  onSelectTarget,
}: {
  indicators: readonly IndicatorConfig[];
  target: NonNullable<DockSelectionTarget>;
  onSelectTarget(target: DockSelectionTarget): void;
}) {
  const items = useMemo(() => buildSwitcherItems(indicators), [indicators]);
  if (items.length <= 1) return null;

  return (
    <div className="b3-detail-switcher" role="group" aria-label="지표 빠른 전환">
      {items.map((item) => {
        const active = sameTarget(item.target, target);
        return (
          <button
            key={item.key}
            type="button"
            className="b3-switch-pill"
            aria-pressed={active}
            onClick={() => onSelectTarget(item.target)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function SingleIndicatorDetail({
  cellId,
  config,
  instanceCount,
  instanceIndex,
  switcher,
  onClose,
}: {
  cellId: WindowId;
  config: IndicatorConfig;
  instanceCount: number;
  instanceIndex: number;
  switcher: React.ReactNode;
  onClose(): void;
}) {
  const [opened] = useState(() => structuredClone(config));
  const { draft, setDraft, check, color, revert } = useLiveIndicatorDraft(cellId, opened);
  const live = useLayoutStore((s) =>
    chartWindows(s.layout).find((cell) => cell.id === cellId)?.chartSettings.indicators.find((item) => item.id === config.id) ?? config,
  );
  const shown = live.visible;
  const hasSwatch = colorLine(live.spec) !== null;
  const swatchCss = hasSwatch ? indicatorCssColor(shownColor(live.spec, live.style.colors)) : "var(--text-3)";

  const modified = useMemo(() => (
    JSON.stringify(live.spec) !== JSON.stringify(opened.spec)
    || live.style.width !== opened.style.width
    || JSON.stringify(live.style.colors) !== JSON.stringify(opened.style.colors)
    || barOpacityOf(live.style, live.spec.kind) !== barOpacityOf(opened.style, opened.spec.kind)
    || !sameIchimokuStyle(ichimokuStyleOf(live.style), ichimokuStyleOf(opened.style))
    || placementOfConfig(live) !== placementOfConfig(opened)
  ), [live, opened]);

  const handleRevert = () => {
    revert();
    onClose();
  };

  return (
    <>
      <header className="b3-detail-head">
        <button
          type="button"
          className="b3-detail-back"
          aria-label="상세 설정 닫기"
          title="레이어 목록으로 (Esc)"
          onClick={onClose}
        >
          <ArrowLeftIcon size={12} />
          <span>레이어</span>
        </button>
        <span aria-hidden="true" className="b3-detail-dot" style={{ background: swatchCss }} />
        <div className="b3-detail-title-wrap">
          <h3 className="b3-detail-title">{KINDS[live.spec.kind].label}</h3>
          <span className="b3-detail-sub">
            {live.panel === "price" ? "가격 패널" : "아래 패널"}
            {instanceCount > 1 ? ` · #${instanceIndex}` : ""}
          </span>
        </div>
        <button
          type="button"
          className="b3-detail-revert"
          disabled={!modified}
          aria-label="변경 전으로 되돌리기"
          title="열었을 때 설정으로 되돌리기"
          onClick={handleRevert}
        >
          <UndoIcon size={12} />
          <span>원래대로</span>
        </button>
        <button
          type="button"
          className="icon-btn size-6"
          aria-label={shown ? "지표 숨기기" : "지표 보이기"}
          aria-pressed={!shown}
          title={shown ? "숨기기" : "보이기"}
          onClick={() => useLayoutStore.getState().updateIndicator(cellId, live.id, { visible: !shown })}
        >
          <EyeIcon size={14} off={!shown} />
        </button>
      </header>
      {switcher}
      <div className="b3-detail-body">
        <IndicatorSettingsForm
          draft={draft}
          color={color}
          errors={check.errors}
          onChange={setDraft}
          lineSample={false}
          colorControl="popover"
        />
      </div>
      <footer className="b3-detail-foot">
        <span>즉시 반영</span>
        <button
          type="button"
          className="b3-detail-delete"
          aria-label={`${specName(live.spec)} 지우기`}
          title="지표 삭제"
          onClick={() => {
            removeIndicatorWithUndo(cellId, live);
            onClose();
          }}
        >
          <TrashIcon size={12} />
          <span>지표 삭제</span>
        </button>
      </footer>
    </>
  );
}

function MaGroupDetail({
  cellId,
  switcher,
  onClose,
}: {
  cellId: WindowId;
  switcher: React.ReactNode;
  onClose(): void;
}) {
  const cell = useCell(cellId);
  const maLines = cell.chartSettings.indicators.filter(isMaConfig);
  const [openedMa] = useState(() => structuredClone(maLines));
  const modified = JSON.stringify(maLines) !== JSON.stringify(openedMa);

  const handleRevert = () => {
    const store = useLayoutStore.getState();
    const current = chartWindows(store.layout).find((c) => c.id === cellId);
    if (!current) return;
    const nonMa = current.chartSettings.indicators.filter((item) => !isMaConfig(item));
    store.setChartSettings(cellId, {
      ...current.chartSettings,
      indicators: [...openedMa, ...nonMa],
    });
  };

  return (
    <>
      <header className="b3-detail-head">
        <button
          type="button"
          className="b3-detail-back"
          aria-label="상세 설정 닫기"
          title="레이어 목록으로 (Esc)"
          onClick={onClose}
        >
          <ArrowLeftIcon size={12} />
          <span>레이어</span>
        </button>
        <div className="b3-detail-title-wrap">
          <h3 className="b3-detail-title">이동평균선</h3>
          <span className="b3-detail-sub">가격 패널 · {maLines.length}개</span>
        </div>
        <button
          type="button"
          className="b3-detail-revert"
          disabled={!modified}
          aria-label="이동평균선 변경 전으로 되돌리기"
          title="열었을 때 설정으로 되돌리기"
          onClick={handleRevert}
        >
          <UndoIcon size={12} />
          <span>원래대로</span>
        </button>
      </header>
      {switcher}
      <div className="b3-detail-body">
        <MaGroupEditorView cellId={cellId} allIndicators={cell.chartSettings.indicators} compact />
      </div>
      <footer className="b3-detail-foot">
        <span>즉시 반영</span>
        <span>Esc 목록으로</span>
      </footer>
    </>
  );
}

export function DockLeftDetail({
  cellId,
  target,
  indicators,
  onSelectTarget,
  onClose,
}: {
  cellId: WindowId;
  target: NonNullable<DockSelectionTarget>;
  indicators: readonly IndicatorConfig[];
  onSelectTarget(target: DockSelectionTarget): void;
  onClose(): void;
}) {
  const switcher = <DetailSwitcher indicators={indicators} target={target} onSelectTarget={onSelectTarget} />;

  if (target.kind === "maGroup") {
    return (
      <section
        data-chart-control=""
        role="region"
        aria-label="지표 상세 설정"
        className="b3-detail-pane"
      >
        <MaGroupDetail key={`ma-group:${cellId}`} cellId={cellId} switcher={switcher} onClose={onClose} />
      </section>
    );
  }

  const config = indicators.find((item) => item.id === target.id);
  if (!config) return null;
  const sameKind = indicators.filter((item) => item.spec.kind === config.spec.kind);
  const instanceIndex = sameKind.findIndex((item) => item.id === config.id) + 1;

  return (
    <section
      data-chart-control=""
      role="region"
      aria-label="지표 상세 설정"
      className="b3-detail-pane"
    >
      <SingleIndicatorDetail
        key={config.id}
        cellId={cellId}
        config={config}
        instanceCount={sameKind.length}
        instanceIndex={instanceIndex}
        switcher={switcher}
        onClose={onClose}
      />
    </section>
  );
}
