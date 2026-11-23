import { beforeEach, expect, test } from "vitest";
import { MAX_TOASTS, useSelectionStore, visibleToasts, type ToastUndo } from "./selection";

const store = () => useSelectionStore.getState();
const texts = () => visibleToasts(store()).map((toast) => toast.text);
const undo: ToastUndo = { available: () => true, run: () => undefined, subscribe: () => () => undefined };

beforeEach(() => store().clearToasts());

test("종류를 주지 않으면 info이고 둘째 인수로 되돌리기를 주는 기존 호출이 그대로 동작한다", () => {
  store().showToast("기존 호출", undo);
  store().showToast("옵션 호출", { tone: "success", undo });
  expect(visibleToasts(store()).map(({ text, tone, undo: given }) => [text, tone, given === undo])).toEqual([["기존 호출", "info", true], ["옵션 호출", "success", true]]);
});

test("알림은 셋까지 쌓이고 넘치면 가장 오래된 것부터 밀려난다", () => {
  for (const text of ["가", "나", "다", "라"]) store().showToast(text);
  expect(MAX_TOASTS).toBe(3);
  expect(texts()).toEqual(["나", "다", "라"]);
  expect(store().toast?.text).toBe("라");
});

test("같은 문구와 종류가 다시 오면 쌓지 않고 맨 뒤로 옮긴다", () => {
  store().showToast("가");
  store().showToast("나");
  store().showToast("가");
  expect(texts()).toEqual(["나", "가"]);
  store().showToast("가", { tone: "error" });
  expect(texts()).toEqual(["나", "가", "가"]);
});

test("알림 하나만 지우면 나머지는 남고 마지막 것이 toast로 보인다", () => {
  store().showToast("가");
  store().showToast("나");
  const [first, second] = visibleToasts(store());
  store().clearToast(second!.id);
  expect(texts()).toEqual(["가"]);
  expect(store().toast?.id).toBe(first!.id);
  store().clearToast(first!.id);
  expect(store().toast).toBeNull();
  expect(texts()).toEqual([]);
});

test("toast를 null로 되돌리는 기존 시험 방식은 쌓인 알림을 모두 비운 것으로 본다", () => {
  store().showToast("가");
  store().showToast("나");
  useSelectionStore.setState({ toast: null });
  expect(texts()).toEqual([]);
  store().showToast("다");
  expect(texts()).toEqual(["다"]);
});

test("넘칠 때 error가 아닌 알림부터 밀려나 error는 닫기 전까지 남는다", () => {
  store().showToast("저장하지 못했습니다", { tone: "error" });
  for (const text of ["가", "나", "다"]) store().showToast(text);
  expect(texts()).toEqual(["저장하지 못했습니다", "나", "다"]);
});

test("error만 셋이 쌓인 뒤에는 가장 오래된 error가 밀려난다", () => {
  for (const text of ["가", "나", "다", "라"]) store().showToast(text, { tone: "error" });
  expect(texts()).toEqual(["나", "다", "라"]);
});
