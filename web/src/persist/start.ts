import { loadAccount } from "../api/account";
import { useAccountStore } from "../stores/account";
import type { AccountStatus } from "../api/generated/AccountStatus";
import { boot, suspendSetup } from "./boot";
import { type SetupLifecycle, stepFor } from "./startFlow";

export interface StartDeps {
  loadAccount(): Promise<void>;
  boot(): Promise<void>;
  suspendSetup(): void;
  reload(): void;
  subscribe(listener: (status: AccountStatus) => void): () => void;
}

export const browserStartDeps: StartDeps = {
  loadAccount: () => loadAccount(),
  boot,
  suspendSetup,
  reload: () => location.reload(),
  subscribe: (listener) => useAccountStore.subscribe((s, prev) => s.status !== null && s.status !== prev.status && listener(s.status)),
};

export async function start(deps: StartDeps = browserStartDeps): Promise<void> {
  let lifecycle: SetupLifecycle = "waiting";
  deps.subscribe((status) => {
    const step = stepFor(lifecycle, status);
    if (step === "boot") {
      lifecycle = "running";
      void deps.boot();
    } else if (step === "suspend") {
      lifecycle = "suspended";
      deps.suspendSetup();
    } else if (step === "reload") deps.reload();
  });
  try {
    await deps.loadAccount();
  } catch (e) {
    console.warn("계정 상태를 읽지 못했습니다", e);
    if (lifecycle === "waiting") {
      lifecycle = "running";
      await deps.boot();
    }
  }
}
