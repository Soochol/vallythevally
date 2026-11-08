"""미리보기용 야후 일별 시세 수집. 사용: python3 -I fetch_yahoo.py <out_dir> <symbol>..."""
import json, sys, time, urllib.request, datetime as dt
UA = {"User-Agent": "Mozilla/5.0 (research-preview)"}
out = sys.argv[1]
start = int(dt.datetime(2019, 7, 1, tzinfo=dt.UTC).timestamp())
end = int(dt.datetime.now(dt.UTC).timestamp())
for sym in sys.argv[2:]:
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
           f"?period1={start}&period2={end}&interval=1d&events=div,split")
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        body = r.read()
    d = json.loads(body)
    meta = d["chart"]["result"][0]["meta"]
    fn = f"{out}/{sym.replace('^', 'IDX_')}.json"
    open(fn, "wb").write(body)
    print(sym, meta.get("shortName"), meta.get("exchangeName"), meta.get("currency"),
          "tz", meta.get("exchangeTimezoneName"), "->", fn)
    time.sleep(1.0)
