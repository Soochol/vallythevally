import { type JumpQuery, jumpAsBarsPage, type SeriesKey } from "../api/bars";
import type { JumpBarsPage } from "../api/generated/JumpBarsPage";
import type { KstDate } from "../api/generated/KstDate";
import type { ApiRequestError } from "../api/http";
import type { MarketSocketLike } from "../api/socket";
import { BarFeed, type FeedListener, type FetchPage, type History } from "./barFeed";
import { isIntraday } from "./time";

export type FetchJump = (q: JumpQuery, signal: AbortSignal) => Promise<JumpBarsPage>;

export type JumpEntry = "entered" | "empty" | "failed" | "cancelled";

export interface JumpModeView {
  date: KstDate;
  entering: boolean;
  unadjustedDays: readonly KstDate[];
}

export interface JumpableListener extends FeedListener {
  jumpEntered(history: History): void;
  modeChanged(): void;
}

export function keepsJumpMode(prev: SeriesKey | null, next: SeriesKey): boolean {
  return prev !== null && prev.symbol === next.symbol && prev.venue === next.venue && isIntraday(prev.period) && isIntraday(next.period);
}

interface Mode {
  date: KstDate;
  feed: BarFeed;
  unadjusted: Set<KstDate>;
  loading: boolean;
}

interface Entering extends Mode {
  settle(entry: JumpEntry): void;
}

export class JumpableFeed {
  private readonly normal: BarFeed;
  private key: SeriesKey | null = null;
  private active: Mode | null = null;
  private entering: Entering | null = null;

  constructor(
    fetchPage: FetchPage,
    private readonly fetchJump: FetchJump,
    private readonly listener: JumpableListener,
    socket?: Pick<MarketSocketLike, "subscribe">,
  ) {
    this.normal = new BarFeed(fetchPage, listener, socket);
  }

  get mode(): JumpModeView | null {
    if (this.entering) {
      return { date: this.entering.date, entering: true, unadjustedDays: [...this.entering.unadjusted].sort() };
    }
    if (this.active) {
      return { date: this.active.date, entering: this.active.loading, unadjustedDays: [...this.active.unadjusted].sort() };
    }
    return null;
  }

  get activeDate(): KstDate | null {
    return this.active?.date ?? null;
  }

  open(key: SeriesKey): void {
    const prevKey = this.key;
    const hadEntering = this.entering !== null;
    const hadActive = this.active !== null;
    const keepDate = this.active && keepsJumpMode(prevKey, key) ? this.active.date : null;
    this.key = key;
    this.dropEntering("cancelled", false);
    if (keepDate !== null) {
      this.reopenMode(key, keepDate);
      return;
    }
    this.dropActive();
    this.normal.open(key);
    if (hadEntering || hadActive) this.listener.modeChanged();
  }

  reload(): void {
    if (this.active !== null) {
      this.active.unadjusted.clear();
      this.active.loading = true;
      this.listener.modeChanged();
      this.active.feed.reload();
      return;
    }
    this.normal.reload();
  }

  needOlder(): void {
    this.current.needOlder();
  }

  retryOlder(): void {
    this.current.retryOlder();
  }

  olderUntil(reached: (history: History) => boolean) {
    return this.current.olderUntil(reached);
  }

  enterMode(date: KstDate): Promise<JumpEntry> {
    const key = this.key;
    if (!key) return Promise.resolve("cancelled");
    this.dropEntering("cancelled");
    return new Promise<JumpEntry>((settle) => {
      const unadjusted = new Set<KstDate>();
      const feed: BarFeed = this.createJumpBarFeed(date, unadjusted, this.jumpListener(() => entering, () => (this.active?.feed === feed ? this.active : null)));
      const entering: Entering = { date, feed, unadjusted, loading: true, settle };
      this.entering = entering;
      this.listener.modeChanged();
      feed.open(key);
    });
  }

  endMode(): void {
    this.dropEntering("cancelled");
    if (!this.active || !this.key) return;
    this.dropActive();
    this.normal.open(this.key);
    this.listener.modeChanged();
  }

  dispose(): void {
    this.dropEntering("cancelled", false);
    this.dropActive();
    this.normal.dispose();
    this.key = null;
  }

  private get current(): BarFeed {
    return this.active?.feed ?? this.normal;
  }

  cancelEntering(): void {
    this.dropEntering("cancelled");
  }

  private createJumpBarFeed(date: KstDate, unadjusted: Set<KstDate>, listener: FeedListener): BarFeed {
    const fetchPage: FetchPage = (q, signal) =>
      this.fetchJump({ ...q, date }, signal).then((page) => {
        for (const day of page.unadjustedDays) unadjusted.add(day);
        return jumpAsBarsPage(page);
      });
    return new BarFeed(fetchPage, listener);
  }

  private reopenMode(key: SeriesKey, date: KstDate): void {
    this.dropActive();
    this.normal.dispose();
    const unadjusted = new Set<KstDate>();
    const feed: BarFeed = this.createJumpBarFeed(date, unadjusted, this.jumpListener(() => null, () => (this.active?.feed === feed ? this.active : null)));
    this.active = { date, feed, unadjusted, loading: true };
    this.listener.modeChanged();
    feed.open(key);
  }

  private dropEntering(entry: JumpEntry, notify = true): void {
    const entering = this.entering;
    if (!entering) return;
    this.entering = null;
    entering.feed.dispose();
    entering.settle(entry);
    if (notify) this.listener.modeChanged();
  }

  private dropActive(): void {
    this.active?.feed.dispose();
    this.active = null;
  }

  private jumpListener(entering: () => Entering | null, active: () => Mode | null): FeedListener {
    const pending = () => {
      const target = entering();
      return target !== null && this.entering === target ? target : null;
    };
    return {
      reset: (history) => {
        const waiting = pending();
        if (!waiting) {
          const current = active();
          if (!current) return;
          current.loading = false;
          this.listener.jumpEntered(history);
          this.listener.modeChanged();
          return;
        }
        if (history.bars.length === 0) return this.dropEntering("empty");
        this.entering = null;
        waiting.loading = false;
        const previous = this.active;
        this.active = waiting;
        previous?.feed.dispose();
        this.normal.dispose();
        this.listener.jumpEntered(history);
        this.listener.modeChanged();
        waiting.settle("entered");
      },
      failed: (error: ApiRequestError) => {
        if (pending()) return this.dropEntering("failed");
        const current = active();
        if (!current) return;
        current.loading = false;
        this.listener.failed(error);
        this.listener.modeChanged();
      },
      prepended: (history, added) => {
        if (!active()) return;
        this.listener.prepended(history, added);
        this.listener.modeChanged();
      },
      olderFailed: (error) => {
        if (active()) this.listener.olderFailed(error);
      },
      olderLoading: () => {
        if (active()) this.listener.olderLoading?.();
      },
      live: () => {},
      confirmed: () => {},
      subError: () => {},
    };
  }
}
