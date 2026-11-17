import { useEffect } from "react";
import { create } from "zustand";
import type { AccountStatus } from "../../api/generated/AccountStatus";

const LOGIN_MARKER = "vv.login-started";

let startedInThisDocument = false;

export function markLoginStarted(): void {
  startedInThisDocument = true;
  try {
    sessionStorage.setItem(LOGIN_MARKER, "1");
  } catch {
    return;
  }
}

function takeLoginMarker(keep: boolean): boolean {
  try {
    const marked = sessionStorage.getItem(LOGIN_MARKER) !== null;
    if (marked && !keep) sessionStorage.removeItem(LOGIN_MARKER);
    return marked;
  } catch {
    return false;
  }
}

export type LoginReturn = "open" | "wait" | "none";

export function loginReturn(status: AccountStatus, marked: boolean): LoginReturn {
  if (!marked) return "none";
  if (status.state === "signed_in") return "open";
  return status.state === "owner_mismatch" ? "wait" : "none";
}

export const needsChoice = (status: AccountStatus | null): boolean => status?.state === "signed_in" && status.sync.state === "needs_choice";

export const wizardVisible = (status: AccountStatus | null, open: boolean): boolean => status?.state === "signed_in" && (open || needsChoice(status));

interface WizardStore {
  open: boolean;
  show(): void;
  hide(): void;
}

export const useWizardStore = create<WizardStore>()((set) => ({ open: false, show: () => set({ open: true }), hide: () => set({ open: false }) }));

export function useWizardOpening(status: AccountStatus | null): void {
  const show = useWizardStore((s) => s.show);
  const state = status?.state;
  const choosing = needsChoice(status);
  useEffect(() => {
    if (!status || startedInThisDocument) return;
    const marked = takeLoginMarker(status.state === "owner_mismatch");
    if (loginReturn(status, marked) === "open") show();
  }, [state]);
  useEffect(() => {
    if (choosing) show();
  }, [choosing, show]);
}
