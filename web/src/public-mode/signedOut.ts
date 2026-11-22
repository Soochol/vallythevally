import { useAccountStore } from "../stores/account";
import { isPublicMode } from "./serverMode";

export function markSignedOut(): void {
  const store = useAccountStore.getState();
  if (store.status?.state !== "signed_out") store.receivePush({ state: "signed_out" });
}

export function reportSignedOut(): void {
  if (isPublicMode()) markSignedOut();
}
