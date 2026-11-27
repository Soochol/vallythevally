import { useEffect, useRef, useState } from "react";
import { COLOR_RANGES, legendStops } from "../../lib/heat/colors";
import { MAX_THEME_NAME_CHARS, MAX_THEMES } from "../../lib/heatmapThemes";
import { useWatchlistStore } from "../../stores/watchlist";
import { ChevronIcon, CloseIcon, PlusIcon, SearchIcon } from "../icons";
import { Popover } from "../overlay/Popover";
import { Segmented } from "../ui/Segmented";
import { HEATMAP_VIEWS, ORDER_LABEL, SIZE_LABEL, SIZE_MODES, SORT_LABEL, SORT_MODES, THEME_ORDERS, VIEW_LABEL, type HeatmapSettings } from "./settings";

interface Props {
  settings: HeatmapSettings;
  onChange(next: HeatmapSettings): void;
  tradedKnown: boolean;
  themeCount: number;
  listQuery: string;
  onListQueryChange(query: string): void;
  onCreateTheme(name: string): { ok: true; id: string } | { ok: false; problem: string };
  onImportWatchlist(listId: string): string[];
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
        <button key={item} type="button" role="tab" className="ui-seg-item" aria-selected={value === item} onClick={() => onSelect(item)}>
          {labels[item]}
        </button>
      ))}
    </div>
  );
}

function ViewSettings({ settings, onChange, tradedKnown, showsStockControls }: Pick<Props, "settings" | "onChange" | "tradedKnown"> & { showsStockControls: boolean }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const set = <K extends keyof HeatmapSettings>(key: K, value: HeatmapSettings[K]) => onChange({ ...settings, [key]: value });
  const summary = [ORDER_LABEL[settings.order], showsStockControls ? SORT_LABEL[settings.sort] : null, showsStockControls ? `크기 ${SIZE_LABEL[settings.size]}` : null].filter((part) => part !== null).join(" · ");
  const sortDescription = settings.sort === "name" ? " 가나다순" : settings.sort === "custom" ? " 저장된 순서" : " 높은 순";
  return (
    <>
      <button ref={button} type="button" className="btn btn-sm hm-settings" aria-haspopup="dialog" aria-expanded={open} aria-label="보기 설정" title={`보기 설정 · ${summary}`} onClick={() => setOpen((value) => !value)}>
        <span>보기 설정</span>
        <small>{summary}</small>
        <ChevronIcon size={12} />
      </button>
      {open && (
        <Popover anchor={button} role="dialog" aria-label="보기 설정" onClose={() => setOpen(false)} className="hm-settings-pop z-40">
          <Segmented label="테마 순서" mode="pressed" size="sm" value={settings.order} options={THEME_ORDERS.map((order) => ({ value: order, label: ORDER_LABEL[order] }))} onChange={(order) => set("order", order)} />
          {showsStockControls && (
            <>
              <Segmented label="칸 크기" mode="pressed" size="sm" value={settings.size} options={SIZE_MODES.map((mode) => ({ value: mode, label: SIZE_LABEL[mode] }))} onChange={(size) => set("size", size)} />
              <Segmented label="칸 정렬" mode="pressed" size="sm" value={settings.sort} options={SORT_MODES.map((mode) => ({ value: mode, label: SORT_LABEL[mode] }))} onChange={(sort) => set("sort", sort)} />
              <p className="hm-settings-note" role="status">
                칸 정렬: {SORT_LABEL[settings.sort]}{sortDescription} · 크기: {SIZE_LABEL[settings.size]}
                {!tradedKnown && settings.size === "traded" ? " (거래대금을 받지 못해 같은 크기로 보입니다)" : ""}
              </p>
            </>
          )}
        </Popover>
      )}
    </>
  );
}

