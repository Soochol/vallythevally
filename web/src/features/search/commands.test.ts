import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test } from "vitest";
import { windowId } from "../../layout/kinds";
import { useSelectionStore } from "../../stores/selection";
import type { RunOutcome } from "../screener/screenEditing";
import { DEFAULT_KEYS } from "../../lib/hotkeys";
import { defaultSearchCommands, screenerRunCommand } from "./commands";

const client = new QueryClient();

async function toastAfter(outcome: RunOutcome) {
  useSelectionStore.setState({ toast: null, phoneTab: "chart" });
  await screenerRunCommand(() => ({ run: async () => outcome })).run({ queryClient: client, cellId: windowId("cell-0"), navigate: () => {} });
  return useSelectionStore.getState().toast?.text ?? null;
}

beforeEach(() => useSelectionStore.setState({ toast: null }));

test("스크리너 실행 명령은 실행 결과마다 알맞은 안내를 띄우고, 실행했거나 실행 중이면 띄우지 않는다", async () => {
  expect(await toastAfter({ kind: "invalid" })).toBe("조건식의 잘못된 값을 고쳐 주세요");
  expect(await toastAfter({ kind: "none" })).toBe("조건식을 먼저 만들어 주세요");
  expect(await toastAfter({ kind: "blocked" })).toBe("자료 상태를 확인한 뒤 스크리너를 실행해 주세요");
  expect(await toastAfter({ kind: "failed", message: "목록 읽기 실패" })).toBe("목록 읽기 실패");
  expect(await toastAfter({ kind: "busy" })).toBeNull();
  expect(await toastAfter({ kind: "ran" })).toBeNull();
});

test("스크리너 실행 명령은 휴대폰 스크리너 탭을 연다", async () => {
  await toastAfter({ kind: "ran" });
  expect(useSelectionStore.getState().phoneTab).toBe("screener");
  expect(defaultSearchCommands(DEFAULT_KEYS).some((command) => command.id === "screener-run")).toBe(true);
});

test("모든 기본 명령에 묶음과 아이콘이 있고 같은 묶음 안에서는 아이콘 모양이 서로 다르다", () => {
  const commands = defaultSearchCommands(DEFAULT_KEYS);
  expect(commands.every((command) => command.group !== undefined && command.icon !== undefined)).toBe(true);
  for (const group of ["chart", "layout", "system"]) {
    const shapes = commands.filter((command) => command.group === group).map((command) => renderToStaticMarkup(createElement(command.icon!)));
    expect(new Set(shapes).size).toBe(shapes.length);
  }
});

test("이미 있는 동작이 명령으로 올라 있다", () => {
  const ids = defaultSearchCommands(DEFAULT_KEYS).map((command) => command.id);
  expect(ids).toEqual(expect.arrayContaining(["add-window-order", "add-window-chart", "layout-undo", "page-market", "page-heatmap", "page-etf", "hotkey-sheet"]));
});

test("배치 되돌리기 명령은 되돌릴 것이 없으면 알리고 단축키 판 명령은 판을 연다", () => {
  const find = (id: string) => defaultSearchCommands(DEFAULT_KEYS).find((command) => command.id === id)!;
  useSelectionStore.setState({ toast: null, dialog: null });
  find("hotkey-sheet").run({ queryClient: client, cellId: windowId("cell-0"), navigate: () => {} });
  expect(useSelectionStore.getState().dialog).toEqual({ kind: "hotkey-sheet" });
  const paths: string[] = [];
  find("page-market").run({ queryClient: client, cellId: windowId("cell-0"), navigate: (path) => paths.push(path) });
  expect(paths).toEqual(["/market"]);
});
