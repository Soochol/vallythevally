// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { getJson } from "../../api/http";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { useRealtimeStore } from "../../stores/realtime";
import { useServerClock } from "../../stores/serverClock";
import { installDomShims, resetDomAfterEach } from "../../test/domSetup";
import { ConnectionIndicator, useConnectionView } from "./ConnectionIndicator";
import { MarketClock } from "./MarketClock";

function ClockHarness() {
  return (
    <footer>
      <MarketClock />
      <ConnectionIndicator view={useConnectionView()} />
    </footer>
  );
}

beforeEach(() => {
  installDomShims();
  useServerClock.setState({ serverTimeOrigin: null });
  useKiwoomLinkStore.getState().receivePush({
    environment: "real",
    keySource: "file",
    appKeyTail: "1234",
    credentialId: null,
    state: "connected",
    problem: null,
    message: "키움에 연결되어 있습니다",
    retryAt: null,
    needsAcknowledgement: false,
    step: null,
    tokenExpiresAt: null,
    realtimeRegistered: 0,
    symbolCount: 2800,
    registeredIp: null,
    atStart: "connects",
  });
  useRealtimeStore.setState({
    connection: { socket: "open", status: { realtime: "live", since: 1_762_900_000, backfilling: false } },
  });
});

resetDomAfterEach();

for (const [serverTime, browserTime, market, connection] of [
  ["2026-11-12T10:00:00+09:00", "2026-11-12T03:00:00+09:00", "장중", "실시간 연결됨"],
  ["2026-11-12T22:00:00+09:00", "2026-11-12T10:00:00+09:00", "장 마감", "장 닫힘: 체결 없음"],
] satisfies readonly [string, string, string, string][]) {
  test(`브라우저 시계가 틀려도 서버 기준 ${market}과 연결 상태가 일치한다`, async () => {
    const fakeNow = Date.parse(browserTime);
    vi.spyOn(Date, "now").mockReturnValue(fakeNow);
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ mode: "local" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            date: new Date(serverTime).toUTCString(),
          },
        }),
      ),
    );

    await getJson("/api/server-mode");
    render(<ClockHarness />);

    expect(screen.getByLabelText("장 상태와 서버 시계").textContent).toContain(market);
    expect(screen.getByRole("status").textContent).toBe(connection);
  });
}
