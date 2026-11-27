// @vitest-environment happy-dom
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import { DEFAULT_CHART_SETTINGS } from "../../chart/settings";
import { windowId } from "../../layout/kinds";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { useLayoutStore } from "../../stores/layout";
import { renderWithProviders, stubFetch } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { PreMarketWindow } from "../premarket/PreMarketWindow";
import { ScannerWindow } from "../scanner/ScannerWindow";
import { TapeMatrixWindow } from "../tape-matrix/TapeMatrixWindow";
import { ThemesWindow } from "../themes/ThemesWindow";

const DISCONNECTED_KIWOOM: KiwoomLinkStatus = {
  environment: "real",
  keySource: "file",
  appKeyTail: "7Z2D",
  credentialId: "k1",
  state: "disconnected",
  problem: null,
  message: "연결하지 않았습니다",
  retryAt: null,
  needsAcknowledgement: false,
  step: null,
  tokenExpiresAt: null,
  realtimeRegistered: null,
  symbolCount: null,
  registeredIp: null,
  atStart: null,
};

beforeEach(() => {
  useKiwoomLinkStore.setState({ status: DISCONNECTED_KIWOOM, source: null });
  useLayoutStore.setState((s) => ({
    ...s,
    layout: {
      ...s.layout,
      windows: [
        { id: windowId("cell-0"), link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: DEFAULT_CHART_SETTINGS },
        { id: windowId("pm-1"), link: "a", kind: "premarket" },
      ],
    },
  }));
});

resetDomAfterEach();

test("키움 미연결 시 스캐너·멀티호가·테마·장전 창은 공통 연결 안내를 보이고 테마 API를 호출하지 않는다", async () => {
  const api = stubFetch(({ pathname }) => {
    if (pathname.endsWith("/premarket/days")) return { body: { symbol: "005930", days: [] } };
    return { body: {} };
  });

  const { client } = renderWithProviders(
    <>
      <ScannerWindow id={windowId("scn-1")} />
      <TapeMatrixWindow id={windowId("tm-1")} />
      <ThemesWindow id={windowId("thm-1")} />
      <PreMarketWindow id={windowId("pm-1")} />
    </>,
  );

  await waitFor(() => expect(screen.getAllByText("키움 연결 전입니다")).toHaveLength(4));
  expect(screen.getAllByRole("button", { name: "연결" })).toHaveLength(4);
  expect(api.calls.filter((call) => call.pathname.startsWith("/api/kiwoom/themes"))).toEqual([]);
  client.clear();
});
