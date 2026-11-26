// @vitest-environment happy-dom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Watchlists } from "../../api/generated/Watchlists";
import { sendJson } from "../../api/http";
import { startAutosave, type Autosave } from "../../persist/autosave";
import { createLayoutReceipt } from "../../persist/layoutReceipt";
import { usePersistStore } from "../../stores/persist";
import { useSelectionStore } from "../../stores/selection";
import { useWatchlistStore } from "../../stores/watchlist";
import { renderWithProviders } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { windowId } from "../../layout/kinds";
import { ShellBanner } from "../status/ShellBanner";
import { WatchPanel } from "./Watchlist";

let server: Watchlists;
let autosave: Autosave;
let putMode: "ok" | "fail" | "conflict";

beforeEach(() => {
  server = { revision: 100, lists: [{ id: "source", name: "기본", symbols: ["005930", "086520", "005935"], groups: [] }] };
  putMode = "ok";
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.method === "PUT") {
      if (putMode === "fail") {
        return Response.json({ error: { code: "internal", message: "저장 실패" } }, { status: 500 });
      }
      const body = JSON.parse(String(init.body ?? "{}")) as Watchlists;
      if (putMode === "conflict" || body.revision <= server.revision) {
        server = { ...server, revision: server.revision + 1 };
        return Response.json({ error: { code: "stale_revision", message: "경쟁 저장" } }, { status: 409 });
      }
      server = structuredClone(body);
      return Response.json(server);
    }
    return Response.json(structuredClone(server));
  }));

  useWatchlistStore.getState().load(structuredClone(server.lists), server.revision);
  usePersistStore.getState().setSave("watchlist", { kind: "idle" });
  useSelectionStore.setState({ dialog: null, activeCell: windowId("cell-0"), toasts: [], toast: null });
  autosave = startAutosave({
    put: (path, body, opts) => sendJson("PUT", path, body, opts),
    toast: (text) => useSelectionStore.getState().showToast(text),
    revisions: { layout: 0, ui: 0, watchlist: server.revision },
    receipt: createLayoutReceipt(),
  });
});

afterEach(() => {
  autosave.stop();
});

resetDomAfterEach();

test("종목 빼기 후 되돌리기 토스트에서 3회 충돌 시 배너/토스트 안내가 뜨고 서버 자료를 덮어쓰지 않는다", async () => {
  const { client } = renderWithProviders(
    <>
      <ShellBanner />
      <WatchPanel id={windowId("watch-1")} />
    </>,
  );

  const row = await screen.findByText("086520");
  fireEvent.contextMenu(row.closest("[data-main]")!);
  fireEvent.click(await screen.findByRole("menuitem", { name: /^관심종목에서 빼기/ }));
  await waitFor(() => expect(server.lists[0]!.symbols).toEqual(["005930", "005935"]));

  putMode = "conflict";
  fireEvent.click(await screen.findByRole("button", { name: /^되돌리기$/ }));
  expect(await screen.findByText("다른 곳에서 바뀌어 되돌리지 못했습니다")).toBeTruthy();
  expect(server.lists[0]!.symbols).toEqual(["005930", "005935"]);
  client.clear();
});

test("저장 실패 배너가 뜬 뒤 되돌리기는 실패 본문을 재전송하지 않고 복구한다", async () => {
  const { client } = renderWithProviders(
    <>
      <ShellBanner />
      <WatchPanel id={windowId("watch-1")} />
    </>,
  );

  putMode = "fail";
  const row = await screen.findByText("086520");
  fireEvent.contextMenu(row.closest("[data-main]")!);
  fireEvent.click(await screen.findByRole("menuitem", { name: /^관심종목에서 빼기/ }));
  expect((await screen.findByTestId("shell-banner")).textContent).toContain("저장하지 못했습니다");

  putMode = "ok";
  fireEvent.click(await screen.findByRole("button", { name: /^되돌리기$/ }));
  await waitFor(() => expect(server.lists[0]!.symbols).toEqual(["005930", "086520", "005935"]));
  expect(useWatchlistStore.getState().lists[0]!.symbols).toEqual(["005930", "086520", "005935"]);
  client.clear();
});
