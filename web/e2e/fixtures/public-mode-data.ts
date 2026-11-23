import type { Request } from "@playwright/test";
import type { AccountProvider } from "../../src/api/generated/AccountProvider";
import type { ApiError } from "../../src/api/generated/ApiError";
import type { ServerModeKind } from "../../src/api/generated/ServerModeKind";
import type { FixtureReply } from "./scenario";

export interface PublicSession {
  provider: AccountProvider;
  createdAt: number;
}

const UNAVAILABLE_API = /^\/api\/(ws|bars|quotes|account|system|trading)(\/|$)|^\/api\/symbols\/[^/]+\/day-summary$/;

const refusal = (status: number, code: ApiError["error"]["code"], message: string): FixtureReply => ({
  status,
  body: { error: { code, message, reason: null, retryAt: null, manualActionRequired: false } } satisfies ApiError,
});

export class PublicMode {
  kind: ServerModeKind = "local";
  session: PublicSession | null = null;

  enable(session: PublicSession | null): void {
    this.kind = "public";
    this.session = session;
  }

  baseline(request: Request): FixtureReply | null {
    const { pathname } = new URL(request.url());
    const method = request.method();
    if (pathname === "/api/server-mode" && method === "GET") return { body: { mode: this.kind } };
    if (this.kind !== "public") return null;
    if (pathname === "/v1/session" && method === "GET") return this.session ? { body: this.session } : refusal(401, "signed_out", "로그인이 필요합니다");
    if (pathname === "/v1/session/logout" && method === "POST") return this.signOut();
    if (pathname === "/v1/account" && method === "DELETE") return this.signOut();
    if (/^\/v1\/session\/[a-z]+\/start$/.test(pathname)) return { body: {} };
    if (this.session === null && pathname.startsWith("/api/")) return refusal(401, "signed_out", "로그인이 필요합니다");
    if (UNAVAILABLE_API.test(pathname)) return refusal(404, "not_found", "공개 리스너에 없는 경로입니다");
    return null;
  }

  private signOut(): FixtureReply {
    this.session = null;
    return { status: 204 };
  }
}
