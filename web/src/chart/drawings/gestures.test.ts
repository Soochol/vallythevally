import { describe, expect, test } from "vitest";
import {
  CLONE_MODIFIER,
  type CloneModifier,
  GESTURES,
  gestureHelp,
  gesturesFor,
  holds,
  type ModeId,
  type Mods,
  type PressMode,
  type PressTarget,
  resolvePress,
} from "./gestures";

const none: Mods = { ctrl: false, alt: false, shift: false };
const ctrl: Mods = { ...none, ctrl: true };
const alt: Mods = { ...none, alt: true };
const shift: Mods = { ...none, shift: true };
const all = new Set<ModeId>(["demo", "eraser"]);
const nothing = new Set<ModeId>();

describe("복제 수정키(Q1)는 한 줄이다", () => {
  test.each<CloneModifier>(["ctrl", "alt"])("%s로 바꿔도 그 줄 하나만 그 키를 쓴다", (clone) => {
    const rows = gesturesFor(clone);
    const other: CloneModifier = clone === "ctrl" ? "alt" : "ctrl";
    expect(resolvePress("select", "body", { ...none, [clone]: true }, all, rows)?.drag).toBe("clone");
    expect(resolvePress("select", "body", { ...none, [other]: true }, all, rows)?.drag).toBe("move");
    expect(rows.filter((r) => r.kind !== "hold" && r.action === "clone")).toHaveLength(1);
    const cloneHelp = gestureHelp(all, rows).find((h) => h.label === "복제");
    expect(cloneHelp?.keys).toBe(`${clone === "ctrl" ? "Ctrl" : "Alt"}+드로잉 끌기`);
  });

  test("지금 표는 CLONE_MODIFIER로 만든다", () => {
    expect(GESTURES).toEqual(gesturesFor(CLONE_MODIFIER));
    expect(resolvePress("select", "body", { ...none, [CLONE_MODIFIER]: true }, all)?.drag).toBe("clone");
  });

  test("CLONE_MODIFIER를 바꿔도 다른 줄의 Ctrl·Alt 뜻은 그대로다", () => {
    for (const clone of ["ctrl", "alt"] as const) {
      const rows = gesturesFor(clone);
      expect(resolvePress("select", "empty", ctrl, all, rows)?.drag).toBe("box");
      expect(resolvePress("select", "empty", alt, all, rows)?.drag).toBe("demo");
      expect(holds("handle", ctrl, rows).has("invertMagnet")).toBe(true);
    }
  });
});

describe("누르기 표", () => {
  test("클릭은 고르고, Ctrl+클릭은 넣고 뺀다", () => {
    expect(resolvePress("select", "body", none, all)?.click).toBe("select");
    expect(resolvePress("select", "body", ctrl, all)?.click).toBe("toggleSelect");
    expect(resolvePress("select", "handle", ctrl, all)?.click).toBe("toggleSelect");
    expect(resolvePress("select", "empty", none, all)?.click).toBe("clearSelection");
  });

  test("끌기: 몸통은 옮기기, 핸들은 점 옮기기, 빈 곳은 차트 옮기기", () => {
    expect(resolvePress("select", "body", none, all)).toEqual({ click: "select", drag: "move", capturesPointer: true });
    expect(resolvePress("select", "handle", none, all)?.drag).toBe("handle");
    expect(resolvePress("select", "empty", none, all)).toEqual({ click: "clearSelection", drag: "pan", capturesPointer: false });
  });

  test("Ctrl+빈 곳 끌기는 상자 고르기", () => {
    expect(resolvePress("select", "empty", ctrl, all)?.drag).toBe("box");
  });

  test("Alt+빈 곳 끌기는 시연 커서. 모드가 없으면 차트 옮기기로 남고 스크롤을 잠그지 않는다", () => {
    expect(resolvePress("select", "empty", alt, all)?.drag).toBe("demo");
    expect(resolvePress("select", "empty", alt, nothing)).toEqual({ click: "clearSelection", drag: "pan", capturesPointer: false });
  });

  test("지우개: 끌면 지나간 것, Ctrl이면 붓 획 일부", () => {
    expect(resolvePress("erase", "body", none, all)?.drag).toBe("erase");
    expect(resolvePress("erase", "empty", ctrl, all)?.drag).toBe("erasePartial");
    expect(resolvePress("erase", "body", none, all)?.click).toBe("eraseOne");
  });

  test("그리는 중에는 무엇을 눌렀든 점을 찍는다", () => {
    for (const target of ["empty", "body", "handle"] as const) expect(resolvePress("draw", target, ctrl, all)).toEqual({ click: "place", drag: "place", capturesPointer: true });
  });

  test.each<[ReadonlySet<ModeId>, PressMode[]]>([
    [nothing, ["select", "draw"]],
    [all, ["select", "draw", "erase"]],
  ])("모든 (모드, 대상, 수정키) 짝이 답을 낸다", (registered, modes) => {
    const targets: PressTarget[] = ["empty", "body", "handle"];
    for (const mode of modes)
      for (const target of targets)
        for (let bits = 0; bits < 8; bits++) {
          const mods = { ctrl: (bits & 1) > 0, alt: (bits & 2) > 0, shift: (bits & 4) > 0 };
          expect(resolvePress(mode, target, mods, registered), `${mode} ${target} ${bits}`).not.toBeNull();
        }
  });
});

describe("끄는 동안 누르고 있는 키", () => {
  test("Shift: 그리기·핸들은 45°·정사각형, 몸통은 수평·수직", () => {
    expect([...holds("place", shift)]).toEqual(["constrainShape"]);
    expect([...holds("handle", shift)]).toEqual(["constrainShape"]);
    expect([...holds("move", shift)]).toEqual(["axisLock"]);
    expect([...holds("clone", shift)]).toEqual(["axisLock"]);
  });

  test("Ctrl: 그리기·핸들 끌기 동안 자석 반대", () => {
    expect([...holds("place", ctrl)]).toEqual(["invertMagnet"]);
    expect(holds("move", ctrl).size).toBe(0);
    expect(holds("pan", { ctrl: true, alt: true, shift: true }).size).toBe(0);
  });
});

test("도움말은 표에서 만든다", () => {
  const help = gestureHelp(all);
  expect(help).toHaveLength(GESTURES.length);
  expect(help).toContainEqual({ keys: "Ctrl+빈 곳 끌기", label: "상자로 고르기" });
  expect(help).toContainEqual({ keys: "Alt+빈 곳 끌기", label: "시연 커서" });
  expect(help).toContainEqual({ keys: "Ctrl+지우개로 끌기", label: "붓 획 일부 지우기" });
  expect(help).toContainEqual({ keys: "Shift 누르고 있기", label: "수평·수직으로만 옮기기" });
});

test("도움말은 등록되지 않은 모드의 끌기를 보이지 않는다", () => {
  const help = gestureHelp(nothing);
  expect(help.map((h) => h.label)).not.toContain("시연 커서");
  expect(help.map((h) => h.label)).not.toContain("붓 획 일부 지우기");
  expect(help).toContainEqual({ keys: "Ctrl+빈 곳 끌기", label: "상자로 고르기" });
});
