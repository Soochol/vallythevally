"""원자료 → 미리보기용 정렬 시계열 + 파생 지표. 모든 판정은 그날까지의 자료만 사용(인과적)."""
import json, sys, datetime as dt
KST = dt.timezone(dt.timedelta(hours=9))

def load(raw, sym):
    d = json.load(open(f"{raw}/{sym}.json"))["chart"]["result"][0]
    q = d["indicators"]["quote"][0]
    out = {}
    for t, c, h, l, v in zip(d["timestamp"], q["close"], q["high"], q["low"], q["volume"]):
        out[dt.datetime.fromtimestamp(t, KST).date().isoformat()] = (c, h, l, v)
    return out

def build(raw):
    K = load(raw, "IDX_KS11"); S = load(raw, "005930.KS"); E = load(raw, "091160.KS")
    peers = {p: load(raw, p) for p in ("000660.KS", "042700.KS", "000990.KS")}
    dates = sorted(d for d, r in K.items() if r[0] is not None)   # 기준 달력 = 코스피 관측일
    g = lambda M, d, i=0: (M.get(d) or (None,)*4)[i]
    close = [g(S, d) for d in dates]
    high = [g(S, d, 1) for d in dates]
    vol = [g(S, d, 3) for d in dates]
    # 거래량 0 또는 결측은 '미관측'(None). 0으로 채우지 않음.
    tv = [round(c*v/1e8) if (c is not None and v) else None for c, v in zip(close, vol)]  # 억원(추정)
    kospi = [g(K, d) for d in dates]
    etf = [g(E, d) for d in dates]
    # 동종 3종목 동일가중(매일 재조정) 지수, 자기(삼성전자) 제외
    basket = [100.0]
    for i in range(1, len(dates)):
        rets = []
        for M in peers.values():
            a, b = g(M, dates[i-1]), g(M, dates[i])
            if a and b: rets.append(b / a - 1)
        basket.append(basket[-1] * (1 + sum(rets)/len(rets)) if rets else basket[-1])
    # 이동평균 (결측일은 창에서 제외하지 않고 판정 보류)
    def ma(n):
        # 창 안 유효 관측이 95% 이상일 때만 계산(결측 1일이 n일 동안 판정을 막지 않도록)
        out = []
        for i in range(len(close)):
            w = [x for x in close[max(0, i-n+1):i+1] if x is not None]
            out.append(sum(w)/len(w) if i >= n-1 and len(w) >= 0.95*n else None)
        return out
    ma50, ma200 = ma(50), ma(200)
    def stages(bench):
        # 미리보기 판정 규칙(예시): 주도 = RS가 250일 고점 대비 -10% 이내 & 종가 > 200일선
        #                                  & 종가가 250일 최고 종가 대비 -25% 이내(지수 동반 급락 시 '덜 빠짐'을 주도로 오판 방지)
        #                           상실 = RS가 250일 고점 대비 -20% 이하 & 종가 < 200일선
        rs = [c/b if (c and b) else None for c, b in zip(close, bench)]
        raw_state = []
        for i in range(len(rs)):
            w = [x for x in rs[max(0, i-249):i+1] if x is not None]
            d = rs[i]/max(w) - 1 if rs[i] is not None and w else None
            c, m = close[i], ma200[i]
            pw = [x for x in close[max(0, i-249):i+1] if x is not None]
            if c is None or m is None or d is None: raw_state.append(None)
            elif d >= -0.10 and c > m and c >= 0.75*max(pw): raw_state.append("lead")
            elif d <= -0.20 and c < m: raw_state.append("lost")
            else: raw_state.append("mid")
        # 잡음 억제: 새 상태가 10관측일 연속이면 10번째 날부터 전환(그날까지 자료만 사용)
        state, cur, run_s, run_n = [], None, None, 0
        for s in raw_state:
            if s is not None:
                run_n = run_n + 1 if s == run_s else 1
                run_s = s
                if s != cur and run_n >= 10: cur = s
            state.append(cur)
        return state
    # 코스피 고점 대비 낙폭(그날까지의 최고 종가 기준)
    kdd, peak = [], 0
    for k in kospi:
        peak = max(peak, k); kdd.append(k/peak - 1)
    return dict(dates=dates, close=close, high=high, tv=tv, kospi=kospi, etf=etf, basket=basket,
                ma50=ma50, ma200=ma200, kdd=kdd,
                state={"kospi": stages(kospi), "etf": stages(etf), "basket": stages(basket)})

if __name__ == "__main__":
    D = build(sys.argv[1])
    for key, st in D["state"].items():
        print("==", key)
        segs, prev = [], object()
        for d, s in zip(D["dates"], st):
            if s != prev: segs.append([d, d, s]); prev = s
            else: segs[-1][1] = d
        for a, b, s in segs: print(f"  {a} ~ {b}  {s}")
