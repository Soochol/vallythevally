import { beforeEach, expect, test, vi } from "vitest";
import type { JumpAnchor, JumpOutcome } from "../../chart/barJump";
import { windowId } from "../../layout/kinds";
import { jumpToBar, NO_JUMP_TARGET } from "./jumpToBar";

const charts = vi.hoisted(() => ({ list: [] as { id: string; symbol: string; period: string }[] }));
const controllers = vi.hoisted(() => new Map<string, { jumpAnchor: () => unknown; jumpTo: (request: unknown) => Promise<string> }>());
const toast = vi.hoisted(() => vi.fn());

vi.mock("../grid/controllers", () => ({ controllerFor: (id: string) => controllers.get(id) }));
vi.mock("../../stores/layout", () => ({ chartWindows: () => charts.list, useLayoutStore: { getState: () => ({ layout: {} }) } }));
vi.mock("../../stores/selection", () => ({ useSelectionStore: { getState: () => ({ showToast: toast }) } }));

const anchor: JumpAnchor = { period: "D", interval: { start: 100, end: 200, period: "D" }, date: "2026-11-09", label: "바로가기 · 2026-11-09" };
const chart = (id: string, symbol: string, period: string) => ({ id, symbol, period });

function controller(outcome: JumpOutcome, source: JumpAnchor | null = null) {
  const jumpTo = vi.fn(async () => outcome);
  return { jumpAnchor: () => source, jumpTo };
}

beforeEach(() => {
  controllers.clear();
  toast.mockClear();
  charts.list = [];
});

test("기준 차트에 봉이 없으면 아무것도 하지 않는다", async () => {
  controllers.set("d", controller("moved"));
  charts.list = [chart("d", "005930", "D")];
  await jumpToBar(windowId("d"));
  expect(toast).not.toHaveBeenCalled();
});

test("대상이 없으면 알림만 보이고 어떤 차트도 부르지 않는다", async () => {
  const other = controller("moved");
  controllers.set("d", controller("moved", anchor));
  controllers.set("o", other);
  charts.list = [chart("d", "005930", "D"), chart("o", "000660", "1m")];
  await jumpToBar(windowId("d"));
  expect(toast).toHaveBeenCalledWith(NO_JUMP_TARGET);
  expect(other.jumpTo).not.toHaveBeenCalled();
});

test("같은 종목의 더 짧은 주기 차트마다 기준 날짜와 구간을 주고 결과를 알림 하나로 묶는다", async () => {
  const m1 = controller("moved");
  const m5 = controller("moved");
  controllers.set("d", controller("moved", anchor));
  controllers.set("m1", m1);
  controllers.set("m5", m5);
  charts.list = [chart("d", "005930", "D"), chart("m1", "005930", "1m"), chart("m5", "005930", "5m")];
  await jumpToBar(windowId("d"));
  for (const target of [m1, m5]) expect(target.jumpTo).toHaveBeenCalledWith({ date: "2026-11-09", interval: anchor.interval });
  expect(toast).toHaveBeenCalledTimes(1);
  expect(toast).toHaveBeenCalledWith("1분·5분 차트를 2026-11-09 기준으로 옮겼습니다");
});

test("모두 취소되면 알림이 없고, 컨트롤러가 없는 대상은 취소로 센다", async () => {
  controllers.set("d", controller("moved", anchor));
  controllers.set("m1", controller("cancelled"));
  charts.list = [chart("d", "005930", "D"), chart("m1", "005930", "1m"), chart("m5", "005930", "5m")];
  await jumpToBar(windowId("d"));
  expect(toast).not.toHaveBeenCalled();
});
