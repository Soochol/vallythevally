import { useState } from "react";

const COLOR_MORE_KEY = "vv.color-more.v1";

export function readColorMore(): boolean {
  try { return localStorage.getItem(COLOR_MORE_KEY) === "open"; } catch { return false; }
}

function writeColorMore(open: boolean): void {
  try { localStorage.setItem(COLOR_MORE_KEY, open ? "open" : "closed"); } catch {}
}

export interface ColorMore { open: boolean; toggle(): void }

export function useColorMore(): ColorMore {
  const [open, setOpen] = useState(readColorMore);
  return { open, toggle: () => { writeColorMore(!open); setOpen(!open); } };
}
