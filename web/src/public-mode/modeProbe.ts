import { loadServerMode } from "./serverModeLoad";

declare global {
  interface Window {
    __serverModeProbe?: Promise<unknown>;
  }
}

const early = window.__serverModeProbe;

export const serverModeProbe = loadServerMode(early === undefined ? undefined : () => early);
