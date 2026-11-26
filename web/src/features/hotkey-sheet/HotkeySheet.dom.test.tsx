// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test } from "vitest";
import { windowId } from "../../layout/kinds";
import { useAccountStore } from "../../stores/account";
import { DEFAULT_LAYOUT, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { installDomShims, resetDomAfterEach } from "../../test/domSetup";
import { PageRail } from "../page-rail/PageRail";
import { useWizardStore } from "../setup-wizard/wizardOpen";
import { useHotkeys } from "../useHotkeys";
import { HotkeySheet } from "./HotkeySheet";

const SEARCH_TITLE = "종목 검색 (/ 또는 Ctrl+K)";

function Harness() {
  useHotkeys(true);
  return (
    <MemoryRouter>
      <PageRail page="workspace" />
      <button type="button" title={SEARCH_TITLE}>검색</button>
      <input aria-label="입력 칸" />
      <HotkeySheet />
    </MemoryRouter>
  );
}

const pressQuestion = (target: Element | Window = window) =>
  fireEvent.keyDown(target, { key: "?", code: "Slash", shiftKey: true });

beforeEach(() => {
  installDomShims();
  useLayoutStore.setState({ layout: structuredClone(DEFAULT_LAYOUT) });
  useSelectionStore.setState({ activeCell: windowId("cell-0"), dialog: null });
  useUiStore.getState().setHotkeys({});
  useAccountStore.setState({ status: { kiwoom: null } as unknown as ReturnType<typeof useAccountStore.getState>["status"] });
  useWizardStore.setState({ open: false });
});

resetDomAfterEach();

const sheet = () => screen.queryByRole("dialog", { name: "단축키" });

test("작업 영역에서 ?를 누르면 단축키 판이 열리고 Esc로 닫히며 초점이 돌아온다", () => {
  render(<Harness />);
  expect(sheet()).toBeNull();
  const trigger = screen.getByTitle(SEARCH_TITLE);
  trigger.focus();
  pressQuestion();
  const dialog = sheet();
  expect(dialog).not.toBeNull();
  for (const label of ["찾기·이동", "차트", "창 배치", "드로잉"]) {
    expect(screen.getByRole("region", { name: label })).toBeTruthy();
  }
  fireEvent.keyDown(window, { key: "Escape" });
  expect(sheet()).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("찾기 입력 칸에 초점이 있으면 ?는 글자로 들어가고 판은 열리지 않는다", () => {
  render(<Harness />);
  const input = screen.getByLabelText("입력 칸") as HTMLInputElement;
  input.focus();
  pressQuestion(input);
  expect(sheet()).toBeNull();
});

test("판에서 배치로 찾으면 배치 되돌리기 줄만 남는다", () => {
  render(<Harness />);
  pressQuestion();
  const find = screen.getByRole("textbox", { name: "단축키 찾기" });
  fireEvent.change(find, { target: { value: "배치" } });
  const items = screen.getAllByRole("listitem");
  expect(items).toHaveLength(1);
  expect(items[0]!.textContent).toContain("배치 되돌리기");
  expect([...items[0]!.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["Ctrl", "Z"]);
  fireEvent.change(find, { target: { value: "없는동작" } });
  expect(sheet()!.textContent).toContain("맞는 단축키가 없습니다");
});

test("시스템 설정에서 바꾼 키가 판에 보이고 바꾸기는 단축키 메뉴를 연다", () => {
  useUiStore.getState().setHotkeys({ search: ["Alt+KeyQ"] });
  render(<Harness />);
  pressQuestion();
  const line = screen.getAllByRole("listitem").find((el) => el.textContent?.includes("종목 검색"));
  expect(line).toBeTruthy();
  expect([...line!.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["Alt", "Q"]);
  fireEvent.click(screen.getByRole("button", { name: "바꾸기" }));
  expect(sheet()).toBeNull();
  expect(useSelectionStore.getState().dialog).toEqual({ kind: "system-settings", menu: "hotkeys" });
});

test("레일의 단축키가 판을 연다", () => {
  render(<Harness />);
  const rail = screen.getByRole("navigation", { name: "페이지 메뉴" });
  expect(rail.querySelector("button[name='설정']")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "단축키" }));
  expect(sheet()).not.toBeNull();
});
