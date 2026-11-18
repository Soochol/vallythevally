import { type JumpResult, jumpNotice, jumpTargets } from "../../chart/barJump";
import type { WindowId } from "../../layout/kinds";
import { chartWindows, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { controllerFor } from "../grid/controllers";

export const NO_JUMP_TARGET = "같은 종목의 더 짧은 주기 차트가 없습니다";

export async function jumpToBar(sourceId: WindowId): Promise<void> {
  const toast = useSelectionStore.getState().showToast;
  const anchor = controllerFor(sourceId)?.jumpAnchor();
  if (!anchor) return;
  const charts = chartWindows(useLayoutStore.getState().layout);
  const targets = jumpTargets(charts, sourceId, anchor.period);
  if (targets.length === 0) return toast(NO_JUMP_TARGET);
  const results = await Promise.all(
    targets.map(async (id): Promise<JumpResult> => ({
      period: charts.find((chart) => chart.id === id)!.period,
      outcome: (await controllerFor(id)?.jumpTo({ date: anchor.date, interval: anchor.interval })) ?? "cancelled",
    })),
  );
  const text = jumpNotice(results, anchor.date);
  if (text) toast(text);
}
