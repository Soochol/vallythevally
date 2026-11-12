import { useEffect, useId, useRef, useState } from "react";
import type { MaMethod } from "../../api/generated/MaMethod";
import { useSymbolInfo } from "../../api/queries";
import { colorsFrom, indicatorCssColor, type IndicatorKind, KIND_ORDER, KINDS, isFinancial, shownColor, specName } from "../../chart/indicators/kinds";
import { loadValidator } from "../../chart/indicators/validate";
import type { LineWidth } from "../../chart/settings";
import { PERIOD_LABEL } from "../../lib/symbol";
import { type Slot, useCell, useLayoutStore } from "../../stores/layout";
import { type IndicatorTab as DialogTab, useSelectionStore } from "../../stores/selection";
import { DialogFrame, Errors, Row, Segment } from "../dialog/DialogParts";
import { CloseIcon, EyeIcon, GearIcon, SearchIcon } from "../icons";
import { ColorPicker } from "../color/ColorPicker";
import { ComparePanel } from "./ComparePanel";
import { stepIndex } from "./compareForm";
import {
  checkForm,
  hasColor,
  KIND_GROUPS,
  matchKinds,
  nextColor,
  panelLabel,
  placeErrors,
  primaryLabel,
  startDraft,
  type Validate,
} from "./indicatorForm";

const METHODS = [
  ["sma", "단순"],
  ["ema", "지수"],
] as const satisfies readonly (readonly [MaMethod, string])[];
const WIDTHS = [
  [1, "1"],
  [2, "2"],
  [3, "3"],
  [4, "4"],
  [5, "5"],
] as const satisfies readonly (readonly [LineWidth, string])[];

const NUMBER_INPUT =
  "ui-field w-24 disabled:opacity-50";

const TABS = ["indicator", "current", "compare"] as const satisfies readonly DialogTab[];
const TAB_LABEL: Record<DialogTab, string> = { indicator: "지표", current: "이 칸에 띄운 지표", compare: "비교 종목" };

export function IndicatorDialog() {
  const dialog = useSelectionStore((s) => s.dialog);
  return dialog?.kind === "indicator" ? <IndicatorDialogBody slot={dialog.slot} editId={dialog.editId} initialTab={dialog.tab} /> : null;
}

