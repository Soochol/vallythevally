// @vitest-environment happy-dom
import { screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { useServerModeStore } from "../../public-mode/serverMode";
import { renderWithProviders, stubFetch } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { JournalPage } from "./JournalPage";

beforeEach(() => {
  useServerModeStore.setState({ kind: "local" });
});

resetDomAfterEach();

test("매매 복기 페이지는 PageFrame 안에서 열리고 공개 모드에서는 안내 카드를 보인다", () => {
  stubFetch(() => ({ body: { records: [] } }));

  const local = renderWithProviders(<JournalPage />, { route: "/journal" });
  expect(local.container.querySelector(".page-frame[data-full-width]")).toBeTruthy();
  expect(screen.getByTestId("journal-page")).toBeTruthy();
  local.unmount();
  local.client.clear();

  useServerModeStore.setState({ kind: "public" });
  const pub = renderWithProviders(<JournalPage />, { route: "/journal" });
  expect(pub.container.querySelector(".page-frame[data-full-width]")).toBeTruthy();
  expect(screen.getByTestId("public-unavailable")).toBeTruthy();
  pub.client.clear();
});
