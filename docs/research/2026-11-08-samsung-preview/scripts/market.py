"""시장환경 지표 → 한국 관측일(코스피 달력)에 정렬.

정렬 규칙(미래 정보 누설 방지):
- 한국 시장 값(코스피·코스닥): 같은 날.
- 해외 값(원/달러 FRED DEXKOUS, 미국 10년물 FRED DGS10, SOX, VIX): 현지 날짜가 한국 날짜보다 '엄격히 이전'인
  가장 최근 값. 한국 장 마감(15:30 KST) 뒤에 확정되는 값을 같은 한국 날짜에 붙이지 않는다.
  그 값이 5일보다 오래되면(미공표·휴장 장기화) 이어 붙이지 않고 비운다.
- 기준금리: 결정일의 발표 시각을 하나하나 확인하지 않았으므로 결정일 '다음' 한국 관측일부터 반영.
"""
import csv, json, re, math, datetime as dt
from zoneinfo import ZoneInfo

MAX_STALE_DAYS = 5


def load_fred(path):
    rows = []
    for r in csv.DictReader(open(path)):
        k = [c for c in r if c != "observation_date"][0]
        if r[k] not in ("", "."):  # FRED 결측 표기
            rows.append((r["observation_date"], float(r[k])))
    rows.sort()
    return rows


def load_yahoo(path):
    d = json.load(open(path))["chart"]["result"][0]
    tz = ZoneInfo(d["meta"]["exchangeTimezoneName"])
    q = d["indicators"]["quote"][0]
    rows = []
    for t, c in zip(d["timestamp"], q["close"]):
        if c is None:
            continue
        rows.append((dt.datetime.fromtimestamp(t, tz).date().isoformat(), c))
    rows.sort()
    return rows


def align_same_day(dates, rows):
    m = dict(rows)
    return [m.get(d) for d in dates]


def align_prior(dates, rows, max_stale=None):
    """각 한국 날짜 D에 대해 현지 날짜 < D 인 마지막 값과 그 관측일. max_stale일보다 오래되면 비움."""
    out, src, j, last, last_d = [], [], 0, None, None
    for d in dates:
        while j < len(rows) and rows[j][0] < d:
            last_d, last = rows[j]
            j += 1
        stale = last_d is not None and max_stale is not None and \
            (dt.date.fromisoformat(d) - dt.date.fromisoformat(last_d)).days > max_stale
        out.append(None if stale else last)
        src.append(None if stale else last_d)
    return out, src


def parse_bok(path):
    h = open(path, encoding="utf-8", errors="replace").read()
    changes = []
    for r in re.findall(r"<tr[^>]*>(.*?)</tr>", h, re.S):
        cells = [re.sub(r"<[^>]+>|\s+", " ", c).strip() for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", r, re.S)]
        if len(cells) == 3 and re.fullmatch(r"\d{4}", cells[0]):
            m = re.fullmatch(r"(\d{2})월 (\d{2})일", cells[1])
            if m:
                changes.append((f"{cells[0]}-{m.group(1)}-{m.group(2)}", float(cells[2])))
    changes.sort()
    return changes


def align_rate(dates, changes):
    """결정일 다음 관측일부터 반영. (값, 해당 결정일) 반환."""
    out, src = [], []
    for d in dates:
        eff = [c for c in changes if c[0] < d]
        out.append(eff[-1][1] if eff else None)
        src.append(eff[-1][0] if eff else None)
    return out, src


def build(dates, kospi, raw_market):
    kq = align_same_day(dates, load_yahoo(f"{raw_market}/IDX_KQ11.json"))
    fx, fx_d = align_prior(dates, load_fred(f"{raw_market}/FRED_DEXKOUS.csv"), MAX_STALE_DAYS)
    sox, sox_d = align_prior(dates, load_yahoo(f"{raw_market}/IDX_SOX.json"), MAX_STALE_DAYS)
    vix, vix_d = align_prior(dates, load_yahoo(f"{raw_market}/IDX_VIX.json"), MAX_STALE_DAYS)
    tnx, tnx_d = align_prior(dates, load_fred(f"{raw_market}/FRED_DGS10.csv"), MAX_STALE_DAYS)
    changes = parse_bok(f"{raw_market}/bok-base-rate.html")
    rate, rate_d = align_rate(dates, changes)
    # 코스피 200일선 이격과 20일 실현변동성(연율, 로그수익률 표준편차 × √252) — 그날까지 자료만
    gap, rv = [], []
    for i in range(len(dates)):
        w = kospi[max(0, i - 199):i + 1]
        gap.append(kospi[i] / (sum(w) / len(w)) - 1 if i >= 199 else None)
        if i >= 20:
            r = [math.log(kospi[j] / kospi[j - 1]) for j in range(i - 19, i + 1)]
            rv.append(statistics_stdev(r) * math.sqrt(252))
        else:
            rv.append(None)
    return dict(kq=kq, fx=fx, fx_d=fx_d, sox=sox, sox_d=sox_d, vix=vix, vix_d=vix_d, tnx=tnx, tnx_d=tnx_d,
                rate=rate, rate_d=rate_d, rate_changes=changes, kgap=gap, rv=rv)


def statistics_stdev(xs):
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))
