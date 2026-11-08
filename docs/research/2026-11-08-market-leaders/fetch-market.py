#!/usr/bin/env python3
"""Fetch public index closes and rebuild this worker's market artifacts only.

No third-party packages, credentials, environment files, server, or repo imports.
Use --offline to rebuild from the archived NAVER responses without network access.
"""

import argparse
import ast
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parent
ACCESSED = "2026-11-08"
API = "https://api.finance.naver.com/siseJson.naver?symbol={}&requestType=1&startTime=20190701&endTime=20230630&timeframe=day"
NAMES = {"KOSPI": "코스피", "KOSDAQ": "코스닥"}
BASIS = "NAVER 금융 반환 일반 지수의 거래일 종가(pt), 배당 재투자 미포함; 개별주식 수정주가 아님. 현재 시점 공급자 자료이며 과거 정정 이력/수정 플래그는 API에 없어 미확인."
SOURCES = [
    {"id": "naver-kospi", "title": "KOSPI 일별 시세 응답 2019-07-01~2023-06-30", "url": API.format("KOSPI"), "publisher": "NAVER 금융 (API 공급자; 상위 원천 계약 미확인)"},
    {"id": "naver-kosdaq", "title": "KOSDAQ 일별 시세 응답 2019-07-01~2023-06-30", "url": API.format("KOSDAQ"), "publisher": "NAVER 금융 (API 공급자; 상위 원천 계약 미확인)"},
    {"id": "official-yearend", "title": "e-나라지표 주가지수 연간 통계표", "url": "https://www.index.go.kr/unity/potal/eNara/sub/showStblGams3.do?freq=Y&idx_cd=1080&period=1980%3A2022&stts_cd=108001", "publisher": "국가지표체계/e-나라지표"},
    {"id": "bok-20200316", "title": "Bank of Korea announces 50bp Base Rate cut", "url": "https://www.bok.or.kr/eng/bbs/E0000634/view.do?menuNo=400069&nttId=10057026", "publisher": "한국은행"},
    {"id": "bok-20200528", "title": "통화정책방향(2020.5.28)", "url": "https://www.bok.or.kr/portal/bbs/P0000559/view.do?edate=&menuNo=200690&nttId=10058432&pageIndex=1&sdate=&searchCnd=1&searchWrd=%ED%86%B5%ED%99%94+%EB%B0%8F+%EC%9C%A0%EB%8F%99%EC%84%B1", "publisher": "한국은행"},
    {"id": "bok-20210826", "title": "통화정책방향(2021.8.26)", "url": "https://www.bok.or.kr/portal/bbs/P0000559/view.do?menuNo=200690&nttId=10066201&pageIndex=11", "publisher": "한국은행"},
    {"id": "bok-20220713", "title": "통화정책방향(2022.7.13)", "url": "https://www.bok.or.kr/portal/bbs/P0000559/view.do?menuNo=200690&nttId=10071639&pageIndex=1", "publisher": "한국은행"},
    {"id": "bok-20221124", "title": "통화정책방향(2022.11.24)", "url": "https://www.bok.or.kr/portal/bbs/P0000559/view.do?menuNo=200788&nttId=10074005", "publisher": "한국은행"},
    {"id": "fed-20200315", "title": "Federal Reserve issues FOMC statement (March 15, 2020)", "url": "https://www.federalreserve.gov/newsevents/pressreleases/monetary20200315a.htm", "publisher": "Federal Reserve"},
    {"id": "fed-20220316", "title": "Federal Reserve issues FOMC statement (March 16, 2022)", "url": "https://www.federalreserve.gov/newsevents/pressreleases/monetary20220316a.htm", "publisher": "Federal Reserve"},
    {"id": "krx-via-yonhap-2021", "title": "[표] 2021년 코스피·코스닥 기록 (한국거래소 자료, 연합뉴스 전재)", "url": "https://m.wowtv.co.kr/NewsCenter/News/Read?articleId=AKR20211230160100002", "publisher": "한국경제TV/연합뉴스 (KRX 원문 직접 확보 아님)"},
]
for source in SOURCES:
    source["accessed"] = ACCESSED

