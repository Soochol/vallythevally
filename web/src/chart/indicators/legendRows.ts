import { indicatorErrorText, type IndicatorRow } from "./layer";

export type IndicatorCommand = "edit" | "toggle" | "remove" | "up" | "down";

const ROW =
  "group pointer-events-auto flex w-max max-w-full items-center gap-1.5 whitespace-nowrap rounded-s pr-1 text-s " +
  "bg-[color-mix(in_srgb,var(--chart-bg)_78%,transparent)]";
const BTN = "grid size-[18px] place-items-center rounded-s text-xs text-text-2 hover:bg-raised hover:text-text disabled:opacity-40";

interface RowEls {
  root: HTMLDivElement;
  swatch: HTMLSpanElement;
  name: HTMLSpanElement;
  values: HTMLSpanElement;
  badge: HTMLSpanElement;
  toggle: HTMLButtonElement;
  up: HTMLButtonElement | null;
  down: HTMLButtonElement | null;
  key: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}

/**
 * 범례의 지표 줄(frontend.md §2.3). 가격 패널 지표는 범례 아래에, 지표 패널 지표는 그 패널 왼쪽 위에 한 줄로 둔다.
 * 줄에 마우스나 초점이 오면 설정·숨기기·지우기(지표 패널은 위로·아래로도)가 보인다.
 */
export class IndicatorLegend {
  readonly priceBox = el("div", "flex flex-col gap-px");
  private readonly rows = new Map<string, RowEls>();

  constructor(
    private readonly overlay: HTMLElement,
    private readonly onCommand: (id: string, command: IndicatorCommand) => void,
  ) {}

  render(rows: IndicatorRow[], paneTops: readonly number[]): void {
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.id);
      const key = row.panel ? "panel" : "price";
      let r = this.rows.get(row.id);
      if (r && r.key !== key) {
        r.root.remove();
        r = undefined;
      }
      r ??= this.build(row.id, key);
      this.rows.set(row.id, r);
      this.fill(r, row);
      if (row.panel) {
        if (r.root.parentElement !== this.overlay) this.overlay.append(r.root);
        r.root.style.top = `${(paneTops[row.panel.index + 1] ?? 0) + 4}px`;
        r.up!.disabled = row.panel.index === 0;
        r.down!.disabled = row.panel.index === row.panel.count - 1;
      }
    }
    const price = rows.filter((row) => !row.panel).map((row) => this.rows.get(row.id)!.root);
    if (price.some((root, i) => this.priceBox.children[i] !== root) || this.priceBox.children.length !== price.length) {
      this.priceBox.replaceChildren(...price);
    }
    for (const [id, r] of this.rows) {
      if (seen.has(id)) continue;
      r.root.remove();
      this.rows.delete(id);
    }
  }

  dispose(): void {
    for (const r of this.rows.values()) r.root.remove();
    this.rows.clear();
    this.priceBox.remove();
  }

  private build(id: string, key: string): RowEls {
    const root = el("div", key === "panel" ? `${ROW} absolute left-2 z-[4]` : ROW);
    root.dataset.indicatorRow = id;
    const swatch = el("span", "h-0.5 w-2.5 flex-none rounded-full");
    const name = el("span", "text-text-2");
    const values = el("span", "flex gap-1.5 font-medium");
    const badge = el("span", "rounded-[9px] border border-line px-1.5 text-xs text-text-3");
    const tools = el("span", "flex gap-px opacity-0 group-hover:opacity-100 group-focus-within:opacity-100");
    const button = (text: string, label: string, command: IndicatorCommand) => {
      const b = el("button", BTN, text);
      b.type = "button";
      b.title = label;
      b.addEventListener("click", () => this.onCommand(id, command));
      tools.append(b);
      return b;
    };
    const up = key === "panel" ? button("↑", "패널 위로", "up") : null;
    const down = key === "panel" ? button("↓", "패널 아래로", "down") : null;
    button("⚙", "설정", "edit");
    const toggle = button("◉", "숨기기", "toggle");
    button("✕", key === "panel" ? "패널 닫기" : "지우기", "remove");
    root.append(swatch, name, values, badge, tools);
    return { root, swatch, name, values, badge, toggle, up, down, key };
  }

  private fill(r: RowEls, row: IndicatorRow): void {
    const dim = row.state !== "ok" && row.state !== "pending";
    r.root.classList.toggle("opacity-60", dim);
    r.swatch.style.background = row.color;
    r.name.textContent = row.name;
    r.values.replaceChildren(
      ...row.values.map((v) => {
        const s = el("span", "", v.text);
        s.style.color = v.color;
        return s;
      }),
    );
    const badge = row.state === "spec" || row.state === "calc" ? indicatorErrorText(row.state) : "";
    r.badge.textContent = badge;
    r.badge.hidden = badge === "";
    const hidden = row.state === "hidden";
    r.toggle.textContent = hidden ? "◎" : "◉";
    r.toggle.title = hidden ? "보이기" : "숨기기";
    r.root.querySelectorAll("button").forEach((b) => b.setAttribute("aria-label", `${row.name} ${b.title}`));
  }
}
