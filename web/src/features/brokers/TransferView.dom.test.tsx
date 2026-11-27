// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import type { FeedBroker } from "../../api/generated/FeedBroker";
import type { FeedBrokers } from "../../api/generated/FeedBrokers";
import { DEFAULT_UI_PREFS } from "../../persist/uiState";
import { useUiStore } from "../../stores/ui";
import { installDomShims, resetDomAfterEach } from "../../test/domSetup";
import { TransferView } from "./TransferView";

const at = (clock: string) => Date.parse(`2026-11-09T${clock}+09:00`) / 1000;
const entry = (code: string, name: string, qty: number): FeedBroker => ({ code, name, qty, qtyChange: 0 });

const SNAPSHOTS: readonly FeedBrokers[] = [
  { t: at("09:20:00"), sells: [entry("141", "삼성", 100), entry("042", "모간서울", 60)], buys: [entry("151", "키움", 100), entry("033", "JP모간", 60)] },
  { t: at("09:22:00"), sells: [entry("141", "삼성", 150), entry("042", "모간서울", 90)], buys: [entry("151", "키움", 150), entry("033", "JP모간", 90)] },
  { t: at("09:24:00"), sells: [entry("141", "삼성", 200), entry("042", "모간서울", 120)], buys: [entry("151", "키움", 200), entry("033", "JP모간", 120)] },
  { t: at("09:26:00"), sells: [entry("141", "삼성", 250), entry("042", "모간서울", 150)], buys: [entry("151", "키움", 250), entry("033", "JP모간", 150)] },
  { t: at("09:28:00"), sells: [entry("141", "삼성", 450), entry("042", "모간서울", 750)], buys: [entry("151", "키움", 850), entry("033", "JP모간", 150)] },
  { t: at("09:30:00"), sells: [entry("141", "삼성", 500), entry("042", "모간서울", 780)], buys: [entry("151", "키움", 900), entry("033", "JP모간", 180)] },
];

const BARS: readonly Bar[] = Array.from({ length: 11 }, (_, index) => {
  const minute = 20 + index;
  const surge = minute === 27 || minute === 28;
  return {
    t: at(`09:${String(minute).padStart(2, "0")}:00`),
    o: 71_000,
    h: 71_500,
    l: 70_900,
    c: surge ? 71_500 : 71_000,
    v: surge ? 500 : 60,
  };
});

const GAP_BEFORE = SNAPSHOTS.map(() => false);
const AXIS = { from: at("09:20:00"), to: at("09:30:00") };

beforeEach(() => {
  installDomShims();
  useUiStore.getState().load(DEFAULT_UI_PREFS, {});
});

resetDomAfterEach();

test("TransferView는 언마운트 뒤 다시 마운트해도 마지막 하위 옵션을 유지한다", () => {
  const first = render(<TransferView snapshots={SNAPSHOTS} gapBefore={GAP_BEFORE} gaps={[]} bars={BARS} axis={AXIS} />);

  fireEvent.click(screen.getByRole("button", { name: "주체 그룹" }));
  fireEvent.click(screen.getByRole("button", { name: "총량" }));
  fireEvent.click(screen.getByTestId("broker-transfer-toggle-other"));
  fireEvent.click(screen.getByTestId("broker-transfer-preset-peak"));
  fireEvent.click(screen.getByTestId("broker-transfer-details-toggle"));

  expect(screen.getByRole("button", { name: "주체 그룹" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "총량" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByTestId("broker-transfer-toggle-other").getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByTestId("broker-transfer-preset-peak").getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByTestId("broker-transfer-details-toggle").getAttribute("aria-expanded")).toBe("true");

  first.unmount();

  render(<TransferView snapshots={SNAPSHOTS} gapBefore={GAP_BEFORE} gaps={[]} bars={BARS} axis={AXIS} />);

  expect(screen.getByRole("button", { name: "주체 그룹" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "총량" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByTestId("broker-transfer-toggle-other").getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByTestId("broker-transfer-preset-peak").getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByTestId("broker-transfer-details-toggle").getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByTestId("broker-transfer-pairs")).toBeTruthy();
});
