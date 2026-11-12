import json
import os
from pathlib import Path
import re
import subprocess
import threading
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


class Process:
    def __init__(self, command, environment, log, record):
        self.started = time.monotonic()
        self.log = log
        self.child = evidence.spawn(command, env=environment, cwd=record.root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.entry = {"command": command, "pid": self.child.pid, "log": str(log), "execution": "direct", "status": "running"}
        record.data.setdefault("processes", []).append(self.entry)
        self.lines = ""
        def drain():
            with log.open("w") as stream:
                for line in self.child.stdout:
                    line = evidence.clean(line)
                    self.lines = (self.lines + line)[-65536:]
                    stream.write(line)
                    stream.flush()
        self.thread = threading.Thread(target=drain, daemon=True)
        self.thread.start()
        record.save()

    def address(self, deadline):
        until = min(deadline, time.monotonic() + 30)
        while time.monotonic() < until:
            match = re.search(r"addr=127\.0\.0\.1:(\d+)", self.lines)
            if match:
                return f"http://127.0.0.1:{match[1]}"
            if self.child.poll() is not None:
                raise ValueError("독립 프로세스 기동 실패: 정제된 로그를 확인하세요")
            time.sleep(.1)
        raise TimeoutError("독립 프로세스 기동 시간 초과")

    def stop(self):
        cleanup = self.child.poll() is None
        evidence.stop_process(self.child)
        self.thread.join(timeout=5)
        self.child.stdout.close()
        self.entry.update(status="stopped" if cleanup else ("passed" if self.child.returncode == 0 else "failed"), exit_code=self.child.returncode, stop_reason="owned_cleanup" if cleanup else "exited", elapsed_seconds=round(time.monotonic() - self.started, 3))


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
        result = {"status": "failed", "mode": args.mode, "symbol": SYMBOL, "fresh_database": True, "limits": {"source_seconds": args.timeout, "app_polls": 300, "dart_requests_upper_bound": args.timeout * 4 + 2, "refresh_posts": 0}, "scope": "isolated fake-kiwoom + real OpenDART"}
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
            if args.mode == "full":
                web.prepare_e2e(root, environment, record)
            else:
                web.prepare_server(root, environment, record)
            environment.pop("VALLY_E2E_BIN_DIR", None)
            deadline = time.monotonic() + args.timeout
            state = record.directory / "state"
            state.mkdir(mode=0o700)
            record.verify()
            binaries = record.directory / "bin"
            fake = Process([str(binaries / "fake-kiwoom"), "--bind", "127.0.0.1:0"], environment, record.directory / "fake.log", record)
            processes.append(fake)
            fake_base = fake.address(deadline)
            child_environment = {**environment, "LD_LIBRARY_PATH": str(binaries), "OPENDART_API_KEY": key, "VALLY_KIWOOM_APP_KEY": "FAKE-APPKEY-e2e-7f3a91c2", "VALLY_KIWOOM_APP_SECRET": "FAKE-SECRET-e2e-c0ffee42", "VALLY_KIWOOM_BASE_URL": fake_base, "VALLY_KIWOOM_WS_URL": fake_base.replace("http:", "ws:") + "/api/dostk/websocket", "VALLY_BIND": "127.0.0.1:0", "VALLY_DB_PATH": str(state / "user.db"), "VALLY_SCREENER_DB_PATH": str(state / "screener.duckdb"), "VALLY_FINANCIAL_DB_PATH": str(state / "financials.db"), "VALLY_LOCK_PATH": str(state / "kiwoom.lock"), "VALLY_TOKEN_PATH": str(state / "fake-token.json"), "VALLY_STATIC_DIR": str(record.directory / "dist"), "VALLY_SCREENER_UPDATE_ON_START": "off", "VALLY_LOG": "info"}
            server = Process([str(binaries / "vally-server")], child_environment, record.directory / "server.log", record)
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
