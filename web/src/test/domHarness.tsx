import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import type { ClientMessage } from "../api/generated/ClientMessage";
import type { ServerMessage } from "../api/generated/ServerMessage";
import { Toast } from "../features/toast/Toast";
import { installDomShims } from "./domSetup";

export interface RecordedFetchCall {
  readonly method: string;
  readonly pathname: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly rawBody: string | null;
  json(): unknown;
}

export type FetchRouteHandler = (
  call: RecordedFetchCall,
) => Response | { status?: number; body?: unknown; headers?: HeadersInit } | Promise<Response | { status?: number; body?: unknown; headers?: HeadersInit }> | undefined;

export function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function errorResponse(
  message: string,
  { code = "bad_request", status = 400, reason = null, retryAt = null, manualActionRequired = false }: {
    code?: string;
    status?: number;
    reason?: string | null;
    retryAt?: number | null;
    manualActionRequired?: boolean;
  } = {},
): Response {
  return jsonResponse({ error: { code, message, reason, retryAt, manualActionRequired } }, status);
}

export function stubFetch(handler: FetchRouteHandler) {
  const calls: RecordedFetchCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, "http://localhost");
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const rawBody = typeof init?.body === "string" ? init.body : null;
    const call: RecordedFetchCall = {
      method,
      pathname: url.pathname,
      url,
      headers,
      rawBody,
      json: () => (rawBody === null ? undefined : JSON.parse(rawBody)),
    };
    calls.push(call);
    const result = await handler(call);
    if (result instanceof Response) return result;
    if (result !== undefined) return jsonResponse(result.body ?? {}, result.status ?? 200, result.headers);
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fn);
  return {
    calls,
    callsTo: (method: string, pathname: string) => calls.filter((c) => c.method === method.toUpperCase() && c.pathname === pathname),
  };
}

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(
  ui: ReactNode,
  { route = "/", client = createTestQueryClient(), withToast = true }: { route?: string; client?: QueryClient; withToast?: boolean } = {},
): RenderResult & { client: QueryClient } {
  installDomShims();
  if (typeof window.scrollTo !== "function") window.scrollTo = (() => {}) as typeof window.scrollTo;
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        {ui}
        {withToast && <Toast />}
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

export interface MockSocketController {
  readonly sent: ClientMessage[];
  emit(message: ServerMessage): void;
  close(): void;
  subsOf(kind: string, symbol?: string): string[];
}

export function installMockWebSocket(
  socket: { start(): void; stop(): void },
  { initialHello = true, serverTime = 1_794_186_000 }: { initialHello?: boolean; serverTime?: number } = {},
): MockSocketController {
  let latest: { onmessage: ((e: { data: string }) => void) | null; onclose: (() => void) | null } | null = null;
  const sent: ClientMessage[] = [];
  class FakeWebSocket {
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() {
      latest = this;
      if (initialHello) {
        queueMicrotask(() => {
          this.onmessage?.({
            data: JSON.stringify({
              type: "hello",
              protocol: 1,
              serverTime,
              status: { realtime: "live", since: serverTime, backfilling: false },
            } satisfies ServerMessage),
          });
        });
      }
    }
    send(text: string) {
      sent.push(JSON.parse(text) as ClientMessage);
    }
    close() {
      latest = null;
    }
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);
  socket.stop();
  socket.start();
  return {
    sent,
    emit(message) {
      latest?.onmessage?.({ data: JSON.stringify(message) });
    },
    close() {
      latest?.onclose?.();
    },
    subsOf(kind, symbol) {
      return sent
        .filter((m): m is Extract<ClientMessage, { type: "subscribe_feed" }> => m.type === "subscribe_feed" && m.kind === kind && (symbol === undefined || m.symbol === symbol))
        .map((m) => m.sub);
    },
  };
}
