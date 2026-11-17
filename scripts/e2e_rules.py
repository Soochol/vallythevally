#!/usr/bin/env python3
import json
from pathlib import Path
import re
import sys


E2E_DIRECTORY = "web/e2e"
BASELINE_FILE = "rules-baseline.json"
STANDARD = "docs/e2e-tests.md"

FIX_STATE_WAIT = "상태·이벤트를 기다리거나(`expect`, `expect.poll`, `scenario.hold`), 시간 경과를 보는 시험은 `page.clock`, 실제 시간이 필요하면 `harness.ts`의 `fixedWait(page, ms, 이유)`를 쓴다"
FIX_FRESH_STATE = "시험마다 `scenario` fixture로 상태를 새로 만든다(`fullyParallel`)"
FIX_SPLIT = "30초 예산을 넘는 시험은 그룹별 시험으로 나눈다(PR #447 방식)"

RULES = {
    "waitForTimeout": {"pattern": re.compile(r"waitForTimeout\b"), "files": lambda path: path != "harness.ts", "fix": FIX_STATE_WAIT},
    "serial": {"pattern": re.compile(r"\.\s*serial\b|\[\s*[\"'`]serial[\"'`]\s*\]|\bmode\s*:\s*[\"'`]serial[\"'`]"), "files": lambda path: True, "fix": FIX_FRESH_STATE},
    "beforeAll-afterAll": {"pattern": re.compile(r"\b(beforeAll|afterAll)\b"), "files": lambda path: True, "fix": FIX_FRESH_STATE},
    "module-variable": {"pattern": re.compile(r"^(export\s+)?(let|var)\s", re.MULTILINE), "files": lambda path: path.endswith(".spec.ts"), "fix": FIX_FRESH_STATE},
    "test-timeout": {"pattern": re.compile(r"\btest\s*\.\s*(setTimeout|slow)\s*\(|\b(testInfo|info|test\s*\.\s*info\s*\(\s*\))\s*\.\s*setTimeout\s*\(|\bdescribe\.configure\s*\([^;]*?\btimeout\b"), "files": lambda path: True, "fix": FIX_SPLIT},
}


def find_violations(root):
    directory = Path(root) / E2E_DIRECTORY
    found = []
    for path in sorted(directory.rglob("*.ts")):
        relative = path.relative_to(directory).as_posix()
        text = path.read_text()
        for rule, spec in RULES.items():
            if not spec["files"](relative):
                continue
            for match in spec["pattern"].finditer(text):
                found.append({"rule": rule, "file": relative, "line": text.count("\n", 0, match.start()) + 1, "fix": spec["fix"]})
    return found


def check(root):
    baseline = json.loads((Path(root) / E2E_DIRECTORY / BASELINE_FILE).read_text())
    found = find_violations(root)
    lines = {}
    for violation in found:
        lines.setdefault((violation["rule"], violation["file"]), []).append(violation)
    problems = []
    keys = set(lines) | {(rule, file) for rule, files in baseline.items() for file in files}
    for rule, file in sorted(keys):
        actual = lines.get((rule, file), [])
        allowed = baseline.get(rule, {}).get(file, 0)
        if len(actual) > allowed:
            for violation in actual:
                problems.append(f"{E2E_DIRECTORY}/{file}:{violation['line']} [{rule}] 허용 {allowed}곳, 실제 {len(actual)}곳. {violation['fix']}. 기준은 {STANDARD}")
        elif len(actual) < allowed:
            problems.append(f"{E2E_DIRECTORY}/{file} [{rule}] 허용 목록을 {len(actual)}으로 낮춘다. {E2E_DIRECTORY}/{BASELINE_FILE}에서 {allowed}를 {len(actual)}으로 고친다")
    return problems


def main(root=Path(__file__).resolve().parent.parent):
    problems = check(root)
    for problem in problems:
        print(problem)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
