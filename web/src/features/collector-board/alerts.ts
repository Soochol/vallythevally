import { useState } from "react";
import type { DaemonJudgment } from "../../api/generated/DaemonJudgment";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { useSelectionStore } from "../../stores/selection";
import { daemonAlertText } from "./labels";

export type NotificationAccess = NotificationPermission | "unsupported";

export const notificationAccess = (): NotificationAccess => (typeof Notification === "undefined" ? "unsupported" : Notification.permission);

function showBrowserNotification(text: string): void {
  if (notificationAccess() !== "granted") return;
  try {
    new Notification("수집 현황판", { body: text, tag: "collector-daemon" });
  } catch {
    return;
  }
}

export function receiveCollectorDaemon(judgment: DaemonJudgment, _at: UnixSeconds): void {
  const text = daemonAlertText(judgment);
  if (text === null) return;
  useSelectionStore.getState().showToast(text);
  showBrowserNotification(text);
}

export function useNotificationAccess(): { access: NotificationAccess; ask(): void } {
  const [access, setAccess] = useState<NotificationAccess>(notificationAccess);
  const ask = () => {
    if (access !== "default") return;
    void Notification.requestPermission().then(() => setAccess(notificationAccess()), () => setAccess(notificationAccess()));
  };
  return { access, ask };
}
