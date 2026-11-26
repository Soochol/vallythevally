const MAGIC = [0x48, 0x4f, 0x47, 0x41] as const;
const SUPPORTED_VERSION = 1;
const HEADER_FIXED_BYTES = 15;
const MS_PER_MINUTE = 60_000;

export const EVENT_KIND_BOOK = 1;
export const EVENT_KIND_TRADE = 2;
export const EVENT_KIND_PROGRAM = 3;

export type HogaStreamName = "book" | "trades" | "program" | "broker" | "gaps";

interface StreamSpec {
  readonly code: number;
  readonly name: HogaStreamName;
  readonly columns: readonly string[];
  readonly deltaColumns: "all" | readonly string[];
}

const numbered = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

const STREAM_SPECS: Readonly<Record<number, StreamSpec>> = {
  1: {
    code: 1,
    name: "book",
    columns: [
      "recv_ms",
      "t_s",
      ...numbered("ask_px", 10),
      ...numbered("bid_px", 10),
      ...numbered("ask_qty", 10),
      ...numbered("bid_qty", 10),
      "ask_total",
      "bid_total",
    ],
    deltaColumns: "all",
  },
  2: {
    code: 2,
    name: "trades",
    columns: ["recv_ms", "t_s", "price", "qty", "venue"],
    deltaColumns: ["recv_ms", "t_s", "price"],
  },
  3: {
    code: 3,
    name: "program",
    columns: ["recv_ms", "t_s", "sell_qty", "sell_amt", "buy_qty", "buy_amt"],
    deltaColumns: "all",
  },
  4: {
    code: 4,
    name: "broker",
    columns: [
      "recv_ms",
      ...numbered("sell_code", 5),
      ...numbered("buy_code", 5),
      ...numbered("sell_qty", 5),
      ...numbered("buy_qty", 5),
    ],
    deltaColumns: ["recv_ms"],
  },
  5: {
    code: 5,
    name: "gaps",
    columns: ["from_ms", "to_ms"],
    deltaColumns: [],
  },
};

const SPEC_BY_NAME: Readonly<Record<HogaStreamName, StreamSpec>> = {
  book: STREAM_SPECS[1]!,
  trades: STREAM_SPECS[2]!,
  program: STREAM_SPECS[3]!,
  broker: STREAM_SPECS[4]!,
  gaps: STREAM_SPECS[5]!,
};

function isDeltaColumn(spec: StreamSpec, name: string): boolean {
  return spec.deltaColumns === "all" || spec.deltaColumns.includes(name);
}

function expectedDeltaFlags(spec: StreamSpec): Uint8Array {
  const flags = new Uint8Array(Math.ceil(spec.columns.length / 8));
  spec.columns.forEach((name, index) => {
    if (isDeltaColumn(spec, name)) flags[index >> 3] = (flags[index >> 3] ?? 0) | (1 << (index & 7));
  });
  return flags;
}

export interface HogaColumnLayout {
  readonly name: string;
  readonly offset: number;
}

export interface HogaStreamLayout {
  readonly kind: HogaStreamName;
  readonly rows: number;
  readonly columns: readonly HogaColumnLayout[];
}

export interface DecodedSpanPayload {
  readonly date: number;
  readonly startMinute: number;
  readonly lengthMinutes: number;
  readonly symbol: string;
  readonly streams: readonly HogaStreamLayout[];
  readonly buffer: ArrayBuffer;
  readonly eventRecvMs: ArrayBuffer;
  readonly eventKind: ArrayBuffer;
  readonly eventRow: ArrayBuffer;
}

export interface OpenedHogaStream {
  readonly rows: number;
  readonly columns: Readonly<Record<string, Int32Array>>;
}

export interface OpenedHogaSpan {
  readonly date: number;
  readonly startMinute: number;
  readonly lengthMinutes: number;
  readonly symbol: string;
  readonly streams: Partial<Record<HogaStreamName, OpenedHogaStream>>;
  readonly eventRecvMs: Int32Array;
  readonly eventKind: Uint8Array;
  readonly eventRow: Int32Array;
}

