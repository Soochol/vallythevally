import { domSelect } from "../../features/menu/domSelect";
import { mountLayer } from "../../features/overlay/topLayer";
import { iconMarkup, type MarkupIcon } from "../../features/icons";
import { type FinancialReport, indicatorErrorText, type IndicatorRow, type PriceLegendValues } from "./layer";
import { axisSlotLabel, type ResolvedAxisSlot } from "./scales";
import type { FinancialDetailRow } from "../financials";
import { FOLD_ABOVE_ROWS, indicatorRowsFolded, type LegendField, type LegendProjection, type LegendTier } from "../legendProjection";
import { sameSlotSignature, type SlotSignature, slotSignature } from "../legendShapes";
import { indicatorsPinnedOpen, onIndicatorsPinnedChange, setIndicatorsPinnedOpen } from "../legendFold";

export type IndicatorCommand = "edit" | "toggle" | "remove" | "up" | "down" | "collapse" | "split" | "axis";

const ROW =
  "group pointer-events-auto flex w-max max-w-full items-center gap-1.5 whitespace-nowrap rounded-s pr-1 text-s " +
  "bg-[color-mix(in_srgb,var(--chart-bg)_78%,transparent)]";
const BTN = "grid size-[18px] place-items-center rounded-s text-xs text-text-2 hover:bg-raised hover:text-text disabled:opacity-40";
const TOOL_FADE = "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100";
const FOLD_BUTTON = "pointer-events-auto flex min-h-6 w-max items-center gap-1 rounded-s px-1.5 text-xs text-text-2 hover:text-text bg-[color-mix(in_srgb,var(--chart-bg)_78%,transparent)]";
const ROWS_BOX = "flex flex-col gap-px";

interface ValueSpan {
  span: HTMLSpanElement;
  text: string;
  color: string;
}

interface RowEls {
  root: HTMLDivElement;
  grip: HTMLSpanElement;
  swatch: HTMLSpanElement;
  name: HTMLButtonElement;
  collapse: HTMLButtonElement;
  values: HTMLSpanElement;
  badge: HTMLSpanElement;
  axis: HTMLButtonElement;
  split: HTMLButtonElement;
  toggle: HTMLButtonElement;
  remove: HTMLButtonElement;
  up: HTMLButtonElement;
  down: HTMLButtonElement;
  commandButtons: readonly HTMLButtonElement[];
  measureButtons: readonly HTMLButtonElement[];
  valueSpans: ValueSpan[];
  key: RowKey | null;
  detail: HTMLDetailsElement;
  summary: HTMLElement;
  text: HTMLDListElement;
  select: HTMLButtonElement;
  currentRows: readonly FinancialDetailRow[];
  shownRows: readonly FinancialDetailRow[] | null;
  dispose(): void;
  reports: readonly FinancialReport[] | null;
  lastName: string;
  lastColor: string;
  lastState: IndicatorRow["state"] | null;
  lastCollapsed: boolean | null;
  lastHasDetail: boolean | null;
  lastDetailStatus: string;
  lastDetailSummary: string;
  lastBadge: string;
  lastDraggable: boolean | null;
  lastMemberCount: number;
  lastSlotIndex: number;
  lastAxisSlot: ResolvedAxisSlot | null;
  lastAxisExplicit: boolean | null;
  lastPanelId: string;
  lastMaxWidth: string;
  lastLeft: string;
  lastUpDisabled: boolean;
  lastDownDisabled: boolean;
  lastPaneTop: number | null;
  lastPaneHeight: number | null;
  lastLeftAxisWidth: number;
  lastTop: string;
  lastPanelLayoutKey: string;
  labelsDirty: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}

function sameDetailRows(a: readonly FinancialDetailRow[] | null, b: readonly FinancialDetailRow[]): boolean {
  if (a === b) return true;
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && (a[i]!.name !== b[i]!.name || a[i]!.value !== b[i]!.value)) return false;
  return true;
}

const CURRENT_REPORT = "차트에서 가리킨 보고기간";

