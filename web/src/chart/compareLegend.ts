import { iconMarkup } from "../features/icons";
import type { CompareLegendValues, CompareRow } from "./compare";
import type { LegendProjection } from "./legendProjection";
import { sameSlotSignature, type SlotSignature, slotSignature } from "./legendShapes";

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
  lastColor: string;
  lastName: string | null;
  lastValue: string;
  lastValueClass: string;
  lastNote: string;
  lastNoteHidden: boolean | null;
  lastFailed: boolean | null;
  lastT: string | null;
  lastClose: string | null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

export class CompareLegend {
  readonly box = el("div", "flex flex-col gap-px");
  private readonly rows = new Map<string, RowEls>();

  private layoutRows: readonly CompareRow[] = [];
  private layoutValues: readonly CompareLegendValues[] = [];
  private layoutSignature: readonly {
    readonly code: string;
    readonly name: string;
    readonly notes: string;
    readonly values: SlotSignature;
  }[] | null = null;

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
      this.fill(r, row);
    }
    for (const [code, r] of this.rows) {
      if (seen.has(code)) continue;
      r.root.remove();
      this.rows.delete(code);
    }
    const order = rows.map((row) => this.rows.get(row.code)!.root);
    if (order.length !== this.box.children.length || order.some((root, i) => this.box.children[i] !== root)) this.box.replaceChildren(...order);
  }

  setLayoutRows(rows: readonly CompareRow[], values: readonly CompareLegendValues[]): boolean {
    const choices = new Map(values.map((row) => [row.code, row.values]));
    const nextSignature = rows.map((row) => ({
      code: row.code,
      name: row.name,
      notes: row.notes.join(" · "),
      values: slotSignature(choices.get(row.code) ?? []),
    }));
    const prev = this.layoutSignature;
    const changed =
      prev === null
      || prev.length !== nextSignature.length
      || nextSignature.some((next, i) => {
        const before = prev[i]!;
        return (
          before.code !== next.code
          || before.name !== next.name
          || before.notes !== next.notes
          || !sameSlotSignature(before.values, next.values)
        );
      });
    this.layoutRows = rows;
    this.layoutValues = values;
    this.layoutSignature = nextSignature;
    return changed;
  }

  projection(): LegendProjection {
    const root = el("div", this.box.className);
    const choices = new Map(this.layoutValues.map((row) => [row.code, row.values]));
    const fields = this.layoutRows.map((row) => {
      const elements = this.build(row.code, false);
      this.fill(elements, row);
      root.append(elements.root);
      return { element: elements.value, alternatives: choices.get(row.code) ?? [] };
    });
    return { root, fields };
  }

  private fill(r: RowEls, row: CompareRow): void {
    if (r.lastColor !== row.color) {
      r.lastColor = row.color;
      r.swatch.style.background = row.color;
    }
    if (r.lastName !== row.name) {
      r.lastName = row.name;
      r.name.textContent = row.name;
      r.remove.setAttribute("aria-label", `${row.name} 비교 종목 지우기`);
    }
    if (r.lastValue !== row.value) {
      r.lastValue = row.value;
      r.value.textContent = row.value;
    }
    const valueClass = `font-medium ${DIR_CLASS[row.dir]}`;
    if (r.lastValueClass !== valueClass) {
      r.lastValueClass = valueClass;
      r.value.className = valueClass;
    }
    const note = row.notes.join(" · ");
    if (r.lastNote !== note) {
      r.lastNote = note;
      r.note.textContent = note;
    }
    const noteHidden = row.notes.length === 0;
    if (r.lastNoteHidden !== noteHidden) {
      r.lastNoteHidden = noteHidden;
      r.note.hidden = noteHidden;
    }
    if (r.lastFailed !== row.failed) {
      r.lastFailed = row.failed;
      r.root.classList.toggle("opacity-60", row.failed);
    }
    const lastT = String(row.last?.t ?? "");
    if (r.lastT !== lastT) {
      r.lastT = lastT;
      r.root.dataset.lastT = lastT;
    }
    const lastClose = String(row.last?.c ?? "");
    if (r.lastClose !== lastClose) {
      r.lastClose = lastClose;
      r.root.dataset.lastClose = lastClose;
    }
  }

  dispose(): void {
    this.rows.clear();
    this.box.remove();
  }

  private build(code: string, interactive = true): RowEls {
    const root = el("div", `group pointer-events-auto ${ROW}`);
    root.dataset.compareRow = code;
    const swatch = el("span", "h-0.5 w-2.5 flex-none rounded-full");
    const name = el("span", "text-text-2");
    const value = el("span", "font-medium");
    const note = el("span", "rounded-[9px] border border-line px-1.5 text-xs text-text-3");
    const remove = el("button", `${BTN} opacity-0 group-hover:opacity-100 focus-visible:opacity-100`);
    remove.type = "button";
    remove.dataset.chartControl = "";
    remove.title = "지우기";
    remove.innerHTML = iconMarkup("close");
    if (interactive) remove.addEventListener("click", () => this.onRemove(code));
    root.append(swatch, name, value, note, remove);
    return {
      root, swatch, name, value, note, remove,
      lastColor: "", lastName: null, lastValue: "", lastValueClass: "font-medium",
      lastNote: "", lastNoteHidden: null, lastFailed: null, lastT: null, lastClose: null,
    };
  }
}
