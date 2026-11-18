import { type JumpQuery, jumpAsBarsPage, type SeriesKey } from "../api/bars";
import type { JumpBarsPage } from "../api/generated/JumpBarsPage";
import type { KstDate } from "../api/generated/KstDate";
import type { ApiRequestError } from "../api/http";
import type { MarketSocketLike } from "../api/socket";
import { BarFeed, type FeedListener, type FetchPage, type History } from "./barFeed";

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

interface Mode {
  date: KstDate;
  feed: BarFeed;
  unadjusted: Set<KstDate>;
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
    const shown = this.entering ?? this.active;
    return shown ? { date: shown.date, entering: this.entering !== null, unadjustedDays: [...(this.active?.unadjusted ?? shown.unadjusted)].sort() } : null;
  }

  get activeDate(): KstDate | null {
    return this.active?.date ?? null;
  }

  open(key: SeriesKey): void {
    const hadMode = this.active !== null;
    this.key = key;
    this.dropEntering("cancelled");
    this.dropActive();
    this.normal.open(key);
    if (hadMode) this.listener.modeChanged();
  }

  reload(): void {
    this.current.reload();
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
      const fetchPage: FetchPage = (q, signal) =>
        this.fetchJump({ ...q, date }, signal).then((page) => {
          for (const day of page.unadjustedDays) unadjusted.add(day);
          return jumpAsBarsPage(page);
        });
      const feed: BarFeed = new BarFeed(fetchPage, this.jumpListener(() => entering, () => this.active?.feed === feed ? this.active : null));
      const entering: Entering = { date, feed, unadjusted, settle };
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

  private jumpListener(entering: () => Entering, active: () => Mode | null): FeedListener {
    const pending = () => (this.entering === entering() ? this.entering : null);
    return {
      reset: (history) => {
        const waiting = pending();
        if (!waiting) {
          if (active()) this.listener.reset(history);
          return;
        }
        if (history.bars.length === 0) return this.dropEntering("empty");
        this.entering = null;
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
        if (active()) this.listener.failed(error);
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
