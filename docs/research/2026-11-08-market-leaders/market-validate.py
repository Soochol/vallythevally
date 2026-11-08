#!/usr/bin/env python3
"""Independently verify the market research artifacts using archived data only."""

from decimal import Decimal, ROUND_HALF_UP
import datetime as dt
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
OUTPUTS = ["market.json", "market-prices.json", "market-daily.json", "market-calculations.json", "market.md"]


def read(name):
    return json.loads((ROOT / name).read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pct(a, b):
    return float(((Decimal(str(b)) / Decimal(str(a)) - 1) * 100).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def main():
    generator = [sys.executable, str(ROOT / "fetch-market.py"), "--offline"]
    first = subprocess.run(generator, capture_output=True, text=True, check=True)
    assert json.loads(first.stdout)["status"] == "ok"
    original = {name: digest(ROOT / name) for name in OUTPUTS}
    subprocess.run(generator, capture_output=True, text=True, check=True)
    assert original == {name: digest(ROOT / name) for name in OUTPUTS}
    data, prices, report, calculations = (read(name) for name in ["market-daily.json", "market-prices.json", "market.json", "market-calculations.json"])
    assert set(prices) == {"series"}
    assert len(prices["series"]) == 2 and len(report["periods"]) == 5
    source_ids = {s["id"] for s in report["sources"]}
    assert len(source_ids) == len(report["sources"])
    for entry in report["periods"] + report["facts"]:
        assert set(entry["sourceIds"]) <= source_ids
    assert report["breadth"] is None and report["indexContribution"] is None
    all_points = {s["id"]: s["points"] for s in data["series"]}
    checks = []
    for weekly in prices["series"]:
        sid = weekly["id"]
        daily = all_points[sid]
        points = {p["date"]: p["close"] for p in daily}
        assert len(points) == 990
        expected = {}
        for point in daily:
            iso_year, iso_week, _ = dt.date.fromisoformat(point["date"]).isocalendar()
            expected[(iso_year, iso_week)] = point
        assert weekly["points"] == list(expected.values())
        assert len(weekly["points"]) == 209
        for period in report["periods"]:
            assert points[period["start"]] == period[sid + "StartClose"]
            assert points[period["end"]] == period[sid + "EndClose"]
            assert pct(points[period["start"]], points[period["end"]]) == period[sid + "Return"]
            sample = [Decimal(str(p["close"])) for p in daily if period["start"] <= p["date"] <= period["end"]]
            # Exhaustive prior-pair check is independent of the generator's running maximum.
            worst = min((sample[j] / sample[i] - 1) * 100 for j in range(len(sample)) for i in range(j + 1))
            rounded = float(worst.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
            assert rounded == period[sid + "MaxDrawdown"]["percent"]
            dd = period[sid + "MaxDrawdown"]
            assert dd["peakDate"] <= dd["troughDate"]
            assert points[dd["peakDate"]] == dd["peakClose"]
            assert points[dd["troughDate"]] == dd["troughClose"]
            assert pct(dd["peakClose"], dd["troughClose"]) == dd["percent"]
        for year in report["annualReturns"]:
            assert pct(points[year["start"]], points[year["end"]]) == year[sid]["returnPercent"]
        for year, kind, key in [(2020, min, "low2020"), (2021, max, "high2021"), (2022, min, "low2022")]:
            sample = [p for p in daily if p["date"].startswith(str(year))]
            assert kind(sample, key=lambda p: p["close"]) == report["extremes"][sid][key]
        ext = report["extremes"][sid]
        assert pct(ext["high2021"]["close"], ext["low2022"]["close"]) == ext["peak2021ToLow2022Percent"]
        assert pct(ext["high2021"]["close"], points["2022-12-29"]) == ext["peak2021ToEnd2022Percent"]
        retrieved = next(r for r in calculations["retrieval"] if r["id"] == sid)
        assert digest(ROOT / retrieved["rawFile"]) == retrieved["sha256"]
        checks.append({"id": sid, "daily": len(daily), "weekly": len(weekly["points"]), "periodReturnsDecimalChecked": 5, "maxDrawdownsExhaustivelyChecked": 5, "annualReturnsDecimalChecked": 3, "extremesChecked": 3, "rawHashMatched": True})
    files = OUTPUTS + ["fetch-market.py", "market-validate.py", "market-raw-kospi.txt", "market-raw-kosdaq.txt"]
    result = {"status": "passed", "verifiedDate": "2026-11-08", "command": "/usr/bin/python3 docs/research/2026-11-08-market-leaders/market-validate.py", "pythonVersion": sys.version, "offlineRegenerationByteIdentical": True, "sourceReferencesResolve": True, "checks": checks, "filesSha256": {name: digest(ROOT / name) for name in files}, "scope": "원본 대조 8개 연말 값·2개 정점은 별도 원문 수동 확인. 이 검증은 저장된 일별 자료의 계산·주별 압축·재현성을 검증하며 전체 990행의 KRX 원본 진위를 증명하지 않는다."}
    (ROOT / "market-validation.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
