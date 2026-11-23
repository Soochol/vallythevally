import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";

export type WizardStepId = "prepare" | "paste" | "setup" | "done";

export interface WizardStep {
  id: WizardStepId;
  label: string;
}

const PREPARE: WizardStep = { id: "prepare", label: "키 준비" };
const PASTE: WizardStep = { id: "paste", label: "키 붙여넣기" };
const SETUP: WizardStep = { id: "setup", label: "셋업 고르기" };
const DONE: WizardStep = { id: "done", label: "끝" };

const PLAIN_STEPS: readonly WizardStep[] = [PREPARE, PASTE, DONE];
const CHOICE_STEPS: readonly WizardStep[] = [PREPARE, PASTE, SETUP, DONE];

export const wizardSteps = (withChoice: boolean): readonly WizardStep[] => (withChoice ? CHOICE_STEPS : PLAIN_STEPS);

const indexOf = (steps: readonly WizardStep[], id: WizardStepId) => steps.findIndex((s) => s.id === id);

export const isSkippable = (id: WizardStepId) => id === "prepare" || id === "paste";

export function firstStep(link: KiwoomLinkStatus, choosing: boolean): WizardStepId {
  if (link.state !== "connected") return "prepare";
  return choosing ? "setup" : "done";
}

export const nextStep = (id: WizardStepId, withChoice: boolean): WizardStepId => {
  const steps = wizardSteps(withChoice);
  return steps[Math.min(steps.length - 1, indexOf(steps, id) + 1)]!.id;
};

const PREVIOUS: Record<WizardStepId, WizardStepId> = { prepare: "prepare", paste: "prepare", setup: "paste", done: "paste" };
export const previousStep = (id: WizardStepId): WizardStepId => PREVIOUS[id];

export const skipTarget = (choosing: boolean): WizardStepId => (choosing ? "setup" : "done");

export const advancesOnConnect = (id: WizardStepId, wasConnected: boolean, connected: boolean): boolean => id === "paste" && !wasConnected && connected;

export interface StepFacts {
  link: KiwoomLinkStatus;
  portalIpConfirmed: boolean;
}

export function isDone(id: WizardStepId, facts: StepFacts): boolean {
  switch (id) {
    case "prepare":
      return facts.portalIpConfirmed || facts.link.state === "connected";
    case "paste":
      return facts.link.state === "connected";
    case "setup":
      return true;
    case "done":
      return false;
  }
}

export type StepMark = "done" | "current" | "later" | "upcoming";

export function stepMark(steps: readonly WizardStep[], id: WizardStepId, current: WizardStepId, facts: StepFacts): StepMark {
  if (id === current) return "current";
  if (indexOf(steps, id) > indexOf(steps, current)) return "upcoming";
  return isDone(id, facts) ? "done" : "later";
}

export const canAdvance = (id: WizardStepId, facts: StepFacts): boolean => isSkippable(id) && isDone(id, facts);

export const MARK_TEXT: Record<StepMark, string> = { done: "끝", current: "지금", later: "나중에", upcoming: "" };
