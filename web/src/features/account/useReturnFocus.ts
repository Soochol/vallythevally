import { useEffect, useRef } from "react";

export function useReturnFocus<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) ref.current?.focus();
    wasOpen.current = open;
  }, [open]);
  return ref;
}
