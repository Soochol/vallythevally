// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { HotkeysMenuContent } from "./HotkeysMenuContent";
import { SystemSettingsDialog } from "./SystemSettingsDialog";
import { useHotkeyRecording } from "./hotkeyRecording";
import { useAccountStore } from "../../stores/account";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { resetDomAfterEach } from "../../test/domSetup";
import { createTestQueryClient, renderWithProviders, stubFetch } from "../../test/domHarness";
import type { KiwoomKeyList } from "../../api/generated/KiwoomKeyList";

const EMPTY_KEYS: KiwoomKeyList = { keys: [], limit: 5, keyFileProblem: null };

function mountHotkeys() {
  stubFetch(({ pathname }) => {
    if (pathname === "/api/system/kiwoom/keys") return { body: EMPTY_KEYS };
    if (pathname === "/api/collector/access") return { body: { access: "denied" } };
    if (pathname === "/api/account") return { body: { state: "local_only" } };
    return { body: {} };
  });
  useSelectionStore.setState({ dialog: { kind: "system-settings", menu: "hotkeys" } });
  return renderWithProviders(<SystemSettingsDialog />, { withToast: false });
}

const dialog = () => screen.getByRole("dialog", { name: "시스템 설정" });
const panelWithContainer = () => {
  const el = within(dialog()).getByRole("tabpanel");
  return {
    ...within(el),
    row: (action: string) => {
      const li = el.querySelector<HTMLElement>(`li[data-action="${action}"]`);
      if (!li) throw new Error(`Missing action row: ${action}`);
      return { el: li, ...within(li) };
    },
    actionCount: () => el.querySelectorAll("li[data-action]").length,
  };
};

function record(action: string, name: string, event: { key: string; code: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }) {
  const p = panelWithContainer();
  fireEvent.click(p.row(action).getByRole("button", { name: `${name}에 키 더하기` }));
  expect(p.row(action).el.textContent).toContain("키를 누르세요 · Esc 취소");
  fireEvent.keyDown(window, event);
}

beforeEach(() => {
  useHotkeyRecording.setState({ actionId: null });
  useUiStore.getState().setHotkeys({});
  useKiwoomLinkStore.setState({ status: null });
  useAccountStore.setState({ status: { state: "local_only" } as ReturnType<typeof useAccountStore.getState>["status"] });
});

resetDomAfterEach();

test("단축키 탭은 일반 다음에 있고 기본 키, 없음, 바꿀 수 없는 키 묶음을 보인다", () => {
  const { client } = mountHotkeys();
  const tabs = within(dialog()).getAllByRole("tab").map((t) => t.textContent?.trim() ?? "");
  expect(tabs.indexOf("단축키")).toBe(tabs.indexOf("일반") + 1);
  const p = panelWithContainer();
  expect(p.row("period:D").el.textContent).toContain("D");
  expect(p.row("search").el.textContent).toContain("/");
  expect(p.row("search").el.textContent).toContain("Ctrl+K");
  expect(p.row("period:10m").el.textContent).toContain("없음");
  expect(p.getByRole("region", { name: "바꿀 수 없는 키" })).toBeTruthy();
  client.clear();
});

test("일에 Q를 더하고 D를 빼면 Q가 일이 되고 저장된다", () => {
  const { client } = mountHotkeys();
  const p = panelWithContainer();
  record("period:D", "일", { key: "q", code: "KeyQ" });
  expect(p.row("period:D").getByRole("button", { name: "일에서 Q 빼기" })).toBeTruthy();
  expect(p.row("period:D").el.textContent).toContain("바꿈");
  fireEvent.click(p.row("period:D").getByRole("button", { name: "일에서 D 빼기" }));
  expect(p.row("period:D").queryByRole("button", { name: "일에서 D 빼기" })).toBeNull();
  expect(useUiStore.getState().prefs.hotkeys).toEqual({ "period:D": ["KeyQ"] });
  client.clear();
});

