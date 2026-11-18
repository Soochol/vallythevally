import { useDrawingSave } from "../../chart/drawings/sync";
import { saveAllAndWait } from "../../persist/autosave";
import type { SaveState } from "../../persist/saver";

export const SAVE_WAIT_MS = 10_000;

function drawingsSettled(): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const look = (state: SaveState): boolean => {
      if (state.kind === "pending" || state.kind === "saving") return false;
      unsubscribe();
      if (state.kind === "failed") reject(new Error("드로잉을 저장하지 못했습니다"));
      else resolve();
      return true;
    };
    if (look(useDrawingSave.getState().state)) return;
    unsubscribe = useDrawingSave.subscribe((s) => look(s.state));
  });
}

export async function saveBeforeReload(timeoutMs = SAVE_WAIT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("저장이 끝나지 않았습니다")), timeoutMs);
  });
  try {
    await Promise.race([Promise.all([saveAllAndWait(), drawingsSettled()]), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
