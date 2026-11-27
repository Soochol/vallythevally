import type { QueryClient } from "@tanstack/react-query";
import { FIX_INVALID, type RunOutcome, type ScreenEditing } from "../screener/screenEditing";
import { firstScreenerWindow, screenEditingFor } from "../screener/useScreenEditing";
import { HOTKEY_ACTIONS, shortcutOf, type ActionKeys } from "../../lib/hotkeys";
import { DESKTOP_QUERY } from "../../lib/media";
import { WINDOW_KIND_LIST, WINDOW_KINDS, type WindowKind } from "../../layout/kinds";
import { chartWindows, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import type { CommandIcon, SearchCommand } from "../commands/registry";
import { BookIcon, BrokersIcon, CameraIcon, ChartIcon, ClockIcon, CopyIcon, EtfIcon, FunnelIcon, GearIcon, HeatmapIcon, IndicatorIcon, KeyboardIcon, ListIcon, LogScaleIcon, MarketIcon, OrderIcon, PreMarketIcon, ProgramIcon, RankingIcon, TradesIcon, UndoIcon, WhaleIcon, WorkspaceIcon } from "../icons";
import { RAIL_PAGES } from "../page-rail/pages";
import { CHART_LIMIT_REASON, WINDOW_LIMIT_REASON, addWindow, workspaceRoom } from "../workspace/manage";
import { openIndicatorCommand } from "../indicator-command/open";
import { pressScale } from "../indicator-dialog/compareForm";
import { saveSnapshot } from "../snapshot/saveSnapshot";
import { openSystemSettings } from "../system-settings/open";

const onDesktop = () => typeof matchMedia === "function" && matchMedia(DESKTOP_QUERY).matches;

const RUN_TOAST: Partial<Record<RunOutcome["kind"], string>> = {
  invalid: FIX_INVALID,
  none: "조건식을 먼저 만들어 주세요",
  blocked: "자료 상태를 확인한 뒤 스크리너를 실행해 주세요",
};

export const screenerRunCommand = (editingOf: (client: QueryClient) => Pick<ScreenEditing, "run">): SearchCommand => ({
  id: "screener-run",
  label: "스크리너 실행",
  keywords: "조건식 검색 screener",
  shortcut: "Ctrl+Enter",
  group: "window",
  icon: FunnelIcon,
  run: async ({ queryClient }) => {
    const selection = useSelectionStore.getState();
    selection.setPhoneTab("screener");
    useLayoutStore.getState().showWindow("screener", undefined, { activeWindow: selection.activeCell });
    const outcome = await editingOf(queryClient).run();
    const message = outcome.kind === "failed" ? outcome.message : RUN_TOAST[outcome.kind];
    if (message) selection.showToast(message);
  },
});

const WINDOW_ICONS: Record<WindowKind, CommandIcon> = {
  chart: ChartIcon, watchlist: ListIcon, screener: FunnelIcon, indicators: IndicatorIcon, trades: TradesIcon,
  book: BookIcon, program: ProgramIcon, brokers: BrokersIcon, order: OrderIcon, ranking: RankingIcon, premarket: PreMarketIcon, whale: WhaleIcon,
};

const PAGE_ICONS = { workspace: WorkspaceIcon, market: MarketIcon, heatmap: HeatmapIcon, etf: EtfIcon, replay: ClockIcon } as const;

const addWindowCommands = (): readonly SearchCommand[] => WINDOW_KIND_LIST.map((kind): SearchCommand => ({
  id: `add-window-${kind}`,
  label: `${WINDOW_KINDS[kind].name} 창 더하기`,
  keywords: `창 추가 add ${kind}`,
  group: "window",
  icon: WINDOW_ICONS[kind],
  run: () => {
    if (addWindow(kind, workspaceRoom()) === null) useSelectionStore.getState().showToast(kind === "chart" ? CHART_LIMIT_REASON : WINDOW_LIMIT_REASON);
  },
}));

const undoLayoutCommand: SearchCommand = {
  id: "layout-undo",
  label: "배치 되돌리기",
  keywords: "창 레이아웃 undo",
  shortcut: "Ctrl+Z",
  group: "layout",
  icon: UndoIcon,
  run: () => {
    const layout = useLayoutStore.getState();
    if (layout.steps.length === 0) useSelectionStore.getState().showToast("되돌릴 배치 변경이 없습니다");
    else layout.undoArrangement();
  },
};

const pageCommands = (): readonly SearchCommand[] => RAIL_PAGES.map(({ id, path, label }): SearchCommand => ({
  id: `page-${id}`,
  label: `${label} 열기`,
  keywords: `페이지 이동 ${id}`,
  group: "system",
  icon: PAGE_ICONS[id],
  run: ({ navigate }) => navigate?.(path),
}));

const hotkeySheetCommand: SearchCommand = {
  id: "hotkey-sheet",
  label: "단축키 판 열기",
  keywords: "단축키 키 도움말 help",
  shortcut: "?",
  group: "system",
  icon: KeyboardIcon,
  run: () => useSelectionStore.getState().openHotkeySheet(),
};

export const defaultSearchCommands = (keys: ActionKeys): readonly SearchCommand[] => [
  ...HOTKEY_ACTIONS.flatMap(({ id: actionId, name: label, effect: action }): SearchCommand[] => {
    const shortcut = shortcutOf(keys, actionId);
    switch (action.kind) {
      case "indicators": return [{ id: "indicators", label, shortcut, group: "chart", icon: IndicatorIcon, run: ({ cellId }) => openIndicatorCommand(cellId) }];
      case "toggleLog": return [{ id: "log", label, shortcut, group: "chart", icon: LogScaleIcon, run: ({ cellId }) => {
        const layout = useLayoutStore.getState();
        const cell = chartWindows(layout.layout).find((c) => c.id === cellId);
        const next = cell && pressScale(cell.chartSettings, "log");
        if (next) layout.setScale(cellId, next);
      } }];
      case "showWatchlist": return [{ id: "watch-panel", label, shortcut, group: "window", icon: ListIcon, run: () => useLayoutStore.getState().showWindow("watchlist", undefined, { activeWindow: useSelectionStore.getState().activeCell }) }];
      case "systemSettings": return [{ id: "system-settings", label, keywords: "설정 키움 연결 키 system", shortcut, group: "system", icon: GearIcon, run: () => openSystemSettings() }];
      case "snapshot": return [{ id: `snapshot-${action.mode}`, label, shortcut, group: "chart", icon: action.mode === "copy" ? CopyIcon : CameraIcon, run: ({ cellId }) => saveSnapshot(cellId, action.mode) }];
      default: return [];
    }
  }),
  screenerRunCommand((client) => screenEditingFor(client, onDesktop() ? firstScreenerWindow() : null)),
  ...addWindowCommands(),
  undoLayoutCommand,
  ...pageCommands(),
  hotkeySheetCommand,
];
