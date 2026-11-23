import type { Page } from "@playwright/test";

interface ProbeWindow {
  __probe: {
    watched: Record<string, string>;
    counts: Record<string, number>;
    held: boolean;
    queue: { id: number; callback: FrameRequestCallback }[];
    messages: number;
    step(): number;
  };
}

function installProbe(): void {
  const probe: ProbeWindow["__probe"] = {
    watched: {},
    counts: {},
    held: false,
    queue: [],
    messages: 0,
    step() {
      const batch = probe.queue.splice(0);
      batch.forEach(({ callback }) => callback(performance.now()));
      return batch.length;
    },
  };
  (window as unknown as ProbeWindow).__probe = probe;

  const nativeFrame = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  let nextId = 1_000_000_000;
  window.requestAnimationFrame = (callback) => {
    if (!probe.held) return nativeFrame(callback);
    const id = nextId++;
    probe.queue.push({ id, callback });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    const at = probe.queue.findIndex((entry) => entry.id === id);
    if (at >= 0) probe.queue.splice(at, 1);
    else nativeCancel(id);
  };

  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      this.addEventListener("message", () => { probe.messages += 1; });
    }
  };

  const HOST_COMPONENT = 5;
  const count = (fiber: { stateNode: unknown }): void => {
    const element = fiber.stateNode;
    if (!(element instanceof Element)) return;
    for (const [name, selector] of Object.entries(probe.watched)) if (element.matches(selector)) probe.counts[name] = (probe.counts[name] ?? 0) + 1;
  };
  type Fiber = { tag: number; stateNode: unknown; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null; memoizedProps: unknown };
  const walk = (next: Fiber, previous: Fiber | null): void => {
    if (next.tag === HOST_COMPONENT && (previous === null || previous.memoizedProps !== next.memoizedProps)) count(next);
    if (next.child !== (previous?.child ?? null)) for (let child = next.child; child !== null; child = child.sibling) walk(child, child.alternate);
  };
  const renderers = new Map<number, unknown>();
  (window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers,
    inject(renderer: unknown) {
      const id = renderers.size + 1;
      renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      if (Object.keys(probe.watched).length > 0) walk(root.current, root.current.alternate);
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
}

export class RenderProbe {
  constructor(private readonly page: Page) {}

  static async install(page: Page): Promise<RenderProbe> {
    await page.addInitScript(installProbe);
    return new RenderProbe(page);
  }

  async watch(selectors: Record<string, string>): Promise<void> {
    await this.page.evaluate((watched) => {
      const probe = (window as unknown as ProbeWindow).__probe;
      Object.assign(probe.watched, watched);
      for (const name of Object.keys(watched)) probe.counts[name] = 0;
    }, selectors);
  }

  async reset(): Promise<void> {
    await this.page.evaluate(() => {
      const probe = (window as unknown as ProbeWindow).__probe;
      for (const name of Object.keys(probe.counts)) probe.counts[name] = 0;
    });
  }

  counts(): Promise<Record<string, number>> {
    return this.page.evaluate(() => ({ ...(window as unknown as ProbeWindow).__probe.counts }));
  }

  messages(): Promise<number> {
    return this.page.evaluate(() => (window as unknown as ProbeWindow).__probe.messages);
  }

  async holdFrames(): Promise<void> {
    await this.page.evaluate(() => { (window as unknown as ProbeWindow).__probe.held = true; });
  }

  async stepFrame(): Promise<void> {
    await this.page.evaluate(() => { (window as unknown as ProbeWindow).__probe.step(); });
  }

  async releaseFrames(): Promise<void> {
    await this.page.evaluate(() => {
      const probe = (window as unknown as ProbeWindow).__probe;
      probe.held = false;
      probe.step();
    });
  }
}
