export interface QuoteSubscribable {
  subscribe(code: string, listener: () => void): () => void;
}

export function subscribeBatched(book: QuoteSubscribable, codes: readonly string[], listener: () => void): () => void {
  let scheduled = false;
  let stopped = false;
  const onChange = (): void => {
    if (stopped || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!stopped) listener();
    });
  };
  const unsubscribes: (() => void)[] = [];
  for (const code of new Set(codes)) unsubscribes.push(book.subscribe(code, onChange));
  return () => {
    if (stopped) return;
    stopped = true;
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
