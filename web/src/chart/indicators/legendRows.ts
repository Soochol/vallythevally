import { domSelect } from "../../features/menu/domSelect";
import { mountLayer } from "../../features/overlay/topLayer";
import { iconMarkup, type MarkupIcon } from "../../features/icons";
import { indicatorErrorText, type IndicatorRow, type PriceLegendValues } from "./layer";
import type { LegendField, LegendProjection } from "../legendProjection";

export type IndicatorCommand = "edit" | "toggle" | "remove" | "up" | "down" | "refresh" | "collapse";

const ROW =
  "group pointer-events-auto flex w-max max-w-full items-center gap-1.5 whitespace-nowrap rounded-s pr-1 text-s " +
  "bg-[color-mix(in_srgb,var(--chart-bg)_78%,transparent)]";
const BTN = "grid size-[18px] place-items-center rounded-s text-xs text-text-2 hover:bg-raised hover:text-text disabled:opacity-40";

interface RowEls {
  root: HTMLDivElement;
  swatch: HTMLSpanElement;
  name: HTMLButtonElement;
  collapse: HTMLButtonElement;
  values: HTMLSpanElement;
  badge: HTMLSpanElement;
  toggle: HTMLButtonElement;
  remove: HTMLButtonElement;
  up: HTMLButtonElement;
  down: HTMLButtonElement;
  key: RowKey | null;
  detail: HTMLDetailsElement;
  summary: HTMLElement;
  text: HTMLElement;
  select: HTMLButtonElement;
  reportOptions: { label: string; text: string }[];
  dispose(): void;
  refresh: HTMLButtonElement;
  reports: NonNullable<IndicatorRow["detail"]>["reports"] | null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}

function labelButton(button: HTMLButtonElement, label: string) {
  button.title = label;
  button.dataset.label = label;
}

export interface PaneBounds { readonly top: number; readonly height: number }

type RowKey = "panel" | "price";

export class IndicatorLegend {
  readonly priceBox = el("div", "flex flex-col gap-px");
  private readonly rows = new Map<string, RowEls>();

  private layoutRows: readonly IndicatorRow[] = [];
  private layoutValues: readonly PriceLegendValues[] = [];

  constructor(
    private readonly overlay: HTMLElement,
    private readonly onCommand: (id: string, command: IndicatorCommand, anchor: HTMLElement) => void,
  ) {}

