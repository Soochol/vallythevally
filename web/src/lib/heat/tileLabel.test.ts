import { expect, test } from "vitest";
import { nameLines, tileLabel } from "./tileLabel";

test("64×34px 이상은 이름과 등락률, 44×20px 이상은 등락률만, 그보다 작으면 글자가 없다", () => {
  expect(tileLabel(64, 34)).toBe("full");
  expect(tileLabel(200, 100)).toBe("full");
  expect(tileLabel(63, 34)).toBe("rate");
  expect(tileLabel(64, 33)).toBe("rate");
  expect(tileLabel(44, 20)).toBe("rate");
  expect(tileLabel(43, 20)).toBe("none");
  expect(tileLabel(44, 19)).toBe("none");
  expect(tileLabel(0, 0)).toBe("none");
});

test("이름은 높이가 넉넉할 때만 두 줄이다", () => {
  expect(nameLines(47)).toBe(1);
  expect(nameLines(48)).toBe(2);
});
