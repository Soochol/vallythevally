import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

export function installDomShims() {
  const proto = HTMLElement.prototype as HTMLElement & {
    showPopover?: () => void;
    hidePopover?: () => void;
  };
  if (typeof proto.showPopover !== "function") {
    proto.showPopover = function showPopover() {
      this.dataset.popoverOpen = "true";
    };
  }
  if (typeof proto.hidePopover !== "function") {
    proto.hidePopover = function hidePopover() {
      delete this.dataset.popoverOpen;
    };
  }
  if (typeof proto.scrollIntoView !== "function") {
    proto.scrollIntoView = () => {};
  }
  if (typeof globalThis.ResizeObserver === "undefined") {
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width") || query.includes("width >="),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

export function resetDomAfterEach() {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
}
