// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { IndicatorConfig } from "../../chart/settings";
import { chartWindows, DEFAULT_LAYOUT, useLayoutStore } from "../../stores/layout";
import { resetDomAfterEach } from "../../test/domSetup";
import { IndicatorSettingsForm } from "./IndicatorSettingsForm";
import { useLiveIndicatorDraft } from "./liveDraft";

vi.mock("../../chart/indicators/validate", () => ({
  loadValidator: () => Promise.resolve(() => ({ ok: true as const })),
}));

const firstCellId = () => chartWindows(DEFAULT_LAYOUT)[0]!.id;
const indicatorOf = (id: string) =>
  chartWindows(useLayoutStore.getState().layout)[0]!.chartSettings.indicators.find((i) => i.id === id);

beforeEach(() => {
  useLayoutStore.getState().load(structuredClone(DEFAULT_LAYOUT));
});

resetDomAfterEach();

function LiveIchimokuHarness({ cellId, initial, onRevertReady }: {
  cellId: ReturnType<typeof firstCellId>;
  initial: IndicatorConfig;
  onRevertReady(revert: () => void): void;
}) {
  const { draft, setDraft, check, color, revert } = useLiveIndicatorDraft(cellId, initial);
  onRevertReady(revert);
  return <IndicatorSettingsForm draft={draft} color={color} errors={check.errors} onChange={setDraft} lineSample={false} />;
}

test("일목균형표 토글·보기 프리셋·구름대 불투명도 변경이 스토어에 즉시 반영되고 revert 시 복원된다", async () => {
  const cellId = firstCellId();
  const id = useLayoutStore.getState().addIndicator(
    cellId,
    { kind: "ichimoku", conversion: 9, base: 26, spanB: 52, displacement: 26 },
    { colors: ["ind-1"], width: 1 },
    "price",
  )!;
  const initial = indicatorOf(id)!;
  const revisionBeforeMount = useLayoutStore.getState().revision;
  let revert = () => {};

  render(<LiveIchimokuHarness cellId={cellId} initial={initial} onRevertReady={(fn) => { revert = fn; }} />);

  await waitFor(() => {
    expect(screen.getByRole("switch", { name: "구름대" }).getAttribute("aria-checked")).toBe("true");
  });
  expect(useLayoutStore.getState().revision).toBe(revisionBeforeMount);

  fireEvent.click(screen.getByRole("switch", { name: "구름대" }));
  await waitFor(() => {
    expect(indicatorOf(id)?.style.ichimoku?.showCloud).toBe(false);
  });

  fireEvent.click(screen.getByRole("switch", { name: "전환선" }));
  await waitFor(() => {
    expect(indicatorOf(id)?.style.ichimoku?.showConversion).toBe(false);
  });

  fireEvent.click(screen.getByRole("switch", { name: "후행스팬" }));
  await waitFor(() => {
    expect(indicatorOf(id)?.style.ichimoku?.showLagging).toBe(false);
  });

  fireEvent.click(screen.getByRole("button", { name: "구름대만 보기" }));
  await waitFor(() => {
    expect(indicatorOf(id)?.style.ichimoku).toEqual({
      showCloud: true,
      showConversion: false,
      showBase: false,
      showSpanA: true,
      showSpanB: true,
      showLagging: false,
      cloudOpacity: 0.18,
    });
  });

  fireEvent.change(screen.getByLabelText("구름대 불투명도"), { target: { value: "30" } });
  await waitFor(() => {
    expect(indicatorOf(id)?.style.ichimoku?.cloudOpacity).toBe(0.3);
  });

  fireEvent.click(screen.getByRole("button", { name: "단기 (7·22·44)" }));
  await waitFor(() => {
    expect(indicatorOf(id)?.spec).toEqual({
      kind: "ichimoku",
      conversion: 7,
      base: 22,
      spanB: 44,
      displacement: 22,
    });
    expect(indicatorOf(id)?.style.ichimoku).toEqual({
      showCloud: true,
      showConversion: false,
      showBase: false,
      showSpanA: true,
      showSpanB: true,
      showLagging: false,
      cloudOpacity: 0.3,
    });
  });

  revert();
  expect(indicatorOf(id)?.spec).toEqual(initial.spec);
  expect(indicatorOf(id)?.style).toEqual(initial.style);
});
