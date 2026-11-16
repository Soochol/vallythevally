export class DecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = "DecodeError";
  }
}

const MAGIC = [0x48, 0x4f, 0x47, 0x41];
const SUPPORTED_VERSION = 1;
const HEADER_FIXED_BYTES = 4 + 2 + 4 + 2 + 2 + 1;

const numbered = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

const STREAM_SPECS = {
  1: {
    name: "book",
    columns: [
      "recv_ms", "t_s",
      ...numbered("ask_px", 10), ...numbered("bid_px", 10),
      ...numbered("ask_qty", 10), ...numbered("bid_qty", 10),
      "ask_total", "bid_total",
    ],
    deltaColumns: "all",
  },
  2: { name: "trades", columns: ["recv_ms", "t_s", "price", "qty", "venue"], deltaColumns: ["recv_ms", "t_s", "price"] },
  3: { name: "program", columns: ["recv_ms", "t_s", "sell_qty", "sell_amt", "buy_qty", "buy_amt"], deltaColumns: "all" },
  4: {
    name: "broker",
    columns: [
      "recv_ms",
      ...numbered("sell_code", 5), ...numbered("buy_code", 5),
      ...numbered("sell_qty", 5), ...numbered("buy_qty", 5),
    ],
    deltaColumns: ["recv_ms"],
  },
  5: { name: "gaps", columns: ["from_ms", "to_ms"], deltaColumns: [] },
};

const isDeltaColumn = (spec, name) => spec.deltaColumns === "all" || spec.deltaColumns.includes(name);

function expectedDeltaFlags(spec) {
  const flags = new Uint8Array(Math.ceil(spec.columns.length / 8));
  spec.columns.forEach((name, index) => {
    if (isDeltaColumn(spec, name)) flags[index >> 3] |= 1 << (index & 7);
  });
  return flags;
}

export function decodeSpan(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let position = 0;
  const need = (count, what) => {
    if (position + count > bytes.length) throw new DecodeError(`파일이 잘렸습니다: ${what}`);
  };

  need(HEADER_FIXED_BYTES, "머리");
  if (!MAGIC.every((byte, index) => bytes[index] === byte)) throw new DecodeError("magic이 HOGA가 아닙니다");
  const version = view.getUint16(4, true);
  if (version !== SUPPORTED_VERSION) throw new DecodeError(`지원하지 않는 버전입니다: ${version}`);
  const date = view.getUint32(6, true);
  const startMinute = view.getUint16(10, true);
  const lengthMinutes = view.getUint16(12, true);
  const symbolLength = view.getUint8(14);
  position = HEADER_FIXED_BYTES;
  need(symbolLength + 1, "종목");
  let symbol = "";
  for (let index = 0; index < symbolLength; index++) {
    const byte = bytes[position + index];
    if (byte >= 0x80) throw new DecodeError("종목이 ASCII가 아닙니다");
    symbol += String.fromCharCode(byte);
  }
  position += symbolLength;
  const streamCount = view.getUint8(position++);

  const streams = [];
  const seenKinds = new Set();
  for (let index = 0; index < streamCount; index++) {
    need(10, "흐름 목록");
    const kind = view.getUint8(position);
    const columnCount = view.getUint8(position + 1);
    const rows = view.getUint32(position + 2, true);
    const bodyBytes = view.getUint32(position + 6, true);
    position += 10;
    const spec = STREAM_SPECS[kind];
    if (!spec) throw new DecodeError(`알 수 없는 흐름 종류입니다: ${kind}`);
    if (seenKinds.has(kind)) throw new DecodeError(`흐름이 두 번 들었습니다: ${spec.name}`);
    seenKinds.add(kind);
    if (columnCount !== spec.columns.length) throw new DecodeError(`${spec.name}의 열 수가 다릅니다: ${columnCount}`);
    if (bodyBytes !== rows * columnCount * 4) throw new DecodeError(`${spec.name}의 본문 바이트 수가 다릅니다`);
    const flagBytes = Math.ceil(columnCount / 8);
    need(flagBytes, "차분 비트");
    const expected = expectedDeltaFlags(spec);
    for (let flag = 0; flag < flagBytes; flag++) {
      if (bytes[position + flag] !== expected[flag]) throw new DecodeError(`${spec.name}의 차분 비트가 규격과 다릅니다`);
    }
    position += flagBytes;
    streams.push({ spec, rows, bodyBytes });
  }

  const padding = (4 - (position % 4)) % 4;
  need(padding, "채움");
  for (let index = 0; index < padding; index++) {
    if (bytes[position + index] !== 0) throw new DecodeError("채움 바이트가 0이 아닙니다");
  }
  position += padding;

  const bodyTotal = streams.reduce((sum, stream) => sum + stream.bodyBytes, 0);
  if (position + bodyTotal > bytes.length) throw new DecodeError("파일이 잘렸습니다: 본문");
  if (position + bodyTotal < bytes.length) throw new DecodeError("본문 뒤에 남는 바이트가 있습니다");

  const layout = { date, startMinute, lengthMinutes, symbol, streams: [] };
  for (const { spec, rows } of streams) {
    const columns = [];
    for (const name of spec.columns) {
      if (isDeltaColumn(spec, name) && rows > 0) {
        const values = new Int32Array(buffer, position, rows);
        for (let row = 1; row < rows; row++) values[row] = (values[row - 1] + values[row]) | 0;
      }
      columns.push({ name, offset: position });
      position += rows * 4;
    }
    layout.streams.push({ kind: spec.name, rows, columns });
  }
  return layout;
}

export function openSpan(layout, buffer) {
  const streams = {};
  for (const stream of layout.streams) {
    const columns = {};
    for (const column of stream.columns) columns[column.name] = new Int32Array(buffer, column.offset, stream.rows);
    streams[stream.kind] = { rows: stream.rows, columns };
  }
  return {
    date: layout.date,
    startMinute: layout.startMinute,
    lengthMinutes: layout.lengthMinutes,
    symbol: layout.symbol,
    streams,
  };
}
