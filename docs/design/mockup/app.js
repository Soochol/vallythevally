// 차트 화면 목업. 실제 앱의 ChartController(칸마다 하나) 구조를 흉내 낸다.
(function () {
  const LC = window.LightweightCharts;
  const $ = (s, el = document) => el.querySelector(s);
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const params = new URLSearchParams(location.search);
  const isPhone = matchMedia('(max-width: 767px)').matches;
  const icon = (id, cls = 'i') => `<svg class="${cls}"><use href="#${id}"/></svg>`;

  const state = {
    layout: isPhone ? 'phone' : params.get('layout') || '4',
    theme: params.get('theme') || 'dark',
    active: 0,
    syncCross: true,
    syncScroll: true,
  };
  document.documentElement.dataset.theme = state.theme;

  // ---- 표기 ----
  const fmtPrice = (p, idx) =>
    p == null ? '-' : idx ? p.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Math.round(p).toLocaleString('ko-KR');
  const fmtNum = (x, d = 2) => (x == null ? '-' : x.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const fmtVol = (v) => (v >= 1e8 ? (v / 1e8).toFixed(2) + '억' : v >= 1e4 ? Math.round(v / 1e4).toLocaleString('ko-KR') + '만' : String(v));
  const fmtPct = (x) => (x > 0 ? '+' : '') + x.toFixed(2) + '%';
  const dir = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : 'flat');
  const toSec = (t) => (typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t + 'T00:00:00Z') / 1000 : Date.UTC(t.year, t.month - 1, t.day) / 1000);
  const fmtTime = (t, intraday) => {
    const d = new Date(toSec(t) * 1000);
    const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    return intraday ? `${ymd} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` : ymd;
  };

  // ---- 칸 구성(실제 앱에서는 레이아웃 스토어가 갖는다) ----
  const MA = (n, kind = '단순', color = 'ind-1') => ({ type: 'ma', p: { n, kind }, color });
  const LAYOUTS = {
    '4': {
      name: '장중 4칸', arr: '4', cells: [
        { sym: '005930', period: '5분', style: 'candle', link: 'A', price: [MA(5, '단순', 'ind-1'), MA(20, '지수', 'ind-2')], panels: [{ type: 'vol' }] },
        { sym: '005930', period: '일', style: 'candle', link: 'A', price: [{ type: 'bb', p: { n: 20, k: 2 }, color: 'ind-3' }], panels: [{ type: 'vol' }, { type: 'rsi', p: { n: 14 } }] },
        { sym: '000660', period: '일', style: 'bar', price: [{ type: 'ichi' }], panels: [{ type: 'stoch' }] },
        { sym: '001', period: '주', style: 'area', price: [MA(13, '단순', 'ind-1'), MA(26, '단순', 'ind-3')], panels: [{ type: 'macd' }] },
      ],
    },
    '1': {
      name: '삼성전자 일봉', arr: '1', cells: [
        {
          sym: '005930', period: '일', style: 'candle', link: 'A',
          price: [MA(5, '단순', 'ind-1'), MA(20, '단순', 'ind-2'), MA(60, '단순', 'ind-3'), MA(120, '단순', 'ind-4'), { type: 'bb', p: { n: 20, k: 2 }, color: 'ind-5' }],
          panels: [{ type: 'vol' }, { type: 'rsi', p: { n: 14 } }, { type: 'macd' }],
          compare: ['000660', '001'], drawings: true,
        },
      ],
    },
    phone: {
      name: '휴대폰', arr: '1', cells: [
        { sym: '005930', period: '일', style: 'candle', price: [MA(5, '단순', 'ind-1'), MA(20, '단순', 'ind-2'), MA(60, '단순', 'ind-3')], panels: [{ type: 'vol' }, { type: 'rsi', p: { n: 14 } }], drawings: true },
      ],
    },
  };
  const layout = LAYOUTS[state.layout] || LAYOUTS['4'];
  const PERIODS = ['1분', '3분', '5분', '15분', '30분', '60분', '일', '주', '월'];
  const barsOf = (code, period) => (period === '5분' ? V.intraday(code, 5, 3) : period === '주' ? V.weekly(code) : V.daily(code));

  // ---- 드로잉 primitive: 점은 (시각, 가격)으로 저장하고 그릴 때마다 좌표로 바꾼다 ----
  class DrawingLayer {
    constructor(items) { this.items = items; }
    attached({ chart, series, requestUpdate }) { this.chart = chart; this.series = series; this.requestUpdate = requestUpdate; }
    detached() {}
    updateAllViews() {}
    x(t) { return this.chart.timeScale().timeToCoordinate(t); }
    y(p) { return this.series.priceToCoordinate(p); }
    paneViews() {
      return [{ zOrder: () => 'top', renderer: () => ({ draw: (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => this.draw(context, mediaSize)) }) }];
    }
    draw(ctx, size) {
      const color = css('--draw'), text2 = css('--text-2'), font = css('--font-sans');
      ctx.lineWidth = 1.5;
      for (const d of this.items) {
        ctx.save();
        ctx.strokeStyle = d.color ? css(d.color) : color;
        ctx.fillStyle = ctx.strokeStyle;
        if (d.kind === 'trend') {
          const [a, b] = d.pts.map((p) => [this.x(p.time), this.y(p.price)]);
          if (a[0] == null || b[0] == null) { ctx.restore(); continue; }
          const k = (b[1] - a[1]) / (b[0] - a[0]);
          const xe = d.extend ? size.width : b[0];
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(xe, a[1] + k * (xe - a[0])); ctx.stroke();
          if (d.selected) for (const [x, y] of [a, b]) {
            ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fillStyle = css('--chart-bg'); ctx.fill(); ctx.lineWidth = 2; ctx.stroke();
          }
        } else if (d.kind === 'hline') {
          const y = this.y(d.price);
          ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size.width, y); ctx.stroke(); ctx.setLineDash([]);
          ctx.font = `600 11px ${font}`; ctx.fillText(d.label || '', 8, y - 5);
        } else if (d.kind === 'vline') {
          const x = this.x(d.time);
          ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size.height); ctx.stroke(); ctx.setLineDash([]);
        } else if (d.kind === 'rect') {
          const [a, b] = d.pts.map((p) => [this.x(p.time), this.y(p.price)]);
          ctx.globalAlpha = 0.12; ctx.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
          ctx.globalAlpha = 0.9; ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
        } else if (d.kind === 'fib') {
          const [lo, hi] = d.pts;
          const x0 = this.x(lo.time), x1 = size.width;
          ctx.font = `11px ${font}`;
          for (const lv of [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]) {
            const price = hi.price - (hi.price - lo.price) * lv;
            const y = this.y(price);
            ctx.globalAlpha = lv === 0.5 || lv === 0.618 ? 0.95 : 0.55;
            ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
            ctx.globalAlpha = 1; ctx.fillStyle = text2;
            ctx.fillText(`${lv}  ${fmtPrice(price)}`, x0 + 4, y - 3);
          }
          ctx.setLineDash([3, 3]); ctx.globalAlpha = 0.6; ctx.beginPath();
          ctx.moveTo(this.x(lo.time), this.y(lo.price)); ctx.lineTo(this.x(hi.time), this.y(hi.price)); ctx.stroke();
        } else if (d.kind === 'text') {
          const x = this.x(d.time), y = this.y(d.price);
          ctx.font = `600 12px ${font}`;
          const w = ctx.measureText(d.text).width;
          ctx.globalAlpha = 0.18; ctx.fillRect(x - 4, y - 14, w + 8, 19); ctx.globalAlpha = 1;
          ctx.fillText(d.text, x, y);
        }
        ctx.restore();
      }
    }
  }

  // 일목균형표 구름: 두 선 사이 채우기는 LWC에 없으므로 primitive로 그린다.
  class CloudLayer {
    constructor(times, a, b) { this.times = times; this.a = a; this.b = b; }
    attached({ chart, series }) { this.chart = chart; this.series = series; }
    detached() {}
    updateAllViews() {}
    paneViews() {
      return [{ zOrder: () => 'bottom', renderer: () => ({ draw: (t) => t.useMediaCoordinateSpace(({ context }) => this.draw(context)) }) }];
    }
    draw(ctx) {
      const ts = this.chart.timeScale(), up = css('--cloud-up'), dn = css('--cloud-down');
      for (let i = 1; i < this.times.length; i++) {
        const a0 = this.a[i - 1], a1 = this.a[i], b0 = this.b[i - 1], b1 = this.b[i];
        if ([a0, a1, b0, b1].some((v) => v == null)) continue;
        const x0 = ts.timeToCoordinate(this.times[i - 1]), x1 = ts.timeToCoordinate(this.times[i]);
        if (x0 == null || x1 == null) continue;
        ctx.fillStyle = a1 >= b1 ? up : dn;
        ctx.beginPath();
        ctx.moveTo(x0, this.series.priceToCoordinate(a0)); ctx.lineTo(x1, this.series.priceToCoordinate(a1));
        ctx.lineTo(x1, this.series.priceToCoordinate(b1)); ctx.lineTo(x0, this.series.priceToCoordinate(b0));
        ctx.closePath(); ctx.fill();
      }
    }
  }

  // ---- 칸 하나 = 컨트롤러 하나 ----
  function chartOptions(isIndex, intraday) {
    return {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: css('--chart-bg') }, textColor: css('--text-2'),
        fontFamily: css('--font-sans'), fontSize: 11, attributionLogo: false,
        panes: { separatorColor: css('--line'), separatorHoverColor: css('--accent-soft'), enableResize: true },
      },
      grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
      crosshair: {
        mode: LC.CrosshairMode.Normal,
        vertLine: { color: css('--crosshair'), style: LC.LineStyle.Dashed, width: 1, labelBackgroundColor: css('--raised') },
        horzLine: { color: css('--crosshair'), style: LC.LineStyle.Dashed, width: 1, labelBackgroundColor: css('--raised') },
      },
      rightPriceScale: { borderColor: css('--line'), scaleMargins: { top: 0.26, bottom: 0.06 } },
      timeScale: { borderColor: css('--line'), timeVisible: intraday, secondsVisible: false, rightOffset: 6 },
      localization: { locale: 'ko-KR', priceFormatter: (p) => fmtPrice(p, isIndex), timeFormatter: (t) => fmtTime(t, intraday) },
    };
  }

  function createController(cell, el, idx) {
    const sym = V.sym(cell.sym);
    const intraday = cell.period.endsWith('분');
    const bars = barsOf(cell.sym, cell.period);
    const times = bars.map((b) => b.time);
    const closes = bars.map((b) => b.close);
    const chart = LC.createChart($('.chart', el), chartOptions(sym.index, intraday));
    const up = css('--up'), dn = css('--down');
    const ctl = { cell, sym, bars, times, chart, el, idx, intraday, priceLegend: [], paneLegends: [] };

    // 주 시리즈: 봉을 그리는 방식만 다르다.
    let main;
    if (cell.style === 'candle') main = chart.addSeries(LC.CandlestickSeries, { upColor: up, downColor: dn, borderUpColor: up, borderDownColor: dn, wickUpColor: up, wickDownColor: dn });
    else if (cell.style === 'bar') main = chart.addSeries(LC.BarSeries, { upColor: up, downColor: dn, thinBars: false });
    else if (cell.style === 'area') main = chart.addSeries(LC.AreaSeries, { lineColor: css('--series-line'), topColor: css('--series-fill'), bottomColor: 'transparent', lineWidth: 2 });
    else main = chart.addSeries(LC.LineSeries, { color: css('--series-line'), lineWidth: 2 });
    main.setData(cell.style === 'area' || cell.style === 'line' ? bars.map((b) => ({ time: b.time, value: b.close })) : bars);
    ctl.main = main;

    const line = (vals, color, pane = 0, extra = {}, t = times) => {
      const s = chart.addSeries(LC.LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra }, pane);
      s.setData(vals.map((v, i) => (v == null ? { time: t[i] } : { time: t[i], value: v })));
      return s;
    };

    // 가격 패널 지표
    for (const ind of cell.price) {
      const c = ind.color ? css('--' + ind.color) : css('--ind-1');
      if (ind.type === 'ma') {
        const v = ind.p.kind === '지수' ? V.ema(closes, ind.p.n) : V.sma(closes, ind.p.n);
        line(v, c, 0, { lineWidth: ind.p.n >= 60 ? 2 : 1 });
        ctl.priceLegend.push({ name: `이동평균 ${ind.p.kind === '지수' ? '지수 ' : ''}${ind.p.n}`, color: c, val: (i) => fmtPrice(v[i], sym.index) });
      } else if (ind.type === 'bb') {
        const b = V.bb(closes, ind.p.n, ind.p.k);
        line(b.up, c, 0, { lineStyle: LC.LineStyle.Solid }); line(b.mid, c, 0, { lineStyle: LC.LineStyle.Dotted }); line(b.lo, c, 0);
        ctl.priceLegend.push({ name: `볼린저 밴드 ${ind.p.n} ${ind.p.k}`, color: c, val: (i) => `${fmtPrice(b.up[i], sym.index)} ${fmtPrice(b.mid[i], sym.index)} ${fmtPrice(b.lo[i], sym.index)}` });
      } else if (ind.type === 'ichi') {
        const k = V.ichimoku(bars);
        // 선행스팬은 미래 시각에 그려지므로 시간축에 빈 봉(whitespace)을 덧붙인다.
        const future = intraday ? [] : V.futureDays(times[times.length - 1], k.spanA.length - bars.length);
        const ext = times.concat(future);
        main.setData((cell.style === 'area' ? bars.map((b) => ({ time: b.time, value: b.close })) : bars).concat(future.map((t) => ({ time: t }))));
        line(k.tenkan, css('--ind-3'), 0); line(k.kijun, css('--ind-1'), 0);
        line(k.spanA, css('--up'), 0, { lineStyle: LC.LineStyle.Solid }, ext); line(k.spanB, css('--down'), 0, {}, ext);
        line(k.chikou, css('--ind-2'), 0, { lineStyle: LC.LineStyle.Dotted });
        main.attachPrimitive(new CloudLayer(ext, k.spanA, k.spanB));
        ctl.priceLegend.push({ name: '일목균형표 9 26 52', color: css('--ind-1'), val: (i) => `전환 ${fmtPrice(k.tenkan[i])} 기준 ${fmtPrice(k.kijun[i])}` });
      }
    }

    // 비교 종목: 가격축을 % 모드로 바꾸면 화면 왼쪽 끝 봉이 0%가 된다.
    if (cell.compare) {
      cell.compare.forEach((code, j) => {
        const cb = barsOf(code, cell.period);
        const c = css(`--cmp-${j + 1}`);
        const s = chart.addSeries(LC.LineSeries, { color: c, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
        s.setData(cb.map((b) => ({ time: b.time, value: b.close })));
        ctl.priceLegend.push({ cmp: true, name: V.sym(code).name, color: c, val: (i, base) => (base == null || !cb[i] ? '-' : fmtPct((cb[i].close / cb[base].close - 1) * 100)) });
      });
    }

    // 지표 패널: 패널 하나 = LWC pane 하나
    let pane = 0;
    for (const p of cell.panels) {
      pane++;
      const leg = { pane, items: [] };
      if (p.type === 'vol') {
        const s = chart.addSeries(LC.HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false }, pane);
        s.setData(bars.map((b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? css('--up-vol') : css('--down-vol') })));
        const ma = V.sma(bars.map((b) => b.volume), 20);
        line(ma, css('--ind-5'), pane);
        leg.items.push({ name: '거래량', val: (i) => fmtVol(bars[i].volume), cls: (i) => dir(bars[i].close - bars[i].open) }, { name: '이동평균 20', color: css('--ind-5'), val: (i) => (ma[i] ? fmtVol(Math.round(ma[i])) : '-') });
      } else if (p.type === 'rsi') {
        const v = V.rsi(closes, p.p.n);
        const s = line(v, css('--ind-1'), pane, { lineWidth: 2, lastValueVisible: true });
        for (const lv of [70, 30]) s.createPriceLine({ price: lv, color: css('--text-3'), lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false });
        leg.items.push({ name: `RSI ${p.p.n}`, color: css('--ind-1'), val: (i) => fmtNum(v[i]) });
      } else if (p.type === 'macd') {
        const m = V.macd(closes);
        const h = chart.addSeries(LC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
        h.setData(m.hist.map((x, i) => (x == null ? { time: times[i] } : { time: times[i], value: x, color: x >= 0 ? css('--up-vol') : css('--down-vol') })));
        line(m.line, css('--ind-2'), pane, { lineWidth: 2 }); line(m.signal, css('--ind-3'), pane);
        leg.items.push({ name: 'MACD 12 26 9', color: css('--ind-2'), val: (i) => fmtNum(m.line[i], sym.index ? 2 : 0) }, { name: '시그널', color: css('--ind-3'), val: (i) => fmtNum(m.signal[i], sym.index ? 2 : 0) });
      } else if (p.type === 'stoch') {
        const st = V.stochSlow(bars, 5, 3, 3);
        const s = line(st.k, css('--ind-2'), pane, { lineWidth: 2 }); line(st.d, css('--ind-3'), pane);
        for (const lv of [80, 20]) s.createPriceLine({ price: lv, color: css('--text-3'), lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false });
        leg.items.push({ name: '스토캐스틱 슬로우 5 3 3', color: css('--ind-2'), val: (i) => `%K ${fmtNum(st.k[i])}  %D ${fmtNum(st.d[i])}` });
      }
      ctl.paneLegends.push(leg);
    }

    // % 축은 가격 패널의 축에만. 지표 패널 축은 일반 축 그대로 둔다.
    if (cell.compare) {
      main.priceScale().applyOptions({ mode: LC.PriceScaleMode.Percentage });
      for (let k = 1; k <= cell.panels.length; k++) chart.priceScale('right', k).applyOptions({ mode: LC.PriceScaleMode.Normal });
    }
    // 패널 높이: 가격 패널이 넓게, 지표 패널은 같은 비율로.
    chart.panes().forEach((pn, i) => pn.setStretchFactor(i === 0 ? (cell.panels.length > 2 ? 3.4 : 3) : 1));

    // 보이는 범위
    const show = cell.period === '5분' ? 150 : layout.arr === '1' ? (isPhone ? 90 : 130) : 120;
    chart.timeScale().setVisibleLogicalRange({ from: bars.length - show, to: bars.length + (cell.price.some((p) => p.type === 'ichi') ? 26 : 4) });

    if (cell.drawings) main.attachPrimitive(new DrawingLayer(sampleDrawings(bars, show)));

    buildLegend(ctl);
    ctl.showIndex = (i) => renderLegend(ctl, (ctl.shown = Math.max(0, Math.min(bars.length - 1, i))));
    // 비교 종목 %의 기준(화면 왼쪽 끝 봉)이 스크롤로 바뀌면 범례도 다시 그린다.
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => ctl.showIndex(ctl.shown));
    ctl.showIndex(bars.length - 1);
    return ctl;
  }

  // 화면에 보이는 구간의 저점·고점에서 드로잉 예시를 만든다.
  function sampleDrawings(bars, show) {
    const n = bars.length, s = n - show;
    const seg = (a, b, key, pick) => { let k = a; for (let i = a; i < b; i++) if (pick(bars[i][key], bars[k][key])) k = i; return k; };
    const lo1 = seg(s, s + Math.floor(show * 0.45), 'low', (x, y) => x < y);
    const lo2 = seg(s + Math.floor(show * 0.55), n - 8, 'low', (x, y) => x < y);
    const hi = seg(lo1, n, 'high', (x, y) => x > y);
    const boxA = n - 46, boxB = n - 18;
    let bh = -Infinity, bl = Infinity;
    for (let i = boxA; i <= boxB; i++) { bh = Math.max(bh, bars[i].high); bl = Math.min(bl, bars[i].low); }
    return [
      { kind: 'fib', pts: [{ time: bars[lo1].time, price: bars[lo1].low }, { time: bars[hi].time, price: bars[hi].high }], color: '--text-3' },
      { kind: 'trend', selected: !isPhone, extend: true, pts: [{ time: bars[lo1].time, price: bars[lo1].low }, { time: bars[lo2].time, price: bars[lo2].low }] },
      { kind: 'rect', pts: [{ time: bars[boxA].time, price: bh }, { time: bars[boxB].time, price: bl }], color: '--ind-1' },
      { kind: 'hline', price: bh, label: `박스 상단 ${fmtPrice(bh)}`, color: '--ind-1' },
      { kind: 'vline', time: bars[hi].time, color: '--text-3' },
      { kind: 'text', time: bars[lo2].time, price: bars[lo2].low * 0.985, text: '두 번째 저점' },
    ];
  }

  // ---- 범례 ----
  function buildLegend(ctl) {
    const { cell, sym, el } = ctl;
    const lg = document.createElement('div');
    lg.className = 'legend';
    const actions = `<span class="acts"><button title="숨기기">${icon('i-eye')}</button><button title="설정 편집">${icon('i-gear')}</button><button title="지우기">${icon('i-x')}</button></span>`;
    lg.innerHTML = `
      <div class="lg-head">
        <span class="link-tag" ${cell.link ? `data-link="${cell.link}"` : ''} title="${cell.link ? `종목 연동 ${cell.link}` : '종목 연동 꺼짐'}">${cell.link || '·'}</span>
        <span class="lg-sym">${sym.name}</span><span class="lg-code">${sym.index ? sym.market : sym.code}</span><span class="lg-period">${cell.period}</span>
      </div>
      <div class="lg-price"><span class="lg-close"></span><span class="lg-chg"></span><span class="lg-time muted" style="font-size:11px"></span></div>
      <div class="lg-ohlc"></div>
      <ul class="lg-ind">${ctl.priceLegend.map((it, j) => `<li class="${it.cmp ? 'cmp' : ''} ${layout.arr === '1' && j === 1 && !isPhone ? 'show-acts' : ''}"><span class="sw" style="background:${it.color}"></span><span class="nm">${it.name}</span><b class="v"></b>${actions}</li>`).join('')}</ul>`;
    el.appendChild(lg);
    ctl.legendEl = lg;
    ctl.paneEls = ctl.paneLegends.map((pl) => {
      const d = document.createElement('div');
      d.className = 'pane-legend';
      d.innerHTML = pl.items.map((it) => `<span>${it.color ? `<span class="sw" style="display:inline-block;width:8px;height:2px;vertical-align:middle;margin-right:4px;background:${it.color}"></span>` : ''}<span class="nm">${it.name}</span> <b></b></span>`).join('');
      el.appendChild(d);
      return d;
    });
    if (isPhone && cell.drawings) el.insertAdjacentHTML('beforeend', `<span class="m-ro">드로잉 보기 전용</span>`);
    else if (layout.arr !== '1') {
      el.insertAdjacentHTML('beforeend', `<span class="cell-badge">${cell.price.length + cell.panels.length}개 지표</span>`);
    }
    // 패널 높이는 칸 크기가 정해진 뒤에야 알 수 있으므로 크기가 바뀔 때마다 범례 위치를 다시 잡는다.
    new ResizeObserver(() => requestAnimationFrame(() => placePaneLegends(ctl))).observe(el);
  }
  function placePaneLegends(ctl) {
    const panes = ctl.chart.panes();
    let top = 0;
    panes.forEach((p, i) => {
      if (i > 0 && ctl.paneEls[i - 1]) ctl.paneEls[i - 1].style.top = top + 4 + 'px';
      top += p.getHeight() + 1;
    });
  }
  function renderLegend(ctl, i) {
    const { bars, sym, legendEl: lg } = ctl;
    const b = bars[i], prev = bars[i - 1] || b;
    const chg = b.close - prev.close, pct = (chg / prev.close) * 100, d = dir(chg);
    $('.lg-close', lg).className = `lg-close ${d}`;
    $('.lg-close', lg).textContent = fmtPrice(b.close, sym.index);
    $('.lg-chg', lg).className = `lg-chg ${d}`;
    $('.lg-chg', lg).textContent = `${chg > 0 ? '+' : ''}${fmtPrice(chg, sym.index)}  ${fmtPct(pct)}`;
    $('.lg-time', lg).textContent = fmtTime(b.time, ctl.intraday);
    $('.lg-ohlc', lg).innerHTML = [['시', b.open], ['고', b.high], ['저', b.low], ['종', b.close]]
      .map(([k, v]) => `<span><i>${k}</i>${fmtPrice(v, sym.index)}</span>`).join('') + `<span><i>량</i>${fmtVol(b.volume)}</span>`;
    // 비교 종목 % 기준 = 화면 왼쪽 끝 봉
    const range = ctl.chart.timeScale().getVisibleLogicalRange();
    const base = range ? Math.max(0, Math.round(range.from)) : 0;
    lg.querySelectorAll('.lg-ind li .v').forEach((v, j) => {
      const it = ctl.priceLegend[j];
      v.textContent = it.val(i, base);
      v.className = 'v ' + (it.cmp ? dir(parseFloat(v.textContent)) : '');
    });
    ctl.paneEls.forEach((pe, k) => pe.querySelectorAll('b').forEach((v, j) => {
      const it = ctl.paneLegends[k].items[j];
      v.textContent = it.val(i);
      if (it.cls) v.className = it.cls(i);
    }));
    if (ctl.idx === state.active) updateHeader(ctl, i);
  }

  // ---- 화면 골격 ----
  const grid = $('#grid');
  grid.dataset.arr = layout.arr;
  const ctls = layout.cells.map((cell, i) => {
    const el = document.createElement('section');
    el.className = 'cell' + (i === state.active ? ' active' : '');
    el.setAttribute('aria-label', `칸 ${i + 1}: ${V.sym(cell.sym).name} ${cell.period}`);
    el.tabIndex = 0;
    el.innerHTML = '<div class="chart"></div>';
    grid.appendChild(el);
    return { cell, el };
  }).map(({ cell, el }, i) => createController(cell, el, i));

  // 십자선 동기화: 같은 시각(또는 그 직전 봉)으로 맞춘다.
  let syncing = false;
  const atOrBefore = (ctl, t) => {
    let lo = 0, hi = ctl.bars.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (toSec(ctl.bars[m].time) <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  };
  ctls.forEach((c) => {
    c.chart.subscribeCrosshairMove((param) => {
      if (syncing) return;
      const i = param.logical != null ? Math.round(param.logical) : c.bars.length - 1;
      c.showIndex(param.time ? Math.min(i, c.bars.length - 1) : c.bars.length - 1);
      if (!state.syncCross) return;
      syncing = true;
      for (const o of ctls) {
        if (o === c) continue;
        if (!param.time) { o.chart.clearCrosshairPosition(); o.showIndex(o.bars.length - 1); continue; }
        const j = atOrBefore(o, toSec(param.time));
        if (j < 0) { o.chart.clearCrosshairPosition(); continue; }
        o.chart.setCrosshairPosition(o.bars[j].close, o.bars[j].time, o.main);
        o.showIndex(j);
      }
      syncing = false;
    });
    // 스크롤 동기화: 같은 봉 주기 칸끼리만.
    c.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (syncing || !r || !state.syncScroll) return;
      syncing = true;
      for (const o of ctls) if (o !== c && o.cell.period === c.cell.period) o.chart.timeScale().setVisibleLogicalRange(r);
      syncing = false;
    });
    c.el.addEventListener('pointerdown', () => setActive(c.idx));
    c.el.addEventListener('focus', () => setActive(c.idx));
  });

  function setActive(i) {
    state.active = i;
    ctls.forEach((c) => c.el.classList.toggle('active', c.idx === i));
    const c = ctls[i];
    updateHeader(c, c.bars.length - 1);
    renderPeriods();
    renderWatch();
  }

  function updateHeader(ctl, i) {
    const { sym } = ctl;
    $('#symBtn').innerHTML = `${icon('i-search')}<b>${sym.name}</b><span class="sub">${sym.index ? sym.market : sym.code}</span><kbd>/</kbd>`;
    if (isPhone) {
      const b = ctl.bars[i], prev = ctl.bars[i - 1] || b, chg = b.close - prev.close, d = dir(chg);
      $('#mHead').innerHTML = `<div class="nm"><b>${sym.name}</b><small>${sym.code}</small>
        <div class="px"><strong class="${d}">${fmtPrice(b.close, sym.index)}</strong><span class="${d}">${chg > 0 ? '+' : ''}${fmtPrice(chg)} ${fmtPct((chg / prev.close) * 100)}</span></div></div>
        <button class="icon-btn" title="테마 바꾸기" id="mTheme">${icon(state.theme === 'dark' ? 'i-sun' : 'i-moon')}</button>`;
      $('#mTheme').onclick = toggleTheme;
    }
  }

  function renderPeriods() {
    const cur = ctls[state.active].cell.period;
    const keys = { '1분': '1', '3분': '3', '5분': '5', '15분': 'Shift+1', '30분': 'Shift+3', '60분': 'Shift+6', 일: 'D', 주: 'W', 월: 'M' };
    $('#periodSeg').innerHTML = PERIODS.map((p, k) => `${k === 6 ? '<span class="gap"></span>' : ''}<button aria-pressed="${p === cur}" title="${p} (${keys[p]})">${p}</button>`).join('');
    $('#mPer').innerHTML = ['5분', '15분', '60분', '일', '주', '월'].map((p) => `<button aria-pressed="${p === cur}">${p}</button>`).join('') +
      `<button class="ind" title="지표">${icon('i-ind')}</button>`;
  }

  function renderTools() {
    const tools = [['i-cursor', '선택·이동', 'V'], ['i-trend', '추세선', 'T'], ['i-hline', '수평선', 'H'], ['i-vline', '수직선', 'Shift+V'], ['i-rect', '사각형', 'R'], ['i-fib', '피보나치 되돌림', 'F'], ['i-text', '텍스트', 'X']];
    $('#tools').innerHTML = tools.map(([id, name, key], k) => `<button class="tool" aria-pressed="${k === 0}" title="${name} (${key})">${icon(id)}<span class="key">${key.length === 1 ? key : ''}</span></button>`).join('') +
      `<hr><button class="tool" aria-pressed="true" title="자석 모드 (G, 그리는 동안 Ctrl을 누르면 잠시 반대로)">${icon('i-magnet')}</button>
       <button class="tool" title="되돌리기 (Ctrl+Z)">${icon('i-undo')}</button>
       <button class="tool" title="선택한 드로잉 지우기 (Delete)">${icon('i-trash')}</button>`;
  }

  function renderArr() {
    $('#layoutName').textContent = layout.name;
    $('#arrSeg').innerHTML = ['1', '2h', '2v', '3', '4'].map((a) => `<button class="arr-btn" aria-pressed="${a === layout.arr}" title="${{ 1: '1칸', '2h': '2칸 좌우', '2v': '2칸 상하', 3: '3칸', 4: '4칸' }[a]}"><svg class="i" viewBox="0 0 16 16"><use href="#a-${a}"/></svg></button>`).join('');
  }

  function spark(bars) {
    const v = bars.slice(-30).map((b) => b.close), mn = Math.min(...v), mx = Math.max(...v);
    const pts = v.map((x, i) => `${(i / (v.length - 1)) * 44},${11 - ((x - mn) / (mx - mn || 1)) * 10}`).join(' ');
    return `<svg class="spark" viewBox="0 0 44 12" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${v[v.length - 1] >= v[0] ? 'var(--up)' : 'var(--down)'}" stroke-width="1.3"/></svg>`;
  }
  function renderWatch() {
    const cur = ctls[state.active].cell.sym;
    const list = ['005930', '000660', '373220', '005380', '035420', '035720', '068270', '086520', '196170', '005935', '069500', '001', '101'];
    $('#watchCount').textContent = list.length + '종목';
    $('#watchList').innerHTML = list.map((code) => {
      const s = V.sym(code), d = V.daily(code), b = d[d.length - 1], p = d[d.length - 2];
      const pct = (b.close / p.close - 1) * 100;
      return `<li><button class="wrow" aria-current="${code === cur}"><span class="nm"><b>${s.name}</b><small>${s.index ? s.market : s.code}${spark(d)}</small></span><span class="px">${fmtPrice(b.close, s.index)}</span><span class="pct ${dir(pct)}">${fmtPct(pct)}</span></button></li>`;
    }).join('');
  }

  // ---- 대화상자 ----
  const scrim = $('#scrim');
  function openDialog(kind) {
    scrim.innerHTML = kind === 'search' ? searchDialog() : kind === 'alert' ? alertDialog() : indicatorDialog(kind === 'compare' ? 'compare' : 'indicator');
    scrim.classList.add('open');
    if (kind === 'search') wireSearch();
    const f = scrim.querySelector('input'); f && f.focus();
  }
  const closeDialog = () => scrim.classList.remove('open');
  scrim.addEventListener('click', (e) => { if (e.target === scrim || e.target.closest('[data-close]')) closeDialog(); });

  function indicatorDialog(tab) {
    const c = ctls[state.active].cell;
    const count = (t) => c.price.filter((p) => p.type === t).length + c.panels.filter((p) => p.type === t).length;
    const opt = (name, t, sel) => `<button class="opt" role="option" aria-selected="${!!sel}">${name}${count(t) ? `<span class="cnt">${count(t)}개 띄움</span>` : ''}</button>`;
    const swatch = ['ind-1', 'ind-2', 'ind-3', 'ind-4', 'ind-5'].map((k, i) => `<button aria-pressed="${i === 1}" style="background:var(--${k})" aria-label="색 ${i + 1}"></button>`).join('');
    const current = [...c.price.map((p) => [p, '가격 패널']), ...c.panels.map((p, i) => [p, `지표 패널 ${i + 1}`])].map(([p, where]) => {
      const nm = { ma: () => `이동평균 ${p.p.kind} ${p.p.n}`, bb: () => `볼린저 밴드 ${p.p.n} ${p.p.k}`, ichi: () => '일목균형표 9 26 52', vol: () => '거래량', rsi: () => `RSI ${p.p.n}`, macd: () => 'MACD 12 26 9', stoch: () => '스토캐스틱 슬로우 5 3 3' }[p.type]();
      return `<li><span class="sw" style="background:var(--${p.color || 'ind-2'})"></span>${nm}<span class="where">${where}</span><button class="icon-btn" title="설정 편집">${icon('i-gear')}</button><button class="icon-btn" title="숨기기">${icon('i-eye')}</button><button class="icon-btn" title="지우기">${icon('i-x')}</button></li>`;
    }).join('');
    const indBody = `
      <div class="dlg-list" role="listbox" aria-label="지표 종류">
        <label class="field-search">${icon('i-search')}<input placeholder="지표 종류 찾기" aria-label="지표 종류 찾기"></label>
        <div class="grp">가격 패널에 겹쳐 그림</div>
        ${opt('이동평균', 'ma', true)}${opt('볼린저 밴드', 'bb')}${opt('일목균형표', 'ichi')}
        <div class="grp">아래 지표 패널에 그림</div>
        ${opt('거래량', 'vol')}${opt('RSI', 'rsi')}${opt('MACD', 'macd')}${opt('스토캐스틱 슬로우', 'stoch')}
      </div>
      <div class="dlg-form">
        <h3>이동평균</h3>
        <p class="help">같은 종류를 여러 번 띄울 수 있습니다. 기간만 바꿔 다시 추가하세요.</p>
        <div class="row"><span class="lbl">계산 방식</span><div class="segbox"><button aria-pressed="true">단순</button><button aria-pressed="false">지수</button></div></div>
        <div class="row"><label for="maN">기간</label><span><input class="input num" id="maN" value="20" inputmode="numeric"> <span class="muted" style="font-size:12px">봉</span></span></div>
        <div class="row"><label for="maSrc">원천</label><select class="input" id="maSrc"><option>종가</option><option>시가</option><option>고가</option><option>저가</option></select></div>
        <div class="row"><span class="lbl">색</span><div class="swatches">${swatch}</div></div>
        <div class="row"><span class="lbl">굵기</span><div class="segbox"><button aria-pressed="true">1</button><button aria-pressed="false">2</button><button aria-pressed="false">3</button></div></div>
        <div class="current"><h3>이 칸에 띄운 지표</h3><ul>${current}</ul></div>
      </div>`;
    const cmpBody = `
      <div class="dlg-list"><label class="field-search">${icon('i-search')}<input placeholder="비교할 종목 찾기" aria-label="비교할 종목 찾기"></label>
        ${['코스피', '코스닥', 'SK하이닉스', 'KODEX 200'].map((n, i) => `<button class="opt" aria-selected="${i === 0}">${n}</button>`).join('')}</div>
      <div class="dlg-form"><h3>비교 종목 <span class="muted" style="font-weight:400">${(c.compare || []).length}/3</span></h3>
        <p class="help">비교 종목을 넣으면 가격축이 화면 왼쪽 끝 봉 기준 % 변화로 바뀝니다. 모두 지우면 원래 축으로 돌아갑니다.</p>
        <div class="current"><ul>${(c.compare || []).map((code, j) => `<li><span class="sw" style="background:var(--cmp-${j + 1})"></span>${V.sym(code).name}<span class="where">${code}</span><button class="icon-btn" title="지우기">${icon('i-x')}</button></li>`).join('') || '<li class="muted">아직 없습니다. 왼쪽에서 종목을 고르세요.</li>'}</ul></div></div>`;
    return `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlgT">
      <div class="dlg-head"><h2 id="dlgT">${tab === 'compare' ? '비교 종목' : '지표 추가'}</h2>
        <div class="tabs" role="tablist"><button role="tab" aria-selected="${tab !== 'compare'}">지표</button><button role="tab" aria-selected="${tab === 'compare'}">비교 종목</button></div>
        <span class="ctx">칸 ${state.active + 1}: ${V.sym(c.sym).name} ${c.period}</span><span class="grow"></span>
        <button class="icon-btn" data-close title="닫기 (Esc)">${icon('i-x')}</button></div>
      <div class="dlg-body">${tab === 'compare' ? cmpBody : indBody}</div>
      <div class="dlg-foot"><span class="hint"><kbd>↑</kbd><kbd>↓</kbd> 종류 고르기 <kbd>Tab</kbd> 설정 <kbd>Enter</kbd> 추가 <kbd>Esc</kbd> 닫기</span><span class="grow"></span>
        <button class="btn" data-close>닫기</button><button class="btn primary">${tab === 'compare' ? '비교 종목 추가' : '이동평균 20 추가'}</button></div></div>`;
  }

  function searchDialog() {
    return `<div class="dialog palette" role="dialog" aria-modal="true" aria-label="종목 검색">
      <label class="field-search">${icon('i-search')}<input id="q" value="${params.get('q') || 'ㅅㅅ'}" placeholder="종목 이름, 코드, 초성(ㅅㅅㅈㅈ)" aria-label="종목 검색" aria-controls="results" autocomplete="off"></label>
      <ul class="results" id="results" role="listbox"></ul>
      <div class="dlg-foot"><span class="hint"><kbd>↑</kbd><kbd>↓</kbd> 고르기 <kbd>Enter</kbd> 이 칸에 열기 <kbd>Shift+Enter</kbd> 비교 종목으로 <kbd>Ctrl+Enter</kbd> 관심종목에 추가</span></div></div>`;
  }
  function wireSearch() {
    const q = $('#q');
    const draw = () => {
      const query = q.value;
      $('#results').innerHTML = V.search(query).slice(0, 8).map((s, i) => {
        const cho = V.chosung(s.name);
        let nm = s.name;
        const at = cho.indexOf(query.trim());
        if (query.trim() && at >= 0) nm = s.name.slice(0, at) + '<mark>' + s.name.slice(at, at + query.trim().length) + '</mark>' + s.name.slice(at + query.trim().length);
        return `<li><button role="option" aria-selected="${i === 0}"><span><b>${nm}</b></span><span class="code">${s.code}</span><span class="mk">${s.market} ${s.kind}</span></button></li>`;
      }).join('') || '<li class="muted" style="padding:12px">맞는 종목이 없습니다. 코드 6자리로도 찾을 수 있습니다.</li>';
    };
    q.addEventListener('input', draw);
    draw();
  }

  function alertDialog() {
    const c = ctls[state.active];
    const last = c.bars[c.bars.length - 1].close;
    return `<div class="dialog alert-dlg" role="dialog" aria-modal="true" aria-labelledby="alT">
      <div class="dlg-head"><h2 id="alT">알림 만들기</h2><span class="ctx">${c.sym.name} ${c.cell.period}</span><span class="grow"></span><button class="icon-btn" data-close title="닫기 (Esc)">${icon('i-x')}</button></div>
      <div class="dlg-form">
        <div class="row"><span class="lbl">종류</span><div class="segbox"><button aria-pressed="false">가격 알림</button><button aria-pressed="true">지표 알림</button></div></div>
        <div class="row"><label>지표</label><select class="input wide"><option>RSI 14 (지표 패널 2)</option><option>이동평균 단순 20</option><option>MACD 12 26 9</option></select></div>
        <div class="row"><span class="lbl">조건</span><div class="segbox"><button aria-pressed="true">상향 돌파</button><button aria-pressed="false">하향 돌파</button><button aria-pressed="false">다른 지표와 교차</button></div></div>
        <div class="row"><label for="alV">값</label><input class="input num" id="alV" value="70"></div>
        <div class="row"><span class="lbl">반복</span><div class="radios"><label><input type="radio" name="rep" checked> 한 번 울리면 끄기</label><label><input type="radio" name="rep"> 매번 울리기</label></div></div>
        <div class="row"><span class="lbl">받을 곳</span><div class="checks"><label><input type="checkbox" checked> 텔레그램</label><label><input type="checkbox" checked> 화면 안 알림</label></div></div>
        <div class="note">지표 알림은 봉이 확정될 때만 판단합니다. 봉 중간에 잠깐 70을 넘었다 내려오면 울리지 않습니다. 가격 알림은 체결이 들어오는 즉시 판단합니다(지금 ${fmtPrice(last, c.sym.index)}).</div>
      </div>
      <div class="dlg-foot"><span class="hint">서버가 켜져 있는 동안 울립니다</span><span class="grow"></span><button class="btn" data-close>취소</button><button class="btn primary">알림 만들기</button></div></div>`;
  }

  // ---- 테마 ----
  function toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    const u = new URL(location.href); u.searchParams.set('theme', state.theme); location.replace(u); // 목업은 다시 그려 단순화한다
  }

  // ---- 키보드 ----
  addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) { if (e.key === 'Escape') closeDialog(); return; }
    if (e.key === 'Escape') return closeDialog();
    if (e.key === '/' || (e.ctrlKey && e.key.toLowerCase() === 'k')) { e.preventDefault(); return openDialog('search'); }
    if (e.key.toLowerCase() === 'i' && !e.ctrlKey) return openDialog('indicator');
    if (e.altKey && e.key.toLowerCase() === 'a') return openDialog('alert');
  });

  $('#symBtn').onclick = () => openDialog('search');
  $('#indBtn').onclick = () => openDialog('indicator');
  $('#cmpBtn').onclick = () => openDialog('compare');
  $('#alertBtn').onclick = () => openDialog('alert');
  $('#themeBtn').innerHTML = icon(state.theme === 'dark' ? 'i-sun' : 'i-moon');
  $('#themeBtn').onclick = toggleTheme;
  $('#watchCollapse').onclick = () => { const a = $('#app'); a.dataset.watch = a.dataset.watch === 'closed' ? 'open' : 'closed'; };
  $('#syncCross').onclick = (e) => { state.syncCross = !state.syncCross; e.currentTarget.setAttribute('aria-pressed', state.syncCross); };
  $('#syncScroll').onclick = (e) => { state.syncScroll = !state.syncScroll; e.currentTarget.setAttribute('aria-pressed', state.syncScroll); };
  $('#mTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tab === 'search') return openDialog('search');
    $('#app').dataset.sheet = b.dataset.tab === 'watch' ? 'watch' : '';
    $('#mTabs').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
  });

  renderTools(); renderArr(); setActive(0);
  if (params.get('sheet') === 'watch') $('#mTabs [data-tab="watch"]').click();
  if (params.get('dialog')) openDialog(params.get('dialog'));
  document.body.dataset.ready = '1';
})();
