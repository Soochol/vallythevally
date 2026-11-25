import type { IChartApi } from "lightweight-charts";
import type { Bar } from "../api/generated/Bar";
import type { Period } from "../api/generated/Period";
import { crosshairVisible, matchingBarTime, type PointedBar } from "./crosshairSync";
import { formatBarTime, toChartTime } from "./time";

export class CrosshairMarker {
  private readonly root = document.createElement("div");
  private readonly line = document.createElement("div");
  private readonly label = document.createElement("div");
  private pointed: PointedBar = null;
  private visible = false;
  private lastX: number | null = null;
  private lastHeight: number | null = null;
  private lastLabelText = "";
  private lastLabelWidth = 0;
  private lastLabelLeft: number | null = null;

  constructor(private readonly host: { element: HTMLElement; chart: IChartApi; bars(): readonly Bar[]; period(): Period }) {
    this.root.dataset.syncedCrosshair = "";
    this.root.setAttribute("aria-hidden", "true");
    Object.assign(this.root.style, { position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden", zIndex: "3" });
    Object.assign(this.line.style, { position: "absolute", top: "0", width: "0", borderLeft: "1px dashed var(--crosshair)" });
    Object.assign(this.label.style, { position: "absolute", padding: "2px 5px", background: "var(--raised)", color: "var(--text-2)", font: "var(--fs-xs) var(--font-sans)", whiteSpace: "nowrap" });
    this.root.append(this.line, this.label);
    this.root.hidden = true;
    host.element.append(this.root);
  }

  show(bar: PointedBar): void {
    this.pointed = bar;
    this.refresh();
  }

  private hide(): void {
    this.lastLabelWidth = 0;
    delete this.root.dataset.syncedTime;
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
  }

  refresh(): void {
    if (!this.pointed) {
      this.hide();
      return;
    }
    const { element, chart, bars, period } = this.host;
    if (!crosshairVisible(element)) {
      this.pointed = null;
      this.hide();
      return;
    }
    const target = matchingBarTime(this.pointed, { bars: bars(), period: period() });
    if (target === null) {
      this.hide();
      return;
    }
    const scale = chart.timeScale();
    const x = scale.timeToCoordinate(toChartTime(target));
    const width = scale.width();
    if (x === null || !Number.isFinite(x) || x < 0 || x > width) {
      this.hide();
      return;
    }
    const height = element.clientHeight - scale.height();
    if (!this.visible) {
      this.visible = true;
      this.root.hidden = false;
    }
    this.root.dataset.syncedTime = String(target);
    if (this.lastX !== x) {
      this.lastX = x;
      this.line.style.left = `${x}px`;
    }
    if (this.lastHeight !== height) {
      this.lastHeight = height;
      this.line.style.height = `${height}px`;
      this.label.style.top = `${height}px`;
    }
    const text = formatBarTime(target, period());
    if (text !== this.lastLabelText || this.lastLabelWidth === 0) {
      if (text !== this.lastLabelText) {
        this.lastLabelText = text;
        this.label.textContent = text;
      }
      this.lastLabelWidth = this.label.offsetWidth;
    }
    const labelLeft = Math.max(0, Math.min(x - this.lastLabelWidth / 2, width - this.lastLabelWidth));
    if (this.lastLabelLeft !== labelLeft) {
      this.lastLabelLeft = labelLeft;
      this.label.style.left = `${labelLeft}px`;
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
