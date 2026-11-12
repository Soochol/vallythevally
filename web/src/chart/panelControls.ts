import type { IChartApi } from "lightweight-charts";
import type { Panel } from "./settings";

export class PanelControls {
  private readonly handles = new Map<string, HTMLDivElement>();
  private panels: readonly Panel[] = [];
  private drag: { pointer: number; startY: number; before: number[]; heights: number[]; above: number; below: number; handle: HTMLDivElement } | null = null;

  constructor(private readonly parent: HTMLElement, private readonly chart: IChartApi, private readonly changed: () => void, private readonly save: () => void) {}

  render(panels: readonly Panel[], tops: readonly number[]): void {
    this.panels = panels;
    const keep = new Set(panels.map((p) => p.id));
    for (const [id, handle] of this.handles) {
      if (!keep.has(id)) { handle.remove(); this.handles.delete(id); }
    }
    panels.forEach((panel, i) => {
      let handle = this.handles.get(panel.id);
      if (!handle) {
        handle = document.createElement("div");
        handle.className = "absolute left-0 right-0 z-[5] h-2 -translate-y-1/2 cursor-row-resize touch-none hover:bg-accent-soft focus-visible:bg-accent-soft";
        handle.dataset.chartControl = "";
        handle.dataset.panelResize = panel.id;
        handle.setAttribute("role", "separator");
        handle.setAttribute("aria-orientation", "horizontal");
        handle.setAttribute("aria-label", "패널 높이 조절");
        handle.tabIndex = 0;
        handle.onpointerdown = (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          handle!.setPointerCapture(event.pointerId);
          this.begin(handle!, panel.id, event.clientY, event.pointerId);
        };
        handle.onpointermove = (event) => {
          if (this.drag?.pointer === event.pointerId) this.move(event.clientY);
        };
        handle.onpointerup = (event) => {
          if (this.drag?.pointer !== event.pointerId) return;
          this.move(event.clientY);
          this.drag = null;
          handle!.releasePointerCapture(event.pointerId);
          this.save();
        };
        const cancel = () => {
          if (!this.drag || this.drag.handle !== handle) return;
          this.chart.panes().forEach((pane, index) => pane.setStretchFactor(this.drag!.before[index] ?? 1));
          this.drag = null;
          this.changed();
        };
        handle.onpointercancel = cancel;
        handle.onlostpointercapture = cancel;
        handle.onkeydown = (event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault(); event.stopPropagation();
          this.begin(handle!, panel.id, 0, -1);
          this.move(event.key === "ArrowUp" ? -16 : 16);
          this.drag = null;
          this.save();
        };
        this.handles.set(panel.id, handle);
        this.parent.append(handle);
      }
      handle.hidden = panel.collapsed === true;
      handle.style.top = `${tops[i + 1] ?? 0}px`;
      handle.setAttribute("aria-valuenow", String(this.chart.panes()[i + 1]?.getHeight() ?? 0));
    });
  }

  dispose(): void { for (const handle of this.handles.values()) handle.remove(); this.handles.clear(); this.drag = null; }

  private begin(handle: HTMLDivElement, id: string, startY: number, pointer: number): void {
    const panes = this.chart.panes();
    const index = this.panels.findIndex((p) => p.id === id);
    let above = index;
    while (above > 0 && this.panels[above - 1]?.collapsed) above--;
    this.drag = { pointer, startY, above, below: index + 1, handle, before: panes.map((pane) => pane.getStretchFactor()), heights: panes.map((pane) => pane.getHeight()) };
  }

  private move(y: number): void {
    const drag = this.drag;
    if (!drag) return;
    const aboveHeight = drag.heights[drag.above] ?? 0;
    const belowHeight = drag.heights[drag.below] ?? 0;
    const minimumAbove = drag.above === 0 ? 80 : 48;
    const minimumBelow = 48;
    const totalHeight = aboveHeight + belowHeight;
    if (totalHeight < minimumAbove + minimumBelow) return;
    const delta = Math.max(minimumAbove - aboveHeight, Math.min(belowHeight - minimumBelow, y - drag.startY));
    const totalStretch = drag.before[drag.above]! + drag.before[drag.below]!;
    const stretchPerPixel = drag.before.reduce((sum, stretch) => sum + stretch, 0) / drag.heights.reduce((sum, height) => sum + height, 0);
    const aboveStretch = drag.before[drag.above]! + delta * stretchPerPixel;
    const panes = this.chart.panes();
    panes[drag.above]?.setStretchFactor(aboveStretch);
    panes[drag.below]?.setStretchFactor(totalStretch - aboveStretch);
    this.changed();
  }
}
