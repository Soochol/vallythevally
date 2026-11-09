import type { SaveTarget } from "../stores/persist";
import type { Unsaved } from "./saver";

// 서버가 받았다고 확인하지 않은 최신 본문(R2). 시세가 아닌 화면 설정이라 ADR 0003과 부딪히지 않는다(테마 사본도 여기 둔다).
const key = (target: SaveTarget) => `vv.unsaved.${target}`;

function isUnsaved(x: unknown): x is Unsaved {
  if (typeof x !== "object" || x === null) return false;
  const u = x as Record<string, unknown>;
  return typeof u.path === "string" && typeof u.body === "string" && typeof u.revision === "number" && Number.isSafeInteger(u.revision);
}

/** 저장소를 못 쓰거나(사생활 모드, 용량) 모양이 틀리면 없는 것으로 본다. 그때는 탭이 살아 있는 동안의 저장만 지킨다. */
export function readUnsaved(target: SaveTarget): Unsaved | null {
  try {
    const raw = localStorage.getItem(key(target));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isUnsaved(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeUnsaved(target: SaveTarget, u: Unsaved) {
  try {
    localStorage.setItem(key(target), JSON.stringify(u));
  } catch {
  }
}

export function clearUnsaved(target: SaveTarget, upTo: number) {
  const u = readUnsaved(target);
  if (u === null || u.revision > upTo) return;
  try {
    localStorage.removeItem(key(target));
  } catch {
  }
}

export function unsavedValue(u: Unsaved): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(u.body);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    const { revision: _, ...rest } = v as Record<string, unknown>;
    return rest;
  } catch {
    return null;
  }
}
