import type { KstDate } from "../api/generated/KstDate";

export interface JumpBadgeState {
  date: KstDate;
  receiving: boolean;
  unadjustedDays: readonly KstDate[];
  compareHidden: boolean;
}

export function jumpBadgeNotes(state: JumpBadgeState): string[] {
  return [
    ...(state.receiving ? ["받는 중"] : []),
    ...(state.compareHidden ? ["비교 숨김"] : []),
  ];
}

export const UNADJUSTED_NOTE = "일부 날짜 수정주가 미반영";

export class JumpBadge {
  private readonly root = document.createElement("div");
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
    this.date.className = "chart-jump-date";
    this.notes.className = "chart-jump-notes";
    this.warning.className = "chart-jump-warning";
    this.close.type = "button";
    this.close.className = "chart-jump-close";
    this.close.setAttribute("aria-label", "바로가기 끝내기");
    this.close.textContent = "×";
    this.close.addEventListener("click", onClose);
    this.root.append(this.date, this.notes, this.warning, this.close);
    parent.append(this.root);
  }

  show(state: JumpBadgeState | null): void {
    this.root.hidden = state === null;
    if (!state) return;
    this.date.textContent = `바로가기 · ${state.date}`;
    const notes = jumpBadgeNotes(state);
    this.notes.textContent = notes.map((note) => ` · ${note}`).join("");
    const unadjusted = state.unadjustedDays.length > 0;
    this.warning.textContent = unadjusted ? ` · ${UNADJUSTED_NOTE}` : "";
    this.warning.title = unadjusted ? `수정주가를 반영하지 못한 날짜: ${state.unadjustedDays.join(", ")}` : "";
  }

  setBottom(axisHeight: number): void {
    this.root.style.bottom = `calc(${axisHeight}px + var(--size-8))`;
  }

  dispose(): void {
    this.root.remove();
  }
}
