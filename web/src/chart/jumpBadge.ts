import type { KstDate } from "../api/generated/KstDate";

export interface JumpBadgeState {
  date: KstDate;
  receiving: boolean;
  unadjustedDays: readonly KstDate[];
  compareHidden: boolean;
}

export function jumpBadgeNotes(state: JumpBadgeState): string[] {
  return [
    "실시간 멈춤",
    ...(state.receiving ? ["받는 중"] : []),
    ...(state.compareHidden ? ["비교 숨김"] : []),
  ];
}

export const UNADJUSTED_NOTE = "일부 날짜 수정주가 미반영";

export interface JumpBadgeBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export class JumpBadge {
  private readonly root = document.createElement("div");
  private readonly dot = document.createElement("span");
  private readonly text = document.createElement("span");
  private readonly date = document.createElement("span");
  private readonly notes = document.createElement("span");
  private readonly warning = document.createElement("span");
  private readonly close = document.createElement("button");

  constructor(parent: HTMLElement, onClose: () => void) {
    this.root.className = "chart-jump";
    this.root.hidden = true;
    this.root.setAttribute("data-chart-control", "");
    this.root.setAttribute("role", "group");
    this.root.setAttribute("aria-label", "바로가기 모드");
    this.dot.className = "chart-jump-dot";
    this.dot.setAttribute("aria-hidden", "true");
    this.text.className = "chart-jump-text";
    this.date.className = "chart-jump-date";
    this.notes.className = "chart-jump-notes";
    this.warning.className = "chart-jump-warning";
    this.text.append(this.date, this.notes, this.warning);
    this.close.type = "button";
    this.close.className = "chart-jump-close";
    this.close.setAttribute("aria-label", "바로가기 끝내기");
    this.close.title = "실시간으로 돌아가기";
    this.close.textContent = "×";
    this.close.addEventListener("click", onClose);
    this.root.append(this.dot, this.text, this.close);
    parent.append(this.root);
  }

  show(state: JumpBadgeState | null): void {
    this.root.hidden = state === null;
    if (!state) return;
    this.date.textContent = `과거 보기 ${state.date}`;
    const notes = jumpBadgeNotes(state);
    this.notes.textContent = notes.map((note) => ` · ${note}`).join("");
    const unadjusted = state.unadjustedDays.length > 0;
    this.warning.textContent = unadjusted ? ` · ${UNADJUSTED_NOTE}` : "";
    this.warning.title = unadjusted ? `수정주가를 반영하지 못한 날짜: ${state.unadjustedDays.join(", ")}` : "";
  }

  box(relativeTo: HTMLElement): JumpBadgeBox | null {
    if (this.root.hidden) return null;
    const rect = this.root.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const base = relativeTo.getBoundingClientRect();
    return {
      left: rect.left - base.left,
      top: rect.top - base.top,
      right: rect.right - base.left,
      bottom: rect.bottom - base.top,
    };
  }

  dispose(): void {
    this.root.remove();
  }
}