function useValidator(): Validate | "loading" | "failed" {
  const [validate, setValidate] = useState<Validate | "loading" | "failed">("loading");
  useEffect(() => {
    let live = true;
    loadValidator().then(
      (v) => live && setValidate(() => v),
      (e: unknown) => {
        console.error("지표 검사기를 불러오지 못했습니다", e);
        if (live) setValidate("failed");
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return validate;
}

function IndicatorDialogBody({ slot, editId, initialTab }: { slot: Slot; editId: string | null; initialTab: DialogTab }) {
  const { closeDialog: close, openIndicators } = useSelectionStore.getState();
  const { addIndicator, updateIndicator, removeIndicator } = useLayoutStore.getState();
  const cell = useCell(slot);
  const symbolName = useSymbolInfo(cell.symbol).data?.name ?? cell.symbol;
  const { indicators, panels } = cell.chartSettings;
  const editing = indicators.find((i) => i.id === editId) ?? null;
  const editingId = editing?.id ?? null;
  const validator = useValidator();
  const ids = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);

  const [tab, setTab] = useState<DialogTab>(initialTab);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState(() => startDraft(editing, editing?.spec.kind ?? "ma"));
  const [draftOf, setDraftOf] = useState(editingId);
  if (draftOf !== editingId) {
    setDraftOf(editingId);
    setDraft(startDraft(editing, editing?.spec.kind ?? draft.form.kind));
  }

  const kind = draft.form.kind;
  const check = checkForm(draft.form, typeof validator === "function" ? validator : null);
  const placed = placeErrors(kind, check.errors);
  const rest = validator === "failed" ? [...placed.rest, "지표 설정 검사기를 불러오지 못했습니다. 새로 고침해 보세요."] : placed.rest;
  const color = draft.color === "auto" ? nextColor(indicators) : draft.color;
  const kinds = editing ? KIND_ORDER : matchKinds(query);
  const optionId = (k: IndicatorKind) => `${ids}-kind-${k}`;
  const tabId = (t: DialogTab) => `${ids}-tab-${t}`;
  const panelId = (t: DialogTab) => `${ids}-panel-${t}`;

  useEffect(() => {
    if (editingId) settingsRef.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")?.focus();
    else searchRef.current?.focus();
  }, [editingId]);

  const setText = (key: string, value: string) => setDraft((d) => ({ ...d, form: { ...d.form, text: { ...d.form.text, [key]: value } } }));
  const setEnabled = (key: string, on: boolean) => setDraft((d) => ({ ...d, form: { ...d.form, enabled: { ...d.form.enabled, [key]: on } } }));
  const chooseKind = (k: IndicatorKind) => {
    if (!editing && k !== kind) setDraft(startDraft(null, k));
  };
  const onQuery = (value: string) => {
    setQuery(value);
    const found = matchKinds(value);
    if (found[0] && !found.includes(kind)) chooseKind(found[0]);
  };
  const stepKind = (by: 1 | -1) => {
    const next = kinds[(kinds.indexOf(kind) + by + kinds.length) % kinds.length];
    if (next) chooseKind(next);
  };

  const submit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!check.ok) return;
    const style = { colors: colorsFrom(check.spec, color), width: draft.width };
    if (editing) {
      updateIndicator(slot, editing.id, { spec: check.spec, style });
      openIndicators(slot, null);
    } else {
      addIndicator(slot, check.spec, style);
      setDraft((d) => ({ ...d, color: "auto" }));
    }
  };
  const remove = (id: string) => {
    removeIndicator(slot, id);
    if (id === editingId) openIndicators(slot, null);
    else dialogRef.current?.focus();
  };

  const onTabKey = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = TABS[stepIndex(TABS.indexOf(tab), e.key === "ArrowRight" ? 1 : -1, TABS.length)];
    if (!next) return;
    setTab(next);
    document.getElementById(tabId(next))?.focus();
  };

  return (
    <DialogFrame labelledBy={`${ids}-title`} width="w-[min(880px,calc(100vw-32px))]" onClose={close} panelRef={dialogRef}>
      <div className="ui-dialog-head">
        <h2 id={`${ids}-title`} className="flex-none text-l font-[650]">
          {tab === "compare" ? "비교 종목" : tab === "current" ? "이 칸에 띄운 지표" : editing ? "지표 편집" : "지표 추가"}
        </h2>

        <span className="min-w-0 truncate text-s text-text-3">
          칸 {slot + 1}: {symbolName} {PERIOD_LABEL[cell.period]}
        </span>
        <span className="flex-1" />
        <button type="button" className="icon-btn flex-none" aria-label="닫기" title="닫기 (Esc)" onClick={close}>
          <CloseIcon />
        </button>
      </div>

      <div role="tablist" aria-label="추가할 것" onKeyDown={onTabKey} className="ui-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={tabId(t)}
            aria-selected={tab === t}
            aria-controls={tab === t ? panelId(t) : undefined}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => setTab(t)}
            className="hover:text-text"
          >
            {TAB_LABEL[t]}{t === "current" && <span>{indicators.length}</span>}
          </button>
        ))}
      </div>

      {tab === "compare" ? (
        <ComparePanel slot={slot} id={panelId("compare")} labelledBy={tabId("compare")} onRemoved={() => dialogRef.current?.focus()} />
      ) : tab === "current" ? (
        <>
          <div role="tabpanel" id={panelId("current")} aria-labelledby={tabId("current")} className="min-h-0 flex-1 overflow-auto">
            <section aria-labelledby={`${ids}-current`} className="p-6">
              <h3 id={`${ids}-current`} className="text-m font-[650]">
                이 칸에 띄운 지표
              </h3>
              <ul className="mt-4 flex flex-col gap-3">
                {indicators.map((ind) => {
                  const name = specName(ind.spec);
                  return (
                    <li
                      key={ind.id}
                      aria-current={ind.id === editingId ? "true" : undefined}
                      className="indicator-current-row text-s"
                    >
                      <span className={`flex min-w-0 flex-1 items-center gap-2 ${ind.visible ? "" : "opacity-50"}`}>
                        <span
                          aria-hidden="true"
                          className="h-[3px] w-3 flex-none rounded-s"
                          style={{ background: indicatorCssColor(shownColor(ind.spec, ind.style.colors)) }}
                        />
                        <span className="min-w-0 flex-1 truncate">{name}</span>
                        <span className="flex-none text-text-3">{panelLabel(panels, ind.panel)}</span>
                      </span>
                      <button
                        type="button"
                        className="icon-btn h-8 w-8 max-md:h-10 max-md:w-10"
                        aria-label={`${name} 설정`}
                        title="설정"
                        onClick={() => { setTab("indicator"); openIndicators(slot, ind.id); }}
                      >
                        <GearIcon />
                      </button>
                      <button
                        type="button"
                        className="icon-btn h-8 w-8 max-md:h-10 max-md:w-10"
                        aria-label={`${name} ${ind.visible ? "숨기기" : "보이기"}`}
                        title={ind.visible ? "숨기기" : "보이기"}
                        onClick={() => updateIndicator(slot, ind.id, { visible: !ind.visible })}
                      >
                        <EyeIcon off={!ind.visible} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn h-8 w-8 max-md:h-10 max-md:w-10"
                        aria-label={`${name} 지우기`}
                        title="지우기"
                        onClick={() => remove(ind.id)}
                      >
                        <CloseIcon />
                      </button>
                    </li>
                  );
                })}
                {indicators.length === 0 && <li className="px-2 py-1 text-s text-text-3">아직 없습니다. 종류를 고르고 추가하세요.</li>}
              </ul>
            </section>
          </div>
          <div className="ui-dialog-foot justify-end"><button type="button" className="tb-btn border border-line" onClick={close}>닫기</button><button type="button" className="btn-primary" onClick={() => { setTab("indicator"); openIndicators(slot, null); }}>지표 추가</button></div>
        </>
      ) : (
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <div
            role="tabpanel"
            id={panelId("indicator")}
            aria-labelledby={tabId("indicator")}
            className="grid min-h-0 flex-1 grid-cols-[236px_minmax(0,1fr)] max-md:auto-rows-max max-md:grid-cols-1 max-md:overflow-auto"
          >
            <div className="indicator-catalog min-h-0 overflow-auto border-r border-line p-4 max-md:overflow-visible max-md:border-b max-md:border-r-0">
              <label className="mb-3 flex h-10 items-center gap-2 rounded-m border border-line bg-chart-bg px-3 text-text-3">
                <SearchIcon size={16} />
                <input
                  ref={searchRef}
                  value={query}
                  disabled={editing !== null}
                  onChange={(e) => onQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                    e.preventDefault();
                    stepKind(e.key === "ArrowDown" ? 1 : -1);
                  }}
                  placeholder="지표 종류 찾기"
                  aria-label="지표 종류 찾기"
                  role="combobox"
                  aria-expanded="true"
                  aria-controls={`${ids}-kinds`}
                  aria-autocomplete="list"
                  aria-activedescendant={kinds.includes(kind) ? optionId(kind) : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-text-3 disabled:opacity-60"
                />
              </label>
              <div id={`${ids}-kinds`} role="listbox" aria-label="지표 종류">
                {KIND_GROUPS.map((g, groupIndex) => {
                  const shown = kinds.filter((k) => KINDS[k].place === g.place && isFinancial(KINDS[k].defaults) === g.financial);
                  if (shown.length === 0) return null;
                  return (
                    <ul key={g.label} role="group" aria-labelledby={`${ids}-group-${groupIndex}`}>
                      <li role="presentation" id={`${ids}-group-${groupIndex}`} className="px-2 pb-1 pt-2 text-xs text-text-3">
                        {g.label}
                      </li>
                      {shown.map((k) => {
                        const count = indicators.filter((i) => i.spec.kind === k).length;
                        return (
                          <li
                            key={k}
                            id={optionId(k)}
                            role="option"
                            aria-selected={k === kind}
                            aria-disabled={editing !== null && k !== kind}
                            onClick={() => chooseKind(k)}
                            className={
                              "flex cursor-pointer items-center gap-2 rounded-m px-2 py-[7px] hover:bg-raised " +
                              "aria-selected:bg-accent-soft aria-selected:font-semibold aria-selected:text-accent " +
                              "aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent max-md:min-h-[44px]"
                            }
                          >
                            {KINDS[k].label}
                            {count > 0 && <span className="ml-auto text-xs font-normal text-text-3">{count}개 띄움</span>}
                          </li>
                        );
                      })}
                    </ul>
                  );
                })}
              </div>
              {kinds.length === 0 && <p className="px-2 py-3 text-s text-text-2">맞는 지표가 없습니다</p>}
            </div>

            <div ref={settingsRef} className="flex min-h-[390px] flex-col gap-6 overflow-auto p-6 max-md:min-h-0 max-md:overflow-visible">
              <div>
                <h3 className="text-m font-[650]">{KINDS[kind].label}</h3>
                <p className="mt-1 max-w-[56ch] text-s text-text-2">
                  {editing
                    ? `${specName(editing.spec)}의 설정을 바꿉니다. 놓인 패널은 그대로입니다.`
                    : isFinancial(KINDS[kind].defaults) ? "분기봉·연봉에서 보고기간별 공시 자료를 표시합니다. DPS는 연간 전용입니다. 다른 주기에서는 설정을 보존하고 숨깁니다." : "같은 종류를 여러 번 띄울 수 있습니다. 기간만 바꿔 다시 추가하세요."}
                </p>
              </div>
              <div role="group" aria-label="설정값" className="flex flex-col gap-3">
                {KINDS[kind].fields.map((f) => {
                  const errors = placed.byField[f.key] ?? [];
                  const inputId = `${ids}-${f.key}`;
                  const errorId = `${inputId}-error`;
                  const text = draft.form.text[f.key] ?? "";
                  if (f.type === "method") {
                    return (
                      <Row key={f.key} label={f.label}>
                        <Segment label={f.label} options={METHODS} value={text} onChange={(v) => setText(f.key, v)} />
                        <Errors id={errorId} messages={errors} />
                      </Row>
                    );
                  }
                  const on = f.type !== "optionalInt" || draft.form.enabled[f.key] === true;
                  return (
                    <Row key={f.key} label={f.label} labelFor={inputId}>
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        {f.type === "optionalInt" && (
                          <label className="flex items-center gap-1.5 text-s">
                            <input type="checkbox" checked={on} onChange={(e) => setEnabled(f.key, e.target.checked)} />
                            {f.toggle}
                          </label>
                        )}
                        <span className="flex items-center gap-1.5">
                          <input
                            id={inputId}
                            type="text"
                            inputMode={f.type === "float" ? "decimal" : "numeric"}
                            value={text}
                            disabled={!on}
                            onChange={(e) => setText(f.key, e.target.value)}
                            aria-invalid={errors.length > 0}
                            aria-describedby={errors.length > 0 ? errorId : undefined}
                            autoComplete="off"
                            className={NUMBER_INPUT}
                          />
                          {"unit" in f && f.unit && <span className="text-s text-text-3">{f.unit}</span>}
                        </span>
                      </span>
                      <Errors id={errorId} messages={errors} />
                    </Row>
                  );
                })}
                {hasColor(draft.form) && (
                  <>
                    <Row label="선 색상"><ColorPicker label="선 색상" value={indicatorCssColor(color)} width={draft.width} onChange={(color) => setDraft((d) => ({ ...d, color }))} /></Row>
                    <Row label="선 굵기">
                      <Segment label="굵기" options={WIDTHS} value={draft.width} onChange={(width) => setDraft((d) => ({ ...d, width }))} />
                    </Row>
                  </>
                )}
                {rest.map((m, i) => (
                  <p key={i} className="text-s text-danger">
                    {m}
                  </p>
                ))}
              </div>

            </div>
          </div>

          <div className="ui-dialog-foot">
            <span className="flex items-center gap-2 text-s text-text-3 max-md:hidden">
              {!editing && (
                <>
                  <kbd>↑</kbd>
                  <kbd>↓</kbd> 종류 고르기
                </>
              )}
              <kbd>Tab</kbd> 설정 <kbd>Enter</kbd> {editing ? "적용" : "추가"} <kbd>Esc</kbd> 닫기
            </span>
            <span className="flex-1" />
            <button type="button" className="h-8 flex-none rounded-m border border-line px-4 hover:bg-raised" onClick={close}>
              닫기
            </button>
            <button type="submit" className="btn-primary flex-none disabled:cursor-not-allowed disabled:opacity-50" disabled={!check.ok}>
              {primaryLabel(editing !== null, kind, check.spec)}
            </button>
          </div>
        </form>
      )}
    </DialogFrame>
  );
}
