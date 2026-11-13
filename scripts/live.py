import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request

import evidence


SYMBOL = "005930"


def read_key(path=None):
    if path is None:
        return os.environ.get("OPENDART_API_KEY", "").strip()
    for line in Path(path).read_text().splitlines():
        name, separator, value = line.partition("=")
        if separator and name.strip() == "OPENDART_API_KEY":
            return value.strip().strip('"').strip("'")
    return ""


def isolated_environment():
    names = ("PATH", "HOME", "LANG", "LC_ALL", "TZ", "DISPLAY", "XAUTHORITY", "PLAYWRIGHT_BROWSERS_PATH", "LD_LIBRARY_PATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "CARGO_HOME", "RUSTUP_HOME", "VALLY_DEV_CACHE_DIR")
    return {name: os.environ[name] for name in names if name in os.environ}


Process = evidence.Process


def get(base, route, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("실원천 검증 최대 시간 초과")
    try:
        with urllib.request.urlopen(base + route, timeout=min(15, remaining)) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 503:
            return {"status": "starting"}
        raise ValueError(f"앱 HTTP 실패: {error.code}") from None


def summary(page):
    return {"status": page.get("status"), "failure": page.get("failure"), "reason": page.get("reason"), "corp_code": page.get("corpCode"), "series": [{"metric": series["metric"], "available": sum(point.get("status") == "available" and point.get("value") is not None for point in series["points"]), "states": sorted({point["status"] for point in series["points"]}), "reasons": sorted({point["reason"] for point in series["points"] if point.get("reason")})} for series in page.get("series", [])]}


def collect(base, mode, deadline, result):
    for poll in range(300):
        if time.monotonic() >= deadline:
            break
        if "identity" not in result:
            snapshot = get(base, f"/api/symbols/{SYMBOL}/financial-source", deadline)
            security = snapshot.get("security")
            if security:
                result["identity"] = {"stock": security["stock_code"], "corp_code": security["company"]["corp_code"], "evidence": security["evidence"]}
                if mode == "connect":
                    result.update(status="connected", collection="not_verified", ui="not_run")
                    return None
            elif snapshot.get("status") not in ("starting", "collecting"):
                result["source"] = {key: snapshot.get(key) for key in ("status", "failure", "reason")}
                raise ValueError("회사 식별 실패: result.json의 source 상태를 확인하세요")
        if "identity" in result:
            page = get(base, f"/api/symbols/{SYMBOL}/financials?period=Y", deadline)
            state = summary(page)
            result.setdefault("polls", []).append(state)
            if state["status"] == "ready":
                revenue = next((series for series in state["series"] if series["metric"] == "revenue"), {})
                if not revenue.get("available"):
                    raise ValueError("수집 종료 후 available 매출액이 없습니다")
                result["api"] = state
                return page
            if state["status"] not in ("starting", "collecting"):
                result["api"] = state
                raise ValueError("수집이 완전한 ready 상태에 이르지 못했습니다")
        time.sleep(min(2, max(0, deadline - time.monotonic())))
    raise TimeoutError("실원천 검증 시간/조회 횟수 상한에 도달했습니다")


def run_live(root, args, web):
    command = ["web.py", "live", "--mode", args.mode, "--timeout", str(args.timeout), *(["--headed"] if args.headed else []), *(["--key-file", "[path omitted]"] if args.key_file else [])]
    with evidence.Run(root, "live", command) as record:
        record.plan("key", "server", "dependencies", "wasm", "types", "ui", "source", "chromium")
        result = {"status": "failed", "mode": args.mode, "symbol": SYMBOL, "fresh_database": True, "limits": {"source_seconds": args.timeout, "app_polls": 300, "dart_requests_upper_bound": args.timeout * 4 + 2, "refresh_posts": 0}, "scope": "isolated financial service + real OpenDART"}
        record.result = result
        processes = []
        try:
            with record.step("key"):
                key = read_key(args.key_file)
                if not key:
                    result["status"] = "not_configured"
                    raise ValueError("OPENDART_API_KEY가 없습니다. 환경변수 또는 --key-file을 명시하세요")
                evidence.SECRETS.add(key)
            environment = web.environment_for(root, record.directory / "tmp")
            environment = {name: value for name, value in environment.items() if name in isolated_environment() or name in ("TMPDIR", "CARGO_TARGET_DIR", "CARGO_BUILD_JOBS")}
            web.prepare_dart(root, environment, record)
            if args.mode == "full":
                web.prepare_e2e(root, environment, record)
            deadline = time.monotonic() + args.timeout
            state = record.directory / "state"
            state.mkdir(mode=0o700)
            record.verify()
            binaries = record.directory / "bin"
            child_environment = {**environment, "LD_LIBRARY_PATH": str(binaries), "OPENDART_API_KEY": key, "VALLY_FINANCIAL_DB_PATH": str(state / "financials.db"), "VALLY_STATIC_DIR": str(record.directory / "dist")}
            server = Process([str(binaries / "dart-smoke")], child_environment, record.directory / "server.log", record)
            processes.append(server)
            base = server.address(deadline)
            with record.step("source"):
                page = collect(base, args.mode, deadline, result)
                if page is not None:
                    (record.directory / "api.json").write_text(evidence.clean(json.dumps(page, ensure_ascii=False, indent=2)))
            if args.mode == "full":
                with record.step("chromium") as step:
                    web.verify_ui(root, record)
                    command = ["node", str(root / "scripts/chromium.mjs"), "ui", str(root), str(record.directory), base, "yes" if args.headed else "no"]
                    step["command"] = [evidence.clean(arg) for arg in command]
                    evidence.bounded(command, environment, 120)
                    web.verify_ui(root, record)
                    browser = json.loads((record.directory / "browser.json").read_text())
                    result.update(status="passed", ui=browser)
        except BaseException as error:
            result.update(evidence.failure(error))
            if result["status"] != "not_configured":
                result["status"] = "failed"
            raise
        finally:
            for process in reversed(processes):
                process.stop()
            (record.directory / "result.json").write_text(evidence.clean(json.dumps(result, ensure_ascii=False, indent=2)) + "\n")
            record.data["results"].update(summary=str(record.directory / "result.json"), source_status=result["status"])
            print(json.dumps({"status": result["status"], "mode": args.mode, "result": str(record.directory / "result.json")}))
