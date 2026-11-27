import { placementsOf, specName } from "./indicators/kinds";
import type { PaneBounds } from "./indicators/legendRows";
import { resolvePanelScales, scaleDomainOf } from "./indicators/scales";
import { type IndicatorConfig, MAX_INDICATORS_PER_PANEL, type Panel } from "./settings";
import { indicatorColorValue, type ThemeTokens } from "./theme";
import { colorLine, lineColor } from "./indicators/kinds";

export type DropTarget =
  | {
      readonly kind: "merge";
      readonly panelId: "price" | Panel["id"];
      readonly pane: PaneBounds;
      readonly blocked: boolean;
      readonly label: string;
      readonly tag: string;
    }
  | {
      readonly kind: "split";
      readonly insertAt: number;
      readonly lineY: number;
      readonly label: string;
    };

export interface DropHitInput {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly draggedId: string;
  readonly configs: readonly IndicatorConfig[];
  readonly panels: readonly Panel[];
  readonly panes: readonly PaneBounds[];
}

const DRAG_THRESHOLD_PX = 5;
const EDGE_RATIO_EXPANDED = 0.22;
const EDGE_RATIO_COLLAPSED = 0.35;

export function resolveDropTarget(input: DropHitInput): DropTarget | null {
  const { x, y, width, height, draggedId, configs, panels, panes } = input;
  if (panes.length === 0) return null;
  if (x < -30 || x > width + 30 || y < -20 || y > height + 20) return null;

  const dragged = configs.find((config) => config.id === draggedId);
  if (!dragged) return null;
  const siblings = configs.filter((config) => config.panel === dragged.panel);
  const isSoloPanel = dragged.panel !== "price" && siblings.length === 1;
  const canOverPrice = placementsOf(dragged.spec.kind).includes("price");

  const pricePane = panes[0]!;
  if (y < pricePane.top + pricePane.height) {
    const bottomEdge = pricePane.top + pricePane.height - Math.min(34, pricePane.height * 0.16);
    if (y >= bottomEdge) {
      return {
        kind: "split",
        insertAt: 0,
        lineY: pricePane.top + pricePane.height,
        label: isSoloPanel ? "맨 위 패널로 이동" : "여기에 새 패널로 분리",
      };
    }
    if (canOverPrice) {
      if (dragged.panel === "price") return null;
      return {
        kind: "merge",
        panelId: "price",
        pane: pricePane,
        blocked: false,
        label: "가격 패널에 겹치기",
        tag: "거래량 겹치기",
      };
    }
    return {
      kind: "merge",
      panelId: "price",
      pane: pricePane,
      blocked: true,
      label: "거래량만 가격 패널에 겹칠 수 있습니다",
      tag: "",
    };
  }

  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i]!;
    const pane = panes[i + 1];
    if (!pane) continue;
    if (y < pane.top || y > pane.top + pane.height) continue;

    const rel = (y - pane.top) / Math.max(1, pane.height);
    const edgeRatio = panel.collapsed ? EDGE_RATIO_COLLAPSED : EDGE_RATIO_EXPANDED;
    if (rel < edgeRatio) {
      return {
        kind: "split",
        insertAt: i,
        lineY: pane.top,
        label: isSoloPanel ? "여기로 패널 이동" : "여기에 새 패널로 분리",
      };
    }
    if (rel > 1 - edgeRatio) {
      return {
        kind: "split",
        insertAt: i + 1,
        lineY: pane.top + pane.height,
        label: isSoloPanel ? "여기로 패널 이동" : "여기에 새 패널로 분리",
      };
    }

    if (dragged.panel === panel.id) return null;

    const targetMembers = configs.filter((config) => config.panel === panel.id);
    const targetNames = targetMembers.map((config) => specName(config.spec)).join(" + ");
    if (targetMembers.length >= MAX_INDICATORS_PER_PANEL) {
      return {
        kind: "merge",
        panelId: panel.id,
        pane,
        blocked: true,
        label: `패널당 최대 ${MAX_INDICATORS_PER_PANEL}개까지 합칠 수 있습니다`,
        tag: "",
      };
    }

    const draggedDomain = scaleDomainOf(dragged.spec);
    const sameDomain = targetMembers.some((member) => scaleDomainOf(member.spec) === draggedDomain);
    const targetScales = resolvePanelScales(configs, panel.id);
    const hasLeft = [...targetScales.values()].some((scale) => scale.slot === "left");
    const tag = sameDomain ? "우측 축 공유" : !hasLeft ? "좌측 Y축(L) 자동 배정" : "독립 스케일 배정";
    return {
      kind: "merge",
      panelId: panel.id,
      pane,
      blocked: false,
      label: `「${targetNames}」 패널에 합치기`,
      tag,
    };
  }

  const lastPane = panes[panes.length - 1]!;
  return {
    kind: "split",
    insertAt: panels.length,
    lineY: lastPane.top + lastPane.height,
    label: isSoloPanel ? "맨 아래 패널로 이동" : "맨 아래 새 패널로 분리",
  };
}