  render(rows: IndicatorRow[], panes: readonly PaneBounds[], axisWidth = 72): void {
    const focused = document.activeElement;
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.id);
      const r = this.rows.get(row.id) ?? this.build(row.id);
      this.rows.set(row.id, r);
      this.place(r, row.panel ? "panel" : "price");
      this.fill(r, row);
      if (row.panel) {
        if (r.root.parentElement !== this.overlay) this.overlay.append(r.root);
        r.root.style.maxWidth = `calc(100% - ${axisWidth + 16}px)`;
        const pane = panes[row.panel.index + 1];
        const height = Math.max(r.root.getBoundingClientRect().height, ...[...r.root.querySelectorAll("button")].map((button) => button.getBoundingClientRect().height));
        const marginTop = parseFloat(getComputedStyle(r.root).marginTop);
        r.root.style.top = `${(pane?.top ?? 0) - marginTop + Math.min(4, Math.max(0, (pane?.height ?? 0) - height))}px`;
        r.up.disabled = row.panel.index === 0;
        r.down.disabled = row.panel.index === row.panel.count - 1;
      }
    }
    const price = rows.filter((row) => !row.panel).map((row) => this.rows.get(row.id)!.root);
    if (price.some((root, i) => this.priceBox.children[i] !== root) || this.priceBox.children.length !== price.length) {
      this.priceBox.replaceChildren(...price);
    }
    for (const [id, r] of this.rows) {
      if (seen.has(id)) continue;
      r.dispose();
      r.root.remove();
      this.rows.delete(id);
    }
    if (focused instanceof HTMLElement && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
  }

  setLayoutRows(rows: readonly IndicatorRow[], values: readonly PriceLegendValues[]): void {
    this.layoutRows = rows.filter((row) => !row.panel);
    this.layoutValues = values;
  }

  projection(): LegendProjection {
    const root = el("div", this.priceBox.className);
    const choices = new Map(this.layoutValues.map((row) => [row.id, row.slots]));
    const fields: LegendField[] = [];
    for (const row of this.layoutRows) {
      const slots = choices.get(row.id) ?? [];
      const elements = this.build(row.id, false);
      this.place(elements, "price");
      const values = this.fill(elements, { ...row, values: slots.map((texts, i) => ({ text: texts[0] ?? "", color: row.values[i]?.color ?? row.color })) }, false);
      fields.push(...values.map((element, i) => ({ element, alternatives: slots[i] ?? [] })));
      root.append(elements.root);
    }
    return { root, fields };
  }

  dispose(): void {
    for (const r of this.rows.values()) { r.dispose(); r.root.remove(); }
    this.rows.clear();
    this.priceBox.remove();
  }

  private place(r: RowEls, key: RowKey): void {
    if (r.key === key) return;
    r.key = key;
    const panel = key === "panel";
    r.root.className = panel ? `${ROW} absolute left-2 z-[4]` : ROW;
    if (!panel) r.root.style.removeProperty("top");
    if (!panel) r.root.style.removeProperty("max-width");
    for (const button of [r.collapse, r.up, r.down]) button.hidden = !panel;
    labelButton(r.remove, panel ? "패널 닫기" : "지우기");
  }

  private build(id: string, interactive = true): RowEls {
    const root = el("div", ROW);
    root.dataset.indicatorRow = id;
    const swatch = el("span", "h-0.5 w-2.5 flex-none rounded-full");
    const name = el("button", "min-w-0 truncate text-text-2 hover:text-text");
    name.type = "button";
    name.dataset.chartControl = "";
    name.dataset.indicatorEdit = id;
    const values = el("span", "flex gap-1.5 font-medium");
    const badge = el("span", "rounded-[9px] border border-line px-1.5 text-xs text-text-3");
    const tools = el("span", "flex gap-px opacity-0 group-hover:opacity-100 group-focus-within:opacity-100");
    const button = (icon: MarkupIcon, label: string, command: IndicatorCommand) => {
      const b = el("button", BTN);
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
    button("gear", "설정", "edit");
    const toggle = button("eye", "숨기기", "toggle");
    const remove = button("close", "지우기", "remove");
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
    const text = el("p", "whitespace-pre-wrap text-xs");
    const refresh = el("button", "btn-primary mt-2", "전체 재무자료 업데이트");
    refresh.type = "button";
    refresh.dataset.chartControl = "";
    refresh.title = "전체 재무자료 업데이트";
    if (interactive) refresh.addEventListener("click", () => this.onCommand(id, "refresh", refresh));
    box.append(select, text, refresh);
    detail.append(summary, box);
    root.append(swatch, name, detail, values, badge, tools);
    const row: RowEls = { root, swatch, name, collapse, values, badge, toggle, remove, up, down, key: null, detail, summary, text, select, refresh, reports: null, reportOptions: [], dispose: () => {} };
    const disposeSelect = interactive ? domSelect(select, () => row.reportOptions.map((option, i) => ({ label: option.label, value: String(i) })), (value) => {
      select.dataset.value = value;
      const option = row.reportOptions[Number(value)];
      select.textContent = option?.label ?? ""; text.textContent = option?.text ?? "";
    }) : null;
    row.dispose = () => { cleanup?.(); disposeSelect?.(); };
    return row;
  }

  private fill(r: RowEls, row: IndicatorRow, interactive = true): HTMLSpanElement[] {
    r.detail.hidden = !row.detail;
    if (row.detail) {
      r.name.className = "min-w-0 truncate text-text-2 max-md:max-w-[15ch]";
      r.values.className = "flex min-w-0 gap-1.5 truncate font-medium max-md:max-w-[10ch]";
      r.summary.textContent = "";
      r.summary.className = "financial-status-dot";
      r.summary.dataset.status = row.detail.status;
      r.summary.title = row.detail.summary;
      r.summary.setAttribute("aria-label", `${row.name} 재무자료와 갱신 상태`);

      if (r.reports !== row.detail.reports) {
        r.reports = row.detail.reports;
        r.reportOptions = [{ label: "차트에서 가리킨 보고기간", text: row.detail.text }, ...row.detail.reports];
        if (!r.select.dataset.value) r.select.dataset.value = "0";
      }
      const current = r.reportOptions[0];
      if (current) current.text = row.detail.text;
      const selected = r.reportOptions[Number(r.select.dataset.value)] ?? current;
      r.select.textContent = selected?.label ?? "";
      r.text.textContent = selected?.text ?? row.detail.text;
    }
    labelButton(r.collapse, row.panel?.collapsed ? "패널 펼치기" : "패널 접기");
    r.collapse.setAttribute("aria-expanded", String(!row.panel?.collapsed));
    const collapseIcon = row.panel?.collapsed ? "up" : "down";
    if (r.collapse.dataset.icon !== collapseIcon) { r.collapse.innerHTML = iconMarkup(collapseIcon); r.collapse.dataset.icon = collapseIcon; }
    r.root.classList.toggle("indicator-collapsed", row.panel?.collapsed === true);
    if (interactive && row.panel?.collapsed) {
      r.root.dataset.chartControl = "";
      r.root.onclick = (event) => { if (!event.composedPath().some((target) => target instanceof Element && target.matches("button,summary"))) this.onCommand(row.id, "collapse", r.root); };
    } else { delete r.root.dataset.chartControl; r.root.onclick = null; }
    const dim = row.state !== "ok" && row.state !== "pending";
    r.root.classList.toggle("opacity-60", dim);
    r.swatch.style.background = row.color;
    r.name.textContent = row.name;
    r.name.title = row.name;
    r.name.setAttribute("aria-label", `${row.name} ${row.panel?.collapsed ? "펼치기" : "설정 열기"}`);
    if (interactive) r.name.onclick = () => this.onCommand(row.id, row.panel?.collapsed ? "collapse" : "edit", r.name);
    const values = row.values.map((v) => {
      const span = el("span", "", v.text);
      span.style.color = v.color;
      return span;
    });
    r.values.replaceChildren(...values);
    const badge = row.state === "spec" || row.state === "calc" ? indicatorErrorText(row.state) : "";
    r.badge.textContent = badge;
    r.badge.hidden = badge === "";
    const hidden = row.state === "hidden";
    const icon = hidden ? "eyeOff" : "eye";
    if (r.toggle.dataset.icon !== icon) { r.toggle.innerHTML = iconMarkup(icon); r.toggle.dataset.icon = icon; }
    labelButton(r.toggle, hidden ? "보이기" : "숨기기");
    r.root.querySelectorAll<HTMLButtonElement>("button[data-indicator-command]").forEach((b) => b.setAttribute("aria-label", `${row.name} ${b.dataset.label}`));
    return values;
  }
}
