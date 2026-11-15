import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useSelectionStore } from "../../stores/selection";
import { copySymbolCode } from "./symbolRowMenu";

beforeEach(() => useSelectionStore.setState({ toast: null }));
afterEach(() => vi.unstubAllGlobals());

test("종목코드 복사는 코드를 클립보드에 넣고 알린다", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await copySymbolCode("005930");
  expect(writeText).toHaveBeenCalledWith("005930");
  expect(useSelectionStore.getState().toast?.text).toBe("종목코드를 복사했습니다: 005930");
});

test("클립보드가 거절하면 실패를 알린다", async () => {
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  await copySymbolCode("005930");
  expect(useSelectionStore.getState().toast?.text).toBe("종목코드를 복사하지 못했습니다");
});
