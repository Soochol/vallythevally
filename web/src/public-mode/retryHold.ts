const HELD_STATUSES: readonly number[] = [429, 503];

interface Held<E> {
  readonly untilMs: number;
  readonly error: E;
}

export class RetryHold<E extends { retryAt: number | null }> {
  private readonly held = new Map<string, Held<E>>();

  constructor(private readonly now: () => number) {}

  static keyOf(method: string, path: string): string {
    return `${method} ${path}`;
  }

  heldError(key: string): E | null {
    const entry = this.held.get(key);
    if (entry === undefined) return null;
    if (this.now() >= entry.untilMs) {
      this.held.delete(key);
      return null;
    }
    return entry.error;
  }

  note(key: string, status: number, error: E): void {
    if (!HELD_STATUSES.includes(status) || error.retryAt === null) return;
    this.held.set(key, { untilMs: error.retryAt * 1000, error });
  }
}
