#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import smoke

ROOT = smoke.ROOT
TARGET_DIR = ROOT / "desktop" / "src-tauri" / "target" / "update-smoke"
UPDATE_PORT = 18943
MANIFEST_PATH = "/latest.json"
ANNOUNCED_VERSION = "9.9.9"
THROWAWAY_PUBLIC_KEY = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQ0QUEzMjc0ODVGQTRFOTkKUldTWlR2cUZkREtxMURnZE5FRzlBektDNFVKODhGaVBJR0NyUzhHeTdsSER4YUFMVGx0aVdOKzQK"
NOTICE_TITLE = "vally 업데이트"
TITLE_POLL_SECONDS = 30
RELEASE_LIKE_CONFIG = {
    "plugins": {"updater": {"pubkey": THROWAWAY_PUBLIC_KEY, "endpoints": [f"http://127.0.0.1:{UPDATE_PORT}{MANIFEST_PATH}"], "dangerousInsecureTransportProtocol": True, "requireSignedVersion": True}}
}


def build():
    environment = {**os.environ, "TAURI_CONFIG": json.dumps(RELEASE_LIKE_CONFIG)}
    command = ["flock", str(smoke_compile_lock()), "env", "CARGO_BUILD_JOBS=4", "cargo", "build", "--locked", "--target-dir", str(TARGET_DIR)]
    subprocess.run(command, cwd=ROOT / "desktop" / "src-tauri", env=environment, check=True)


def smoke_compile_lock():
    sys.path.insert(0, str(ROOT / "desktop" / "scripts"))
    import cargo

    return cargo.compile_lock()


class ListServer:
    def __init__(self):
        self.manifest = None
        self.requests = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                owner.requests.append(self.path)
                body = owner.manifest if self.path == MANIFEST_PATH else None
                self.send_response(200 if body is not None else 404)
                self.send_header("Content-Length", str(len(body or b"")))
                self.end_headers()
                self.wfile.write(body or b"")

            def log_message(self, *arguments):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", UPDATE_PORT), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def announce_newer_release(self):
        platform = os.uname().sysname.lower() + "-" + os.uname().machine
        document = {"version": ANNOUNCED_VERSION, "notes": "연기 시험", "pub_date": "2026-11-23T00:00:00Z", "platforms": {platform: {"signature": "c2lnbmF0dXJl", "url": f"http://127.0.0.1:{UPDATE_PORT}/vally.AppImage"}}}
        self.manifest = json.dumps(document).encode()


def window_titles():
    tree = subprocess.run(["xwininfo", "-root", "-tree"], capture_output=True, text=True).stdout
    return [match.group(1) for line in tree.splitlines() if (match := re.match(r'\s*0x[0-9a-f]+ "([^"]*)":', line))]


def wait_for_title(wanted):
    return smoke.wait_until(TITLE_POLL_SECONDS, lambda: wanted in window_titles(), pause=0.25)


def scenario_newer_release(bus, server):
    server.announce_newer_release()
    trace = smoke.RUNS / "newer" / "app-trace.txt"
    trace.parent.mkdir(parents=True)
    run = smoke.Run("newer-run", bus, app_trace=trace)
    smoke.check(bool(wait_for_title(f"vally · 새 판 {ANNOUNCED_VERSION} 있음")), "새 판이 있으면 앱 창 제목에 알린다")
    smoke.check(bool(wait_for_title(NOTICE_TITLE)), "새 판이 있으면 알림 창이 뜬다")
    smoke.check(MANIFEST_PATH in server.requests, f"설정이 켜진 앱은 켤 때 갱신 목록을 부른다 (요청 {server.requests})")
    smoke.check(smoke.server_mode_status(run.port) == 200, "알림이 떠 있어도 엔진은 정상이다")
    os.kill(run.app.pid, smoke.signal.SIGTERM)
    smoke.wait_until(smoke.WINDOW_CLOSE_DEADLINE, lambda: run.launcher.poll() is not None)
    connects = smoke.inet_connects(trace.read_text(errors="replace"))
    smoke.check(("127.0.0.1", UPDATE_PORT) in connects, f"strace가 갱신 확인 연결을 본다. 기본 빌드의 무음 단정이 헛돌지 않는다 (연결 {sorted(set(connects))})")


def scenario_broken_list(bus, server):
    server.manifest = None
    run = smoke.Run("broken-run", bus)
    smoke.check(bool(wait_for_title("vally · 업데이트 확인 실패")), "목록을 못 받으면 앱 창 제목에 작게 표시한다")
    smoke.check(NOTICE_TITLE not in window_titles(), "확인 실패는 알림 창을 띄우지 않는다")
    smoke.check(smoke.server_mode_status(run.port) == 200 and run.app.poll() is None, "확인 실패가 앱 사용을 막지 않는다")
    os.kill(run.app.pid, smoke.signal.SIGTERM)
    smoke.wait_until(smoke.WINDOW_CLOSE_DEADLINE, lambda: run.app.poll() is not None)


def run():
    smoke.APP = TARGET_DIR / "debug" / "vally-desktop"
    if not smoke.APP.is_file():
        sys.exit(f"update-smoke: 준비가 안 됐습니다: {smoke.APP}")
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
    smoke.shutil.rmtree(smoke.RUNS, ignore_errors=True)
    smoke.RUNS.mkdir(parents=True)
    bus = smoke.start_session_bus()
    server = ListServer()
    try:
        scenario_newer_release(bus, server)
        scenario_broken_list(bus, server)
    finally:
        smoke.finish()
    if smoke.failures:
        smoke.say(f"실패 {len(smoke.failures)}건: {smoke.failures}")
        sys.exit(1)
    smoke.say("모두 통과")


if __name__ == "__main__":
    {"build": build, "run": run}[sys.argv[1]]()
