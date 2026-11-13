import { createElement } from "react";
import type { DrawingSurface } from "../../chart/drawings/DrawingSurface";
import type { ScreenPoint } from "../../chart/drawings/types";
import { formatBarTime } from "../../chart/time";
import { formatPrice } from "../../lib/format";
import { isIndexCode } from "../../lib/symbol";
import type { Slot } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { activeWatchlist, useWatchlistStore } from "../../stores/watchlist";
import { CopyIcon, DRAWING_ICONS, ExpandIcon, Icon, PlusIcon } from "../icons";
import { canCopyImage, saveSnapshot } from "../snapshot/saveSnapshot";
import { defaultObjectStyle } from "../../chart/drawings/objects";
import { toolOf } from "../../chart/drawings/tools";
import type { Period } from "../../api/generated/Period";
import { useDrawingSession } from "../../stores/drawingSession";
import { useUiStore } from "../../stores/ui";
import type { MenuItem } from "../menu/Menu";
import { DRAWING_COMMANDS } from "../../chart/drawings/commands";

const action = (label: string, onSelect: () => void): MenuItem => ({ kind: "action", label, onSelect });
const glyph = (path: string) => createElement(Icon, { path, size: 14 });

function chartItems(surface: DrawingSurface, at: ScreenPoint): MenuItem[] {
  const view = surface.host.view(); const point = surface.pointAt(at);
  if (!view || !point) return [];
  const toast = useSelectionStore.getState().showToast;
  const watchlist = activeWatchlist(useWatchlistStore.getState().lists, useUiStore.getState().prefs.activeWatchlistId);
  return [
    { kind: "heading", label: [formatPrice(point.price, isIndexCode(view.symbol)), ...(point.t === null ? [] : [formatBarTime(point.t, view.period)])].join(" · ") },
    { kind: "action", label: "이 가격에 수평선", icon: glyph(DRAWING_ICONS.hline), hint: "Alt+H", onSelect: () => surface.placeHorizontalLine(at) },
    { kind: "action", label: "관심종목에 넣기", icon: createElement(PlusIcon), disabled: watchlist.symbols.includes(view.symbol), onSelect: () => { useWatchlistStore.getState().add(watchlist.id, view.symbol); toast(`${watchlist.name}에 넣었습니다`); } },
    { kind: "action", label: "축 자동 맞춤", icon: createElement(ExpandIcon, { size: 14 }), onSelect: () => surface.fitPriceScale() },
    ...(canCopyImage() ? [{ kind: "action" as const, label: "차트 이미지 복사", icon: createElement(CopyIcon, { size: 14 }), hint: "Alt+Shift+S", onSelect: () => void saveSnapshot(surface.slot as Slot, "copy") }] : []),
    { kind: "separator" },
  ];
}

export function drawingMenu(surface: DrawingSurface, empty = false, at: ScreenPoint | null = null): MenuItem[] {
  const session = useDrawingSession.getState(); const prefs = useUiStore.getState().prefs.drawing;
  const selected = surface.selected();
  if (empty) {
    const symbol = surface.host.view()?.symbol;
    const removable = symbol ? surface.sync.drawings(symbol).filter((d) => !d.locked && !prefs.lockAll) : [];
    return [
      ...(at ? chartItems(surface, at) : []),
      { kind: "heading", label: `드로잉 ${symbol ? surface.sync.drawings(symbol).length : 0}개` },
      ...(session.clip ? [action("붙여넣기", () => surface.paste())] : []),
      { kind: "check", label: "모든 드로잉 숨기기", checked: prefs.hideAll, onSelect: () => useUiStore.getState().setDrawingPrefs({ hideAll: !useUiStore.getState().prefs.drawing.hideAll }) },
      { kind: "check", label: "모든 드로잉 잠그기", checked: prefs.lockAll, onSelect: () => useUiStore.getState().setDrawingPrefs({ lockAll: !useUiStore.getState().prefs.drawing.lockAll }) },
      { kind: "action", label: "이 종목 드로잉 모두 지우기…", icon: glyph(DRAWING_ICONS.trash), danger: true, disabled: removable.length === 0, onSelect: () => surface.sync.commitWithUndo(surface.slot, removable.map((before) => ({ kind: "delete", before })), `드로잉 ${removable.length}개를 지웠습니다`) },
    ];
  }
  const first = selected[0]; if (!first) return [];
  const locked = selected.every((d) => d.locked);
  const periods = (p: Period[] | null) => surface.updateSelected((d) => ({ ...d, periods: p }));
  return [
    action("세부 설정…", () => surface.openEditor(first.id)), action("복사", () => surface.copy()), action("복제", () => surface.clone()),
    ...(toolOf(first.tool)?.text ? [action("글자 고치기…", () => surface.openEditor(first.id, "text"))] : []),
    ...DRAWING_COMMANDS.filter((c) => c.available(selected)).map((c) => action(c.label, () => c.run(surface))),
    { kind: "separator" }, action(locked ? "잠금 풀기" : "잠금", () => surface.updateSelected((d) => ({ ...d, locked: !locked }))),
    action("숨기기", () => { surface.updateSelected((d) => ({ ...d, hidden: true })); session.select([]); }),
    { kind: "heading", label: "순서" },
    ...([ ["맨 앞으로", "front"], ["앞으로", "forward"], ["뒤로", "backward"], ["맨 뒤로", "back"] ] as const).map(([label, direction]) => action(label, () => surface.reorder(first.id, direction))),
    { kind: "heading", label: "보이는 봉 주기" }, action("모든 봉 주기", () => periods(null)),
    action("분봉만", () => periods(["1m", "3m", "5m", "10m", "15m", "30m", "60m"])), action("일·주·월만", () => periods(["D", "W", "M"])),
    action("지금 봉 주기만", () => periods([surface.host.view()?.period ?? "D"])),
    { kind: "separator" }, action("기본 스타일로", () => surface.updateSelected((d) => ({ ...d, style: defaultObjectStyle(d) }))),
    { kind: "action", label: "지우기", icon: glyph(DRAWING_ICONS.trash), danger: true, hint: "Del", onSelect: () => surface.remove(true) },
  ];
}
