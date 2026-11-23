import type { IPrimitivePaneRenderer, ISeriesApi, ISeriesPrimitive, ISeriesPrimitiveAxisView, SeriesType, Time } from "lightweight-charts";

export const LAST_PRICE_LINE_OPACITY = 0.55;

export interface LastPriceHost {
  text(price: number): string;
  textColor(): string;
}

interface Placed {
  y: number;
  text: string;
  color: string;
}

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

export class LastPriceTag implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private placed: Placed | null = null;

  private readonly axisView: ISeriesPrimitiveAxisView = {
    coordinate: () => this.placed?.y ?? -1,
    text: () => this.placed?.text ?? "",
    textColor: () => this.host.textColor(),
    backColor: () => this.placed?.color ?? "transparent",
    visible: () => this.placed !== null,
    tickVisible: () => false,
  };

  private readonly axisViews = [this.axisView];

  private readonly lineViews = [{
    zOrder: () => "normal" as const,
    renderer: (): IPrimitivePaneRenderer => ({
      draw: (target: DrawTarget) => this.drawLine(target),
    }),
  }];

  constructor(private readonly host: LastPriceHost) {}

  attached({ series }: { series: ISeriesApi<SeriesType, Time> }): void {
    this.series = series;
  }

  detached(): void {
    this.series = null;
    this.placed = null;
  }

  updateAllViews(): void {
    this.placed = this.locate();
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this.axisViews;
  }

  paneViews() {
    return this.lineViews;
  }

  private locate(): Placed | null {
    const series = this.series;
    if (!series) return null;
    const last = series.lastValueData(false);
    if (last.noData) return null;
    const y = series.priceToCoordinate(last.price);
    return y === null ? null : { y, text: this.host.text(last.price), color: last.color };
  }

  private drawLine(target: DrawTarget): void {
    const placed = this.placed;
    if (!placed) return;
    target.useBitmapCoordinateSpace(({ context, bitmapSize, verticalPixelRatio }) => {
      const thickness = Math.max(1, Math.round(verticalPixelRatio));
      const top = Math.round(placed.y * verticalPixelRatio - thickness / 2);
      context.globalAlpha = LAST_PRICE_LINE_OPACITY;
      context.fillStyle = placed.color;
      context.fillRect(0, top, bitmapSize.width, thickness);
      context.globalAlpha = 1;
    });
  }
}
