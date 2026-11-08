// 목업용 결정론적 가짜 데이터와 지표 계산.
// 실제 앱에서 지표 계산은 Rust 지표 크레이트(WASM)가 맡는다. 여기 JS 구현은 화면을 그리기 위한 대역일 뿐이다.
(function () {
  const V = (window.V = {});

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seedOf(s) {
    let h = 2166136261;
    for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function gauss(r) {
    const u = Math.max(r(), 1e-9), v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // KRX 호가 단위(목업 근사).
  V.tick = (p) => (p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000);
  const roundP = (p, isIndex) => (isIndex ? Math.round(p * 100) / 100 : Math.round(p / V.tick(p)) * V.tick(p));

  V.SYMBOLS = [
    { code: '005930', name: '삼성전자', market: '코스피', kind: '주식', base: 64000, vol: 0.017, drift: 0.0007 },
    { code: '000660', name: 'SK하이닉스', market: '코스피', kind: '주식', base: 150000, vol: 0.025, drift: 0.001 },
    { code: '373220', name: 'LG에너지솔루션', market: '코스피', kind: '주식', base: 390000, vol: 0.021, drift: -0.0003 },
    { code: '005380', name: '현대차', market: '코스피', kind: '주식', base: 220000, vol: 0.016, drift: 0.0003 },
    { code: '035420', name: 'NAVER', market: '코스피', kind: '주식', base: 190000, vol: 0.02, drift: 0.0001 },
    { code: '035720', name: '카카오', market: '코스피', kind: '주식', base: 46000, vol: 0.022, drift: -0.0004 },
    { code: '068270', name: '셀트리온', market: '코스피', kind: '주식', base: 170000, vol: 0.019, drift: 0.0002 },
    { code: '086520', name: '에코프로', market: '코스닥', kind: '주식', base: 110000, vol: 0.034, drift: -0.0005 },
    { code: '196170', name: '알테오젠', market: '코스닥', kind: '주식', base: 250000, vol: 0.031, drift: 0.0011 },
    { code: '005935', name: '삼성전자우', market: '코스피', kind: '우선주', base: 52000, vol: 0.015, drift: 0.0006 },
    { code: '069500', name: 'KODEX 200', market: '코스피', kind: 'ETF', base: 33000, vol: 0.011, drift: 0.0003 },
    { code: '001', name: '코스피', market: '지수', kind: '지수', base: 2450, vol: 0.01, drift: 0.0003, index: true },
    { code: '101', name: '코스닥', market: '지수', kind: '지수', base: 740, vol: 0.013, drift: 0.0001, index: true },
  ];
  // 검색 대화상자에서만 쓰는 종목(차트 데이터 없음).
  V.SEARCH_ONLY = [
    { code: '006400', name: '삼성SDI', market: '코스피', kind: '주식' },
    { code: '207940', name: '삼성바이오로직스', market: '코스피', kind: '주식' },
    { code: '032830', name: '삼성생명', market: '코스피', kind: '주식' },
    { code: '004170', name: '신세계', market: '코스피', kind: '주식' },
    { code: '055550', name: '신한지주', market: '코스피', kind: '주식' },
    { code: '028260', name: '삼성물산', market: '코스피', kind: '주식' },
    { code: '009150', name: '삼성전기', market: '코스피', kind: '주식' },
  ];
  V.sym = (code) => V.SYMBOLS.find((s) => s.code === code);

  const DAY = 86400000;
  const iso = (d) => d.toISOString().slice(0, 10);
  // 기준 달력 근사: 주말만 뺀 날들(목업이라 공휴일은 무시).
  V.calendar = function (n, end = '2026-11-06') {
    const out = [];
    let d = new Date(end + 'T00:00:00Z');
    while (out.length < n) {
      const w = d.getUTCDay();
      if (w !== 0 && w !== 6) out.push(iso(d));
      d = new Date(d.getTime() - DAY);
    }
    return out.reverse();
  };
  V.futureDays = function (from, n) {
    const out = [];
    let d = new Date(from + 'T00:00:00Z');
    while (out.length < n) {
      d = new Date(d.getTime() + DAY);
      const w = d.getUTCDay();
      if (w !== 0 && w !== 6) out.push(iso(d));
    }
    return out;
  };

  const cache = new Map();
  const memo = (k, f) => (cache.has(k) ? cache.get(k) : (cache.set(k, f()), cache.get(k)));

  function walk(sym, n, r, start, volScale, times, volumeShape) {
    const bars = [];
    let prev = start;
    const v0 = sym.index ? 4e8 : 3e10 / sym.base;
    const phase = r() * 6;
    for (let i = 0; i < n; i++) {
      const trend = sym.drift + 0.0035 * Math.sin(i / 41 + phase) + 0.002 * Math.sin(i / 13 + phase * 2);
      const ret = trend * volScale + gauss(r) * sym.vol * volScale;
      const open = prev * (1 + gauss(r) * sym.vol * 0.15 * volScale);
      const close = open * (1 + ret);
      const high = Math.max(open, close) * (1 + Math.abs(gauss(r)) * sym.vol * 0.45 * volScale);
      const low = Math.min(open, close) * (1 - Math.abs(gauss(r)) * sym.vol * 0.45 * volScale);
      const shape = volumeShape ? volumeShape(i) : 1;
      const volume = Math.round(v0 * shape * (0.55 + r() * 0.9) * (1 + 18 * Math.abs(ret / volScale)));
      bars.push({
        time: times[i],
        open: roundP(open, sym.index), high: roundP(high, sym.index),
        low: roundP(low, sym.index), close: roundP(close, sym.index), volume,
      });
      prev = close;
    }
    return bars;
  }

  // 일봉 n개. 마지막 관측일은 2026-11-06(금).
  // 모든 봉 주기가 같은 1300일 원본에서 나오게 해 서로 값이 맞도록 한다.
  const FULL = 1300;
  V.daily = (code, n = 500) =>
    memo(`d:${code}:${n}`, () => {
      const full = memo(`full:${code}`, () => {
        const sym = V.sym(code);
        return walk(sym, FULL, mulberry32(seedOf(code)), sym.base * 0.6, 1, V.calendar(FULL));
      });
      return full.slice(-n);
    });

  // 주봉. 목업은 일봉을 묶어 만든다(실제로는 키움이 준 주봉을 그대로 쓴다: ADR 0003).
  V.weekly = (code) =>
    memo(`w:${code}`, () => {
      const out = [];
      for (const b of V.daily(code, FULL)) {
        const d = new Date(b.time + 'T00:00:00Z');
        const monday = iso(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY));
        const last = out[out.length - 1];
        if (last && last.time === monday) {
          last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low);
          last.close = b.close; last.volume += b.volume;
        } else out.push({ ...b, time: monday });
      }
      return out;
    });

  // 분봉: 마지막 days 관측일의 08:00~20:00 체결(통합 시세). 시각은 한국 벽시계를 UTC 초로 담는다.
  V.intraday = (code, minutes = 5, days = 3) =>
    memo(`m:${code}:${minutes}:${days}`, () => {
      const sym = V.sym(code);
      const r = mulberry32(seedOf(code + ':' + minutes));
      const cal = V.calendar(days);
      const perDay = (12 * 60) / minutes;
      const times = [];
      for (const day of cal) {
        const [y, m, d] = day.split('-').map(Number);
        for (let k = 0; k < perDay; k++) times.push(Date.UTC(y, m - 1, d, 8, k * minutes) / 1000);
      }
      const daily = V.daily(code);
      const start = daily[daily.length - days - 1].close;
      const shape = (i) => {
        const minute = 8 * 60 + (i % perDay) * minutes;
        return minute >= 540 && minute < 930 ? 1 : 0.18; // 정규장 밖은 거래량만 적다. 색은 따로 칠하지 않는다.
      };
      const bars = walk({ ...sym, drift: sym.drift / 6 }, times.length, r, start, 0.16, times, (i) => shape(i) / 20);
      // 마지막 분봉 종가를 일봉 종가에 맞춘다(같은 종목의 봉 주기끼리 값이 어긋나 보이지 않게).
      const f = daily[daily.length - 1].close / bars[bars.length - 1].close;
      for (const b of bars) for (const k of ['open', 'high', 'low', 'close']) b[k] = roundP(b[k] * f, sym.index);
      return bars;
    });

  // ---- 지표 계산(대역) ----
  V.sma = (v, n) => {
    const o = new Array(v.length).fill(null);
    let s = 0, c = 0;
    for (let i = 0; i < v.length; i++) {
      if (v[i] == null) { s = 0; c = 0; continue; }
      s += v[i]; c++;
      if (c > n) { s -= v[i - n]; c = n; }
      if (c === n) o[i] = s / n;
    }
    return o;
  };
  V.ema = (v, n) => {
    const o = new Array(v.length).fill(null);
    const k = 2 / (n + 1);
    let e = null, s = 0, c = 0;
    for (let i = 0; i < v.length; i++) {
      if (v[i] == null) continue;
      if (e == null) { s += v[i]; c++; if (c === n) e = s / n; }
      else e = v[i] * k + e * (1 - k);
      o[i] = e;
    }
    return o;
  };
  V.stdev = (v, n, mean) =>
    v.map((_, i) => {
      if (mean[i] == null) return null;
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (v[j] - mean[i]) ** 2;
      return Math.sqrt(s / n);
    });
  V.bb = (c, n = 20, k = 2) => {
    const mid = V.sma(c, n), sd = V.stdev(c, n, mid);
    return { mid, up: mid.map((m, i) => (m == null ? null : m + k * sd[i])), lo: mid.map((m, i) => (m == null ? null : m - k * sd[i])) };
  };
  V.rsi = (c, n = 14) => {
    const o = new Array(c.length).fill(null);
    let g = 0, l = 0;
    for (let i = 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      const up = Math.max(d, 0), dn = Math.max(-d, 0);
      if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; o[i] = 100 - 100 / (1 + g / (l || 1e-9)); } }
      else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = 100 - 100 / (1 + g / (l || 1e-9)); }
    }
    return o;
  };
  V.macd = (c, f = 12, s = 26, sig = 9) => {
    const a = V.ema(c, f), b = V.ema(c, s);
    const line = a.map((x, i) => (x == null || b[i] == null ? null : x - b[i]));
    const signal = V.ema(line, sig);
    return { line, signal, hist: line.map((x, i) => (x == null || signal[i] == null ? null : x - signal[i])) };
  };
  const hh = (bars, i, n) => { let m = -Infinity; for (let j = i - n + 1; j <= i; j++) m = Math.max(m, bars[j].high); return m; };
  const ll = (bars, i, n) => { let m = Infinity; for (let j = i - n + 1; j <= i; j++) m = Math.min(m, bars[j].low); return m; };
  V.stochSlow = (bars, n = 14, k = 3, d = 3) => {
    const fast = bars.map((b, i) => (i < n - 1 ? null : (100 * (b.close - ll(bars, i, n))) / (hh(bars, i, n) - ll(bars, i, n) || 1)));
    const slowK = V.sma(fast, k);
    return { k: slowK, d: V.sma(slowK, d) };
  };
  // 일목균형표. 선행스팬은 displacement-1 칸 앞(미래 시각)에 그린다. 정확한 관례는 지표 크레이트 참조값 테스트에서 고정한다.
  V.ichimoku = (bars, t = 9, kj = 26, sb = 52, disp = 26) => {
    const n = bars.length, total = n + disp - 1;
    const mid = (i, p) => (i < p - 1 ? null : (hh(bars, i, p) + ll(bars, i, p)) / 2);
    const tenkan = bars.map((_, i) => mid(i, t));
    const kijun = bars.map((_, i) => mid(i, kj));
    const spanA = new Array(total).fill(null), spanB = new Array(total).fill(null);
    for (let i = 0; i < n; i++) {
      if (tenkan[i] != null && kijun[i] != null) spanA[i + disp - 1] = (tenkan[i] + kijun[i]) / 2;
      const b = mid(i, sb);
      if (b != null) spanB[i + disp - 1] = b;
    }
    const chikou = bars.map((_, i) => (i + disp - 1 < n ? bars[i + disp - 1].close : null));
    return { tenkan, kijun, spanA, spanB, chikou };
  };

  // ---- 초성 검색 ----
  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  V.chosung = (s) =>
    [...s].map((ch) => {
      const c = ch.charCodeAt(0) - 0xac00;
      return c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch;
    }).join('');
  const isChoOnly = (q) => [...q].every((ch) => CHO.includes(ch) || ch === ' ');
  V.search = (q) => {
    const all = [...V.SYMBOLS, ...V.SEARCH_ONLY];
    q = q.trim().toLowerCase();
    if (!q) return all.slice(0, 8);
    const score = (s) => {
      const name = s.name.toLowerCase();
      if (s.code.startsWith(q)) return 3;
      if (name.startsWith(q)) return 3;
      if (isChoOnly(q) && V.chosung(name).startsWith(q)) return 2;
      if (name.includes(q) || (isChoOnly(q) && V.chosung(name).includes(q))) return 1;
      return 0;
    };
    return all.map((s) => [score(s), s]).filter(([sc]) => sc > 0).sort((a, b) => b[0] - a[0]).map(([, s]) => s);
  };
})();