export function lastRowAtOrBefore(sortedValues: Int32Array, target: number): number {
  let lo = 0;
  let hi = sortedValues.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedValues[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export function firstRowAtOrAfter(sortedValues: Int32Array, target: number): number {
  let lo = 0;
  let hi = sortedValues.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedValues[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildMergedEventIndex(
  startMs: number,
  bookRecv: Int32Array | null,
  tradeRecv: Int32Array | null,
  programRecv: Int32Array | null,
): { eventRecvMs: Int32Array; eventKind: Uint8Array; eventRow: Int32Array } {
  let bIdx = bookRecv ? firstRowAtOrAfter(bookRecv, startMs) : 0;
  const bLen = bookRecv ? bookRecv.length : 0;
  let tIdx = tradeRecv ? firstRowAtOrAfter(tradeRecv, startMs) : 0;
  const tLen = tradeRecv ? tradeRecv.length : 0;
  let pIdx = programRecv ? firstRowAtOrAfter(programRecv, startMs) : 0;
  const pLen = programRecv ? programRecv.length : 0;

  const total = (bLen - bIdx) + (tLen - tIdx) + (pLen - pIdx);
  const eventRecvMs = new Int32Array(total);
  const eventKind = new Uint8Array(total);
  const eventRow = new Int32Array(total);

  let out = 0;
  const INF = 0x7fffffff;
  while (out < total) {
    const bv = bIdx < bLen ? bookRecv![bIdx]! : INF;
    const tv = tIdx < tLen ? tradeRecv![tIdx]! : INF;
    const pv = pIdx < pLen ? programRecv![pIdx]! : INF;
    if (bv <= tv && bv <= pv) {
      eventRecvMs[out] = bv;
      eventKind[out] = EVENT_KIND_BOOK;
      eventRow[out] = bIdx++;
    } else if (tv <= pv) {
      eventRecvMs[out] = tv;
      eventKind[out] = EVENT_KIND_TRADE;
      eventRow[out] = tIdx++;
    } else {
      eventRecvMs[out] = pv;
      eventKind[out] = EVENT_KIND_PROGRAM;
      eventRow[out] = pIdx++;
    }
    out += 1;
  }
  return { eventRecvMs, eventKind, eventRow };
}

export function decodeHogaSpan(buffer: ArrayBuffer): DecodedSpanPayload {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let position = 0;
  const need = (count: number, label: string) => {
    if (position + count > bytes.length) throw new Error(`HOGA 파일이 잘렸습니다: ${label}`);
  };

  need(HEADER_FIXED_BYTES, "header");
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error("HOGA 매직 바이트가 일치하지 않습니다");
  }
  const version = view.getUint16(4, true);
  if (version !== SUPPORTED_VERSION) throw new Error(`지원하지 않는 HOGA 버전입니다: ${version}`);
  const date = view.getUint32(6, true);
  const startMinute = view.getUint16(10, true);
  const lengthMinutes = view.getUint16(12, true);
  const symbolLength = view.getUint8(14);
  position = HEADER_FIXED_BYTES;
  need(symbolLength + 1, "symbol");
  let symbol = "";
  for (let i = 0; i < symbolLength; i++) {
    const byte = bytes[position + i]!;
    if (byte >= 0x80) throw new Error("종목 코드가 ASCII가 아닙니다");
    symbol += String.fromCharCode(byte);
  }
  position += symbolLength;
  const streamCount = view.getUint8(position++);

  const entries: { spec: StreamSpec; rows: number; bodyBytes: number }[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < streamCount; i++) {
    need(10, "stream-entry");
    const kind = view.getUint8(position);
    const columnCount = view.getUint8(position + 1);
    const rows = view.getUint32(position + 2, true);
    const bodyBytes = view.getUint32(position + 6, true);
    position += 10;
    const spec = STREAM_SPECS[kind];
    if (!spec) throw new Error(`알 수 없는 스트림 종류입니다: ${kind}`);
    if (seen.has(kind)) throw new Error(`중복 스트림입니다: ${spec.name}`);
    seen.add(kind);
    if (columnCount !== spec.columns.length) throw new Error(`${spec.name} 열 개수가 일치하지 않습니다`);
    if (bodyBytes !== rows * columnCount * 4) throw new Error(`${spec.name} 본문 길이가 일치하지 않습니다`);
    const flagBytes = Math.ceil(columnCount / 8);
    need(flagBytes, "delta-flags");
    const expected = expectedDeltaFlags(spec);
    for (let f = 0; f < flagBytes; f++) {
      if (bytes[position + f] !== expected[f]) throw new Error(`${spec.name} 차분 플래그가 일치하지 않습니다`);
    }
    position += flagBytes;
    entries.push({ spec, rows, bodyBytes });
  }

  const padding = (4 - (position % 4)) % 4;
  need(padding, "padding");
  for (let i = 0; i < padding; i++) {
    if (bytes[position + i] !== 0) throw new Error("채움 바이트가 0이 아닙니다");
  }
  position += padding;

  const bodyTotal = entries.reduce((sum, entry) => sum + entry.bodyBytes, 0);
  if (position + bodyTotal !== bytes.length) throw new Error("HOGA 본문 길이가 파일 크기와 다릅니다");

  const streams: HogaStreamLayout[] = [];
  let bookRecv: Int32Array | null = null;
  let tradeRecv: Int32Array | null = null;
  let programRecv: Int32Array | null = null;

  for (const { spec, rows } of entries) {
    const columns: HogaColumnLayout[] = [];
    for (const name of spec.columns) {
      const colOffset = position;
      if (rows > 0) {
        const values = new Int32Array(buffer, colOffset, rows);
        if (isDeltaColumn(spec, name)) {
          for (let row = 1; row < rows; row++) {
            values[row] = (values[row - 1]! + values[row]!) | 0;
          }
        }
        if (name === "recv_ms") {
          if (spec.name === "book") bookRecv = values;
          else if (spec.name === "trades") tradeRecv = values;
          else if (spec.name === "program") programRecv = values;
        }
      }
      columns.push({ name, offset: colOffset });
      position += rows * 4;
    }
    streams.push({ kind: spec.name, rows, columns });
  }

  const merged = buildMergedEventIndex(startMinute * MS_PER_MINUTE, bookRecv, tradeRecv, programRecv);
  return {
    date,
    startMinute,
    lengthMinutes,
    symbol,
    streams,
    buffer,
    eventRecvMs: merged.eventRecvMs.buffer as ArrayBuffer,
    eventKind: merged.eventKind.buffer as ArrayBuffer,
    eventRow: merged.eventRow.buffer as ArrayBuffer,
  };
}

export function openHogaSpan(payload: DecodedSpanPayload): OpenedHogaSpan {
  const streams: Partial<Record<HogaStreamName, OpenedHogaStream>> = {};
  for (const stream of payload.streams) {
    const columns: Record<string, Int32Array> = {};
    for (const col of stream.columns) {
      columns[col.name] = new Int32Array(payload.buffer, col.offset, stream.rows);
    }
    streams[stream.kind] = { rows: stream.rows, columns };
  }
  return {
    date: payload.date,
    startMinute: payload.startMinute,
    lengthMinutes: payload.lengthMinutes,
    symbol: payload.symbol,
    streams,
    eventRecvMs: new Int32Array(payload.eventRecvMs),
    eventKind: new Uint8Array(payload.eventKind),
    eventRow: new Int32Array(payload.eventRow),
  };
}

export interface EncodeSpanStreamInput {
  readonly kind: HogaStreamName;
  readonly columns: Readonly<Record<string, readonly number[]>>;
}

export function encodeHogaSpan(input: {
  readonly date: number;
  readonly startMinute: number;
  readonly lengthMinutes: number;
  readonly symbol: string;
  readonly streams: readonly EncodeSpanStreamInput[];
}): ArrayBuffer {
  const prepared = input.streams.map((stream) => {
    const spec = SPEC_BY_NAME[stream.kind];
    const firstCol = stream.columns[spec.columns[0]!] ?? [];
    const rows = firstCol.length;
    const flags = expectedDeltaFlags(spec);
    const bodyBytes = rows * spec.columns.length * 4;
    return { spec, rows, flags, bodyBytes, columns: stream.columns };
  });

  let headerSize = HEADER_FIXED_BYTES + input.symbol.length + 1;
  for (const item of prepared) {
    headerSize += 10 + item.flags.length;
  }
  const padding = (4 - (headerSize % 4)) % 4;
  headerSize += padding;
  const totalBytes = headerSize + prepared.reduce((sum, item) => sum + item.bodyBytes, 0);

  const buffer = new ArrayBuffer(totalBytes);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  for (let i = 0; i < 4; i++) bytes[i] = MAGIC[i]!;
  view.setUint16(4, SUPPORTED_VERSION, true);
  view.setUint32(6, input.date, true);
  view.setUint16(10, input.startMinute, true);
  view.setUint16(12, input.lengthMinutes, true);
  view.setUint8(14, input.symbol.length);
  let pos = HEADER_FIXED_BYTES;
  for (let i = 0; i < input.symbol.length; i++) {
    bytes[pos++] = input.symbol.charCodeAt(i);
  }
  view.setUint8(pos++, prepared.length);
  for (const item of prepared) {
    view.setUint8(pos, item.spec.code);
    view.setUint8(pos + 1, item.spec.columns.length);
    view.setUint32(pos + 2, item.rows, true);
    view.setUint32(pos + 6, item.bodyBytes, true);
    pos += 10;
    bytes.set(item.flags, pos);
    pos += item.flags.length;
  }
  pos += padding;

  for (const item of prepared) {
    for (const colName of item.spec.columns) {
      const vals = item.columns[colName] ?? [];
      const delta = isDeltaColumn(item.spec, colName);
      let prev = 0;
      for (let r = 0; r < item.rows; r++) {
        const cur = (vals[r] ?? 0) | 0;
        const stored = delta && r > 0 ? (cur - prev) | 0 : cur;
        prev = cur;
        view.setInt32(pos, stored, true);
        pos += 4;
      }
    }
  }
  return buffer;
}
