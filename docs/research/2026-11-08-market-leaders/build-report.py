"""Build the offline study report from the three workers' evidence files."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def read(name: str):
    return json.loads((ROOT / name).read_text())


def main():
    market = read("market.json")
    # Daily alignment precedes weekly display sampling. Metrics always use daily data.
    indices = read("market-daily.json")
    if "series" not in indices:
        raise ValueError("market-daily.json must contain series")
    bundle = {"market": market, "research": {}, "series": [], "sources": []}
    hashes = {
        name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
        for name in ("market-daily.json", "report-template.html", "build-report.py")
    }
    for prefix in ("market", "kospi", "kosdaq"):
        for suffix in (".json", "-prices.json"):
            name = prefix + suffix
            hashes[name] = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
        doc = read(prefix + ".json")
        source_ids = {s["id"] for s in doc["sources"]}
        if len(source_ids) != len(doc["sources"]):
            raise ValueError(f"Duplicate source IDs in {prefix}")
        source_by_id = {s["id"]: s for s in doc["sources"]}
        for case in doc.get("cases", []):
            for snapshot in case.get("asOf", []):
                for source_id in snapshot["sourceIds"]:
                    published = source_by_id[source_id].get("published")
                    if not published or published > snapshot["date"]:
                        raise ValueError(f"Snapshot uses later or undated source: {source_id}")

        def scope(value):
            if isinstance(value, list):
                return [scope(x) for x in value]
            if isinstance(value, dict):
                out = {}
                for key, item in value.items():
                    if key == "sourceIds":
                        missing = set(item) - source_ids
                        if missing:
                            raise ValueError(f"Unresolved {prefix} references: {missing}")
                        out[key] = [prefix + ":" + x for x in item]
                    else:
                        out[key] = scope(item)
                return out
            return value

        scoped = scope(doc)
        if prefix == "market":
            bundle["market"] = scoped
        else:
            bundle["research"][prefix] = scoped
        for source in doc["sources"]:
            if not source["url"].startswith("https://"):
                raise ValueError("Every source needs an HTTPS URL")
            bundle["sources"].append({**source, "id": prefix + ":" + source["id"], "scope": prefix})
        prices = indices if prefix == "market" else read(prefix + "-prices.json")
        for original in prices["series"]:
            if prefix != "market" and original["id"] in ("kospi", "kosdaq"):
                continue
            points = original["points"]
            dates = [p["date"] for p in points]
            if len(dates) != len(set(dates)) or dates != sorted(dates):
                raise ValueError(f"Invalid dates: {original['id']}")
            for point in points:
                dt.date.fromisoformat(point["date"])
                if not math.isfinite(point["close"]) or point["close"] <= 0:
                    raise ValueError("Invalid price")
            item = {
                k: original.get(k)
                for k in ("id", "name", "code", "market", "sourceUrl", "priceBasis", "adjustments")
            }
            # Round display payload only; metric computation below retains original precision.
            item["points"] = [[p["date"], round(p["close"], 6)] for p in points]
            if prefix != "market":
                core = [p for p in points if "2020-01-01" <= p["date"] <= "2022-12-31"]
                peak = max(core, key=lambda p: p["close"])
                end22 = next(p for p in reversed(points) if p["date"] <= "2022-12-31")
                end23 = next(p for p in reversed(points) if p["date"] <= "2023-06-30")
                later = [p for p in points if peak["date"] < p["date"] <= "2023-06-30"]
                trough = min(later, key=lambda p: p["close"])
                item["auditMetrics"] = {
                    "peak": peak,
                    "end2022": end22,
                    "end2023H1": end23,
                    "postPeakTrough": trough,
                    "peakTo2022Pct": (end22["close"] / peak["close"] - 1) * 100,
                    "peakTo2023H1Pct": (end23["close"] / peak["close"] - 1) * 100,
                    "peakToTroughPct": (trough["close"] / peak["close"] - 1) * 100,
                }
            bundle["series"].append(item)
    for market_id in ("kospi", "kosdaq"):
        for case in bundle["research"][market_id]["cases"]:
            if not any(s["id"] == case["id"] for s in bundle["series"]):
                raise ValueError(f"Missing prices for {case['id']}")
            case["market"] = market_id
            case["selectionReason"] = case["selectionReason"].replace("사전 선정", "연구 대상으로 선정")
            actual = next(s["auditMetrics"] for s in bundle["series"] if s["id"] == case["id"])
            reported = case["metrics"]
            reported_peak = reported.get("peak", reported.get("peakClose2020to2022"))
            if reported_peak["date"] != actual["peak"]["date"] or not math.isclose(reported_peak["close"], actual["peak"]["close"], abs_tol=0.01):
                raise ValueError(f"Worker peak differs from daily observations: {case['id']}")
            for keys, actual_key in (
                (("peakTo2022Pct", "peakToEnd2022Pct"), "peakTo2022Pct"),
                (("peakTo2023H1Pct", "peakToEnd2023H1Pct"), "peakTo2023H1Pct"),
            ):
                expected = next(reported[k] for k in keys if k in reported)
                if not math.isclose(expected, actual[actual_key], abs_tol=0.00001):
                    raise ValueError(f"Worker percentage differs: {case['id']} {actual_key}")
    ids = [s["id"] for s in bundle["series"]]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate series")
    serialized = json.dumps(bundle, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    template = (ROOT / "report-template.html").read_text()
    if template.count("__REPORT_DATA__") != 1:
        raise ValueError("Template must have one data placeholder")
    report = template.replace("__REPORT_DATA__", serialized)
    if len(report.encode()) >= 512 * 1024:
        raise ValueError("Inline report must be below 512 KiB")
    (ROOT / "report.html").write_text(report)
    (ROOT / "report-data.json").write_text(json.dumps(bundle, ensure_ascii=False, indent=2))
    manifest = {
        "created": dt.datetime.now(dt.timezone.utc).isoformat(),
        "repositoryBaseSha": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "inputsSha256": hashes,
        "series": [{"id": s["id"], "dailyPoints": len(s["points"])} for s in bundle["series"]],
        "cases": sum(len(x["cases"]) for x in bundle["research"].values()),
        "sourceCount": len(bundle["sources"]),
        "htmlBytes": len(report.encode()),
        "reportSha256": hashlib.sha256(report.encode()).hexdigest(),
        "checks": ["source references resolve", "asOf sources were published before each snapshot", "positive finite unique sorted observations", "daily core peak and subsequent minimum recalculated", "worker peak dates/prices and endpoint percentages match independent recomputation", "offline single HTML below 512 KiB"],
    }
    (ROOT / "report-build.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
