import { QueryClient } from "@tanstack/react-query";
import { beforeEach, expect, test } from "vitest";
import { windowId } from "../../layout/kinds";
import { useSelectionStore } from "../../stores/selection";
import type { RunOutcome } from "../screener/screenEditing";
import { DEFAULT_SEARCH_COMMANDS, screenerRunCommand } from "./commands";

const client = new QueryClient();

async function toastAfter(outcome: RunOutcome) {
  useSelectionStore.setState({ toast: null, phoneTab: "chart" });
  await screenerRunCommand(() => ({ run: async () => outcome })).run({ queryClient: client, cellId: windowId("cell-0") });
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
  expect(DEFAULT_SEARCH_COMMANDS.some((command) => command.id === "screener-run")).toBe(true);
});