export interface PanelDndHost {
  panes(): readonly PaneBounds[];
  panels(): readonly Panel[];
  configs(): readonly IndicatorConfig[];
  tokens(): ThemeTokens;
  onMerge(indicatorId: string, targetPanelId: "price" | Panel["id"]): void;
  onSplit(indicatorId: string, insertAt: number): void;
}

interface PendingDrag {
  readonly pointerId: number;
  readonly indicatorId: string;
  readonly rowEl: HTMLElement;
  readonly startX: number;
  readonly startY: number;
}

interface ActiveDrag {
  readonly pointerId: number;
  readonly indicatorId: string;
  readonly rowEl: HTMLElement;
  target: DropTarget | null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

export class PanelDnd {
  private readonly mergeOverlay: HTMLDivElement;
  private readonly mergePill: HTMLDivElement;
  private readonly mergeLabel: HTMLSpanElement;
  private readonly mergeTag: HTMLSpanElement;
  private readonly splitLine: HTMLDivElement;
  private readonly splitBadge: HTMLSpanElement;
  private readonly ghost: HTMLDivElement;
  private readonly ghostSwatch: HTMLSpanElement;
  private readonly ghostTitle: HTMLSpanElement;
  private pending: PendingDrag | null = null;
  private active: ActiveDrag | null = null;

  constructor(private readonly parent: HTMLElement, private readonly host: PanelDndHost) {
    this.mergeOverlay = el("div", "pane-dnd-merge");
    this.mergeOverlay.dataset.paneDndMerge = "";
    this.mergePill = el("div", "pane-dnd-merge-pill");
    this.mergeLabel = el("span", "");
    this.mergeTag = el("span", "pane-dnd-merge-tag");
    this.mergePill.append(this.mergeLabel, this.mergeTag);
    this.mergeOverlay.append(this.mergePill);

    this.splitLine = el("div", "pane-dnd-split");
    this.splitLine.dataset.paneDndSplit = "";
    this.splitBadge = el("span", "pane-dnd-split-badge");
    this.splitLine.append(this.splitBadge);

    this.ghost = el("div", "pane-dnd-ghost");
    this.ghost.dataset.paneDndGhost = "";
    this.ghostSwatch = el("span", "h-0.5 w-2.5 flex-none rounded-full");
    this.ghostTitle = el("span", "");
    this.ghost.append(this.ghostSwatch, this.ghostTitle);

    this.parent.append(this.mergeOverlay, this.splitLine);
    this.parent.addEventListener("pointerdown", this.onPointerDown);
    this.parent.addEventListener("mousedown", this.onMouseDown);
  }

  dispose(): void {
    this.cancel();
    this.parent.removeEventListener("pointerdown", this.onPointerDown);
    this.parent.removeEventListener("mousedown", this.onMouseDown);
    this.mergeOverlay.remove();
    this.splitLine.remove();
    this.ghost.remove();
  }

