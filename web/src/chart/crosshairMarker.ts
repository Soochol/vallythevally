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

  refresh(): void {
    const { element, chart, bars, period } = this.host;
    this.root.hidden = true;
    if (!crosshairVisible(element)) {
      this.pointed = null;
      return;
    }
    if (!this.pointed) return;
    const target = matchingBarTime(this.pointed, { bars: bars(), period: period() });
    if (target === null) return;
    const scale = chart.timeScale();
    const x = scale.timeToCoordinate(toChartTime(target));
    const width = scale.width();
    if (x === null || !Number.isFinite(x) || x < 0 || x > width) return;
    const height = element.clientHeight - scale.height();
    this.root.hidden = false;
    this.line.style.left = `${x}px`;
    this.line.style.height = `${height}px`;
    this.label.textContent = formatBarTime(target, period());
    this.label.style.top = `${height}px`;
    this.label.style.left = `${Math.max(0, Math.min(x - this.label.offsetWidth / 2, width - this.label.offsetWidth))}px`;
  }

  dispose(): void {
    this.root.remove();
  }
}
