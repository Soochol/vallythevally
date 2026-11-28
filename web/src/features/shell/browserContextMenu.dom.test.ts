// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installBrowserContextMenuGuard } from "./browserContextMenu";

const SVG_NS = "http://www.w3.org/2000/svg";

function dispatchContextMenu(target: EventTarget, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("installBrowserContextMenuGuard", () => {
  let uninstall: (() => void) | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
    uninstall = installBrowserContextMenuGuard(window);
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    document.body.innerHTML = "";
  });

  it("blocks default browser context menu on non-editable elements", () => {
    const div = document.createElement("div");
    const button = document.createElement("button");
    const span = document.createElement("span");
    const svg = document.createElementNS(SVG_NS, "svg");
    const rect = document.createElementNS(SVG_NS, "rect");
    svg.append(rect);
    document.body.append(div, button, span, svg);

    for (const target of [div, button, span, rect, document.body]) {
      expect(dispatchContextMenu(target).defaultPrevented).toBe(true);
    }
  });

  it("allows default browser context menu on input and textarea elements", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    document.body.append(input, textarea);

    expect(dispatchContextMenu(input).defaultPrevented).toBe(false);
    expect(dispatchContextMenu(textarea).defaultPrevented).toBe(false);
  });

  it("allows default browser context menu on active contenteditable elements and descendants", () => {
    const bare = document.createElement("div");
    bare.setAttribute("contenteditable", "");

    const explicitTrue = document.createElement("div");
    explicitTrue.setAttribute("contenteditable", "true");
    const nestedSpan = document.createElement("span");
    const nestedText = document.createTextNode("editable text");
    nestedSpan.append(nestedText);
    explicitTrue.append(nestedSpan);

    const plaintext = document.createElement("div");
    plaintext.setAttribute("contenteditable", "PLAINTEXT-ONLY");

    document.body.append(bare, explicitTrue, plaintext);

    for (const target of [bare, explicitTrue, nestedSpan, nestedText, plaintext]) {
      expect(dispatchContextMenu(target).defaultPrevented).toBe(false);
    }
  });

  it("blocks default browser context menu on contenteditable=false including inside editable ancestors", () => {
    const standalone = document.createElement("div");
    standalone.setAttribute("contenteditable", "false");

    const outer = document.createElement("div");
    outer.setAttribute("contenteditable", "true");
    const innerDisabled = document.createElement("span");
    innerDisabled.setAttribute("contenteditable", "false");
    const innerText = document.createTextNode("locked");
    innerDisabled.append(innerText);
    outer.append(innerDisabled);

    document.body.append(standalone, outer);

    expect(dispatchContextMenu(standalone).defaultPrevented).toBe(true);
    expect(dispatchContextMenu(innerDisabled).defaultPrevented).toBe(true);
    expect(dispatchContextMenu(innerText).defaultPrevented).toBe(true);
  });

  it("allows default browser context menu on Shift + right-click", () => {
    const div = document.createElement("div");
    document.body.append(div);

    expect(dispatchContextMenu(div, { shiftKey: true }).defaultPrevented).toBe(false);
  });

  it("runs after child custom contextmenu listeners without blocking or altering them", () => {
    const customTarget = document.createElement("div");
    const observed: Array<{ phase: string; defaultPrevented: boolean }> = [];
    customTarget.addEventListener("contextmenu", (event) => {
      observed.push({ phase: "child-before", defaultPrevented: event.defaultPrevented });
      event.preventDefault();
      observed.push({ phase: "child-after", defaultPrevented: event.defaultPrevented });
    });
    document.body.append(customTarget);

    const handledEvent = dispatchContextMenu(customTarget);
    expect(observed).toEqual([
      { phase: "child-before", defaultPrevented: false },
      { phase: "child-after", defaultPrevented: true },
    ]);
    expect(handledEvent.defaultPrevented).toBe(true);

    const passiveTarget = document.createElement("div");
    let childSawPrevented: boolean | null = null;
    passiveTarget.addEventListener("contextmenu", (event) => {
      childSawPrevented = event.defaultPrevented;
    });
    document.body.append(passiveTarget);

    const passiveEvent = dispatchContextMenu(passiveTarget);
    expect(childSawPrevented).toBe(false);
    expect(passiveEvent.defaultPrevented).toBe(true);
  });

  it("stops preventing contextmenu events after cleanup is called", () => {
    const div = document.createElement("div");
    document.body.append(div);

    expect(dispatchContextMenu(div).defaultPrevented).toBe(true);
    uninstall?.();
    uninstall = null;
    expect(dispatchContextMenu(div).defaultPrevented).toBe(false);
  });
});
