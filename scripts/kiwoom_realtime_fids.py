#!/usr/bin/env python3
import argparse
import json
import re
import sys

SPEC_COMMIT = "c7a3d25449ed4b4238bef378780c41103c67b9e9"
SPEC_URL = (
    "https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/"
    f"{SPEC_COMMIT}/kiwoom/_data/kiwoom_api_spec.json"
)
REAL_TYPES = ["0B", "0D", "0w", "0F", "1h", "0H", "0E", "0g", "0J", "0U", "0s"]

TEXT_NAME = re.compile(
    r"시간$|시각$|거래원\d+$|거래원코드|거래원색깔|종목명|종목코드|구분|ticker"
    r"|임의연장|통화단위|증거금율표시|종목정보|Extra Item|조기종료ELW발생|VI적용구분"
)
FLOAT_NAME = re.compile(r"율|강도")
FLOAT_OVERRIDES = {
    "0J": {10, 11, 16, 17, 18},
    "0U": {10, 11},
}


def kind_of(real_type, fid, name):
    if TEXT_NAME.search(name):
        return "text"
    if FLOAT_NAME.search(name) or fid in FLOAT_OVERRIDES.get(real_type, ()):
        return "float"
    return "int"


def extract(spec_path):
    with open(spec_path, encoding="utf-8") as stream:
        apis = json.load(stream)["apis"]
    found = {}
    for title, api in apis.items():
        match = re.search(r"\((\w+)\)$", title)
        if not match or match.group(1) not in REAL_TYPES:
            continue
        if "실시간시세" not in api["meta"].get("메뉴 위치", ""):
            continue
        real_type = match.group(1)
        fids = []
        seen = set()
        for row in api["response"]["body"]:
            if row["depth"] != 2:
                continue
            fid = int(row["element"])
            if fid in seen:
                raise SystemExit(f"{real_type}의 FID {fid}가 두 번 나온다")
            seen.add(fid)
            fids.append({"fid": fid, "name": row["한글명"], "kind": kind_of(real_type, fid, row["한글명"])})
        found[real_type] = {"type": real_type, "name": title.rsplit("(", 1)[0], "fids": fids}
    missing = [t for t in REAL_TYPES if t not in found]
    if missing:
        raise SystemExit(f"명세에 없는 타입: {missing}")
    return {"spec": SPEC_URL, "types": [found[t] for t in REAL_TYPES]}


def markdown(table):
    lines = []
    for entry in table["types"]:
        lines.append(f"### {entry['type']} {entry['name']}")
        lines.append("")
        lines.append("| 열 | 형 | FID | 키움 이름 |")
        lines.append("|---|---|---|---|")
        for column in entry["fids"]:
            lines.append(f"| `f{column['fid']}` | {SQL_KIND[column['kind']]} | {column['fid']} | {column['name']} |")
        lines.append("")
    return "\n".join(lines)


SQL_KIND = {"int": "정수", "float": "실수", "text": "문자"}


def main():
    parser = argparse.ArgumentParser(description="키움 REST API 명세에서 수집기가 받는 열한 실시간 타입의 FID 표를 뽑는다.")
    parser.add_argument("spec")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--json", action="store_true")
    mode.add_argument("--markdown", action="store_true")
    arguments = parser.parse_args()
    table = extract(arguments.spec)
    if arguments.json:
        json.dump(table, sys.stdout, ensure_ascii=False, indent=1)
        sys.stdout.write("\n")
    else:
        sys.stdout.write(markdown(table))


if __name__ == "__main__":
    main()
