import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { useSymbolInfos, useSymbolSearch } from "../../api/queries";
import { colorsFrom, shownColor } from "../../chart/indicators/kinds";
import { useCell, type Slot } from "../../stores/layout";
import { useActiveWatchlist } from "../../stores/watchlist";
import { addButton } from "../indicator-dialog/compareForm";
import { checkForm, nextColor, startDraft, type Draft } from "../indicator-dialog/indicatorForm";
import { useValidator } from "../indicator-dialog/IndicatorSettingsForm";
import { normalizeQuery } from "../search/highlight";
import { searchList } from "../search/searchList";
import { executeCommand } from "./execute";
import { commandRows, modeAfterInput, selectedRow, type CommandRow, type IndicatorCommandMode } from "./model";
import { useIndicatorPreview } from "./preview";

export type EditorAction = { commit(): boolean; focus(): void };
export type EditableRow = Exclude<CommandRow, { kind: "symbol" }>;

export function useIndicatorCommand(slot: Slot, initialMode: IndicatorCommandMode) {
  const cell = useCell(slot);
  const [mode, setMode] = useState(initialMode);
  const [input, setInput] = useState("");
  const [chosen, setChosen] = useState("");
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

  const submit = (): boolean => {
    if (selected?.kind !== "symbol") return selected ? editor.current?.commit() ?? false : false;
    if (!selectedSymbol || !compareButton.ok) return false;
    const added = executeCommand(slot, { kind: "compare", code: selectedSymbol.code });
    if (added) queryClient.setQueryData(["symbol", selectedSymbol.code], selectedSymbol);
    return added;
  };

  return {
    cell, mode, input, rows, selected, symbols, search, selectedSymbol, compareButton, editor, submit,
    type(value: string) { setInput(value); setChosen(""); setMode((mode) => modeAfterInput(mode, value)); },
    show(next: IndicatorCommandMode) { setMode(next); setInput(""); setChosen(""); },
    select(row: CommandRow) { if (row.kind !== "symbol" || row.selectable) setChosen(row.key); },
  };
}

export function useIndicatorDraft(slot: Slot, row: EditableRow, actionRef: Ref<EditorAction>, focus: () => void) {
  const cell = useCell(slot);
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
  const style = { colors, width: draft.width };

  useEffect(() => {
    useIndicatorPreview.getState().set(slot, valid && check.spec ? editing ? { kind: "edit", id: editing.id, spec: check.spec, style } : { kind: "add", id: previewIds[0], panelId: previewIds[1], spec: check.spec, style } : null);
  }, [draft, validator, cell.chartSettings.indicators, slot]);
  useEffect(() => () => useIndicatorPreview.getState().set(slot, null), [slot]);

  const commit = () => {
    if (!valid || !check.spec) return false;
    const committed = executeCommand(slot, { kind: "indicator", id: editing?.id ?? null, spec: check.spec, style });
    if (committed && !editing) setDraft((draft) => ({ ...draft, color: "auto" }));
    return committed;
  };
  useImperativeHandle(actionRef, () => ({ commit, focus }));

  return { cell, editing, draft, setDraft, validator, check, errors, valid, color, commit };
}
