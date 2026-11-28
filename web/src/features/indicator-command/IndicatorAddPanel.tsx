import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { useSymbolInfo, useSymbolInfos, useSymbolSearch } from "../../api/queries";
import { colorsFrom, indicatorCssColor, KINDS, shownColor, type IndicatorSpec, type SpecOf } from "../../chart/indicators/kinds";
import { MAX_COMPARE } from "../../chart/settings";
import type { WindowId } from "../../layout/kinds";
import { PERIOD_LABEL, symbolSub } from "../../lib/symbol";
import { useCell, useLayoutStore } from "../../stores/layout";
import type { AddSection } from "../../stores/selection";
import { useActiveWatchlist } from "../../stores/watchlist";
import { CloseIcon, SearchIcon } from "../icons";
import { addButton } from "../indicator-dialog/compareForm";
import { checkForm, draftStyle, nextColor, startDraft } from "../indicator-dialog/indicatorForm";
import { useValidator } from "../indicator-dialog/IndicatorSettingsForm";
import { removeIndicatorsWithUndo, restoreIndicators } from "../indicator-inspector/removalUndo";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { normalizeQuery } from "../search/highlight";
import { searchList } from "../search/searchList";
import { Kbd } from "../ui/Kbd";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import { addIndicatorCommand, executeCommand } from "./execute";
import { forgetRemembered, rememberedOf } from "./memory";
import { addRows, indicatorPeriodBadge, QUICK_MA_PERIODS, stepRow, type AddRow } from "./model";
import type { IndicatorCandidate } from "./parseInput";
import { useIndicatorPreview } from "./preview";

const SECTIONS = [
  { value: "indicators", label: "지표" },
  { value: "compare", label: "종목 비교" },
] as const satisfies readonly SegmentedOption<AddSection>[];

type SymbolRow = { kind: "symbol"; key: string; info: SymbolInfo; on: boolean; reason: string | null };
type Row = AddRow | SymbolRow;