  private draggableRowFrom(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    if (target.closest("button,summary,[data-indicator-command]")) return null;
    const row = target.closest<HTMLElement>('[data-indicator-row][data-draggable="true"]');
    if (!row || !this.parent.contains(row)) return null;
    return row;
  }

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    if (this.draggableRowFrom(event.target)) {
      event.stopPropagation();
    }
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const row = this.draggableRowFrom(event.target);
    if (!row) return;
    const indicatorId = row.dataset.indicatorRow;
    if (!indicatorId) return;
    event.preventDefault();
    event.stopPropagation();
    this.pending = {
      pointerId: event.pointerId,
      indicatorId,
      rowEl: row,
      startX: event.clientX,
      startY: event.clientY,
    };
    window.addEventListener("pointermove", this.onPointerMove, true);
    window.addEventListener("pointerup", this.onPointerUp, true);
    window.addEventListener("pointercancel", this.onPointerCancel, true);
    window.addEventListener("keydown", this.onKeyDown, true);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.pending && event.pointerId === this.pending.pointerId) {
      const dist = Math.hypot(event.clientX - this.pending.startX, event.clientY - this.pending.startY);
      if (dist < DRAG_THRESHOLD_PX) return;
      this.activate(this.pending, event);
      this.pending = null;
    }
    if (!this.active || event.pointerId !== this.active.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    this.updateDrag(event.clientX, event.clientY);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.pending && event.pointerId === this.pending.pointerId) {
      this.detachListeners();
      this.pending = null;
      return;
    }
    if (!this.active || event.pointerId !== this.active.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const { indicatorId, target } = this.active;
    this.finishVisuals();
    if (!target) return;
    if (target.kind === "merge" && !target.blocked) {
      this.host.onMerge(indicatorId, target.panelId);
    } else if (target.kind === "split") {
      this.host.onSplit(indicatorId, target.insertAt);
    }
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.pending?.pointerId === event.pointerId || this.active?.pointerId === event.pointerId) {
      this.cancel();
    }
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (!this.active && !this.pending) return;
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
  };

  private activate(pending: PendingDrag, event: PointerEvent): void {
    const config = this.host.configs().find((item) => item.id === pending.indicatorId);
    if (!config) {
      this.detachListeners();
      return;
    }
    const tokens = this.host.tokens();
    const primary = colorLine(config.spec);
    const color = primary === null ? tokens.text2 : indicatorColorValue(tokens, lineColor(config.spec, config.style.colors, primary));
    this.ghostSwatch.style.background = color;
    this.ghostTitle.textContent = specName(config.spec);
    if (!this.ghost.isConnected) document.body.append(this.ghost);
    this.ghost.dataset.visible = "true";
    pending.rowEl.dataset.dragging = "true";
    document.body.style.cursor = "grabbing";
    this.active = {
      pointerId: pending.pointerId,
      indicatorId: pending.indicatorId,
      rowEl: pending.rowEl,
      target: null,
    };
    this.updateDrag(event.clientX, event.clientY);
  }

  private updateDrag(clientX: number, clientY: number): void {
    if (!this.active) return;
    this.ghost.style.left = `${clientX}px`;
    this.ghost.style.top = `${clientY}px`;
    const rect = this.parent.getBoundingClientRect();
    const target = resolveDropTarget({
      x: clientX - rect.left,
      y: clientY - rect.top,
      width: rect.width,
      height: rect.height,
      draggedId: this.active.indicatorId,
      configs: this.host.configs(),
      panels: this.host.panels(),
      panes: this.host.panes(),
    });
    this.active.target = target;
    this.paintTarget(target);
  }

  private paintTarget(target: DropTarget | null): void {
    if (!target) {
      delete this.mergeOverlay.dataset.visible;
      delete this.mergeOverlay.dataset.blocked;
      delete this.splitLine.dataset.visible;
      return;
    }
    if (target.kind === "merge") {
      delete this.splitLine.dataset.visible;
      this.mergeOverlay.style.top = `${target.pane.top + 3}px`;
      this.mergeOverlay.style.height = `${Math.max(24, target.pane.height - 6)}px`;
      this.mergeOverlay.dataset.visible = "true";
      if (target.blocked) this.mergeOverlay.dataset.blocked = "true";
      else delete this.mergeOverlay.dataset.blocked;
      this.mergeLabel.textContent = target.label;
      this.mergeTag.textContent = target.tag;
      this.mergeTag.hidden = target.tag === "";
      return;
    }
    delete this.mergeOverlay.dataset.visible;
    delete this.mergeOverlay.dataset.blocked;
    this.splitLine.style.top = `${target.lineY}px`;
    this.splitBadge.textContent = target.label;
    this.splitLine.dataset.visible = "true";
  }

  private cancel(): void {
    this.finishVisuals();
  }

  private finishVisuals(): void {
    this.detachListeners();
    if (this.active) {
      delete this.active.rowEl.dataset.dragging;
    }
    this.pending = null;
    this.active = null;
    delete this.ghost.dataset.visible;
    this.ghost.remove();
    this.paintTarget(null);
    document.body.style.cursor = "";
  }

  private detachListeners(): void {
    window.removeEventListener("pointermove", this.onPointerMove, true);
    window.removeEventListener("pointerup", this.onPointerUp, true);
    window.removeEventListener("pointercancel", this.onPointerCancel, true);
    window.removeEventListener("keydown", this.onKeyDown, true);
  }
}