function AddThemePopover({
  themeCount,
  onCreateTheme,
  onImportWatchlist,
}: Pick<Props, "themeCount" | "onCreateTheme" | "onImportWatchlist">) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const lists = useWatchlistStore((state) => state.lists);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setProblem(null);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className="btn btn-sm hm-add-theme-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          setProblem(null);
          setNotices([]);
        }}
      >
        <PlusIcon size={12} />
        <span>테마 추가</span>
      </button>
      {open && (
        <Popover anchor={button} role="dialog" aria-label="테마 추가" onClose={close} className="hm-add-pop z-40">
          <div className="hm-add-pop-head">
            <b>새 테마 만들기</b>
            <span>{themeCount} / {MAX_THEMES}</span>
          </div>
          <form
            className="hm-add-pop-form"
            onSubmit={(event) => {
              event.preventDefault();
              const result = onCreateTheme(name);
              if (result.ok) {
                setName("");
                setProblem(null);
                setNotices([]);
                setOpen(false);
              } else {
                setProblem(result.problem);
              }
            }}
          >
            <input
              ref={input}
              className="ui-field hm-add-pop-input"
              aria-label="새 테마 이름"
              placeholder={`테마 이름 (${MAX_THEME_NAME_CHARS}자까지)`}
              value={name}
              autoComplete="off"
              onChange={(event) => {
                setName(event.target.value);
                setProblem(null);
              }}
            />
            <button type="submit" className="btn-primary btn-sm">추가</button>
          </form>
          {problem && <p className="hm-add-pop-error" role="alert">{problem}</p>}

          <div className="hm-add-pop-sep" />

          <div className="hm-add-pop-head">
            <b>관심종목 그룹에서 가져오기</b>
          </div>
          <div className="hm-add-pop-imports" role="group" aria-label="관심종목 그룹에서 가져오기">
            {lists.map((list) => (
              <button
                key={list.id}
                type="button"
                className="hm-add-pop-import-btn"
                onClick={() => setNotices(onImportWatchlist(list.id))}
              >
                <span>{list.name}</span>
                <small>그룹 {list.groups.length}개</small>
              </button>
            ))}
          </div>
          <p className="hm-add-pop-note">선택한 관심종목 목록의 그룹이 테마로 복사됩니다. 원본 관심종목은 바뀌지 않습니다.</p>
          {notices.length > 0 && (
            <ul className="hm-add-pop-notices" role="status" aria-label="가져오기 결과">
              {notices.map((notice) => <li key={notice}>{notice}</li>)}
            </ul>
          )}
        </Popover>
      )}
    </>
  );
}

export function HeatmapToolbar({ settings, onChange, tradedKnown, themeCount, listQuery, onListQueryChange, onCreateTheme, onImportWatchlist }: Props) {
  const showsStockControls = settings.view === "board";
  return (
    <div className="hm-toolbar">
      <SegmentTabs label="보기" values={HEATMAP_VIEWS} labels={VIEW_LABEL} value={settings.view} onSelect={(view) => onChange({ ...settings, view })} />
      <div className="hm-toolbar-end">
        {settings.view === "board" && (
          <>
            <Segmented label="색 범위" mode="pressed" size="sm" value={String(settings.range)} options={COLOR_RANGES.map((range) => ({ value: String(range), label: `±${range}%` }))} onChange={(range) => onChange({ ...settings, range: COLOR_RANGES.find((value) => String(value) === range) ?? settings.range })} />
            <Legend range={settings.range} />
          </>
        )}
        {settings.view === "list" && (
          <>
            <div className="hm-list-search">
              <SearchIcon size={13} />
              <input
                type="search"
                aria-label="종목·테마 검색"
                placeholder="종목 · 테마 검색"
                value={listQuery}
                onChange={(event) => onListQueryChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || !listQuery) return;
                  event.stopPropagation();
                  onListQueryChange("");
                }}
              />
              {listQuery && (
                <button type="button" className="hm-list-search-clear" aria-label="검색 지우기" onClick={() => onListQueryChange("")}>
                  <CloseIcon size={12} />
                </button>
              )}
            </div>
            <Segmented label="종목 정렬" mode="pressed" size="sm" value={settings.sort} options={SORT_MODES.map((mode) => ({ value: mode, label: SORT_LABEL[mode] }))} onChange={(sort) => onChange({ ...settings, sort })} />
          </>
        )}
        <ViewSettings settings={settings} onChange={onChange} tradedKnown={tradedKnown} showsStockControls={showsStockControls} />
        <AddThemePopover themeCount={themeCount} onCreateTheme={onCreateTheme} onImportWatchlist={onImportWatchlist} />
      </div>
    </div>
  );
}
