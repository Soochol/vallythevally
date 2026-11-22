import { Segment } from "../dialog/DialogParts";
import { COLOR_RANGES, legendStops } from "./colors";
import { HEATMAP_VIEWS, ORDER_LABEL, SIZE_LABEL, SIZE_MODES, SORT_LABEL, SORT_MODES, THEME_ORDERS, VIEW_LABEL, type HeatmapSettings } from "./settings";

interface Props {
  settings: HeatmapSettings;
  onChange(next: HeatmapSettings): void;
  tradedKnown: boolean;
  onEdit(): void;
}

export function Legend({ range }: { range: HeatmapSettings["range"] }) {
  const stops = legendStops(range);
  return (
    <div className="hm-legend" role="img" aria-label={`색 범위 −${range}%에서 +${range}%`} data-range={range}>
      <span className="hm-legend-title">칸 색 = 등락률</span>
      <span className="hm-legend-end">−{range}%</span>
      <div className="hm-legend-bar">
        {stops.map((stop) => <span key={stop.rate} style={{ background: stop.fill }} />)}
      </div>
      <span className="hm-legend-end">+{range}%</span>
      <i className="hm-legend-none" />
      <span>시세 없음</span>
    </div>
  );
}

function Labelled<T extends string | number>(props: { label: string; options: readonly (readonly [T, string])[]; value: T; onChange(value: T): void }) {
  return (
    <div className="hm-control">
      <span className="hm-control-label" aria-hidden="true">{props.label}</span>
      <Segment {...props} />
    </div>
  );
}

export function HeatmapToolbar({ settings, onChange, tradedKnown, onEdit }: Props) {
  const set = <K extends keyof HeatmapSettings>(key: K, value: HeatmapSettings[K]) => onChange({ ...settings, [key]: value });
  return (
    <div className="hm-toolbar">
      <div role="tablist" aria-label="보기" className="hm-views">
        {HEATMAP_VIEWS.map((view) => (
          <button key={view} type="button" role="tab" aria-selected={settings.view === view} className="seg-btn" aria-pressed={settings.view === view} onClick={() => set("view", view)}>
            {VIEW_LABEL[view]}
          </button>
        ))}
      </div>
      <Labelled label="테마 순서" options={THEME_ORDERS.map((order) => [order, ORDER_LABEL[order]] as const)} value={settings.order} onChange={(order) => set("order", order)} />
      {settings.view === "board" && (
        <>
          <Labelled label="색 범위" options={COLOR_RANGES.map((range) => [range, `±${range}%`] as const)} value={settings.range} onChange={(range) => set("range", range)} />
          <Labelled label="칸 크기" options={SIZE_MODES.map((mode) => [mode, SIZE_LABEL[mode]] as const)} value={settings.size} onChange={(size) => set("size", size)} />
          <Labelled label="칸 정렬" options={SORT_MODES.map((mode) => [mode, SORT_LABEL[mode]] as const)} value={settings.sort} onChange={(sort) => set("sort", sort)} />
          <span className="hm-sort-note" role="status">
            칸 정렬: {SORT_LABEL[settings.sort]}{settings.sort === "name" ? " 가나다순" : " 높은 순"} · 크기: {SIZE_LABEL[settings.size]}
            {!tradedKnown && settings.size === "traded" ? " (거래대금을 받지 못해 같은 크기로 보입니다)" : ""}
          </span>
        </>
      )}
      <div className="hm-toolbar-end">
        {settings.view === "board" && <Legend range={settings.range} />}
        <button type="button" className="tb-btn hm-edit-open" aria-haspopup="dialog" onClick={onEdit}>테마 편집</button>
      </div>
    </div>
  );
}
