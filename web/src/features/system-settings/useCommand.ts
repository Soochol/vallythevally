import { useCallback, useRef, useState } from "react";

export interface Command {
  busy: boolean;
  error: string | null;
  run(action: () => Promise<void>): Promise<boolean>;
}

export function useCommand(): Command {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const run = useCallback(async (action: () => Promise<void>) => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "요청을 처리하지 못했습니다");
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}
