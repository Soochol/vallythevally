#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

SOURCE_SCHEMA_VERSION = 1
OUTPUT_SCHEMA_VERSION = 1
DEFAULT_OUTPUT = Path(__file__).resolve().parent.parent / "crates/server/data/etf/funds.json"


def convert(source):
    if source.get("schemaVersion") != SOURCE_SCHEMA_VERSION:
        raise SystemExit(f"지원하지 않는 스냅샷 버전: {source.get('schemaVersion')}")
    funds = [
        {
            "code": fund["code"],
            "name": fund["name"],
            "issuer": fund["issuer"],
            "style": fund["style"],
            "benchmark": fund["benchmark"],
            "holdings": [{"code": h["code"], "weightBps": h["weightBps"]} for h in fund["holdings"]],
        }
        for fund in source["funds"]
    ]
    stocks = {code: source["stocks"][code]["name"] for code in sorted(source["stocks"])}
    return {"schemaVersion": OUTPUT_SCHEMA_VERSION, "holdingsAsOf": source["holdingsAsOf"], "funds": funds, "stocks": stocks}


def render(data):
    line = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    funds = ",\n".join("    " + line(fund) for fund in data["funds"])
    stocks = ",\n".join(f"    {line(code)}:{line(name)}" for code, name in data["stocks"].items())
    return (
        "{\n"
        f'  "schemaVersion": {data["schemaVersion"]},\n'
        f'  "holdingsAsOf": {line(data["holdingsAsOf"])},\n'
        f'  "funds": [\n{funds}\n  ],\n'
        f'  "stocks": {{\n{stocks}\n  }}\n'
        "}\n"
    )


def main():
    parser = argparse.ArgumentParser(description="hoga-ops ETF 스냅샷을 서버 내장 자료 형식으로 바꾼다. 자세한 내용은 docs/etf-api.md")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path, nargs="?", default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    data = convert(json.loads(args.source.read_text(encoding="utf-8")))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render(data), encoding="utf-8")
    holdings = sum(len(f["holdings"]) for f in data["funds"])
    print(f"{args.output}: ETF {len(data['funds'])}개, 종목 {len(data['stocks'])}개, 편입 {holdings}건, 구성 기준일 {data['holdingsAsOf']}")


if __name__ == "__main__":
    main()
