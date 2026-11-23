import { beforeEach, expect, test } from "vitest";
import { DEFAULT_UI_PREFS } from "../persist/uiState";
import { orderEntryKey, type OrderEntry } from "../features/order/orderEntries";
import { useUiStore } from "./ui";

beforeEach(() => useUiStore.getState().load(DEFAULT_UI_PREFS, {}));

test("관심종목 그룹을 접고 펴면서 없어진 그룹 id는 지운다", () => {
  const s = useUiStore.getState();
  s.setWatchGroupCollapsed("A", true, ["A", "B"]);
  s.setWatchGroupCollapsed("B", true, ["A", "B"]);
  expect(useUiStore.getState().prefs.collapsedWatchGroups).toEqual(["A", "B"]);
  const revision = useUiStore.getState().revision;
  s.setWatchGroupCollapsed("A", true, ["A", "B"]);
  expect(useUiStore.getState().revision).toBe(revision);
  s.setWatchGroupCollapsed("C", true, ["C", "B"]);
  expect(useUiStore.getState().prefs.collapsedWatchGroups).toEqual(["B", "C"]);
  s.setWatchGroupCollapsed("B", false, ["C", "B"]);
  expect(useUiStore.getState().prefs.collapsedWatchGroups).toEqual(["C"]);
  s.setWatchGroupCollapsed("Z", true, ["C"]);
  expect(useUiStore.getState().prefs.collapsedWatchGroups).toEqual(["C"]);
});

test("창 배치 방식을 바꾸면 한 번 저장하고 같은 값은 저장하지 않는다", () => {
  const revision = useUiStore.getState().revision;
  useUiStore.getState().setLayoutMode("canvas");
  expect(useUiStore.getState().prefs.layoutMode).toBe("canvas");
  expect(useUiStore.getState().revision).toBe(revision + 1);
  useUiStore.getState().setLayoutMode("canvas");
  expect(useUiStore.getState().revision).toBe(revision + 1);
});

test("호가주문창의 기억을 꺼내면 그 레이아웃의 그 창 기억만 지우고 없으면 저장하지 않는다", () => {
  const entry: OrderEntry = { presetKind: "sharePresets", quantity: 5, usedAt: 1 };
  const s = useUiStore.getState();
  for (const key of [orderEntryKey("L", "order-2", "A"), orderEntryKey("L", "order-2", "B"), orderEntryKey("L", "order-20", "A"), orderEntryKey("L", "order", "A"), orderEntryKey("M", "order-2", "A")]) s.rememberOrderEntry(key, entry);
  const revision = useUiStore.getState().revision;
  s.takeOrderWindow("L", "order-2");
  expect(Object.keys(useUiStore.getState().prefs.orderEntries).sort()).toEqual([orderEntryKey("L", "order", "A"), orderEntryKey("L", "order-20", "A"), orderEntryKey("M", "order-2", "A")].sort());
  expect(useUiStore.getState().revision).toBe(revision + 1);
  const prefs = useUiStore.getState().prefs;
  s.takeOrderWindow("L", "order-2");
  expect(useUiStore.getState().prefs).toBe(prefs);
  expect(useUiStore.getState().revision).toBe(revision + 1);
});

test("꺼낸 호가주문창의 기억은 되돌려 넣으면 그 창 기억을 그대로 되찾고 그 사이 남긴 기억은 대신한다", () => {
  const closed: OrderEntry = { presetKind: "amountPresets", quantity: 37, usedAt: 1 };
  const reused: OrderEntry = { presetKind: "sharePresets", quantity: 5, usedAt: 2 };
  const other: OrderEntry = { presetKind: "sharePresets", quantity: 9, usedAt: 3 };
  const s = useUiStore.getState();
  s.rememberOrderEntry(orderEntryKey("L", "order-2", "A"), closed);
  s.rememberOrderEntry(orderEntryKey("L", "order", "A"), other);
  const taken = s.takeOrderWindow("L", "order-2");
  expect(taken).toEqual({ [orderEntryKey("L", "order-2", "A")]: closed });
  s.rememberOrderEntry(orderEntryKey("L", "order-2", "B"), reused);
  s.restoreOrderWindow("L", "order-2", taken);
  expect(useUiStore.getState().prefs.orderEntries).toEqual({ [orderEntryKey("L", "order-2", "A")]: closed, [orderEntryKey("L", "order", "A")]: other });
  const prefs = useUiStore.getState().prefs;
  s.restoreOrderWindow("L", "order-3", {});
  expect(useUiStore.getState().prefs).toBe(prefs);
});
