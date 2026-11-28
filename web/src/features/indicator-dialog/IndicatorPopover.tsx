import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { isTypingTarget } from "../../lib/typingTarget";
import { KINDS, specName } from "../../chart/indicators/kinds";
import { resolvePanelScales, type ResolvedAxisSlot } from "../../chart/indicators/scales";
import { type IndicatorConfig, MAX_INDICATORS_PER_PANEL, placementOfConfig } from "../../chart/settings";
import { chartWindows, useCell, useLayoutStore } from "../../stores/layout";
import { ChevronRightIcon, CloseIcon, DRAWING_ICONS, EyeIcon, Icon } from "../icons";
import { cellSelector, CHART_POP_TRIGGERS } from "../indicator-command/open";
import { isUndoKey, undoChartSettings } from "../indicator-command/settingsHistory";
import { removeIndicatorWithUndo } from "../indicator-inspector/removalUndo";
import { Popover } from "../overlay/Popover";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import { Row } from "../dialog/DialogParts";
import { startDraft, type Draft } from "./indicatorForm";
import { IndicatorSettingsForm } from "./IndicatorSettingsForm";
import { useLiveIndicatorDraft } from "./liveDraft";
import type { WindowId } from "../../layout/kinds";

const MIN_ROOM_BELOW = 240;
const AXIS_OPTIONS = [
  { value: "right", label: "오른쪽" },
  { value: "left", label: "왼쪽" },
  { value: "overlay", label: "따로" },
] as const satisfies readonly SegmentedOption<ResolvedAxisSlot>[];

const sameSetup = (a: IndicatorConfig, b: IndicatorConfig): boolean =>
  JSON.stringify(a.spec) === JSON.stringify(b.spec) && JSON.stringify(a.style) === JSON.stringify(b.style) && placementOfConfig(a) === placementOfConfig(b);

export function IndicatorPopover({ cellId, initial, anchor, field, onClose }: {
  cellId: WindowId;
  initial: IndicatorConfig;
  anchor: HTMLElement;
  field: string | null;
  onClose(): void;
}) {
  const trigger = useRef(anchor);
  const sheet = useRef<HTMLDivElement>(null);
  const { draft, setDraft, validator, check, color, revert } = useLiveIndicatorDraft(cellId, initial);
  const live = useLayoutStore((s) => chartWindows(s.layout).find((cell) => cell.id === cellId)?.chartSettings.indicators.find((i) => i.id === initial.id)) ?? initial;
  const shown = live.visible;
  const [placed, setPlaced] = useState(false);
  const modified = placed || !sameSetup(live, initial);
  const change = (next: Draft) => {
    if (next.placement !== draft.placement) setPlaced(true);
    setDraft(next);
  };

  useEffect(() => {
    if (field === null) return;
    const input = sheet.current?.querySelector<HTMLInputElement>(`input[data-field="${CSS.escape(field)}"]`);
    if (!input || input.disabled) return;
    input.focus({ preventScroll: true });
    input.select();
  }, [field]);

  const backToStart = () => {
    revert();
    setPlaced(false);
    setDraft(startDraft(initial, initial.spec.kind));
  };

  const undoKeys = (event: KeyboardEvent) => {
    const command = isUndoKey(event.nativeEvent);
    if (!command || isTypingTarget(event.target)) return;
    event.preventDefault();
    if (!undoChartSettings({ kind: "open" }, command === "redo")) return;
    const current = chartWindows(useLayoutStore.getState().layout).find((cell) => cell.id === cellId)?.chartSettings.indicators.find((i) => i.id === initial.id);
    if (current) setDraft(startDraft(current, current.spec.kind));
  };

  const isOwnToggle = (target: Node) => target instanceof Element
    && target.closest("[data-indicator-command=toggle]")?.closest("[data-indicator-row]")?.getAttribute("data-indicator-row") === initial.id
    && target.closest(cellSelector(cellId)) !== null;

  return <Popover isInside={(target) => target instanceof Element && target.closest(CHART_POP_TRIGGERS) !== null} releasesClick={isOwnToggle} anchor={trigger} solid follow fitBelow={MIN_ROOM_BELOW} onClose={onClose} role="dialog" aria-label={`${specName(initial.spec)} 설정`} data-chart-control="" className="ip-popover" onKeyDown={undoKeys}>
    <div ref={sheet} className="ip-sheet">
      <div className="ip-head">
        <h3 className="flex-1 text-m font-semibold">{KINDS[initial.spec.kind].label}</h3>
        <button type="button" className="icon-btn" aria-label={shown ? "지표 숨기기" : "지표 보이기"} aria-pressed={!shown} title={shown ? "숨기기" : "보이기"} onClick={() => useLayoutStore.getState().updateIndicator(cellId, initial.id, { visible: !shown })}><EyeIcon size={15} off={!shown} /></button>
        <button type="button" className="icon-btn text-danger" aria-label="지표 지우기" title="지우기" onClick={() => { removeIndicatorWithUndo(cellId, live); onClose(); }}><Icon path={DRAWING_ICONS.trash} size={15} /></button>
        <button type="button" className="icon-btn" aria-label="설정 닫기" title="닫기 (Esc)" onClick={onClose}><CloseIcon size={14} /></button>
      </div>
      <div className="ip-body">
        <div role="group" aria-label="설정값" className="flex flex-col gap-3">
          <IndicatorSettingsForm draft={draft} color={color} errors={check.errors} onChange={change} foldColors />
          {check.errors.filter((error) => !KINDS[draft.form.kind].fields.some((f) => f.key === error.field)).map((error, i) => <p key={i} className="text-s text-danger">{error.message}</p>)}
          {validator === "failed" && <p role="alert" className="text-s text-danger">지표 설정 검사기를 불러오지 못했습니다. 새로고침해 보세요.</p>}
        </div>
        {live.panel !== "price" && <PanelPlace cellId={cellId} config={live} onClose={onClose} />}
      </div>
      <div className="ip-foot">
        <span>바로 반영 · Ctrl+Z로 되돌리기</span>
        <button type="button" className="ip-reset" disabled={!modified} onClick={backToStart}>처음 값으로</button>
      </div>
    </div>
  </Popover>;
}

