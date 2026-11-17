import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";

export const WIZARD_STEPS = [
  { id: "login", label: "로그인" },
  { id: "ip", label: "IP 확인" },
  { id: "key", label: "키움 키" },
  { id: "connect", label: "연결" },
  { id: "setup", label: "기본 셋업" },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];

const ORDER = WIZARD_STEPS.map((s) => s.id);
const indexOf = (id: WizardStepId) => ORDER.indexOf(id);

export const isSkippable = (id: WizardStepId) => id === "key" || id === "ip" || id === "connect";

export function firstStep(link: KiwoomLinkStatus): WizardStepId {
  if (link.state === "connected") return "setup";
  return "ip";
}

export const nextStep = (id: WizardStepId): WizardStepId => ORDER[Math.min(ORDER.length - 1, indexOf(id) + 1)]!;
export const previousStep = (id: WizardStepId): WizardStepId => ORDER[Math.max(1, indexOf(id) - 1)]!;
export const skipToSetup: WizardStepId = "setup";

export interface StepFacts {
  link: KiwoomLinkStatus;
  portalIpConfirmed: boolean;
}

export function isDone(id: WizardStepId, facts: StepFacts): boolean {
  switch (id) {
    case "login":
      return true;
    case "key":
      return facts.link.keySource !== "none";
    case "ip":
      return facts.portalIpConfirmed || facts.link.state === "connected";
    case "connect":
      return facts.link.state === "connected";
    case "setup":
      return false;
  }
}

export type StepMark = "done" | "current" | "later" | "upcoming";

export function stepMark(id: WizardStepId, current: WizardStepId, facts: StepFacts): StepMark {
  if (id === current) return "current";
  if (indexOf(id) > indexOf(current)) return "upcoming";
  return isDone(id, facts) ? "done" : "later";
}

export const canAdvance = (id: WizardStepId, facts: StepFacts): boolean => isSkippable(id) && isDone(id, facts);

export const MARK_TEXT: Record<StepMark, string> = { done: "끝", current: "지금", later: "나중에", upcoming: "" };
