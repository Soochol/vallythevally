import { beforeEach, describe, expect, it } from "vitest";
import { windowId } from "../layout/kinds";
import { cellDrawing, useDrawingSession } from "./drawingSession";
import { useSelectionStore } from "./selection";

const first = windowId("cell-0");
const second = windowId("cell-1");
const picked = (id: typeof first) => cellDrawing(useDrawingSession.getState(), id);

beforeEach(() => {
  useDrawingSession.setState({ tool: null, mode: null, pinnedTool: null, clip: null, cells: {} });
  useSelectionStore.setState({ activeCell: first });
});

describe("칸마다 나뉜 드로잉 상태", () => {
  it("한 칸에서 고르거나 편집하거나 막대를 옮겨도 다른 칸은 그대로다", () => {
    const session = useDrawingSession.getState();
    session.select(first, ["a"]);
    session.patchCell(second, { toolbarAt: { x: 10, y: 20 }, popup: { x: 1, y: 2, id: "b" } });
    session.select(second, ["b"]);
    session.select(first, ["c"], true);
    expect(picked(first).selected).toEqual(["a", "c"]);
    expect(picked(first).toolbarAt).toBeNull();
    expect(picked(first).popup).toBeNull();
    expect(picked(second).selected).toEqual(["b"]);
    expect(picked(second).toolbarAt).toEqual({ x: 10, y: 20 });
  });

  it("도구를 고르면 그 칸의 선택과 메뉴만 푼다", () => {
    const session = useDrawingSession.getState();
    session.select(first, ["a"]); session.select(second, ["b"]);
    session.patchCell(first, { popup: { x: 1, y: 2, id: "a" } });
    session.setTool(first, "trendline");
    expect(useDrawingSession.getState().tool).toBe("trendline");
    expect(picked(first)).toMatchObject({ selected: [], popup: null });
    expect(picked(second).selected).toEqual(["b"]);
  });

  it("활성 칸이 바뀌면 고른 도구·모드·연속 도구를 풀되 이전 칸의 선택은 남긴다", () => {
    const session = useDrawingSession.getState();
    session.select(first, ["a"]);
    session.setTool(first, "trendline", true);
    useDrawingSession.setState({ mode: "eraser" });
    session.select(first, ["a"]);
    useSelectionStore.getState().setActiveCell(second);
    expect(useDrawingSession.getState()).toMatchObject({ tool: null, mode: null, pinnedTool: null });
    expect(picked(first).selected).toEqual(["a"]);
  });

  it("복사한 드로잉은 칸을 바꿔도 남고 칸 상태를 비워도 남는다", () => {
    const clip = { symbol: "005930", bodies: [], pasted: 0 } as never;
    useDrawingSession.setState({ clip });
    useDrawingSession.getState().select(first, ["a"]);
    useSelectionStore.getState().setActiveCell(second);
    useDrawingSession.getState().clearCells();
    expect(useDrawingSession.getState().clip).toBe(clip);
    expect(picked(first).selected).toEqual([]);
  });
});