POLICY_FACTS = [
    {"date": "2020-03-15", "text": "[당시 발표·미국 현지일] 연준은 연방기금금리 목표범위를 0~0.25%로 낮춘다고 발표했다. 발표시각은 17:00 EDT로 한국시간 3월 16일 06:00이며 한국 거래일과 날짜를 구분한다.", "sourceIds": ["fed-20200315"]},
    {"date": "2020-03-16", "text": "[당시 발표] 한국은행은 기준금리 1.25%→0.75% 인하를 발표했고 시행일은 3월 17일이라고 명시했다. 발표일과 시행일은 다르다.", "sourceIds": ["bok-20200316"]},
    {"date": "2020-05-28", "text": "[당시 발표] 한국은행은 기준금리를 0.75%에서 0.50%로 내리기로 결정했다. 당시 의결문은 코로나19로 세계경제가 위축됐다고 진단했다.", "sourceIds": ["bok-20200528"]},
    {"date": "2021-08-26", "text": "[당시 발표] 한국은행은 기준금리를 0.50%에서 0.75%로 올리기로 결정했다. 이는 두 시장의 2021년 종가 정점일 이후 발표이나, 시간적 선후만으로 주가 전환의 원인이라고 할 수 없다.", "sourceIds": ["bok-20210826", "naver-kospi", "naver-kosdaq"]},
    {"date": "2022-03-16", "text": "[당시 발표·미국 현지일] 연준은 연방기금금리 목표범위를 0.25~0.50%로 올리고 추가 인상이 적절할 것으로 예상한다고 발표했다. 발표시각 14:00 EDT는 한국시간 3월 17일 03:00이다.", "sourceIds": ["fed-20220316"]},
    {"date": "2022-07-13", "text": "[당시 발표] 한국은행은 기준금리를 1.75%에서 2.25%로 인상했다. 의결문은 광범위한 물가 상승과 기대인플레이션을 정책 판단 근거로 제시했다.", "sourceIds": ["bok-20220713"]},
    {"date": "2022-11-24", "text": "[당시 발표] 한국은행은 기준금리를 3.00%에서 3.25%로 인상했다. 의결문은 높은 물가 오름세와 경기 둔화·단기금융시장 위축을 함께 언급했다.", "sourceIds": ["bok-20221124"]},
]
METHODOLOGY = [
    "연구 범위는 2020-01-01~2022-12-31; 가격 맥락은 2019-07-01~2023-06-30. 연간 수익률과 첫 구간의 시작값은 직전 연말 마지막 거래일 종가다.",
    "일별 응답 헤더의 종가 열을 읽는다. 고가·저가는 극값 산정에 사용하지 않는다. 날짜는 한국 거래소 거래일이며 비거래일을 보간하거나 0으로 채우지 않는다.",
    "market-prices.json은 ISO 주(월~일)별 실제 마지막 거래일 종가만 보존한다. 첫 주·마지막 주가 불완전해도 확보된 범위의 마지막 거래일을 사용한다. 주중 극값과 구간 경계는 주봉에 없을 수 있다.",
    "극값·구간 경계·고점 대비 낙폭은 압축 전 일별 종가에서 계산한다. market-daily.json 및 market-raw-*.txt로 모든 관측값을 보존한다.",
    "구간 수익률(%)=(종료 종가/시작 종가-1)×100. 최대낙폭(%)=min_t((종가_t/max_{s≤t} 종가_s-1)×100); 구간 양 끝 거래일을 모두 포함한다. 음수는 하락이며 0 이하로 보고한다.",
    "2021년 정점 대비 2022년 저점 낙폭은 2021년 각 시장 최고 종가를 기준으로 2022년 최저 종가까지 계산한다. 두 지수의 저점 날짜가 달라 공통 구간 수익률과 같은 값이 아니다.",
    "5개 구간은 사후 연구용 정의다. 공통 경계는 직전 연말·2020년 공통 종가 저점·2020년 말·코스피 2021년 종가 정점·2021년 말·2022년 말이다. 코스닥 정점은 별도 기록하며 코스피 정점일을 코스닥 정점일이라고 해석하지 않는다.",
    "정책 사실은 당일 공개된 결정문 발표일 기준으로 기록했다. 미국 날짜와 한국시간 환산을 병기했다. 당시 결정문 진술과 사후 시장 분할을 구분하며 정책·뉴스와 수익률의 인과관계를 추정하지 않는다.",
    "가격은 현재 시점 NAVER 응답의 일반 지수 종가다. 배당 재투자 총수익률을 계산하지 않으며 ETF 수익률·개별주식 수정종가와 구분한다. 수집 후 자체 수정주가 조정을 적용하지 않았다.",
    "모든 수익률·낙폭 단위는 %. 원본 종가는 pt. 계산은 원본 소수로 수행하고 JSON·본문 표시는 소수 둘째 자리 반올림. null은 미산출이며 0으로 대체하지 않는다.",
]
LIMITATIONS = [
    "일별 가격 공급자는 NAVER 금융이다. KRX 원본 일별 다운로드와 전수 교차검증은 하지 못했으며 NAVER의 상위 원천 계약·과거 정정 이력·수정 여부 플래그는 확인하지 못했다. 현재 제공되는 과거 자료이지 당시 보관본은 아니다.",
    "2019~2022 연말 종가는 국가지표체계 통계표와 대조했고 2021년 최고 종가·날짜는 KRX 자료를 인용한 연합뉴스 표와 대조했다. 이 검증은 일별 990개 관측값 전체의 공식 원천 대조를 대신하지 않는다.",
    "시장 breadth(상승·하락 종목수, 신고가 비율 등)는 미산출(null). 당시 전 종목 모집단·가중치·기업행사를 확보하지 않아 종목별 지수 기여도와 기여도 순위도 미산출(null). 지수 상승이 모든 종목 상승 또는 특정 종목의 전체 1위를 뜻하지 않는다.",
    "주봉 선형 연결은 관측점 사이를 잇는 표시일 뿐 중간 날의 관측값을 뜻하지 않는다. 2021년 정점·2020/2022년 저점 표와 툴팁은 일별 계산 파일의 날짜·종가를 우선 사용해야 한다.",
    "정점과 저점을 알고 나눈 사후 구간이며 실시간 매매 신호·당시 예측 가능성·인과 추론을 검증하지 않았다. 2023년 상반기는 맥락 자료로만 제공하고 2020~2022 주 분석에 합치지 않았다.",
]


