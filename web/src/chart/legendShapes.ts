export function valueShape(text: string): string {
  return text.replace(/\d/g, "0");
}

export function shapeSetOf(values: readonly string[]): Set<string> {
  const shapes = new Set<string>();
  for (const value of values) shapes.add(valueShape(value));
  return shapes;
}

export function sameShapeSet(first: ReadonlySet<string>, second: ReadonlySet<string>): boolean {
  if (first.size !== second.size) return false;
  for (const shape of first) if (!second.has(shape)) return false;
  return true;
}

export class ShapeMultiset {
  private readonly counts = new Map<string, number>();

  add(text: string): boolean {
    return this.addShape(valueShape(text));
  }

  remove(text: string): boolean {
    return this.removeShape(valueShape(text));
  }

  replace(previous: string, next: string): boolean {
    const previousShape = valueShape(previous);
    const nextShape = valueShape(next);
    if (previousShape === nextShape) return false;
    const removed = this.removeShape(previousShape);
    const added = this.addShape(nextShape);
    return removed || added;
  }

  clear(): void {
    this.counts.clear();
  }

  has(shape: string): boolean {
    return this.counts.has(shape);
  }

  get size(): number {
    return this.counts.size;
  }

  private addShape(shape: string): boolean {
    const count = this.counts.get(shape) ?? 0;
    this.counts.set(shape, count + 1);
    return count === 0;
  }

  private removeShape(shape: string): boolean {
    const count = this.counts.get(shape) ?? 0;
    if (count === 0) return false;
    if (count === 1) {
      this.counts.delete(shape);
      return true;
    }
    this.counts.set(shape, count - 1);
    return false;
  }
}

const trackedByValues = new WeakMap<readonly string[], TrackedValues>();

export function trackedValuesOf(values: readonly string[]): TrackedValues | null {
  return trackedByValues.get(values) ?? null;
}

export class TrackedValues {
  readonly values: string[] = [];
  private readonly shapes = new ShapeMultiset();
  private version = 0;

  constructor() {
    trackedByValues.set(this.values, this);
  }

  get shapeVersion(): number {
    return this.version;
  }

  setAll(values: readonly string[]): void {
    this.values.length = 0;
    this.shapes.clear();
    for (const value of values) {
      this.values.push(value);
      this.shapes.add(value);
    }
    this.version++;
  }

  push(value: string): boolean {
    this.values.push(value);
    const changed = this.shapes.add(value);
    if (changed) this.version++;
    return changed;
  }

  pushBeforeLast(value: string): boolean {
    if (this.values.length === 0) return this.push(value);
    const last = this.values[this.values.length - 1]!;
    this.values[this.values.length - 1] = value;
    this.values.push(last);
    const changed = this.shapes.add(value);
    if (changed) this.version++;
    return changed;
  }

  setAt(index: number, value: string): boolean {
    if (index === this.values.length) return this.push(value);
    const previous = this.values[index]!;
    if (previous === value) return false;
    this.values[index] = value;
    const changed = this.shapes.replace(previous, value);
    if (changed) this.version++;
    return changed;
  }

  truncate(length: number): boolean {
    let changed = false;
    while (this.values.length > length) {
      const removed = this.values.pop()!;
      if (this.shapes.remove(removed)) changed = true;
    }
    if (changed) this.version++;
    return changed;
  }

  clear(): boolean {
    if (this.values.length === 0) return false;
    this.values.length = 0;
    this.shapes.clear();
    this.version++;
    return true;
  }
}

export class OptionalTrackedValues {
  private readonly perIndex: string[] = [];
  private readonly textCounts = new Map<string, number>();
  private readonly shapes = new ShapeMultiset();
  readonly values: string[] = [];

  setAt(index: number, value: string): boolean {
    if (index === this.perIndex.length) {
      this.perIndex.push(value);
      return value === "" ? false : this.addValue(value);
    }
    const previous = this.perIndex[index]!;
    if (previous === value) return false;
    this.perIndex[index] = value;
    let changed = false;
    if (previous !== "" && this.removeValue(previous)) changed = true;
    if (value !== "" && this.addValue(value)) changed = true;
    return changed;
  }

  truncate(length: number): boolean {
    let changed = false;
    while (this.perIndex.length > length) {
      const removed = this.perIndex.pop()!;
      if (removed !== "" && this.removeValue(removed)) changed = true;
    }
    return changed;
  }

  private addValue(value: string): boolean {
    const count = this.textCounts.get(value) ?? 0;
    this.textCounts.set(value, count + 1);
    if (count === 0) this.values.push(value);
    return this.shapes.add(value);
  }

  private removeValue(value: string): boolean {
    const count = this.textCounts.get(value) ?? 0;
    if (count <= 1) {
      if (count === 0) return false;
      this.textCounts.delete(value);
      const pos = this.values.indexOf(value);
      if (pos >= 0) this.values.splice(pos, 1);
    } else {
      this.textCounts.set(value, count - 1);
    }
    return this.shapes.remove(value);
  }
}

export interface SlotSignature {
  readonly tracked: TrackedValues | null;
  readonly version: number;
  readonly shapes: ReadonlySet<string> | null;
}

export function slotSignature(values: readonly string[]): SlotSignature {
  const tracked = trackedValuesOf(values);
  if (tracked) return { tracked, version: tracked.shapeVersion, shapes: null };
  return { tracked: null, version: -1, shapes: shapeSetOf(values) };
}

export function sameSlotSignature(first: SlotSignature, second: SlotSignature): boolean {
  if (second.tracked !== null) return first.tracked === second.tracked && first.version === second.version;
  return first.tracked === null && first.shapes !== null && second.shapes !== null && sameShapeSet(first.shapes, second.shapes);
}