function PanelPlace({ cellId, config, onClose }: { cellId: WindowId; config: IndicatorConfig; onClose(): void }) {
  const [open, setOpen] = useState(false);
  const settings = useCell(cellId).chartSettings;
  const panelIndex = settings.panels.findIndex((panel) => panel.id === config.panel);
  const members = settings.indicators.filter((item) => item.panel === config.panel);
  const others = settings.panels
    .filter((panel) => panel.id !== config.panel)
    .map((panel) => ({ panel, members: settings.indicators.filter((item) => item.panel === panel.id) }))
    .filter((entry) => entry.members.length > 0);
  const slot = members.length > 1 ? resolvePanelScales(settings.indicators, config.panel).get(config.id)?.slot ?? "right" : null;
  const store = useLayoutStore.getState();

  return <section className="ip-place">
    <button type="button" className="ip-place-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      <ChevronRightIcon size={11} />
      <span>자세히 · 패널 자리</span>
    </button>
    {open && <div className="ip-place-body">
      <Row label="자리">
        <span role="group" aria-label="패널 자리" className="ip-chips">
          <button type="button" className="ip-chip" aria-pressed={members.length === 1} onClick={() => { if (members.length > 1) store.splitIndicatorToNewPanel(cellId, config.id, panelIndex + 1); }}>따로</button>
          {others.map(({ panel, members: group }) => {
            const names = group.map((item) => KINDS[item.spec.kind].label).join("·");
            return <button key={panel.id} type="button" className="ip-chip" aria-pressed={false} disabled={group.length >= MAX_INDICATORS_PER_PANEL} title={group.length >= MAX_INDICATORS_PER_PANEL ? `한 패널에는 ${MAX_INDICATORS_PER_PANEL}개까지입니다` : undefined} onClick={() => store.mergeIndicatorIntoPanel(cellId, config.id, panel.id)}>{names} 패널에 합치기</button>;
          })}
          {members.length > 1 && <span className="ip-chip-note">{members.filter((item) => item.id !== config.id).map((item) => KINDS[item.spec.kind].label).join("·")}와 같은 패널</span>}
        </span>
      </Row>
      {slot !== null && <Row label="Y축">
        <Segmented label="Y축" mode="pressed" variant="boxed" options={AXIS_OPTIONS} value={slot} onChange={(axis) => store.setIndicatorAxis(cellId, config.id, axis)} />
      </Row>}
      <Row label="패널">
        <span role="group" aria-label="패널 순서와 접기" className="ip-chips">
          <button type="button" className="ip-chip" disabled={panelIndex <= 0} onClick={() => store.movePanel(cellId, config.panel, -1)}>위로</button>
          <button type="button" className="ip-chip" disabled={panelIndex < 0 || panelIndex >= settings.panels.length - 1} onClick={() => store.movePanel(cellId, config.panel, 1)}>아래로</button>
          <button type="button" className="ip-chip" onClick={() => { store.togglePanel(cellId, config.panel); onClose(); }}>접기</button>
        </span>
      </Row>
      <p className="text-xs text-text-3">범례 줄을 끌어다 놓아도 패널을 합치고 나눌 수 있습니다.</p>
    </div>}
  </section>;
}
