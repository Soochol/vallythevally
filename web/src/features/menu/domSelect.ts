import { mountLayer } from "../overlay/topLayer";
import { menuIndex } from "../overlay/position";
export function domSelect(button: HTMLButtonElement, options: () => readonly { label: string; value: string }[], choose: (value: string) => void) {
  let close: (() => void) | null = null;
  const open = () => {
    if (close) { close(); return; }
    const panel = document.createElement("div");
    if (button.closest("[data-chart-control]")) panel.dataset.chartControl = "";
    panel.className = "ui-popover flex flex-col p-1";
    panel.setAttribute("role", "menu");
    panel.setAttribute("aria-label", button.getAttribute("aria-label") ?? "선택");
    const buttons = options().map((option) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "tb-btn text-left";
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(option.value === button.dataset.value));
      item.dataset.optionValue = option.value;
      item.textContent = option.label;
      item.onclick = () => { choose(option.value); close?.(); };
      panel.append(item);
      return item;
    });
    let query = ""; let typedAt = 0;
    panel.onkeydown = (e) => {
      e.stopPropagation();
      const current = buttons.findIndex((b) => b === document.activeElement);
      if (e.key === "Tab") { close?.(); return; }
      if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey) { query = Date.now() - typedAt < 600 ? query + e.key : e.key; typedAt = Date.now(); }
      else query = "";
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || query) {
        e.preventDefault();
        buttons[menuIndex(buttons.map((b) => b.textContent ?? ""), current, e.key, query)]?.focus();
      }
    };
    document.body.append(panel);
    button.setAttribute("aria-expanded", "true");
    const cleanup = mountLayer(panel, { anchor: () => button.getBoundingClientRect(), trigger: button, onClose: () => close?.() });
    close = () => { cleanup(); panel.remove(); button.setAttribute("aria-expanded", "false"); close = null; };
  };
  button.type = "button";
  button.setAttribute("role", "combobox");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-haspopup", "menu");
  button.addEventListener("click", open);
  return () => { close?.(); button.removeEventListener("click", open); };
}
