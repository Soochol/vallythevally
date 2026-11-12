import { iconMarkup } from "../features/icons";
import type { CompareRow } from "./compare";

const ROW =
  "flex w-max max-w-full items-center gap-1.5 whitespace-nowrap rounded-s pr-1 text-s " +
  "bg-[color-mix(in_srgb,var(--chart-bg)_78%,transparent)]";
const DIR_CLASS = { up: "text-up", down: "text-down", flat: "text-text-2" } as const;
const BTN = "grid size-[18px] place-items-center rounded-s text-xs text-text-2 hover:bg-raised hover:text-text";

interface RowEls {
  root: HTMLDivElement;
  swatch: HTMLSpanElement;
  name: HTMLSpanElement;
  value: HTMLSpanElement;
  note: HTMLSpanElement;
  remove: HTMLButtonElement;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

export class CompareLegend {
  readonly box = el("div", "flex flex-col gap-px");
  private readonly rows = new Map<string, RowEls>();

  constructor(private readonly onRemove: (code: string) => void) {}

  render(rows: readonly CompareRow[]): void {
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.code);
      let r = this.rows.get(row.code);
      if (!r) {
        r = this.build(row.code);
        this.rows.set(row.code, r);
      }
      r.swatch.style.background = row.color;
      r.name.textContent = row.name;
      r.value.textContent = row.value;
      r.value.className = `font-medium ${DIR_CLASS[row.dir]}`;
      r.note.textContent = row.notes.join(" · ");
      r.note.hidden = row.notes.length === 0;
      r.root.classList.toggle("opacity-60", row.failed);
      r.remove.setAttribute("aria-label", `${row.name} 비교 종목 지우기`);
      r.root.dataset.lastT = String(row.last?.t ?? "");
      r.root.dataset.lastClose = String(row.last?.c ?? "");
    }
    for (const [code, r] of this.rows) {
      if (seen.has(code)) continue;
      r.root.remove();
      this.rows.delete(code);
    }
    const order = rows.map((row) => this.rows.get(row.code)!.root);
    if (order.length !== this.box.children.length || order.some((root, i) => this.box.children[i] !== root)) this.box.replaceChildren(...order);
  }

  dispose(): void {
    this.rows.clear();
    this.box.remove();
  }

  private build(code: string): RowEls {
    const root = el("div", `group pointer-events-auto ${ROW}`);
    root.dataset.compareRow = code;
    const swatch = el("span", "h-0.5 w-2.5 flex-none rounded-full");
    const name = el("span", "text-text-2");
    const value = el("span", "font-medium");
    const note = el("span", "rounded-[9px] border border-line px-1.5 text-xs text-text-3");
    const remove = el("button", `${BTN} opacity-0 group-hover:opacity-100 focus-visible:opacity-100`);
    remove.type = "button";
    remove.title = "지우기";
    remove.innerHTML = iconMarkup("close");
    remove.addEventListener("click", () => this.onRemove(code));
    root.append(swatch, name, value, note, remove);
    return { root, swatch, name, value, note, remove };
  }
}