function showReport(r: RowEls, index: number): void {
  const report = index > 0 ? r.reports?.[index - 1] : undefined;
  const label = report?.label ?? CURRENT_REPORT;
  if (r.select.textContent !== label) r.select.textContent = label;
  showDetailRows(r, report?.rows ?? r.currentRows);
}

function showDetailRows(r: RowEls, rows: readonly FinancialDetailRow[]): void {
  if (sameDetailRows(r.shownRows, rows)) return;
  r.shownRows = rows;
  r.text.replaceChildren(...rows.map(({ name, value }) => {
    const line = el("div", "");
    line.append(el("dt", "", name), el("dd", "", value));
    return line;
  }));
}

function labelButton(button: HTMLButtonElement, label: string) {
  button.title = label;
  button.dataset.label = label;
}

export interface PaneBounds { readonly top: number; readonly height: number }

type RowKey = "panel" | "price";

function foldButton(): HTMLButtonElement {
  const button = el("button", FOLD_BUTTON);
  button.type = "button";
  button.dataset.chartControl = "";
  button.dataset.indicatorFold = "";
  button.append(el("span", ""), el("span", "", "▾"));
  button.lastElementChild?.setAttribute("aria-hidden", "true");
  return button;
}

export class IndicatorLegend {
  readonly priceBox = el("div", "relative flex flex-col gap-px");
  private readonly rowsBox = el("div", ROWS_BOX);
  private readonly fold = foldButton();
  private readonly rows = new Map<string, RowEls>();
  private tier: LegendTier = "full";
  private open = false;
  private readonly unsubscribePinned: () => void;

  private layoutRows: readonly IndicatorRow[] = [];
  private layoutValues: readonly PriceLegendValues[] = [];
  private layoutSignature: readonly {
    readonly id: string;
    readonly name: string;
    readonly state: IndicatorRow["state"];
    readonly hasDetail: boolean;
    readonly slots: readonly SlotSignature[];
  }[] | null = null;

  constructor(
    private readonly overlay: HTMLElement,
    private readonly onCommand: (id: string, command: IndicatorCommand, anchor: HTMLElement) => void,
    private readonly onFoldChange: () => void = () => {},
  ) {
    this.priceBox.dataset.indicatorFoldBox = "";
    this.priceBox.append(this.fold, this.rowsBox);
    this.fold.addEventListener("click", () => this.toggleFold());
    this.unsubscribePinned = onIndicatorsPinnedChange(() => { this.syncFold(); this.onFoldChange(); });
    this.syncFold();
  }

  setTier(tier: LegendTier): void {
    if (this.tier === tier) return;
    this.tier = tier;
    this.open = false;
    this.syncFold();
  }

  private toggleFold(): void {
    if (this.tier === "minimal") {
      this.open = !this.open;
      this.syncFold();
      return;
    }
    setIndicatorsPinnedOpen(!indicatorsPinnedOpen());
  }

  private syncFold(): void {
    const count = this.layoutRows.length;
    const folded = indicatorRowsFolded(this.tier, count, indicatorsPinnedOpen());
    const foldable = this.tier === "minimal" ? count > 0 : count > FOLD_ABOVE_ROWS;
    const expanded = this.tier === "minimal" ? this.open : !folded;
    this.priceBox.toggleAttribute("data-folded", folded);
    this.priceBox.toggleAttribute("data-open", folded && this.open);
    this.fold.hidden = !foldable;
    this.fold.setAttribute("aria-expanded", String(expanded));
    const label = this.fold.firstElementChild;
    if (label && label.textContent !== `지표 ${count}`) label.textContent = `지표 ${count}`;
  }

