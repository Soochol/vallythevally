"""미리보기 HTML 생성.

사용: python3 -I scripts/build_preview.py <raw_dir> <raw_market_dir> <기존 report-data.json> <출력 html>...
"""
import json, sys, os, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import derive, market

raw_dir, raw_market, old_report, *outs = sys.argv[1:]
D = derive.build(raw_dir)
dates = D["dates"]
M = market.build(dates, D["kospi"], raw_market)

# --- 시장 지표 정렬 점검 ---
assert all(x is not None for x in M["kq"]), "코스닥 관측일 불일치"
assert M["rate"][dates.index("2022-07-13")] == 1.75 and M["rate"][dates.index("2022-07-14")] == 2.25  # 결정일 다음 관측일 반영
assert M["rate"][0] == 1.75  # 2018-11-30 결정값이 2019-07-01에 유효
for k in ("fx", "sox", "vix", "tnx"):  # 해외 값은 항상 한국 날짜보다 이전 현지일, 5일 이내
    assert all(sd is None or (sd < d and (dt.date.fromisoformat(d) - dt.date.fromisoformat(sd)).days <= 5)
               for sd, d in zip(M[k + "_d"], dates)), k
assert M["tnx"][dates.index("2026-06-22")] == 4.46 and M["fx"][dates.index("2026-06-22")] == 1540.64  # FRED 2026-06-18 값
lag = lambda k: [None if sd is None else (dt.date.fromisoformat(d) - dt.date.fromisoformat(sd)).days for sd, d in zip(M[k + "_d"], dates)]

# --- 기존 보고서(NAVER 가격)와 2021년 정점 대조 ---
i_s = dates.index("2021-01-11"); i_k = dates.index("2021-07-06")
assert D["close"][i_s] == 91000.0, D["close"][i_s]
assert abs(D["kospi"][i_k] - 3305.21) < 0.01, D["kospi"][i_k]
win = [i for i, d in enumerate(dates) if "2020-01-01" <= d <= "2022-12-31"]
assert max(win, key=lambda i: D["close"][i] or 0) == i_s
assert max(win, key=lambda i: D["kospi"][i]) == i_k

# --- 기존 연구에서 출처가 확인된 삼성전자 사건(재사용) ---
old = json.load(open(old_report))
case = next(c for c in old["research"]["kospi"]["cases"] if c["id"] == "samsung")
src = {s["id"]: s for s in old["sources"]}
events = []
for e in case["events"]:
    s = src[e["sourceIds"][0]]
    events.append({"date": e["date"], "title": e["title"], "detail": e["detail"],
                   "url": s["url"], "earnings": "실적" in e["title"]})