export function IndicatorAddPanel({ cellId, section, onSection, autoFocus = false, focusNonce = 0, embedded = false, regionLabel }: {
  cellId: WindowId;
  section: AddSection;
  onSection(section: AddSection): void;
  autoFocus?: boolean;
  focusNonce?: number;
  embedded?: boolean;
  regionLabel?: string;
}) {
  const cell = useCell(cellId);
  const settings = cell.chartSettings;
  const name = useSymbolInfo(cell.symbol).data?.name ?? cell.symbol;
  const [input, setInput] = useState("");
  const [active, setActive] = useState(0);
  const [previewIds] = useState(() => [crypto.randomUUID(), crypto.randomUUID()] as const);
  const validator = useValidator();
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  const queryClient = useQueryClient();
  const comparing = section === "compare";
  const query = normalizeQuery(input);
  const search = useSymbolSearch(comparing ? query : "");
  const watch = useSymbolInfos(useActiveWatchlist().symbols);
  const compared = useSymbolInfos(settings.compare);
  const symbols = searchList(query, { watch, recent: [] }, search.data);

  const indicatorRows = useMemo(() => (comparing ? [] : addRows(settings, input)), [comparing, settings, input]);
  const symbolRows = useMemo(() => {
    if (!comparing) return [];
    const listed = new Set<string>();
    const out: SymbolRow[] = [];
    const push = (info: SymbolInfo) => {
      if (listed.has(info.code) || info.code === cell.symbol) return;
      listed.add(info.code);
      const on = settings.compare.includes(info.code);
      out.push({ kind: "symbol", key: `symbol:${info.code}`, info, on, reason: on ? null : addButton(settings, info, cell.symbol).reason });
    };
    if (query === "") for (const info of compared) push(info);
    for (const { info } of symbols.rows) push(info);
    return out;
  }, [comparing, settings, query, compared, symbols.rows, cell.symbol]);
  const rows: Row[] = comparing ? symbolRows : indicatorRows;

  const activeIndex = rows.length === 0 ? -1 : Math.min(active, rows.length - 1);
  const activeRow = activeIndex < 0 ? null : rows[activeIndex]!;
  const optionId = (index: number) => `${ids}-option-${index}`;

  useEffect(() => { setActive(0); }, [input, section]);
  useEffect(() => {
    if (focusNonce > 0) inputRef.current?.focus();
  }, [focusNonce]);
  useEffect(() => {
    if (activeIndex >= 0) document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const specOf = (candidate: IndicatorCandidate): IndicatorSpec | null => {
    if (candidate.errors.length > 0) return null;
    const check = checkForm(candidate.form, typeof validator === "function" ? validator : null);
    if (!check.spec || check.errors.length > 0) return null;
    if (typeof validator === "function" && !check.ok) return null;
    return check.spec;
  };

  const styleOf = (candidate: IndicatorCandidate, spec: IndicatorSpec) => {
    const draft = startDraft(null, candidate.kind);
    return { style: draftStyle(draft, colorsFrom(spec, nextColor(settings.indicators))), placement: draft.placement };
  };

  const previewed = activeRow?.kind === "candidate" ? activeRow.candidate : null;
  useEffect(() => {
    const spec = previewed ? specOf(previewed) : null;
    if (!previewed || !spec) return useIndicatorPreview.getState().set(cellId, null);
    const { style, placement } = styleOf(previewed, spec);
    useIndicatorPreview.getState().set(cellId, { kind: "add", id: previewIds[0], panelId: previewIds[1], spec, style, placement });
  }, [previewed, validator, settings.indicators, cellId]);
  useEffect(() => () => useIndicatorPreview.getState().set(cellId, null), [cellId]);

  const refocus = () => inputRef.current?.focus();

  const addNew = (candidate: IndicatorCandidate): boolean => {
    const spec = specOf(candidate);
    if (!spec) return false;
    const { style, placement } = styleOf(candidate, spec);
    return addIndicatorCommand(cellId, spec, style, placement) !== null;
  };

  const toggleKind = (candidate: IndicatorCandidate) => {
    const kind = candidate.kind;
    const existing = settings.indicators.filter((item) => item.spec.kind === kind);
    if (existing.length > 0) return removeIndicatorsWithUndo(cellId, existing, `${KINDS[kind].label} ${existing.length}개를 지웠습니다`);
    const last = rememberedOf(cellId, kind);
    if (last.length === 0) return void addNew(candidate);
    forgetRemembered(cellId, kind);
    restoreIndicators(cellId, last);
  };

  const toggleMa = (period: number) => {
    const existing = settings.indicators.filter((item) => item.spec.kind === "ma" && item.spec.period === period);
    if (existing.length > 0) return removeIndicatorsWithUndo(cellId, existing, `이동평균 ${period} ${existing.length}개를 지웠습니다`);
    const last = rememberedOf(cellId, "ma").filter((item) => item.spec.kind === "ma" && item.spec.period === period);
    if (last.length > 0) return restoreIndicators(cellId, last.slice(0, 1));
    const spec: SpecOf<"ma"> = { kind: "ma", method: "sma", period };
    useLayoutStore.getState().addIndicator(cellId, spec, { colors: colorsFrom(spec, nextColor(settings.indicators)), width: 1 }, "price");
  };

  const toggleSymbol = (row: SymbolRow) => {
    if (row.on) return useLayoutStore.getState().removeCompare(cellId, row.info.code);
    if (row.reason !== null || !symbols.selectable && query !== "") return;
    if (executeCommand(cellId, { kind: "compare", code: row.info.code })) queryClient.setQueryData(["symbol", row.info.code], row.info);
  };

  const run = (row: Row) => {
    if (row.kind === "symbol") toggleSymbol(row);
    else if (row.kind === "switch") toggleKind(row.candidate);
    else if (addNew(row.candidate)) setInput("");
    refocus();
  };

  const maLines = settings.indicators.filter((item) => item.spec.kind === "ma");
  const full = settings.compare.length >= MAX_COMPARE;
  const typedError = activeRow?.kind === "candidate" ? activeRow.candidate.errors[0]?.message ?? null : null;

  return <div className="ia-panel" data-chart-control="" role={regionLabel ? "region" : undefined} aria-label={regionLabel}>
    <header className="ia-head">
      {embedded ? <span className="ia-sub-cell">{name} · {PERIOD_LABEL[cell.period]}</span> : <h3 className="ia-title"><span>더하기</span><small>{name} · {PERIOD_LABEL[cell.period]}</small></h3>}
      <Segmented label="더할 것" mode="pressed" size="sm" options={SECTIONS} value={section} onChange={(next) => { onSection(next); setInput(""); refocus(); }} />
    </header>
    <label className="ia-search">
      <SearchIcon size={14} />
      <input ref={(node) => { inputRef.current = node; if (node && autoFocus) node.setAttribute("autofocus", ""); }} role="combobox" aria-label="지표·비교 찾기" aria-expanded={rows.length > 0} aria-controls={`${ids}-list`} aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined} aria-autocomplete="list"
        value={input} autoComplete="off" spellCheck={false}
        placeholder={comparing ? "비교할 종목 이름·코드" : "이름으로 찾기 · 이평 60, rsi 7, bb 20 2"}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive(stepRow(activeIndex, event.key === "ArrowDown" ? 1 : -1, rows.length));
          } else if (event.key === "Enter" && activeRow) {
            event.preventDefault();
            run(activeRow);
          }
        }} />
      {input !== "" && <button type="button" className="ia-clear" aria-label="입력 지우기" onClick={() => { setInput(""); refocus(); }}><CloseIcon size={12} /></button>}
    </label>
    {comparing && <p className="ia-note"><b className="tabular-nums">비교 종목 {settings.compare.length}/{MAX_COMPARE}</b>{full ? addButton(settings, null, cell.symbol).reason : "같은 시점부터의 % 변화로 견줍니다. 비교 종목이 있는 동안 가격 축은 %입니다."}</p>}
    <ul id={`${ids}-list`} role="listbox" aria-label={comparing ? "비교 종목" : "지표 종류"} aria-multiselectable="true" className="ia-list">
      {rows.map((row, index) => {
        const current = index === activeIndex;
        if (row.kind === "symbol") {
          const blocked = !row.on && (row.reason !== null || full);
          return <li key={row.key} id={optionId(index)} role="option" aria-label={row.info.name} aria-selected={row.on} aria-checked={row.on} aria-disabled={blocked || undefined} data-current={current || undefined} title={blocked ? row.reason ?? undefined : undefined}
            className="ui-switch ia-row" onMouseEnter={() => setActive(index)} onClick={() => run(row)}>
            <span className="ia-row-name"><span>{row.info.name}</span><small>{symbolSub(row.info.code, row.info)}</small></span>
            <span aria-hidden="true" className="ui-switch-track"><span /></span>
          </li>;
        }
        const kind = row.candidate.kind;
        const showGroup = row.group !== (rows[index - 1] as AddRow | undefined)?.group;
        const badge = indicatorPeriodBadge(kind);
        if (row.kind === "candidate") {
          return <Fragment key={row.key}>
            {showGroup && <li role="presentation" className="ia-group">{row.group}</li>}
            <li id={optionId(index)} role="option" aria-label={`${row.candidate.label} 더하기`} aria-selected={false} aria-disabled={row.candidate.errors.length > 0 || undefined} data-current={current || undefined}
              className="ia-row ia-candidate" onMouseEnter={() => setActive(index)} onClick={() => run(row)}>
              <span className="ia-row-name"><span>{row.candidate.label} 더하기</span>{badge && <span className="ui-badge" data-tone="warning">{badge}</span>}</span>
              <Kbd>Enter</Kbd>
            </li>
          </Fragment>;
        }
        const on = row.count > 0;
        return <Fragment key={row.key}>
          {showGroup && <li role="presentation" className="ia-group">{row.group}</li>}
          <li id={optionId(index)} role="option" aria-label={KINDS[kind].label} aria-selected={on} aria-checked={on} data-current={current || undefined}
            className="ui-switch ia-row" onMouseEnter={() => setActive(index)} onClick={() => run(row)}>
            <span className="ia-row-name"><span>{KINDS[kind].label}</span>{row.count > 1 && <small>{row.count}개</small>}{badge && <span className="ui-badge" data-tone="warning">{badge}</span>}</span>
            {on && KINDS[kind].fields.length > 0 && <button type="button" className="ia-more" aria-label={`${KINDS[kind].label} 하나 더`} title="같은 지표를 하나 더 넣습니다. 값은 범례에서 바꿉니다" onClick={(event) => { event.stopPropagation(); addNew(row.candidate); refocus(); }}>하나 더</button>}
            <span aria-hidden="true" className="ui-switch-track"><span /></span>
          </li>
          {kind === "ma" && <li role="presentation" className="ia-ma">
            <span role="group" aria-label="이동평균 기간" className="ia-ma-chips">
              {QUICK_MA_PERIODS.map((period) => {
                const line = maLines.find((item) => item.spec.kind === "ma" && item.spec.period === period);
                return <button key={period} type="button" className="ia-ma-chip" aria-pressed={line !== undefined} aria-label={`이동평균 ${period}`}
                  style={line ? { background: indicatorCssColor(shownColor(line.spec, line.style.colors)) } : undefined}
                  onClick={() => { toggleMa(period); refocus(); }}>{period}</button>;
              })}
            </span>
          </li>}
        </Fragment>;
      })}
      {rows.length === 0 && !comparing && <li role="presentation">
        <EmptyState title="맞는 지표가 없습니다" action={`종목 비교에서 ‘${input.trim()}’ 찾기`} onAction={() => { onSection("compare"); refocus(); }}>이름·약어·초성으로 찾아보세요. 예: 볼밴, macd, 이평 60</EmptyState>
      </li>}
      {rows.length === 0 && comparing && !search.isFetching && !search.isError && <li role="presentation">
        <EmptyState title={query === "" ? "비교할 종목을 찾아보세요" : "맞는 종목이 없습니다"} action={query === "" ? undefined : "입력 지우기"} onAction={() => { setInput(""); refocus(); }}>종목 이름·코드·초성으로 찾습니다.</EmptyState>
      </li>}
      {comparing && !symbols.selectable && search.isFetching && <li role="presentation"><Skeleton label="비교 종목 찾는 중" /></li>}
      {comparing && search.isError && <li role="presentation"><ErrorState message="종목을 찾지 못했습니다. 다시 시도해 보세요." retry={() => void search.refetch()} /></li>}
    </ul>
    <footer className="ia-foot">
      {typedError ? <span role="alert" className="text-danger">{typedError}</span> : <span className="ia-hints"><span><Kbd>↑↓</Kbd> 고르기</span><span><Kbd>Enter</Kbd> {activeRow?.kind === "candidate" ? "더하기" : "켜고 끄기"}</span><span><Kbd>Esc</Kbd> 닫기</span></span>}
    </footer>
  </div>;
}

