import { loadAccount } from "../api/account";
import { useAccountStore } from "../stores/account";
import type { AccountStatus } from "../api/generated/AccountStatus";
import { SAVE_TARGETS } from "../stores/persist";
import { boot, suspendSetup } from "./boot";
import { type SetupLifecycle, stepFor } from "./startFlow";
import { clearUnsaved } from "./unsaved";

export interface StartDeps {
  loadAccount(): Promise<void>;
  knownStatus(): AccountStatus | null;
  boot(): Promise<void>;
  suspendSetup(): void;
  discardUnsaved(): void;
  reload(): void;
  subscribe(listener: (status: AccountStatus) => void): () => void;
}

export const browserStartDeps: StartDeps = {
  loadAccount: () => loadAccount(),
  knownStatus: () => useAccountStore.getState().status,
  boot,
  suspendSetup,
  discardUnsaved: () => SAVE_TARGETS.forEach((target) => clearUnsaved(target, Infinity)),
  reload: () => location.reload(),
  subscribe: (listener) => useAccountStore.subscribe((s, prev) => s.status !== null && s.status !== prev.status && listener(s.status)),
};

export async function start(deps: StartDeps = browserStartDeps): Promise<void> {
  let lifecycle: SetupLifecycle = "waiting";
  let previous: AccountStatus | null = null;
  deps.subscribe((status) => {
    const step = stepFor(lifecycle, status);
    const replacedLocalSetup = previous?.state === "owner_mismatch" && status.state === "signed_in";
    previous = status;
    if (replacedLocalSetup) deps.discardUnsaved();
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
    if (lifecycle === "waiting" && deps.knownStatus() === null) {
      lifecycle = "running";
      await deps.boot();
    }
  }
}