def dump(name, value):
    (ROOT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def percent(start, end):
    return round((end / start - 1) * 100, 2)


def max_drawdown(points):
    high = points[0]
    result = {"percent": 0.0, "peakDate": high["date"], "peakClose": high["close"], "troughDate": high["date"], "troughClose": high["close"]}
    for point in points:
        if point["close"] > high["close"]:
            high = point
        loss = (point["close"] / high["close"] - 1) * 100
        if loss < result["percent"]:
            result = {"percent": loss, "peakDate": high["date"], "peakClose": high["close"], "troughDate": point["date"], "troughClose": point["close"]}
    result["percent"] = round(result["percent"], 2)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    daily, weekly, retrieval = [], [], []
    for symbol, name in NAMES.items():
        url = API.format(symbol)
        raw_path = ROOT / f"market-raw-{symbol.lower()}.txt"
        if not args.offline:
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
            raw_path.write_bytes(raw)
        raw = raw_path.read_bytes()
        rows = ast.literal_eval(raw.decode("utf-8-sig").strip())
        assert rows[0][0] == "날짜" and rows[0][4] == "종가"
        points = []
        for row in rows[1:]:
            day = dt.datetime.strptime(row[0], "%Y%m%d").date()
            close = float(row[4])
            assert math.isfinite(close) and close > 0 and day.weekday() < 5
            assert float(row[3]) <= close <= float(row[2])
            assert "2019-07-01" <= day.isoformat() <= "2023-06-30"
            points.append({"date": day.isoformat(), "close": close})
        assert points == sorted(points, key=lambda p: p["date"])
        assert len({p["date"] for p in points}) == len(points)
        assert points[0]["date"] == "2019-07-01" and points[-1]["date"] == "2023-06-30"
        assert len(points) == 990, "Historical coverage changed: review before accepting"
        iso_weeks = {}
        for point in points:
            iso = dt.date.fromisoformat(point["date"]).isocalendar()
            iso_weeks[(iso.year, iso.week)] = point
        compressed = list(iso_weeks.values())
        assert len(compressed) == 209
        assert all(point in points for point in compressed)
        base = {"id": symbol.lower(), "name": name, "sourceUrl": url, "priceBasis": BASIS}
        daily.append({**base, "points": points})
        weekly.append({**base, "points": compressed})
        retrieval.append({"id": symbol.lower(), "sourceUrl": url, "rawFile": raw_path.name, "sha256": hashlib.sha256(raw).hexdigest(), "dailyCount": len(points), "weeklyCount": len(compressed), "start": points[0]["date"], "end": points[-1]["date"]})
    assert [p["date"] for p in daily[0]["points"]] == [p["date"] for p in daily[1]["points"]]
    by_id = {s["id"]: {p["date"]: p["close"] for p in s["points"]} for s in daily}
    reference = {"2019-12-30": [2197.67, 669.83], "2020-12-30": [2873.47, 968.42], "2021-12-30": [2977.65, 1033.98], "2022-12-29": [2236.40, 679.29]}
    for date, values in reference.items():
        assert [by_id[s][date] for s in ["kospi", "kosdaq"]] == values
    definitions = [
        ("crash-2020", "급락: 직전 연말→2020년 종가 저점", "2019-12-30", "2020-03-19", "사후 관찰: 두 시장의 2020년 최저 종가일이 일치한다. 최저점을 당시 식별할 수 있었다는 뜻은 아니다.", ["bok-20200316", "fed-20200315"]),
        ("rebound-2020", "반등·확장: 2020년 저점→연말", "2020-03-19", "2020-12-30", "사후 관찰: 두 지수 모두 저점 이후 연말까지 크게 상승했다. 완화 정책은 당시 환경 자료이며 반등의 단독 원인으로 검증한 것은 아니다.", ["bok-20200528"]),
        ("extension-2021", "상승 연장: 2020년 말→코스피 정점", "2020-12-30", "2021-07-06", "사후 관찰: 코스피의 2021년 최고 종가일을 공통 경계로 썼다. 코스닥 최고 종가는 그 이후인 8월 9일이므로 양 시장의 정점은 동시가 아니다.", ["krx-via-yonhap-2021"]),
        ("divergence-2021", "정점 시차와 약화: 코스피 정점→2021년 말", "2021-07-06", "2021-12-30", "사후 관찰: 코스닥은 구간 안에서 8월 9일 정점을 기록했다. 구간의 시작·종료 수익률만으로 중간 경로와 종목별 주도력 변화를 판단할 수 없다.", ["bok-20210826"]),
        ("bear-2022", "약세: 2021년 말→2022년 말", "2021-12-30", "2022-12-29", "사후 관찰: 두 지수의 연간 수익률은 음수이며 연중 종가 저점 날짜도 다르다. 긴축·물가 관련 발표와 약세가 겹쳤지만 인과관계와 개별종목 기여도는 미추정이다.", ["fed-20220316", "bok-20220713", "bok-20221124"]),
    ]
    periods = []
    for pid, label, start, end, interpretation, source_ids in definitions:
        p = {"id": pid, "label": label, "start": start, "end": end, "interpretation": interpretation, "sourceIds": ["naver-kospi", "naver-kosdaq"] + source_ids}
        for sid in ["kospi", "kosdaq"]:
            p[sid + "StartClose"] = by_id[sid][start]
            p[sid + "EndClose"] = by_id[sid][end]
            p[sid + "Return"] = percent(by_id[sid][start], by_id[sid][end])
            window = [x for x in next(s for s in daily if s["id"] == sid)["points"] if start <= x["date"] <= end]
            p[sid + "MaxDrawdown"] = max_drawdown(window)
        periods.append(p)
    extremes, annual = {}, []
    for series in daily:
        sid = series["id"]
        select = lambda year: [p for p in series["points"] if p["date"].startswith(str(year))]
        low2020 = min(select(2020), key=lambda p: p["close"])
        high2021 = max(select(2021), key=lambda p: p["close"])
        low2022 = min(select(2022), key=lambda p: p["close"])
        extremes[sid] = {"low2020": low2020, "high2021": high2021, "low2022": low2022, "peak2021ToLow2022Percent": percent(high2021["close"], low2022["close"]), "peak2021ToEnd2022Percent": percent(high2021["close"], by_id[sid]["2022-12-29"]), "maxDrawdown2020to2022": max_drawdown([p for p in series["points"] if "2020-01-01" <= p["date"] <= "2022-12-31"])}
    assert extremes["kospi"]["high2021"] == {"date": "2021-07-06", "close": 3305.21}
    assert extremes["kosdaq"]["high2021"] == {"date": "2021-08-09", "close": 1060.0}
    for year, start, end in [(2020, "2019-12-30", "2020-12-30"), (2021, "2020-12-30", "2021-12-30"), (2022, "2021-12-30", "2022-12-29")]:
        annual.append({"year": year, "start": start, "end": end, **{sid: {"startClose": by_id[sid][start], "endClose": by_id[sid][end], "returnPercent": percent(by_id[sid][start], by_id[sid][end])} for sid in ["kospi", "kosdaq"]}})
    facts = list(POLICY_FACTS)
    for sid, name in [("kospi", "코스피"), ("kosdaq", "코스닥")]:
        for key, label in [("low2020", "2020년 최저 종가"), ("high2021", "2021년 최고 종가"), ("low2022", "2022년 최저 종가")]:
            extreme = extremes[sid][key]
            facts.append({"date": extreme["date"], "text": f"[사후 일별 계산] {name} {label}는 {extreme['close']:,.2f}pt. 장중 극값이 아니다.", "sourceIds": ["naver-" + sid] + (["krx-via-yonhap-2021"] if key == "high2021" else [])})
    summary = "2020년 3월 19일 종가 저점 이후 두 시장은 반등했으나 2021년 종가 정점은 코스피 7월 6일, 코스닥 8월 9일로 달랐다. 2022년 연간 가격수익률은 코스피 {:+.2f}%, 코스닥 {:+.2f}%였다. 구간은 사후 정의이며 주도 종목의 순위·breadth·지수 기여도는 이 자료로 판단하지 않는다.".format(annual[-1]["kospi"]["returnPercent"], annual[-1]["kosdaq"]["returnPercent"])
    result = {"summary": summary, "periods": periods, "facts": sorted(facts, key=lambda f: f["date"]), "sources": SOURCES, "methodology": METHODOLOGY, "limitations": LIMITATIONS, "annualReturns": annual, "extremes": extremes, "breadth": None, "indexContribution": None}
    dump("market-prices.json", {"series": weekly})
    dump("market-daily.json", {"series": daily})
    dump("market.json", result)
    metrics = {"accessed": ACCESSED, "priceBasis": BASIS, "sampling": "market-prices.json: ISO week last available trading day; all calculations: original daily close", "retrieval": retrieval, "annualReturns": annual, "extremes": extremes, "periods": periods, "validation": {"bothCalendarsEqual": True, "dailyCountEach": 990, "positiveFiniteUniqueSorted": True, "ohlcCloseBounds": True, "officialYearEndChecks": 8, "krxViaYonhap2021PeakChecks": 2, "breadth": None, "indexContribution": None}}
    dump("market-calculations.json", metrics)
    write_markdown(result, metrics)
    print(json.dumps({"status": "ok", "retrieval": retrieval, "annualReturns": annual, "extremes": extremes}, ensure_ascii=False, indent=2))


def write_markdown(report, metrics):
    lines = ["# 시장 사이클과 지수 가격: 2020~2022 파일럿", "", report["summary"], "", "분석·원문 확인일: 2026-11-08. 담당 범위는 시장 맥락과 지수 가격이며 최종 HTML 조립은 포함하지 않는다.", "", "## 실제 종가의 연말 비교", "", "수익률은 직전 연말 마지막 거래일 종가 대비 가격수익률이다. [e-나라지표 통계표](" + SOURCES[2]["url"] + ")의 2019~2022년 연말 값 8개와 일치한다.", "", "| 연도 | 시작→종료일 | 코스피 시작→종료(pt) | 수익률(%) | 코스닥 시작→종료(pt) | 수익률(%) |", "|---|---|---:|---:|---:|---:|"]
    for a in report["annualReturns"]:
        k, q = a["kospi"], a["kosdaq"]
        lines.append(f"| {a['year']} | {a['start']}→{a['end']} | {k['startClose']:,.2f}→{k['endClose']:,.2f} | {k['returnPercent']:+.2f} | {q['startClose']:,.2f}→{q['endClose']:,.2f} | {q['returnPercent']:+.2f} |")
    lines += ["", "## 종가 극값과 고점 대비 낙폭", "", "주봉의 고가·저가가 아니라 원 일별 **종가**의 극값이다. 2021년 정점 두 개는 [KRX 자료를 인용한 연합뉴스 표](" + SOURCES[-1]["url"] + ")와도 대조했다.", "", "| 지수 | 2020년 최저 종가 | 2021년 최고 종가 | 2022년 최저 종가 | 2021 정점→2022 저점(%) | 2021 정점→2022 연말(%) |", "|---|---|---|---|---:|---:|"]
    for sid, x in report["extremes"].items():
        format_extreme = lambda key: f"{x[key]['date']} / {x[key]['close']:,.2f}"
        lines.append(f"| {NAMES[sid.upper()]} | {format_extreme('low2020')} | {format_extreme('high2021')} | {format_extreme('low2022')} | {x['peak2021ToLow2022Percent']:.2f} | {x['peak2021ToEnd2022Percent']:.2f} |")
    lines += ["", "코스피는 2022-09-30, 코스닥은 2022-10-13이 각각 2022년 종가 저점이다. '두 시장의 바닥'을 한 날로 통합하지 않는다. 이 날짜들은 확보된 해당 연도 일별 관측치에서 선택한 사후 극값이다.", "", "## 다섯 연구 구간: 사후 분할", "", "첫 구간은 2020년 수익률 계산을 위해 2019년 최종 종가를 기준으로 삼는다. 공통 경계는 인접 구간이 같은 종가를 공유하며 일별 수익률을 중복 합산한 것이 아니다.", "", "| 구간 | 기준일→종료일 | 코스피 시작→종료(pt) | 수익률(%) | 코스닥 시작→종료(pt) | 수익률(%) |", "|---|---|---:|---:|---:|---:|"]
    for p in report["periods"]:
        lines.append(f"| {p['label']} | {p['start']}→{p['end']} | {p['kospiStartClose']:,.2f}→{p['kospiEndClose']:,.2f} | {p['kospiReturn']:+.2f} | {p['kosdaqStartClose']:,.2f}→{p['kosdaqEndClose']:,.2f} | {p['kosdaqReturn']:+.2f} |")
    lines += ["", *["- **" + p["label"] + "** — " + p["interpretation"] for p in report["periods"]], "", "구간별 최대낙폭의 기준 고점일·종가와 저점일·종가는 `market-calculations.json`의 `periods[].kospiMaxDrawdown` 및 `kosdaqMaxDrawdown`에 보존했다. 최대낙폭은 구간 종료 수익률과 다르다.", "", "## 당시 발표로 확인한 정책 환경", "", "아래는 현재의 설명으로 재구성한 원인 목록이 아니라 당시 결정문에 적힌 결정과 진단이다. 가격의 방향과 시간적으로 나란히 놓되 인과를 단정하지 않는다.", ""]
    source_map = {s["id"]: s for s in SOURCES}
    for fact in POLICY_FACTS:
        refs = ", ".join(f"[{source_map[s]['publisher']}]({source_map[s]['url']})" for s in fact["sourceIds"] if not s.startswith("naver"))
        lines.append(f"- {fact['date']}: {fact['text']} {refs}")
    lines += ["", "## 수집과 계산 재현", "", "표준 라이브러리만 사용하며 저장소 코드·자격증명·환경 파일을 읽지 않는다. 아래 명령은 보고서 폴더를 어디에 놓든 스크립트의 폴더 안에서 지정된 market 파일만 생성한다.", "", "```sh", "/usr/bin/python3 docs/research/2026-11-08-market-leaders/fetch-market.py", "# 네트워크 없이 보존한 원 응답에서 재계산", "/usr/bin/python3 docs/research/2026-11-08-market-leaders/fetch-market.py --offline", "# 별도 Decimal 계산과 주봉 전수 대조, 오프라인 재생성 검증", "/usr/bin/python3 docs/research/2026-11-08-market-leaders/market-validate.py", "```", "", "- `market-raw-kospi.txt`, `market-raw-kosdaq.txt`: 실제 HTTP 응답 원문(UTF-8), 헤더 포함. `ast.literal_eval`만 사용하며 `eval`은 사용하지 않는다.", "- `market-daily.json`: 시장별 일별 종가 990개, 2019-07-01~2023-06-30. `market-prices.json`: ISO 주별 마지막 실제 거래일만 추린 시각화용 자료.", "- `market-calculations.json`: 원문 SHA-256, 관측 수, 연말 값·수익률·극값·구간별 최대낙폭과 날짜.", "- `market.json`: HTML 조립에 사용할 요약, 5개 구간, 사건, 직접 열람 출처, 방법론과 한계. 수익률 단위 %; 미산출 null.", "- `market-validation.json`: 별도 Decimal 재계산·주별 마지막 거래일 전수 대조·오프라인 재생성 동일성 검증의 결과와 파일 SHA-256. 생성 스크립트 본문을 함께 보존한다.", "", "### 자체 검증", "", "두 시장의 날짜 배열 일치, 정렬·중복 없음, 양의 유한 종가, 일별 고저가 범위 안의 종가, 주말 제외, 시작/종료일 및 각 990행을 assert로 검사했다. e-나라지표 원문에서 확인한 연말 종가 8개와 KRX 자료를 인용한 연합뉴스 표의 2021년 정점 2개도 assert로 대조했다. 주봉은 모든 ISO 주의 마지막 원 관측값인지 확인하며, 일별 파일·주봉 파일·본문 표가 같은 수집/계산 코드에서 생성된다.", "", "구간 수익률 = `(endClose / startClose - 1) * 100`; 고점 대비 낙폭 = `(close / priorPeakClose - 1) * 100`. 원래 일별 소수값으로 계산한 뒤 표시만 반올림한다. 극값 탐색 대상은 `row[4]` 종가이며 `row[2]` 장중 고가나 `row[3]` 장중 저가를 대신 쓰지 않는다.", ""]
    for r in metrics["retrieval"]:
        lines.append(f"- {r['id']}: 일별 {r['dailyCount']}개 → 주별 {r['weeklyCount']}개; `{r['rawFile']}` SHA-256 `{r['sha256']}`.")
    lines += ["", "## 방법론", "", *["- " + m for m in METHODOLOGY], "", "## 한계와 미산출", "", *["- " + item for item in LIMITATIONS], "", "## 실제 열람한 직접 출처", ""]
    for s in SOURCES:
        lines.append(f"- `{s['id']}` — [{s['title']}]({s['url']}) · {s['publisher']} · 확인일 {s['accessed']}.")
    (ROOT / "market.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
