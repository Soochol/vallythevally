import { useSelectionStore } from "../../stores/selection";
import { controllerFor } from "../grid/controllers";
import type { WindowId } from "../../layout/kinds";

export type SnapshotMode = "download" | "copy";

/** 브라우저는 보안 문맥(https, localhost)에서만 `navigator.clipboard`를 준다. */
export const canCopyImage = (): boolean => typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";

const toast = (text: string) => useSelectionStore.getState().showToast(text);

/** 브라우저는 사용자 조작 직후에만 클립보드 쓰기를 허락한다. 그래서 `clipboard.write`를 기다리지 않고 바로 부르고 PNG는 Promise로 넘긴다. */
export function saveSnapshot(cellId: WindowId, mode: SnapshotMode): void {
  const shot = controllerFor(cellId)?.snapshot(Math.floor(Date.now() / 1000));
  if (!shot) return;
  const png = new Promise<Blob>((resolve, reject) =>
    shot.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/png"),
  );
  if (mode === "copy") {
    if (!canCopyImage()) return toast("이 브라우저에서는 이미지를 복사할 수 없습니다. 내려받기를 쓰세요");
    navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(
      () => toast("차트 이미지를 클립보드에 복사했습니다"),
      () => toast("차트 이미지를 복사하지 못했습니다"),
    );
    return;
  }
  png.then(
    (blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = shot.fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
    () => toast("차트 이미지를 만들지 못했습니다"),
  );
}
