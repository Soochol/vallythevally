import { useEffect, useId, useMemo, useRef, useState } from "react";
import { colorsFrom, KINDS, type IndicatorKind, type SpecOf } from "../../chart/indicators/kinds";
import type { IndicatorConfig } from "../../chart/settings";
import type { WindowId } from "../../layout/kinds";
import { useLayoutStore } from "../../stores/layout";
import { CloseIcon, PlusIcon, SearchIcon } from "../icons";
import { checkForm, draftStyle, nextColor, startDraft } from "../indicator-dialog/indicatorForm";
import { useValidator } from "../indicator-dialog/IndicatorSettingsForm";
import { addIndicatorCommand } from "./execute";
import { ADD_CATEGORIES, BELOW_GROUP, candidateGroup, FINANCIAL_GROUP, indicatorPeriodBadge, matchesCategory, PRICE_GROUP, QUOTE_GROUP, type AddCategory } from "./model";
import { parseIndicatorInput, type IndicatorCandidate } from "./parseInput";
import { useIndicatorPreview } from "./preview";

const QUICK_MA_PERIODS = [5, 10, 20, 60, 120, 240] as const;

function zoneTagLabel(group: string): string {
  if (group === PRICE_GROUP) return "가격";
  if (group === BELOW_GROUP) return "아래";
  if (group === QUOTE_GROUP) return "호가";
  if (group === FINANCIAL_GROUP) return "재무";
  return "";
}

export interface DockQuickAddProps {
  cellId: WindowId;
  indicators: readonly IndicatorConfig[];
  open: boolean;
  category: AddCategory;
  onOpenChange(open: boolean): void;
  onCategoryChange(category: AddCategory): void;
  onAdded(createdId: string, kind: IndicatorKind, keepOpen: boolean): void;
  onSelectMaGroup(): void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

export function DockQuickAdd({
  cellId,
  indicators,
  open,
  category,
  onOpenChange,
  onCategoryChange,
  onAdded,
  onSelectMaGroup,
  inputRef,
}: DockQuickAddProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [previewIds] = useState(() => [crypto.randomUUID(), crypto.randomUUID()] as const);
  const validator = useValidator();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  const hasQuery = query.trim() !== "";
  const candidates = useMemo(() => {
    const parsed = parseIndicatorInput(query);
    if (hasQuery || category === "all") return parsed;
    return parsed.filter((candidate) => matchesCategory(candidateGroup(candidate), category));
  }, [query, hasQuery, category]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, category, open]);

  const activeCandidate = candidates[Math.min(activeIndex, Math.max(0, candidates.length - 1))] ?? null;

  const validatedSpec = (candidate: IndicatorCandidate) => {
    if (candidate.errors.length > 0) return null;
    const check = checkForm(candidate.form, typeof validator === "function" ? validator : null);
    if (!check.spec) return null;
    if (typeof validator === "function" && !check.ok) return null;
    if (check.errors.length > 0) return null;
    return check.spec;
  };

  useEffect(() => {
    if (!open || !hasQuery || !activeCandidate) {
      useIndicatorPreview.getState().set(cellId, null);
      return;
    }
    const spec = validatedSpec(activeCandidate);
    if (!spec) {
      useIndicatorPreview.getState().set(cellId, null);
      return;
    }
    const baseDraft = startDraft(null, activeCandidate.kind);
    const color = nextColor(indicators);
    const style = draftStyle(baseDraft, colorsFrom(spec, color));
    useIndicatorPreview.getState().set(cellId, {
      kind: "add",
      id: previewIds[0],
      panelId: previewIds[1],
      spec,
      style,
      placement: baseDraft.placement,
    });
  }, [open, hasQuery, activeCandidate, validator, indicators, cellId, previewIds]);

  useEffect(() => () => useIndicatorPreview.getState().set(cellId, null), [cellId]);

  const countByKind = useMemo(() => {
    const map = new Map<IndicatorKind, number>();
    for (const item of indicators) map.set(item.spec.kind, (map.get(item.spec.kind) ?? 0) + 1);
    return map;
  }, [indicators]);

  const activeMaPeriods = useMemo(() => {
    const set = new Set<number>();
    for (const item of indicators) {
      if (item.spec.kind === "ma") set.add(item.spec.period);
    }
    return set;
  }, [indicators]);

  const commitCandidate = (candidate: IndicatorCandidate, keepOpen: boolean) => {
    const spec = validatedSpec(candidate);
    if (!spec) return;
    const baseDraft = startDraft(null, candidate.kind);
    const color = nextColor(indicators);
    const style = draftStyle(baseDraft, colorsFrom(spec, color));
    const createdId = addIndicatorCommand(cellId, spec, style, baseDraft.placement);
    if (!createdId) return;
    useIndicatorPreview.getState().set(cellId, null);
    setQuery("");
    if (!keepOpen) {
      inputRef.current?.blur();
    }
    onAdded(createdId, candidate.kind, keepOpen);
  };

