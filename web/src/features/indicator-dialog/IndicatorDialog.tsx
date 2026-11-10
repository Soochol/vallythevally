import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { MaMethod } from "../../api/generated/MaMethod";
import { useSymbolInfo } from "../../api/queries";
import { colorsFrom, INDICATOR_COLORS, type IndicatorKind, KIND_ORDER, KINDS, shownColor, specName } from "../../chart/indicators/kinds";
import { loadValidator } from "../../chart/indicators/validate";
import type { LineWidth } from "../../chart/settings";
import { PERIOD_LABEL } from "../../lib/symbol";
import { type Slot, useCell, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { CloseIcon, EyeIcon, GearIcon, SearchIcon } from "../icons";
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
] as const satisfies readonly (readonly [LineWidth, string])[];

const NUMBER_INPUT =
  "h-[30px] w-24 rounded-m border border-line bg-chart-bg px-2 text-text outline-none focus:border-accent aria-invalid:border-up aria-invalid:focus:border-up disabled:opacity-50";

/** 지표 추가·편집(frontend.md §3.3). 추가해도 닫지 않는다. 이동평균 5·20·60·120을 연달아 넣기 위해서다. */
export function IndicatorDialog() {
  const dialog = useSelectionStore((s) => s.dialog);
  return dialog?.kind === "indicator" ? <IndicatorDialogBody slot={dialog.slot} editId={dialog.editId} /> : null;
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

function IndicatorDialogBody({ slot, editId }: { slot: Slot; editId: string | null }) {
  const { closeDialog: close, openIndicators } = useSelectionStore.getState();
  const { addIndicator, updateIndicator, removeIndicator } = useLayoutStore.getState();
  const cell = useCell(slot);
  const symbolName = useSymbolInfo(cell.symbol).data?.name ?? cell.symbol;
  const { indicators, panels } = cell.chartSettings;
  const editing = indicators.find((i) => i.id === editId) ?? null;
  const editingId = editing?.id ?? null;
  const validator = useValidator();
  const ids = useId();
  const opener = useRef<Element | null>(document.activeElement);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);

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
  const color = draft.color ?? nextColor(indicators);
  const kinds = editing ? KIND_ORDER : matchKinds(query);
  const optionId = (k: IndicatorKind) => `${ids}-kind-${k}`;

  useEffect(() => {
    const back = opener.current;
    return () => {
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);
  useEffect(() => {
    if (editingId) settingsRef.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")?.focus();
    else searchRef.current?.focus();
  }, [editingId]);

  const setText = (key: string, value: string) => setDraft((d) => ({ ...d, form: { ...d.form, text: { ...d.form.text, [key]: value } } }));
  const setOn = (key: string, on: boolean) => setDraft((d) => ({ ...d, form: { ...d.form, on: { ...d.form.on, [key]: on } } }));
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

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!check.ok) return;
    const style = { colors: colorsFrom(check.spec, color), width: draft.width };
    if (editing) {
      updateIndicator(slot, editing.id, { spec: check.spec, style });
      openIndicators(slot, null);
    } else {
      addIndicator(slot, check.spec, style);
      setDraft((d) => ({ ...d, color: null }));
    }
  };
  const remove = (id: string) => {
    removeIndicator(slot, id);
    if (id === editingId) openIndicators(slot, null);
    else dialogRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      if (e.key === "Enter") e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      const nodes = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")].filter((n) => n.tabIndex >= 0);
      const first = nodes[0];
      const last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--scrim)] pt-[72px] max-md:items-end max-md:pt-0"
      onPointerDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={
          "flex max-h-[calc(100vh-110px)] w-[min(760px,calc(100vw-32px))] flex-col overflow-hidden rounded-l border border-line bg-surface shadow-dialog outline-none " +
          "max-md:max-h-[85dvh] max-md:w-screen max-md:rounded-b-none"
        }
      >
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-none items-center gap-3 border-b border-line px-4 py-3">
            <h2 id={`${ids}-title`} className="flex-none text-l font-[650]">
              {editing ? "지표 편집" : "지표 추가"}
            </h2>
            <div role="tablist" aria-label="추가할 것" className="ml-1 inline-flex flex-none gap-1">
              <button type="button" role="tab" id={`${ids}-tab`} aria-selected="true" className="h-7 rounded-m bg-raised px-3 font-semibold">
                지표
              </button>
              <button
                type="button"
                role="tab"
                aria-selected="false"
                aria-disabled="true"
                tabIndex={-1}
                title="비교 종목은 다음 단계에서 켭니다"
                className="h-7 cursor-not-allowed rounded-m px-3 text-text-3"
              >
                비교 종목
              </button>
            </div>
            <span className="min-w-0 truncate text-s text-text-3">
              칸 {slot + 1}: {symbolName} {PERIOD_LABEL[cell.period]}
            </span>
            <span className="flex-1" />
            <button type="button" className="icon-btn flex-none" aria-label="닫기" title="닫기 (Esc)" onClick={close}>
              <CloseIcon />
            </button>
          </div>

          <div
            role="tabpanel"
            aria-labelledby={`${ids}-tab`}
            className="grid min-h-0 flex-1 grid-cols-[236px_minmax(0,1fr)] max-md:auto-rows-max max-md:grid-cols-1 max-md:overflow-auto"
          >
            <div className="min-h-0 overflow-auto border-r border-line p-2 max-md:overflow-visible max-md:border-b max-md:border-r-0">
              <label className="mb-1 flex h-8 items-center gap-1.5 rounded-m border border-line bg-chart-bg px-2 text-text-3">
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
                {KIND_GROUPS.map((g) => {
                  const shown = kinds.filter((k) => KINDS[k].place === g.place);
                  if (shown.length === 0) return null;
                  return (
                    <ul key={g.place} role="group" aria-labelledby={`${ids}-${g.place}`}>
                      <li role="presentation" id={`${ids}-${g.place}`} className="px-2 pb-1 pt-2 text-xs text-text-3">
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

            <div ref={settingsRef} className="flex min-h-0 flex-col gap-4 overflow-auto p-4 max-md:overflow-visible">
              <div>
                <h3 className="text-m font-[650]">{KINDS[kind].label}</h3>
                <p className="mt-1 max-w-[56ch] text-s text-text-2">
                  {editing
                    ? `${specName(editing.spec)}의 설정을 바꿉니다. 놓인 패널은 그대로입니다.`
                    : "같은 종류를 여러 번 띄울 수 있습니다. 기간만 바꿔 다시 추가하세요."}
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
                  const on = f.type !== "optionalInt" || draft.form.on[f.key] === true;
                  return (
                    <Row key={f.key} label={f.label} labelFor={inputId}>
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        {f.type === "optionalInt" && (
                          <label className="flex items-center gap-1.5 text-s">
                            <input type="checkbox" checked={on} onChange={(e) => setOn(f.key, e.target.checked)} />
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
                    <Row label="색">
                      <div role="group" aria-label="색" className="flex h-[30px] items-center gap-1.5">
                        {INDICATOR_COLORS.map((c, i) => (
                          <button
                            key={c}
                            type="button"
                            aria-pressed={c === color}
                            aria-label={`색 ${i + 1}`}
                            onClick={() => setDraft((d) => ({ ...d, color: c }))}
                            style={{ background: `var(--${c})` }}
                            className="h-5 w-5 rounded-full border-2 border-transparent aria-pressed:border-text"
                          />
                        ))}
                      </div>
                    </Row>
                    <Row label="굵기">
                      <Segment label="굵기" options={WIDTHS} value={draft.width} onChange={(width) => setDraft((d) => ({ ...d, width }))} />
                    </Row>
                  </>
                )}
                {rest.map((m, i) => (
                  <p key={i} className="text-s text-up">
                    {m}
                  </p>
                ))}
              </div>

              <section aria-labelledby={`${ids}-current`} className="border-t border-line pt-4">
                <h3 id={`${ids}-current`} className="text-m font-[650]">
                  이 칸에 띄운 지표
                </h3>
                <ul className="mt-2 flex flex-col gap-0.5">
                  {indicators.map((ind) => {
                    const name = specName(ind.spec);
                    return (
                      <li
                        key={ind.id}
                        aria-current={ind.id === editingId ? "true" : undefined}
                        className="flex items-center gap-2 rounded-m px-2 py-1 text-s hover:bg-raised aria-[current=true]:bg-accent-soft"
                      >
                        <span className={`flex min-w-0 flex-1 items-center gap-2 ${ind.visible ? "" : "opacity-50"}`}>
                          <span
                            aria-hidden="true"
                            className="h-[3px] w-3 flex-none rounded-s"
                            style={{ background: `var(--${shownColor(ind.spec, ind.style.colors)})` }}
                          />
                          <span className="min-w-0 flex-1 truncate">{name}</span>
                          <span className="flex-none text-text-3">{panelLabel(panels, ind.panel)}</span>
                        </span>
                        <button
                          type="button"
                          className="icon-btn h-[22px] w-[22px] max-md:h-10 max-md:w-10"
                          aria-label={`${name} 설정`}
                          title="설정"
                          onClick={() => openIndicators(slot, ind.id)}
                        >
                          <GearIcon />
                        </button>
                        <button
                          type="button"
                          className="icon-btn h-[22px] w-[22px] max-md:h-10 max-md:w-10"
                          aria-label={`${name} ${ind.visible ? "숨기기" : "보이기"}`}
                          title={ind.visible ? "숨기기" : "보이기"}
                          onClick={() => updateIndicator(slot, ind.id, { visible: !ind.visible })}
                        >
                          <EyeIcon off={!ind.visible} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn h-[22px] w-[22px] max-md:h-10 max-md:w-10"
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
          </div>

          <div className="flex flex-none items-center gap-2 border-t border-line px-4 py-2">
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
      </div>
    </div>
  );
}

function Row({ label, labelFor, children }: { label: string; labelFor?: string; children: ReactNode }) {
  const caption = "text-s leading-[30px] text-text-2";
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] items-start gap-3">
      {labelFor ? (
        <label htmlFor={labelFor} className={caption}>
          {label}
        </label>
      ) : (
        <span className={caption}>{label}</span>
      )}
      <div className="flex min-w-0 flex-col gap-1">{children}</div>
    </div>
  );
}

function Segment<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly (readonly [T, string])[];
  value: T | string;
  onChange(v: T): void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex w-max overflow-hidden rounded-m border border-line">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={v === value}
          onClick={() => onChange(v)}
          className="h-7 border-r border-line px-3 text-text-2 last:border-r-0 hover:text-text aria-pressed:bg-raised aria-pressed:font-semibold aria-pressed:text-text"
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Errors({ id, messages }: { id: string; messages: readonly string[] }) {
  if (messages.length === 0) return null;
  return (
    <p id={id} className="text-s text-up">
      {messages.join(" ")}
    </p>
  );
}
