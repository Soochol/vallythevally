import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";

const CORP = "00126380";
const CODES = ["11013", "11012", "11014", "11011"];
const receipt = (year: number, code: string, corp = CORP) => `${year}${String(CODES.indexOf(code) + 1).padStart(2, "0")}15${corp === "00000002" ? "000002" : "000001"}`;

function zip(name: string, text: string): Buffer {
  const data = Buffer.from(text);
  const filename = Buffer.from(name);
  let crc = 0xffffffff;
  for (const b of data) {
    crc ^= b;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}

export interface Dart {
  url: string;
  calls: string[];
  fail: string | null;
  delay: number;
  edge: boolean;
  block: { scope: string; wait: Promise<void> } | null;
  close(): Promise<void>;
}

export async function startDart(): Promise<Dart> {
  const send = (res: ServerResponse, body: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
  const dart: Dart = { url: "", calls: [], fail: null, delay: 0, edge: false, block: null, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const endpoint = url.pathname.split("/").at(-1) ?? "";
    const q = url.searchParams;
    const scope = `${endpoint}/${q.get("bsns_year") ?? ""}/${q.get("reprt_code") ?? ""}/${q.get("corp_code") ?? ""}`;
    dart.calls.push(scope);
    if (dart.block && scope.includes(dart.block.scope)) await dart.block.wait;
    if (dart.delay) await new Promise((resolve) => setTimeout(resolve, dart.delay));
    if (dart.fail && scope.includes(dart.fail)) { send(res, { status: "020" }); return; }
    if (endpoint === "corpCode.xml") {
      res.end(zip("CORPCODE.xml", `<result><list><corp_code>${CORP}</corp_code><corp_name>합성회사</corp_name><stock_code>005930</stock_code></list><list><corp_code>00000002</corp_code><corp_name>합성회사2</corp_name><stock_code>000020</stock_code></list></result>`));
    } else if (endpoint === "company.json") send(res, { status: "000", corp_code: q.get("corp_code"), corp_name: "합성회사", acc_mt: dart.edge || q.get("corp_code") === "00000002" ? "03" : "12" });
    else if (endpoint === "searchcorpname.do") send(res, [{ repisusrtcd2: q.get("searchCorpName"), secugrpId: "ST", fssunqno: CORP }]);
    else if (endpoint === "list.json") send(res, { status: "000", page_no: 1, total_page: 1, list: [2015, 2016].flatMap((year) => CODES.map((code, i) => ({ corp_code: q.get("corp_code"), rcept_no: receipt(year, code, q.get("corp_code") ?? CORP), rcept_dt: `${year}1231`, report_nm: `${i === 3 ? "사업" : "분기"}보고서 (${dart.edge && year === 2015 && i === 3 ? "2016.03" : `${year}.${dart.edge && i === 0 ? "04" : String((i + 1) * 3).padStart(2, "0")}`})` }))) });
    else if (endpoint === "fnlttSinglAcntAll.json") {
      const year = Number(q.get("bsns_year"));
      if (year < 2015 || year > 2016) { send(res, { status: "013" }); return; }
      const code = q.get("reprt_code") ?? "11011";
      if (dart.edge && year === 2016 && code === "11014" && q.get("fs_div") === "CFS") { send(res, { status: "013" }); return; }
      send(res, { status: "000", list: statement(year, code, q.get("corp_code") ?? CORP, dart.edge).rows });
    } else if (endpoint === "fnlttXbrl.xml") {
      const stamp = q.get("rcept_no") ?? "";
      const year = Number(stamp.slice(0, 4));
      const code = CODES[Number(stamp.slice(4, 6)) - 1] ?? "11011";
      res.end(zip("synthetic.xbrl", statement(year, code, stamp.endsWith("000002") ? "00000002" : CORP, dart.edge).xml));
    } else if (endpoint === "alotMatter.json") {
      const year = Number(q.get("bsns_year"));
      send(res, year < 2015 || year > 2016 ? { status: "013" } : { status: "000", list: ["보통주", "우선주"].map((stock_knd) => ({ corp_code: q.get("corp_code"), stlm_dt: `${year}-12-31`, rcept_no: receipt(year, "11011", q.get("corp_code") ?? CORP), se: "주당 현금배당금(원)", stock_knd, thstrm: "0" })) });
    } else { res.statusCode = 404; res.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("가짜 DART 포트를 받지 못했습니다");
  dart.url = `http://127.0.0.1:${addr.port}`;
  return dart;
}

function statement(year: number, code: string, corp: string, edge: boolean) {
  const i = CODES.indexOf(code);
  const end = edge && year === 2015 && i === 3 ? "2016-03-31" : `${year}-${edge && i === 0 ? "04-30" : ["03-31", "06-30", "09-30", "12-31"][i]}`;
  const quarter = `${year}-${edge && i === 0 ? "02" : String(i * 3 + 1).padStart(2, "0")}-01`;
  const basis = edge && year === 2016 && code === "11014" ? "OFS" : "CFS";
  const rows = [
    ["IS", "ifrs-full_Revenue", i === 3 ? "1000" : "100", String((i + 1) * 100)],
    ["IS", "dart_OperatingIncomeLoss", i === 3 ? "-100" : "-10", String((i + 1) * -10)],
    ["IS", "ifrs-full_ProfitLossAttributableToOwnersOfParent", i === 3 ? "100" : "10", String((i + 1) * 10)],
    ["CF", "ifrs-full_CashFlowsFromUsedInInvestingActivities", String((i + 1) * -100), String((i + 1) * -100)],
    ["BS", "ifrs-full_Liabilities", "200", null], ["BS", "ifrs-full_Equity", edge && year === 2016 ? "0" : "400", null], ["BS", "ifrs-full_EquityAttributableToOwnersOfParent", "500", null],
  ].map(([sj_div, account_id, amount, cumulative]) => ({ corp_code: corp, bsns_year: String(year), reprt_code: code, rcept_no: receipt(year, code, corp), fs_div: basis, sj_div, account_id, account_nm: account_id === "ifrs-full_Liabilities" ? "부채총계" : account_id === "ifrs-full_Equity" ? "자본총계" : account_id, currency: "KRW", thstrm_nm: "합성기간", thstrm_amount: amount, ...(cumulative === null ? {} : { thstrm_add_amount: cumulative }) }));
  const context = (id: string, start: string | null) => `<x:context id="${id}"><x:entity><x:identifier scheme="http://dart.fss.or.kr/ifrs/CIK">${corp}</x:identifier></x:entity><x:period>${start === null ? `<x:instant>${end}</x:instant>` : `<x:startDate>${start}</x:startDate><x:endDate>${end}</x:endDate>`}</x:period><x:scenario><d:explicitMember dimension="ifrs:ConsolidatedAndSeparateFinancialStatementsAxis">ifrs:${basis === "CFS" ? "ConsolidatedMember" : "SeparateMember"}</d:explicitMember></x:scenario></x:context>`;
  const facts = rows.map((r) => {
    const concept = r.account_id?.replace("ifrs-full_", "ifrs:").replace("dart_", "dart:");
    return `<${concept} contextRef="${r.sj_div === "BS" ? "bs" : r.sj_div === "CF" || i === 3 ? "cum" : "q"}" unitRef="krw">${r.thstrm_amount}</${concept}>` + (r.thstrm_add_amount === undefined ? "" : `<${concept} contextRef="cum" unitRef="krw">${r.thstrm_add_amount}</${concept}>`);
  }).join("");
  return { rows, xml: `<x:xbrl xmlns:x="http://www.xbrl.org/2003/instance" xmlns:d="http://xbrl.org/2006/xbrldi" xmlns:g="http://dart.fss.or.kr/taxonomy/2025/dart-gcd" xmlns:dart="http://dart.fss.or.kr/ifrs/2025" xmlns:ifrs="http://xbrl.ifrs.org/taxonomy/2025/ifrs-full" xmlns:iso="http://www.xbrl.org/2003/iso4217"><x:unit id="krw"><x:measure>iso:KRW</x:measure></x:unit>${context("q", quarter)}${context("cum", edge && year === 2015 && i === 3 ? "2015-04-01" : `${year}-01-01`)}${context("bs", null)}<g:DocumentReceiptNumber>${receipt(year, code, corp)}</g:DocumentReceiptNumber>${facts}</x:xbrl>` };
}
