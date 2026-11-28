import { afterEach, describe, expect, test, vi } from "vitest";
import { JumpBadge, jumpBadgeNotes, UNADJUSTED_NOTE } from "./jumpBadge";

class FakeNode {
  className = "";
  title = "";
  type = "";
  hidden = false;
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, (() => void)[]>();
  readonly children: FakeNode[] = [];
  parentElement: FakeNode | null = null;
  rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  private text = "";

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.children.length > 0 ? this.children.map((child) => child.textContent).join("") : this.text;
  }

  set textContent(value: string) {
    this.children.length = 0;
    this.text = value;
  }

  append(...items: FakeNode[]): void {
    for (const item of items) {
      item.remove();
      item.parentElement = this;
      this.children.push(item);
    }
  }

  remove(): void {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  addEventListener(name: string, listener: () => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) listener();
  }

  getBoundingClientRect(): DOMRectReadOnly {
    return this.rect as DOMRectReadOnly;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JumpBadge", () => {
  test("과거 보기 날짜·실시간 멈춤·부가 상태 문구와 닫기 버튼을 렌더링한다", () => {
    vi.stubGlobal("document", { createElement: (tag: string) => new FakeNode(tag) });
    const parent = new FakeNode("div");
    const onClose = vi.fn();
    const badge = new JumpBadge(parent as unknown as HTMLElement, onClose);
    const root = parent.children[0]!;
    expect(root.className).toBe("chart-jump");
    expect(root.hidden).toBe(true);
    expect(root.attrs.get("role")).toBe("group");
    expect(root.attrs.get("aria-label")).toBe("바로가기 모드");

    const [dot, text, close] = root.children;
    expect(dot!.className).toBe("chart-jump-dot");
    expect(dot!.attrs.get("aria-hidden")).toBe("true");
    expect(text!.className).toBe("chart-jump-text");
    expect(close!.className).toBe("chart-jump-close");
    expect(close!.attrs.get("aria-label")).toBe("바로가기 끝내기");
    expect(close!.title).toBe("실시간으로 돌아가기");

    badge.show({ date: "2026-10-28", receiving: false, unadjustedDays: [], compareHidden: false });
    expect(root.hidden).toBe(false);
    expect(text!.textContent).toBe("과거 보기 2026-10-28 · 실시간 멈춤");

    badge.show({ date: "2026-10-28", receiving: true, unadjustedDays: ["2026-10-20", "2026-10-21"], compareHidden: true });
    expect(jumpBadgeNotes({ date: "2026-10-28", receiving: true, unadjustedDays: [], compareHidden: true })).toEqual([
      "실시간 멈춤",
      "받는 중",
      "비교 숨김",
    ]);
    expect(text!.textContent).toBe(`과거 보기 2026-10-28 · 실시간 멈춤 · 받는 중 · 비교 숨김 · ${UNADJUSTED_NOTE}`);
    const warning = text!.children[2]!;
    expect(warning.title).toBe("수정주가를 반영하지 못한 날짜: 2026-10-20, 2026-10-21");

    close!.click();
    expect(onClose).toHaveBeenCalledTimes(1);

    badge.show(null);
    expect(root.hidden).toBe(true);
    badge.dispose();
    expect(parent.children).toHaveLength(0);
  });

  test("box는 숨김이거나 크기가 0이면 null을 돌려주고 보이면 기준 요소 상대 좌표를 돌려준다", () => {
    vi.stubGlobal("document", { createElement: (tag: string) => new FakeNode(tag) });
    const parent = new FakeNode("div");
    parent.rect = { left: 100, top: 40, right: 900, bottom: 640, width: 800, height: 600 };
    const badge = new JumpBadge(parent as unknown as HTMLElement, () => {});
    const root = parent.children[0]!;
    root.rect = { left: 380, top: 46, right: 620, bottom: 76, width: 240, height: 30 };

    expect(badge.box(parent as unknown as HTMLElement)).toBeNull();

    badge.show({ date: "2026-10-28", receiving: false, unadjustedDays: [], compareHidden: false });
    expect(badge.box(parent as unknown as HTMLElement)).toEqual({ left: 280, top: 6, right: 520, bottom: 36 });

    root.rect = { left: 380, top: 46, right: 380, bottom: 46, width: 0, height: 0 };
    expect(badge.box(parent as unknown as HTMLElement)).toBeNull();
  });
});
