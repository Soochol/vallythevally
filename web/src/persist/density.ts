export type Density = "regular" | "compact";

export const DENSITY_STORAGE_KEY = "vally.density";

export const DEFAULT_DENSITY: Density = "compact";

export const DENSITY_OPTIONS = [
  { value: "regular", label: "기본" },
  { value: "compact", label: "촘촘" },
] as const satisfies readonly { value: Density; label: string }[];

export const parseDensity = (raw: unknown): Density => (raw === "regular" || raw === "compact" ? raw : DEFAULT_DENSITY);

type DensityStorage = Pick<Storage, "getItem" | "setItem">;

const browserStorage = (): DensityStorage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function readDensity(storage: () => DensityStorage | null = browserStorage): Density {
  try {
    return parseDensity(storage()?.getItem(DENSITY_STORAGE_KEY));
  } catch {
    return DEFAULT_DENSITY;
  }
}

export function writeDensity(density: Density, storage: () => DensityStorage | null = browserStorage): void {
  try {
    storage()?.setItem(DENSITY_STORAGE_KEY, density);
  } catch {
    return;
  }
}

const densityListeners = new Set<() => void>();

export function subscribeDensity(listener: () => void): () => void {
  densityListeners.add(listener);
  return () => void densityListeners.delete(listener);
}

export const appliedDensity = (root: HTMLElement = document.documentElement): Density => parseDensity(root.dataset.density);

export function applyDensity(density: Density, root: HTMLElement = document.documentElement): void {
  root.dataset.density = density;
  densityListeners.forEach((listener) => listener());
}

const densityFromStorageEvent = (event: StorageEvent): Density | null =>
  event.key === null ? DEFAULT_DENSITY : event.key === DENSITY_STORAGE_KEY ? parseDensity(event.newValue) : null;

let followingOtherTabs = false;

function followDensityOfOtherTabs(): void {
  if (followingOtherTabs || typeof window === "undefined") return;
  followingOtherTabs = true;
  window.addEventListener("storage", (event) => {
    const density = densityFromStorageEvent(event);
    if (density !== null) applyDensity(density);
  });
}

export function chooseDensity(density: Density): void {
  applyDensity(density);
  writeDensity(density);
}

export function applyStoredDensity(): Density {
  const density = readDensity();
  applyDensity(density);
  followDensityOfOtherTabs();
  return density;
}