  const quickToggleMaPeriod = (period: number) => {
    if (activeMaPeriods.has(period)) {
      onSelectMaGroup();
      return;
    }
    const spec: SpecOf<"ma"> = { kind: "ma", method: "sma", period };
    const color = nextColor(indicators);
    const createdId = useLayoutStore.getState().addIndicator(cellId, spec, { colors: colorsFrom(spec, color), width: 1 }, "price");
    if (createdId) {
      onAdded(createdId, "ma", false);
    }
  };

  const closeQuickAdd = () => {
    setQuery("");
    onOpenChange(false);
    inputRef.current?.blur();
  };

  return (
    <div ref={rootRef} className="b3-quick-add" data-open={open || undefined}>
      <div className="b3-quick-search-wrap">
        <label className="b3-search-box">
          <SearchIcon size={13} />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-label="지표 빠른 추가"
            aria-expanded={open}
            aria-controls={listId}
            value={query}
            autoComplete="off"
            spellCheck={false}
            placeholder="지표 추가 · 예: 이평 120, rsi 14"
            onFocus={() => onOpenChange(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!open) onOpenChange(true);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Escape") {
                e.stopPropagation();
                if (query !== "") setQuery("");
                else closeQuickAdd();
                return;
              }
              if (e.key === "ArrowDown" && candidates.length > 0) {
                e.preventDefault();
                setActiveIndex((prev) => (prev + 1) % candidates.length);
                return;
              }
              if (e.key === "ArrowUp" && candidates.length > 0) {
                e.preventDefault();
                setActiveIndex((prev) => (prev - 1 + candidates.length) % candidates.length);
                return;
              }
              if (e.key === "Enter" && activeCandidate) {
                e.preventDefault();
                commitCandidate(activeCandidate, e.shiftKey);
              }
            }}
          />
          {query !== "" && (
            <button
              type="button"
              className="ic-search-clear"
              aria-label="입력 지우기"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <CloseIcon size={11} />
            </button>
          )}
        </label>
      </div>

      {open && (
        <div className="b3-quick-tray" role="region" aria-label="지표 빠른 추가 목록">
          {!hasQuery && (
            <div className="b3-quick-filters">
              <div className="b3-quick-ma">
                <span className="b3-quick-ma-label">이평선</span>
                <div className="b3-quick-ma-chips" role="group" aria-label="이동평균 기간 빠른 추가">
                  {QUICK_MA_PERIODS.map((period) => {
                    const active = activeMaPeriods.has(period);
                    return (
                      <button
                        key={period}
                        type="button"
                        className="b3-ma-chip"
                        data-active={active || undefined}
                        aria-pressed={active}
                        title={active ? `이동평균 ${period} 편집` : `이동평균 ${period} 추가`}
                        onClick={() => quickToggleMaPeriod(period)}
                      >
                        {period}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="b3-quick-cats" role="group" aria-label="지표 분류">
                {ADD_CATEGORIES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="b3-cat-chip"
                    aria-pressed={category === item.id}
                    onClick={() => onCategoryChange(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <ul id={listId} role="listbox" aria-label="추가할 지표" className="b3-quick-list">
            {candidates.length === 0 ? (
              <li className="b3-quick-empty">맞는 지표가 없습니다</li>
            ) : (
              candidates.map((candidate, index) => {
                const count = countByKind.get(candidate.kind) ?? 0;
                const badge = indicatorPeriodBadge(candidate.kind);
                const zone = zoneTagLabel(candidateGroup(candidate));
                const invalid = candidate.errors.length > 0;
                const selected = index === Math.min(activeIndex, candidates.length - 1);
                return (
                  <li key={`${candidate.kind}:${index}`} role="option" aria-selected={selected}>
                    <button
                      type="button"
                      className="b3-quick-item"
                      data-active={selected || undefined}
                      disabled={invalid}
                      aria-label={`${candidate.label} 추가`}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => commitCandidate(candidate, false)}
                    >
                      <span className="b3-quick-item-name">
                        {hasQuery ? candidate.label : KINDS[candidate.kind].label}
                      </span>
                      {zone && <span className="b3-quick-zone">{zone}</span>}
                      {badge && <span className="ui-badge" data-tone="warning">{badge}</span>}
                      {count > 0 && <span className="b3-quick-count">{count}개</span>}
                      <span className="b3-quick-plus" aria-hidden="true"><PlusIcon size={12} /></span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>

          <div className="b3-quick-foot">
            <span>
              {hasQuery && activeCandidate
                ? (activeCandidate.errors[0]?.message ?? "차트 미리보기 · Enter 추가")
                : "Enter 추가 · Shift+Enter 연속"}
            </span>
            <button type="button" className="b3-quick-done" onClick={closeQuickAdd}>
              완료
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
