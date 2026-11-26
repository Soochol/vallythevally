import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { useSymbolInfos, useSymbolSearch } from "../../api/queries";
import { colorsFrom, shownColor } from "../../chart/indicators/kinds";
import { useCell } from "../../stores/layout";
import { useActiveWatchlist } from "../../stores/watchlist";
import { addButton } from "../indicator-dialog/compareForm";
import { checkForm, draftStyle, nextColor, startDraft, type Draft } from "../indicator-dialog/indicatorForm";
import { useValidator } from "../indicator-dialog/IndicatorSettingsForm";
import { normalizeQuery } from "../search/highlight";
import { searchList } from "../search/searchList";
import { executeCommand } from "./execute";
import { commandRows, currentKey, modeAfterInput, selectedRow, type CommandRow, type IndicatorCommandMode } from "./model";
import { useIndicatorPreview } from "./preview";
import type { WindowId } from "../../layout/kinds";

export type EditorAction = { commit(onCommitted: () => void): void; focus(): void };
export type EditableRow = Exclude<CommandRow, { kind: "symbol" }>;
export type CandidateRow = Extract<CommandRow, { kind: "candidate" }>;

export function useIndicatorCommand(cellId: WindowId, initialMode: IndicatorCommandMode, initialIndicator: string | null = null) {
  const cell = useCell(cellId);
  const [mode, setMode] = useState(initialMode);
  const [input, setInput] = useState("");
  const [chosen, setChosen] = useState(initialIndicator ? currentKey(initialIndicator) : "");
  const editor = useRef<EditorAction | null>(null);
  const query = normalizeQuery(input);
  const search = useSymbolSearch(mode === "compare" ? query : "");
  const watch = useSymbolInfos(useActiveWatchlist().symbols);
  const queryClient = useQueryClient();
  const symbols = searchList(query, { watch, recent: [] }, search.data);
  const rows = commandRows(cell.chartSettings, input, mode, symbols);
  const selected = selectedRow(rows, chosen);
  const selectedSymbol = selected?.kind === "symbol" && selected.selectable ? selected.info : null;
  const compareButton = addButton(cell.chartSettings, selectedSymbol, cell.symbol);

  const addCompareSymbol = (info: SymbolInfo): boolean => {
    if (!addButton(cell.chartSettings, info, cell.symbol).ok) return false;
    if (!executeCommand(cellId, { kind: "compare", code: info.code })) return false;
    queryClient.setQueryData(["symbol", info.code], info);
    return true;
  };

  const submit = (onSubmitted: () => void) => {
    if (selected?.kind !== "symbol") return editor.current?.commit(onSubmitted);
    if (!selectedSymbol || !addCompareSymbol(selectedSymbol)) return;
    onSubmitted();
  };

  return {
    cell, mode, input, chosen, rows, selected, symbols, search, selectedSymbol, compareButton, editor, submit, addCompareSymbol,
    type(value: string) { setInput(value); setChosen(""); setMode((mode) => modeAfterInput(mode, value)); },
    show(next: IndicatorCommandMode, indicator: string | null = null) { setMode(next); setInput(""); setChosen(indicator ? currentKey(indicator) : ""); },
    select(row: CommandRow) { if (row.kind !== "symbol" || row.selectable) setChosen(row.key); },
    selectKey(key: string) { setChosen(key); },
  };
}

export function useIndicatorDraft(cellId: WindowId, row: EditableRow, actionRef: Ref<EditorAction>, focus: () => void) {
  const cell = useCell(cellId);
  const editing = row.kind === "current" ? row.config : null;
  const candidate = row.kind === "candidate" ? row.candidate : null;
  const [draft, setDraft] = useState<Draft>(() => editing ? startDraft(editing, editing.spec.kind) : { ...startDraft(null, candidate!.kind), form: candidate!.form });
  const [previewIds] = useState(() => [crypto.randomUUID(), crypto.randomUUID()] as const);
  const validator = useValidator();
  const check = checkForm(draft.form, typeof validator === "function" ? validator : null);
  const errors = [...(candidate?.errors.filter((error) => error.field === "") ?? []), ...check.errors];
  const valid = check.ok && errors.length === 0;
  const color = draft.color === "auto" ? nextColor(cell.chartSettings.indicators) : draft.color;
  const colors = editing && color === shownColor(editing.spec, editing.style.colors) ? editing.style.colors : check.spec ? colorsFrom(check.spec, color) : [];
  const style = draftStyle(draft, colors);

  useEffect(() => {
    useIndicatorPreview.getState().set(cellId, valid && check.spec ? { kind: editing ? "edit" : "add", id: editing?.id ?? previewIds[0], panelId: previewIds[1], spec: check.spec, style, placement: draft.placement } : null);
  }, [draft, validator, cell.chartSettings.indicators, cellId]);
  useEffect(() => () => useIndicatorPreview.getState().set(cellId, null), [cellId]);

  const commitNow = () => {
    if (!valid || !check.spec) return false;
    const committed = executeCommand(cellId, { kind: "indicator", id: editing?.id ?? null, spec: check.spec, style, placement: draft.placement });
    if (committed && !editing) setDraft((draft) => ({ ...draft, color: "auto" }));
    return committed;
  };
  const commitWhenValidatorLoads = useRef<(() => void) | null>(null);
  useEffect(() => { commitWhenValidatorLoads.current = null; }, [draft]);
  useEffect(() => {
    const onCommitted = commitWhenValidatorLoads.current;
    if (validator === "loading" || !onCommitted) return;
    commitWhenValidatorLoads.current = null;
    if (commitNow()) onCommitted();
  }, [validator]);
  const commit = (onCommitted: () => void) => {
    if (validator === "loading") commitWhenValidatorLoads.current ??= onCommitted;
    else if (commitNow()) onCommitted();
  };
  useImperativeHandle(actionRef, () => ({ commit, focus }));

  return { cell, editing, draft, setDraft, validator, check, errors, valid, color, commit };
}