test("다른 동작이 쓰는 키는 옮길지 묻고, 옮기면 원래 동작에서 빠지고 취소하면 그대로다", () => {
  const { client } = mountHotkeys();
  const p = panelWithContainer();
  record("period:D", "일", { key: "q", code: "KeyQ" });
  record("period:W", "주", { key: "q", code: "KeyQ" });
  expect(p.row("period:W").el.textContent).toContain('Q는 "일"에 쓰고 있습니다');
  fireEvent.click(p.row("period:W").getByRole("button", { name: "취소" }));
  expect(p.row("period:W").queryByRole("button", { name: "주에서 Q 빼기" })).toBeNull();
  expect(p.row("period:D").getByRole("button", { name: "일에서 Q 빼기" })).toBeTruthy();
  record("period:W", "주", { key: "q", code: "KeyQ" });
  fireEvent.click(p.row("period:W").getByRole("button", { name: "옮기기" }));
  expect(p.row("period:W").getByRole("button", { name: "주에서 Q 빼기" })).toBeTruthy();
  expect(p.row("period:D").queryByRole("button", { name: "일에서 Q 빼기" })).toBeNull();
  client.clear();
});

test("바꿀 수 없는 키는 막고 이유를 보이며 차트가 가로채는 키도 막는다", () => {
  const { client } = mountHotkeys();
  const p = panelWithContainer();
  record("period:D", "일", { key: "w", code: "KeyW", ctrlKey: true });
  expect(p.row("period:D").el.textContent).toContain("바꿀 수 없는 키입니다");
  expect(p.row("period:D").queryByRole("button", { name: "일에서 Ctrl+W 빼기" })).toBeNull();
  record("search", "종목 검색", { key: "z", code: "KeyZ", ctrlKey: true, altKey: true });
  expect(p.row("search").el.textContent).toContain("Ctrl+Alt+Z는 바꿀 수 없는 키입니다");
  expect(p.row("search").el.textContent).toContain("되돌리기");
  expect(p.row("search").queryByRole("button", { name: /Ctrl\+Alt\+Z 빼기/ })).toBeNull();
  client.clear();
});

test("키를 기다리는 중의 Esc는 기록만 취소하고 창은 열어 둔다", () => {
  const { client } = mountHotkeys();
  const p = panelWithContainer();
  fireEvent.click(p.row("period:D").getByRole("button", { name: "일에 키 더하기" }));
  expect(p.row("period:D").el.textContent).toContain("키를 누르세요");
  fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
  expect(dialog()).toBeTruthy();
  expect(p.row("period:D").el.textContent).not.toContain("키를 누르세요");
  fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
  expect(screen.queryByRole("dialog", { name: "시스템 설정" })).toBeNull();
  client.clear();
});

test("숫자패드 + 키도 글자로 보인다", () => {
  const client = createTestQueryClient();
  render(<HotkeysMenuContent />);
  const plusBtn = screen.getByRole("button", { name: "10분에 키 더하기" });
  fireEvent.click(plusBtn);
  fireEvent.keyDown(window, { key: "+", code: "NumpadAdd" });
  expect(screen.getByRole("button", { name: "10분에서 Num + 빼기" })).toBeTruthy();
  client.clear();
});

test("찾기 칸은 키 글자로 거른다", () => {
  const { client } = mountHotkeys();
  const p = panelWithContainer();
  fireEvent.change(p.getByRole("searchbox", { name: "단축키 찾기" }), { target: { value: "Alt+S" } });
  expect(p.actionCount()).toBe(1);
  expect(p.row("snapshotDownload").el).toBeTruthy();
  expect(p.queryByRole("region", { name: "바꿀 수 없는 키" })).toBeNull();
  client.clear();
});

test("모두 기본값으로는 한 번 더 묻고 되돌리면 저장된 바꿈이 비워진다", () => {
  const { client } = mountHotkeys();
  const p = panelWithContainer();
  record("period:D", "일", { key: "q", code: "KeyQ" });
  expect(useUiStore.getState().prefs.hotkeys).toEqual({ "period:D": ["KeyD", "KeyQ"] });
  fireEvent.click(p.getByRole("button", { name: "모두 기본값으로" }));
  expect(within(dialog()).getByRole("tabpanel").textContent).toContain("바꾼 키를 모두 되돌릴까요?");
  fireEvent.click(p.getByRole("button", { name: "취소" }));
  expect(p.row("period:D").getByRole("button", { name: "일에서 Q 빼기" })).toBeTruthy();
  fireEvent.click(p.getByRole("button", { name: "모두 기본값으로" }));
  fireEvent.click(p.getByRole("button", { name: "되돌리기" }));
  expect(p.row("period:D").getByRole("button", { name: "일에서 D 빼기" })).toBeTruthy();
  expect(useUiStore.getState().prefs.hotkeys).toEqual({});
  client.clear();
});
