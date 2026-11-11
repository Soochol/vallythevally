import type { DrawingSurface } from "../../chart/drawings/DrawingSurface";
import { toolOf } from "../../chart/drawings/tools";
import type { Period } from "../../api/generated/Period";
import { useDrawingSession } from "../../stores/drawingSession";
import { useUiStore } from "../../stores/ui";
import type { MenuItem } from "../menu/Menu";
import { DRAWING_COMMANDS } from "../../chart/drawings/commands";

const action = (label: string, onSelect: () => void): MenuItem => ({ kind: "action", label, onSelect });
export function drawingMenu(surface: DrawingSurface, empty = false): MenuItem[] {
  const session = useDrawingSession.getState(); const prefs = useUiStore.getState().prefs.drawing;
  const selected = surface.selected();
  if (empty) return [
    { kind: "action", label: "붙여넣기", disabled: !session.clip, onSelect: () => surface.paste() },
    { kind: "check", label: "모든 드로잉 숨기기", checked: prefs.hideAll, onSelect: () => useUiStore.getState().setDrawingPrefs({ hideAll: !useUiStore.getState().prefs.drawing.hideAll }) },
    { kind: "check", label: "모든 드로잉 잠그기", checked: prefs.lockAll, onSelect: () => useUiStore.getState().setDrawingPrefs({ lockAll: !useUiStore.getState().prefs.drawing.lockAll }) },
    action("이 종목 드로잉 모두 지우기…", () => {
      const symbol = surface.host.view()?.symbol; if (!symbol) return;
      const all = surface.sync.drawings(symbol).filter((d) => !d.locked && !prefs.lockAll);
      if (all.length && window.confirm(`이 종목의 드로잉 ${all.length}개를 지울까요?`)) surface.sync.commit(surface.slot, all.map((before) => ({ kind: "delete", before })));
    }),
  ];
  const first = selected[0]; if (!first) return [];
  const locked = selected.every((d) => d.locked);
  const periods = (p: Period[] | null) => surface.updateSelected((d) => ({ ...d, periods: p }));
  return [
    action("설정…", () => surface.openEditor(first.id)), action("복사", () => surface.copy()), action("복제", () => surface.clone()),
    ...(toolOf(first.tool)?.text ? [action("글자 고치기…", () => surface.openEditor(first.id, "text"))] : []),
    ...DRAWING_COMMANDS.filter((c) => c.available(selected)).map((c) => action(c.label, () => c.run(surface))),
    { kind: "separator" }, action(locked ? "잠금 풀기" : "잠금", () => surface.updateSelected((d) => ({ ...d, locked: !locked }))),
    action("숨기기", () => { surface.updateSelected((d) => ({ ...d, hidden: true })); session.select([]); }),
    { kind: "heading", label: "순서" },
    ...([ ["맨 앞으로", "front"], ["앞으로", "forward"], ["뒤로", "backward"], ["맨 뒤로", "back"] ] as const).map(([label, direction]) => action(label, () => surface.reorder(first.id, direction))),
    { kind: "heading", label: "보이는 봉 주기" }, action("모든 봉 주기", () => periods(null)),
    action("분봉만", () => periods(["1m", "3m", "5m", "10m", "15m", "30m", "60m"])), action("일·주·월만", () => periods(["D", "W", "M"])),
    action("지금 봉 주기만", () => periods([surface.host.view()?.period ?? "D"])),
    { kind: "separator" }, action("기본 스타일로", () => surface.updateSelected((d) => ({ ...d, style: toolOf(d.tool)?.defaultStyle() ?? d.style }))),
    action("지우기", () => surface.remove(true)),
  ];
}
