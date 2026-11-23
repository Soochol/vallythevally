import { useRef, useState } from "react";
import { COLOR_RANGES, legendStops } from "../../lib/heat/colors";
import { ChevronIcon } from "../icons";
import { Popover } from "../overlay/Popover";
import { Segmented } from "../ui/Segmented";
import { HEATMAP_SOURCES, HEATMAP_VIEWS, ORDER_LABEL, SIZE_LABEL, SOURCE_LABEL, SIZE_MODES, SORT_LABEL, SORT_MODES, THEME_ORDERS, VIEW_LABEL, type HeatmapSettings } from "./settings";

interface Props {
  settings: HeatmapSettings;
  onChange(next: HeatmapSettings): void;
  onSelectSource(source: HeatmapSettings["source"]): void;
  tradedKnown: boolean;
  onEdit(): void;
}

export function Legend({ range }: { range: HeatmapSettings["range"] }) {
  const stops = legendStops(range);
  const zero = (stops.length - 1) / 2;
  return (
    <div className="hm-legend" role="img" aria-label={`색 범위 −${range}%에서 +${range}%`} data-range={range}>
      <span className="hm-legend-title">칸 색 = 등락률</span>
      <span className="hm-legend-end">−{range}%</span>
      <div className="hm-legend-bar">
        {stops.map((stop, i) => <span key={stop.rate} style={{ background: stop.fill }}>{i === zero ? "0" : null}</span>)}
      </div>
      <span className="hm-legend-end">+{range}%</span>
      <i className="hm-legend-none" />
      <span>시세 없음</span>
    </div>
  );
}

interface SegmentTabsProps<T extends string> {
  label: string;
  values: readonly T[];
  labels: Record<T, string>;
  value: T;
  onSelect(value: T): void;
}

function SegmentTabs<T extends string>({ label, values, labels, value, onSelect }: SegmentTabsProps<T>) {
  return (
    <div role="tablist" aria-label={label} className="ui-seg hm-tabs" data-size="sm">
      {values.map((item) => (
        <button key={item} type="button" role="tab" className="ui-seg-item" aria-selected={value === item} aria-pressed={value === item} onClick={() => onSelect(item)}>
          {labels[item]}
        </button>
      ))}
    </div>
  );
}

export function SourceTabs({ settings, onSelect }: { settings: HeatmapSettings; onSelect(source: HeatmapSettings["source"]): void }) {
  return (
    <div role="tablist" aria-label="테마 출처" className="ui-seg hm-tabs" data-size="sm">
      {HEATMAP_SOURCES.map((source) => (
        <button key={source} type="button" role="tab" className="ui-seg-item" aria-selected={settings.source === source} onClick={() => onSelect(source)}>
          {SOURCE_LABEL[source]}
        </button>
      ))}
    </div>
  );
}

function ViewSettings({ settings, onChange, tradedKnown, showsThemeOrder, showsStockControls }: Omit<Props, "onEdit" | "onSelectSource"> & { showsThemeOrder: boolean; showsStockControls: boolean }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const set = <K extends keyof HeatmapSettings>(key: K, value: HeatmapSettings[K]) => onChange({ ...settings, [key]: value });
  const summary = [showsThemeOrder ? ORDER_LABEL[settings.order] : null, showsStockControls ? SORT_LABEL[settings.sort] : null, showsStockControls ? `크기 ${SIZE_LABEL[settings.size]}` : null].filter((part) => part !== null).join(" · ");
  return (
    <>
      <button ref={button} type="button" className="btn btn-sm hm-settings" aria-haspopup="dialog" aria-expanded={open} aria-label="보기 설정" title={`보기 설정 · ${summary}`} onClick={() => setOpen((value) => !value)}>
        <span>보기 설정</span>
        <small>{summary}</small>
        <ChevronIcon size={12} />
      </button>
      {open && (
        <Popover anchor={button} role="dialog" aria-label="보기 설정" onClose={() => setOpen(false)} className="hm-settings-pop z-40">
          {showsThemeOrder && <Segmented label="테마 순서" mode="pressed" size="sm" value={settings.order} options={THEME_ORDERS.map((order) => ({ value: order, label: ORDER_LABEL[order] }))} onChange={(order) => set("order", order)} />}
          {showsStockControls && (
            <>
              <Segmented label="칸 크기" mode="pressed" size="sm" value={settings.size} options={SIZE_MODES.map((mode) => ({ value: mode, label: SIZE_LABEL[mode] }))} onChange={(size) => set("size", size)} />
              <Segmented label="칸 정렬" mode="pressed" size="sm" value={settings.sort} options={SORT_MODES.map((mode) => ({ value: mode, label: SORT_LABEL[mode] }))} onChange={(sort) => set("sort", sort)} />
              <p className="hm-settings-note" role="status">
                칸 정렬: {SORT_LABEL[settings.sort]}{settings.sort === "name" ? " 가나다순" : " 높은 순"} · 크기: {SIZE_LABEL[settings.size]}
                {!tradedKnown && settings.size === "traded" ? " (거래대금을 받지 못해 같은 크기로 보입니다)" : ""}
              </p>
            </>
          )}
        </Popover>
      )}
    </>
  );
}

export function HeatmapToolbar({ settings, onChange, onSelectSource, tradedKnown, onEdit }: Props) {
  const kiwoom = settings.source === "kiwoom";
  const themeMap = kiwoom && settings.view === "board" && settings.theme === null;
  const showsThemeOrder = !kiwoom;
  const showsStockControls = settings.view === "board" && !themeMap;
  return (
    <div className="hm-toolbar">
      <SourceTabs settings={settings} onSelect={onSelectSource} />
      <span className="hm-toolbar-rule" aria-hidden="true" />
      <SegmentTabs label="보기" values={HEATMAP_VIEWS} labels={VIEW_LABEL} value={settings.view} onSelect={(view) => onChange({ ...settings, view })} />
      <div className="hm-toolbar-end">
        {settings.view === "board" && (
          <>
            <Segmented label="색 범위" mode="pressed" size="sm" value={String(settings.range)} options={COLOR_RANGES.map((range) => ({ value: String(range), label: `±${range}%` }))} onChange={(range) => onChange({ ...settings, range: COLOR_RANGES.find((value) => String(value) === range) ?? settings.range })} />
            <Legend range={settings.range} />
          </>
        )}
        {(showsThemeOrder || showsStockControls) && <ViewSettings settings={settings} onChange={onChange} tradedKnown={tradedKnown} showsThemeOrder={showsThemeOrder} showsStockControls={showsStockControls} />}
        {!kiwoom && <button type="button" className="btn btn-sm hm-edit-open" aria-haspopup="dialog" onClick={onEdit}>테마 편집</button>}
      </div>
    </div>
  );
}