  render(rows: IndicatorRow[], panes: readonly PaneBounds[] | null, axisWidth?: number, leftAxisWidth = 0): void {
    const focused = document.activeElement;
    let priceRowCount = 0;
    for (const row of rows) if (!row.panel) priceRowCount++;
    if (priceRowCount !== this.layoutRows.length) {
      this.layoutRows = rows.filter((row) => !row.panel);
      this.layoutSignature = null;
      this.syncFold();
    }
    const seen = new Set<string>();
    const panelGroups = new Map<number, { elements: RowEls; paneTop: number; paneHeight: number; layoutKey: string; slotIndex: number; collapsed: boolean }[]>();
    const dirtyPanels = new Set<number>();
    const baseLeft = leftAxisWidth > 0 ? leftAxisWidth + 8 : 8;
    for (const row of rows) {
      seen.add(row.id);
      const r = this.rows.get(row.id) ?? this.build(row.id);
      this.rows.set(row.id, r);
      this.place(r, row.panel ? "panel" : "price");
      this.fill(r, row);
      if (row.panel) {
        if (r.root.parentElement !== this.overlay) this.overlay.append(r.root);
        if (axisWidth !== undefined || r.lastLeftAxisWidth !== leftAxisWidth || r.lastMaxWidth === "") {
          const maxWidth = `calc(100% - ${(axisWidth ?? 72) + leftAxisWidth + 16}px)`;
          if (r.lastMaxWidth !== maxWidth) {
            r.lastMaxWidth = maxWidth;
            r.root.style.maxWidth = maxWidth;
          }
        }
        const upDisabled = row.panel.index === 0;
        if (r.lastUpDisabled !== upDisabled) {
          r.lastUpDisabled = upDisabled;
          r.up.disabled = upDisabled;
        }
        const downDisabled = row.panel.index === row.panel.count - 1;
        if (r.lastDownDisabled !== downDisabled) {
          r.lastDownDisabled = downDisabled;
          r.down.disabled = downDisabled;
        }
        if (panes !== null) {
          const pane = panes[row.panel.index + 1];
          const paneTop = pane?.top ?? 0;
          const paneHeight = pane?.height ?? 0;
          const slotIndex = row.panel.slotIndex ?? 0;
          const memberCount = row.panel.memberCount ?? 1;
          const collapsed = row.panel.collapsed === true;
          const layoutKey = `${r.lastCollapsed}:${r.lastHasDetail}:${slotIndex}:${memberCount}`;
          const entry = { elements: r, paneTop, paneHeight, layoutKey, slotIndex, collapsed };
          const list = panelGroups.get(row.panel.index);
          if (list) list.push(entry);
          else panelGroups.set(row.panel.index, [entry]);
          if (
            r.lastPaneTop !== paneTop
            || r.lastPaneHeight !== paneHeight
            || r.lastLeftAxisWidth !== leftAxisWidth
            || r.lastPanelLayoutKey !== layoutKey
          ) {
            dirtyPanels.add(row.panel.index);
          }
        }
      }
    }
    const price = rows.filter((row) => !row.panel).map((row) => this.rows.get(row.id)!.root);
    if (price.some((root, i) => this.rowsBox.children[i] !== root) || this.rowsBox.children.length !== price.length) {
      this.rowsBox.replaceChildren(...price);
    }
    for (const [id, r] of this.rows) {
      if (seen.has(id)) continue;
      r.dispose();
      r.root.remove();
      this.rows.delete(id);
    }
    if (dirtyPanels.size > 0) {
      const measuredGroups = [...dirtyPanels].map((panelIndex) => {
        const group = (panelGroups.get(panelIndex) ?? []).sort((a, b) => a.slotIndex - b.slotIndex);
        return group.map((item) => {
          const rect = item.elements.root.getBoundingClientRect();
          let height = rect.height;
          for (const button of item.elements.measureButtons) {
            if (button.hidden) continue;
            const h = button.getBoundingClientRect().height;
            if (h > height) height = h;
          }
          const marginTop = parseFloat(getComputedStyle(item.elements.root).marginTop);
          return { ...item, height, width: rect.width, marginTop };
        });
      });
      for (const group of measuredGroups) {
        let stackY = 0;
        let stackX = baseLeft;
        const single = group.length === 1;
        for (const item of group) {
          const { elements, paneTop, paneHeight, layoutKey, height, width, marginTop, collapsed } = item;
          const topPx = single || collapsed
            ? paneTop - marginTop + Math.min(4, Math.max(0, paneHeight - height))
            : paneTop - marginTop + 4 + stackY;
          const leftPx = collapsed ? stackX : baseLeft;
          const top = `${topPx}px`;
          const left = `${leftPx}px`;
          elements.lastPaneTop = paneTop;
          elements.lastPaneHeight = paneHeight;
          elements.lastLeftAxisWidth = leftAxisWidth;
          elements.lastPanelLayoutKey = layoutKey;
          if (elements.lastTop !== top) {
            elements.lastTop = top;
            elements.root.style.top = top;
          }
          if (elements.lastLeft !== left) {
            elements.lastLeft = left;
            elements.root.style.left = left;
          }
          stackY += height + 2;
          stackX += width + 4;
        }
      }
    }
    if (focused instanceof HTMLElement && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
  }

  setLayoutRows(rows: readonly IndicatorRow[], values: readonly PriceLegendValues[]): boolean {
    const priceRows = rows.filter((row) => !row.panel);
    const choices = new Map(values.map((row) => [row.id, row.slots]));
    const nextSignature = priceRows.map((row) => ({
      id: row.id,
      name: row.name,
      state: row.state,
      hasDetail: Boolean(row.detail),
      slots: (choices.get(row.id) ?? []).map(slotSignature),
    }));
    const prev = this.layoutSignature;
    const changed =
      prev === null
      || prev.length !== nextSignature.length
      || nextSignature.some((next, i) => {
        const before = prev[i]!;
        return (
          before.id !== next.id
          || before.name !== next.name
          || before.state !== next.state
          || before.hasDetail !== next.hasDetail
          || before.slots.length !== next.slots.length
          || next.slots.some((slot, j) => !sameSlotSignature(before.slots[j]!, slot))
        );
      });
    this.layoutRows = priceRows;
    this.layoutValues = values;
    this.layoutSignature = nextSignature;
    this.syncFold();
    return changed;
  }

  projection(): LegendProjection {
    const root = el("div", this.priceBox.className);
    root.dataset.indicatorFoldBox = "";
    root.toggleAttribute("data-folded", this.priceBox.hasAttribute("data-folded"));
    const rowsBox = el("div", ROWS_BOX);
    if (!this.fold.hidden) {
      const fold = foldButton();
      fold.firstElementChild!.textContent = this.fold.firstElementChild?.textContent ?? "";
      root.append(fold);
    }
    root.append(rowsBox);
    const choices = new Map(this.layoutValues.map((row) => [row.id, row.slots]));
    const fields: LegendField[] = [];
    for (const row of this.layoutRows) {
      const slots = choices.get(row.id) ?? [];
      const elements = this.build(row.id, false);
      this.place(elements, "price");
      const values = this.fill(elements, { ...row, values: slots.map((texts, i) => ({ text: texts[0] ?? "", color: row.values[i]?.color ?? row.color })) }, false);
      fields.push(...values.map((element, i) => ({ element, alternatives: slots[i] ?? [] })));
      rowsBox.append(elements.root);
    }
    return { root, fields };
  }

  invalidatePanelLayout(): void {
    for (const r of this.rows.values()) r.lastPaneTop = null;
  }

  dispose(): void {
    for (const r of this.rows.values()) { r.dispose(); r.root.remove(); }
    this.rows.clear();
    this.unsubscribePinned();
    this.priceBox.remove();
  }

  private place(r: RowEls, key: RowKey): void {
    if (r.key === key) return;
    r.key = key;
    const panel = key === "panel";
    r.root.className = panel ? `${ROW} absolute left-2 z-[4]` : ROW;
    if (!panel) {
      r.root.style.removeProperty("top");
      r.root.style.removeProperty("left");
      r.root.style.removeProperty("max-width");
    }
    r.lastPaneTop = null;
    r.lastPaneHeight = null;
    r.lastLeftAxisWidth = -1;
    r.lastMemberCount = -1;
    r.lastPanelLayoutKey = "";
    r.lastMaxWidth = "";
    r.lastLeft = "";
    r.lastTop = "";
    for (const button of [r.collapse, r.up, r.down]) button.hidden = !panel;
    labelButton(r.remove, panel ? "패널 닫기" : "지우기");
    r.labelsDirty = true;
  }

  private build(id: string, interactive = true): RowEls {
    const root = el("div", ROW);
    root.dataset.indicatorRow = id;
    const grip = el("span", "indicator-grip grid size-3.5 flex-none place-items-center text-text-3");
    grip.innerHTML = iconMarkup("grip", 12);
    grip.dataset.indicatorGrip = "";
    grip.dataset.chartControl = "";
    grip.title = "끌어서 패널 합치기 · 분리";
    grip.hidden = true;
    const swatch = el("span", "h-0.5 w-2.5 flex-none rounded-full");
    const name = el("button", "min-w-0 truncate text-text-2 hover:text-text");
    name.type = "button";
    name.dataset.chartControl = "";
    name.dataset.indicatorEdit = id;
    const values = el("span", "flex gap-1.5 font-medium");
    values.dataset.indicatorValues = "";
    const badge = el("span", "rounded-[9px] border border-line px-1.5 text-xs text-text-3");
    const axis = el("button", "indicator-axis-pill");
    axis.type = "button";
    axis.dataset.chartControl = "";
    axis.dataset.indicatorAxis = "";
    axis.dataset.indicatorCommand = "axis";
    axis.hidden = true;
    labelButton(axis, "Y축 전환");
    if (interactive) axis.addEventListener("click", () => this.onCommand(id, "axis", axis));
    const tools = el("span", "flex gap-px");
    tools.dataset.indicatorTools = "";
    const button = (icon: MarkupIcon, label: string, command: IndicatorCommand) => {
      const b = el("button", `${BTN} ${TOOL_FADE}`);
      b.innerHTML = iconMarkup(icon);
      b.type = "button";
      b.dataset.chartControl = "";
      labelButton(b, label);
      b.dataset.indicatorCommand = command;
      if (command === "edit") b.dataset.indicatorEdit = id;
      if (interactive) b.addEventListener("click", () => this.onCommand(id, command, b));
      tools.append(b);
      return b;
    };
    const collapse = button("down", "패널 접기", "collapse");
    const up = button("up", "패널 위로", "up");
    const down = button("down", "패널 아래로", "down");
    const split = button("split", "새 패널로 분리", "split");
    split.hidden = true;
    const edit = button("gear", "설정", "edit");
    const toggle = button("eye", "숨기기", "toggle");
    const remove = button("close", "지우기", "remove");
    const commandButtons = [axis, collapse, up, down, split, edit, toggle, remove] as const;
    const detail = el("details", "relative min-w-0 text-text-2");
    const summary = el("summary", "max-w-[18ch] cursor-pointer truncate text-xs max-md:max-w-[10ch]", "자료·갱신");
    summary.dataset.chartControl = "";
    summary.setAttribute("aria-label", "재무자료와 갱신 상태");
    const box = el("div", "ui-popover w-[min(440px,85vw)] whitespace-normal p-3");
    box.dataset.chartControl = "";
    let cleanup: (() => void) | null = null;
    const syncDetail = () => {
      if (detail.open && detail.isConnected) {
        cleanup ??= mountLayer(box, { anchor: () => summary.getBoundingClientRect(), trigger: summary, onClose: () => { detail.open = false; syncDetail(); } });
      } else { cleanup?.(); cleanup = null; }
    };
    if (interactive) summary.addEventListener("click", (event) => { event.preventDefault(); detail.open = !detail.open; syncDetail(); });
    if (interactive) detail.addEventListener("toggle", syncDetail);
    const select = el("button", "mb-2 w-full bg-surface text-s");
    select.dataset.chartControl = "";
    select.setAttribute("aria-label", "보고기간 자료");
    const text = el("dl", "financial-detail-rows text-xs");
    box.append(select, text);
    detail.append(summary, box);
    root.append(grip, swatch, name, detail, values, badge, axis, tools);
    const row: RowEls = {
      root, grip, swatch, name, collapse, values, badge, axis, split, toggle, remove, up, down,
      commandButtons,
      measureButtons: [name, axis, collapse, up, down, split, edit, toggle, remove],
      valueSpans: [],
      key: null, detail, summary, text, select, reports: null, currentRows: [], shownRows: null, dispose: () => {},
      lastName: "", lastColor: "", lastState: null, lastCollapsed: null, lastHasDetail: null,
      lastDetailStatus: "", lastDetailSummary: "", lastBadge: "",
      lastDraggable: null, lastMemberCount: 1, lastSlotIndex: 0, lastAxisSlot: null, lastAxisExplicit: null, lastPanelId: "",
      lastMaxWidth: "", lastLeft: "", lastUpDisabled: false, lastDownDisabled: false,
      lastPaneTop: null, lastPaneHeight: null, lastLeftAxisWidth: -1, lastTop: "", lastPanelLayoutKey: "", labelsDirty: true,
    };
    if (interactive) {
      name.addEventListener("click", () => this.onCommand(id, row.lastCollapsed === true ? "collapse" : "edit", name));
      root.addEventListener("click", (event) => {
        if (row.lastCollapsed === true && !event.composedPath().some((target) => target instanceof Element && target.matches("button,summary"))) {
          this.onCommand(id, "collapse", root);
        }
      });
    }
    const disposeSelect = interactive ? domSelect(select, () => [CURRENT_REPORT, ...(row.reports ?? []).map((report) => report.label)].map((label, i) => ({ label, value: String(i) })), (value) => {
      select.dataset.value = value;
      showReport(row, Number(value));
    }) : null;
    row.dispose = () => { cleanup?.(); disposeSelect?.(); };
    return row;
  }

  private fill(r: RowEls, row: IndicatorRow, interactive = true): HTMLSpanElement[] {
    const hasDetail = Boolean(row.detail);
    const nameChanged = r.lastName !== row.name;
    const collapsed = row.panel?.collapsed === true;
    const collapsedChanged = r.lastCollapsed !== collapsed;
    const stateChanged = r.lastState !== row.state;

    if (nameChanged) {
      r.lastName = row.name;
      r.name.textContent = row.name;
      r.name.title = row.name;
      r.labelsDirty = true;
    }

    if (r.lastHasDetail !== hasDetail) {
      r.lastHasDetail = hasDetail;
      r.detail.hidden = !hasDetail;
      if (hasDetail) {
        r.name.className = "min-w-0 truncate text-text-2 max-md:max-w-[15ch]";
        r.values.className = "flex min-w-0 gap-1.5 truncate font-medium max-md:max-w-[10ch]";
        r.summary.textContent = "";
        r.summary.className = "financial-status-dot";
      }
    }
    if (row.detail) {
      if (r.lastDetailStatus !== row.detail.status) {
        r.lastDetailStatus = row.detail.status;
        r.summary.dataset.status = row.detail.status;
      }
      if (r.lastDetailSummary !== row.detail.summary) {
        r.lastDetailSummary = row.detail.summary;
        r.summary.title = row.detail.summary;
      }
      if (r.labelsDirty) r.summary.setAttribute("aria-label", `${row.name} 재무자료와 갱신 상태`);
      r.reports = row.detail.reports;
      r.currentRows = row.detail.rows;
      if (!r.select.dataset.value) r.select.dataset.value = "0";
      showReport(r, Number(r.select.dataset.value));
    }

    if (collapsedChanged) {
      r.lastCollapsed = collapsed;
      labelButton(r.collapse, collapsed ? "패널 펼치기" : "패널 접기");
      r.collapse.setAttribute("aria-expanded", String(!collapsed));
      const collapseIcon = collapsed ? "up" : "down";
      if (r.collapse.dataset.icon !== collapseIcon) { r.collapse.innerHTML = iconMarkup(collapseIcon); r.collapse.dataset.icon = collapseIcon; }
      r.root.classList.toggle("indicator-collapsed", collapsed);
      if (interactive && collapsed) r.root.dataset.chartControl = "";
      else delete r.root.dataset.chartControl;
      r.labelsDirty = true;
    }

    if (stateChanged) {
      r.lastState = row.state;
      const dim = row.state !== "ok" && row.state !== "pending";
      r.root.classList.toggle("opacity-60", dim);
      const badge = row.state === "spec" || row.state === "calc" ? indicatorErrorText(row.state) : "";
      if (r.lastBadge !== badge) {
        r.lastBadge = badge;
        r.badge.textContent = badge;
      }
      r.badge.hidden = badge === "";
      const hidden = row.state === "hidden";
      const icon = hidden ? "eyeOff" : "eye";
      if (r.toggle.dataset.icon !== icon) { r.toggle.innerHTML = iconMarkup(icon); r.toggle.dataset.icon = icon; }
      const toggleClass = hidden ? BTN : `${BTN} ${TOOL_FADE}`;
      if (r.toggle.className !== toggleClass) r.toggle.className = toggleClass;
      labelButton(r.toggle, hidden ? "보이기" : "숨기기");
      r.labelsDirty = true;
    }

    const draggable = interactive && row.draggable === true;
    const memberCount = row.panel?.memberCount ?? 1;
    const slotIndex = row.panel?.slotIndex ?? 0;
    const panelId = row.panel?.panelId ?? "";
    const axisSlot = row.panel?.axisSlot ?? "right";
    const axisExplicit = row.panel?.axisExplicit === true;
    const merged = row.panel !== null && memberCount >= 2;

    if (r.lastDraggable !== draggable) {
      r.lastDraggable = draggable;
      r.grip.hidden = !draggable;
      if (draggable) r.root.dataset.draggable = "true";
      else delete r.root.dataset.draggable;
    }

    if (r.lastPanelId !== panelId) {
      r.lastPanelId = panelId;
      if (panelId) r.root.dataset.panelId = panelId;
      else delete r.root.dataset.panelId;
    }

    if (r.lastMemberCount !== memberCount || r.lastSlotIndex !== slotIndex) {
      r.lastMemberCount = memberCount;
      r.lastSlotIndex = slotIndex;
      const showPanelControls = row.panel !== null && slotIndex === 0;
      for (const button of [r.collapse, r.up, r.down]) button.hidden = !showPanelControls;
      r.split.hidden = !(merged || (row.panel === null && draggable));
      r.axis.hidden = !merged;
      labelButton(r.remove, row.panel !== null && !merged ? "패널 닫기" : "지우기");
      r.labelsDirty = true;
    } else if (row.panel === null) {
      r.split.hidden = !draggable;
      r.axis.hidden = true;
    }

    if (r.lastAxisSlot !== axisSlot || r.lastAxisExplicit !== axisExplicit) {
      r.lastAxisSlot = axisSlot;
      r.lastAxisExplicit = axisExplicit;
      const slotText = axisSlotLabel(axisSlot);
      r.axis.textContent = slotText;
      r.axis.dataset.axisSlot = axisSlot;
      if (axisExplicit) r.axis.dataset.axisExplicit = "true";
      else delete r.axis.dataset.axisExplicit;
      const axisTitle = axisSlot === "right" ? "우측 Y축 (클릭하여 전환)" : axisSlot === "left" ? "좌측 Y축 (클릭하여 전환)" : "독립 스케일 (클릭하여 전환)";
      labelButton(r.axis, axisTitle);
      r.labelsDirty = true;
    }

    if (r.lastColor !== row.color) {
      r.lastColor = row.color;
      r.swatch.style.background = row.color;
    }

    if (r.labelsDirty) {
      r.labelsDirty = false;
      r.name.setAttribute("aria-label", `${row.name} ${collapsed ? "펼치기" : "설정 열기"}`);
      for (const b of r.commandButtons) b.setAttribute("aria-label", `${row.name} ${b.dataset.label}`);
    }

    const nextCount = row.values.length;
    while (r.valueSpans.length > nextCount) {
      r.valueSpans.pop()!.span.remove();
    }
    for (let i = 0; i < nextCount; i++) {
      const v = row.values[i]!;
      const entry = r.valueSpans[i];
      if (!entry) {
        const span = el("span", "", v.text);
        span.style.color = v.color;
        r.valueSpans.push({ span, text: v.text, color: v.color });
        r.values.append(span);
      } else {
        if (entry.text !== v.text) {
          entry.text = v.text;
          entry.span.textContent = v.text;
        }
        if (entry.color !== v.color) {
          entry.color = v.color;
          entry.span.style.color = v.color;
        }
      }
    }
    return interactive ? [] : r.valueSpans.map((entry) => entry.span);
  }
}