code = {"lead": "L", "mid": "M", "lost": "X", None: "_"}
r0 = lambda xs, n=0: [None if x is None else (round(x, n) if n else round(x)) for x in xs]
data = {
    "d": dates,
    "c": r0(D["close"]), "tv": D["tv"], "k": r0(D["kospi"], 2), "e": r0(D["etf"]),
    "b": r0(D["basket"], 3), "m50": r0(D["ma50"]), "m200": r0(D["ma200"]),
    "kdd": [round(x, 4) for x in D["kdd"]],
    "kq": r0(M["kq"], 2), "kgap": r0(M["kgap"], 4), "rv": r0(M["rv"], 4), "rate": M["rate"],
    "fx": r0(M["fx"], 1), "sox": r0(M["sox"], 1), "vix": r0(M["vix"], 2), "tnx": r0(M["tnx"], 3),
    "fxl": lag("fx"), "soxl": lag("sox"), "vixl": lag("vix"), "tnxl": lag("tnx"),
    "st": {k: "".join(code[s] for s in v) for k, v in D["state"].items()},
    "events": events,
    "cycles": [{"id": "a", "label": "2020~22 사이클", "start": "2020-01-01", "end": "2022-12-31"},
               {"id": "b", "label": "2024~26 사이클", "start": "2024-01-01", "end": "2026-12-31"}],
    "meta": {
        "accessed": "2026-11-08",
        "eventsNote": "사건 4건은 이전 연구(kingfish 2026-11-08-market-leaders)에서 공개일과 원문을 확인한 항목을 재사용했습니다. 2024~26 사이클 사건은 아직 조사하지 않았습니다.",
        "method": [
            "가격: Yahoo Finance chart API 일별 응답(005930.KS, ^KS11, 091160.KS, 000660.KS, 042700.KS, 000990.KS), 확인일 2026-11-08. 분할만 반영된 종가이며 배당은 더하지 않았습니다. 코스피도 가격지수라 종목·지수 모두 가격수익률 기준입니다.",
            "교차 확인: 2020~22 구간의 삼성전자 종가 정점(2021-01-11, 91,000원)과 코스피 종가 정점(2021-07-06, 3,305.21)이 이전 보고서의 NAVER 기준 값과 일치합니다. 2024년 이후 값은 아직 다른 원천과 대조하지 않았습니다.",
            "기준 달력은 코스피 관측일입니다. 거래일 순번을 x축으로 써서 주말·휴일 간격은 그리지 않습니다. 발표일이 휴일이면 다음 관측일에 표시합니다.",
            "결측: 삼성전자 종가 1일(2025-09-19)과 거래량 0으로 온 14일(2020-03-09, 2022년 2~3월 등)은 0으로 채우지 않고 비웠습니다. 섹터 ETF 종가 23일 결측일에는 해당 상대강도 선이 끊깁니다.",
            "거래대금은 종가×거래량으로 추정했습니다. 거래소 공식 거래대금이 아닙니다.",
            "동종 3종목: SK하이닉스·한미반도체·DB하이텍을 매일 동일가중으로 재조정한 지수(삼성전자 제외)입니다. 현재 시점에서 고른 구성이라 생존 편향이 있으며, 본 작업에서는 당시 상장 종목 기준으로 다시 정해야 합니다. 한미반도체 2022-04 액면분할 정지일은 수익률 0으로 처리됩니다.",
            "섹터 ETF(KODEX 반도체)의 구성종목과 비중은 확인하지 않았습니다. 공식 업종지수(KRX)는 로그인이 필요해 이번 미리보기에서 쓰지 않았습니다.",
            "이동평균은 창 안 유효 관측이 95% 이상일 때만 계산합니다. 결측 하루 때문에 200일 동안 판정이 멈추는 문제를 막기 위해서입니다.",
            "판정 규칙과 임계값(−10%, −20%, −25%, 10일 확인)은 화면 구조를 보여주기 위한 예시입니다. 민감도 점검 전이며, 매매 신호나 예측력 검증이 아닙니다.",
            "시장환경 기본 지표: 미국 10년 국채금리는 FRED DGS10(미 재무부 고정만기 수익률, 연준 H.15), 원/달러는 FRED DEXKOUS(뉴욕 정오 매입률, 연준 H.10)입니다. 확인일 2026-11-08. 미국 날짜가 한국 날짜보다 이전인 가장 최근 값을 쓰고, 5일보다 오래된 값은 이어 붙이지 않습니다. DEXKOUS는 주 단위로 공표되어 2026-11-05·06 값이 비어 있습니다. 읽기 막대에 현지 기준일을 함께 표시합니다.",
            "교차 확인: 2019-07~2026-10 공통일 기준 야후 ^TNX와 DGS10의 차이는 중앙값 0.006%p, 최대 0.086%p입니다. 야후 KRW=X와 DEXKOUS는 중앙값 0.3% 차이이고 1.5% 넘게 다른 날이 23일 있어, 원/달러는 FRED를 씁니다. 2026-06-18 원/달러(1,540.64원)와 10년물(4.46%)은 두 원천이 같은 수준을 보입니다.",
            "추가 지표: 코스닥(^KQ11)은 코스피와 같은 날 관측입니다. SOX·VIX(야후)는 미국 날짜가 한국 날짜보다 이전인 값을 씁니다.",
            "기준금리: 한국은행 기준금리 변경표(https://www.bok.or.kr/portal/singl/baseRate/list.do?dataSeCd=01&menuNo=200643, 확인일 2026-11-08). 표의 날짜가 결정일인지 효력일인지, 발표 시각이 언제인지를 하나하나 확인하지 않아 표의 날짜 다음 관측일부터 반영합니다. 2019~2025 변경 이력은 알려진 결정과 일치합니다.",
            "실현변동성은 코스피 일간 로그수익률 20개의 표본 표준편차×√252입니다. 거래소가 발표하는 VKOSPI(옵션 기대변동성)와 다른 지표입니다. 200일선 이격과 실현변동성은 계산 준비 기간(각 199·20관측일) 동안 비워 둡니다.",
            "뉴욕 정오 기준 원/달러는 서울 외환시장 종가(15:30)와 시각이 다릅니다. 서울 기준이 필요하면 ECOS 매매기준율로 바꿀 수 있습니다(인증키 필요).",
            "Yahoo·NAVER 등 공급자 자료는 각 이용 조건을 따라야 합니다. 이 파일은 개인 학습용 미리보기입니다.",
        ],
        "envMissing": [
            "외국인·기관 순매수(시장별): KRX 정보데이터시스템은 로그인이 필요합니다(이번 요청에 LOGOUT 응답). 이전 조사에서 KRX OpenAPI 목록의 투자자별 항목은 확인하지 못했습니다. 직접 로그인해 CSV를 내려받는 경로가 현실적입니다.",
            "시장 거래대금: KRX 집계값이 필요합니다. 야후 지수 거래량은 단위와 정의가 불분명해 대신 쓰지 않았습니다.",
            "상승·하락 종목 수, 200일선 위 종목 비율(breadth): 당시 상장된 전 종목의 일별 시세가 필요합니다(KRX). 사례 종목으로는 만들지 않습니다.",
            "VKOSPI: 야후에 없습니다(404). KRX 파생상품지수에서 확인해야 합니다. 실현변동성과는 다른 지표입니다.",
            "국고채 3년, 서울 기준 원/달러(매매기준율): 한국은행 ECOS 정식 인증키(무료 신청)가 필요합니다. 공개 sample 키는 요청당 10건이라 수집에 쓰지 않았습니다.",
            "신용융자 잔고·고객예탁금: 금융투자협회 통계가 후보이나 이번에는 확인하지 않았습니다.",
        ],
    },
}
html = open(os.path.join(os.path.dirname(__file__), "template.html"), encoding="utf-8").read()
payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
html = html.replace("/*__DATA__*/", payload)
for out in outs:
    open(out, "w", encoding="utf-8").write(html)
    print(out, f"{os.path.getsize(out)/1024:.0f} KB")
