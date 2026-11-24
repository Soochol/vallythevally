import { expect, test } from "vitest";
import { OptionalTrackedValues, sameSlotSignature, ShapeMultiset, slotSignature, TrackedValues, trackedValuesOf, valueShape } from "./legendShapes";

test("값 모양은 숫자만 0으로 바꾸고 부호·구분자·단위·문구는 남긴다", () => {
  expect(valueShape("85,400")).toBe("00,000");
  expect(valueShape("1,963.30")).toBe("0,000.00");
  expect(valueShape("+1,600  +1.86%")).toBe("+0,000  +0.00%");
  expect(valueShape("−500  −0.58%")).toBe("−000  −0.00%");
  expect(valueShape("25.64억")).toBe("00.00억");
  expect(valueShape("123만")).toBe("000만");
  expect(valueShape("멈춤 10:05")).toBe("멈춤 00:00");
  expect(valueShape("조회 값")).toBe("조회 값");
  expect(valueShape("—")).toBe("—");
});

test("모양 다중집합은 새 모양이 생기거나 마지막 모양이 사라질 때만 바뀜을 알린다", () => {
  const shapes = new ShapeMultiset();
  expect(shapes.add("71,200")).toBe(true);
  expect(shapes.add("85,400")).toBe(false);
  expect(shapes.replace("85,400", "91,000")).toBe(false);
  expect(shapes.replace("91,000", "100,000")).toBe(true);
  expect(shapes.replace("100,000", "123,456")).toBe(false);
  expect(shapes.replace("123,456", "88,000")).toBe(true);
  expect(shapes.has("000,000")).toBe(false);
  expect(shapes.has("00,000")).toBe(true);
  expect(shapes.remove("71,200")).toBe(false);
  expect(shapes.remove("88,000")).toBe(true);
  expect(shapes.size).toBe(0);
});

test("추적 값 열은 모양이 바뀔 때만 버전을 올리고 꼬리 삽입과 잘라내기를 반영한다", () => {
  const tracked = new TrackedValues();
  expect(trackedValuesOf(tracked.values)).toBe(tracked);
  tracked.setAll(["71,200", "72,300", "—"]);
  const baseVersion = tracked.shapeVersion;
  expect(tracked.setAt(1, "79,900")).toBe(false);
  expect(tracked.shapeVersion).toBe(baseVersion);
  expect(tracked.setAt(1, "100,000")).toBe(true);
  expect(tracked.shapeVersion).toBe(baseVersion + 1);
  expect(tracked.setAt(1, "75,000")).toBe(true);
  expect(tracked.shapeVersion).toBe(baseVersion + 2);
  expect(tracked.pushBeforeLast("76,000")).toBe(false);
  expect(tracked.values).toEqual(["71,200", "75,000", "76,000", "—"]);
  expect(tracked.shapeVersion).toBe(baseVersion + 2);
  expect(tracked.pushBeforeLast("1,234,567")).toBe(true);
  expect(tracked.values).toEqual(["71,200", "75,000", "76,000", "1,234,567", "—"]);
  expect(tracked.truncate(3)).toBe(true);
  expect(tracked.values).toEqual(["71,200", "75,000", "76,000"]);
});

test("선택 추적 값은 빈 글자를 목록에서 빼고 나타남과 사라짐을 감지한다", () => {
  const optional = new OptionalTrackedValues();
  expect(optional.setAt(0, "")).toBe(false);
  expect(optional.setAt(1, "조회 값")).toBe(true);
  expect(optional.values).toEqual(["조회 값"]);
  expect(optional.setAt(1, "")).toBe(true);
  expect(optional.values).toEqual([]);
  expect(optional.setAt(1, "")).toBe(false);
  expect(optional.setAt(0, "멈춤 10:00")).toBe(true);
  expect(optional.setAt(1, "멈춤 10:00")).toBe(false);
  expect(optional.truncate(1)).toBe(false);
  expect(optional.truncate(0)).toBe(true);
  expect(optional.values).toEqual([]);
});

test("슬롯 서명은 추적 배열은 버전으로, 일반 배열은 모양 집합으로 비교한다", () => {
  const tracked = new TrackedValues();
  tracked.setAll(["10,000", "20,000"]);
  const first = slotSignature(tracked.values);
  tracked.setAt(1, "30,000");
  expect(sameSlotSignature(first, slotSignature(tracked.values))).toBe(true);
  tracked.setAt(1, "100,000");
  expect(sameSlotSignature(first, slotSignature(tracked.values))).toBe(false);
  expect(sameSlotSignature(slotSignature(["10,000"]), slotSignature(["99,999"]))).toBe(true);
  expect(sameSlotSignature(slotSignature(["10,000"]), slotSignature(["100,000"]))).toBe(false);
});
