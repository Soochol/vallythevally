#!/usr/bin/env python3
import argparse
import glob
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

BENCH = Path(__file__).resolve().parent
ROOT = BENCH.parents[1]
CRATE = ROOT / "desktop" / "src-tauri"
CARGO_PY = ROOT / "desktop" / "scripts" / "cargo.py"
APP_NAME = "vally-desktop.exe" if os.name == "nt" else "vally-desktop"
RELEASE_APP = CRATE / "target" / "release" / APP_NAME
DEFAULT_RATES = (1000, 3000)
DEFAULT_SECONDS = 30
RESULT_GRACE_SECONDS = 90
STARTUP_SECONDS = 60
WINDOW = (1440, 900)
SCREEN_PROCESS_NAMES = ("WebKitWebProcess", "WebKitGPUProcess")
LIGHTWEIGHT_CHARTS = BENCH / "node_modules" / "lightweight-charts" / "dist" / "lightweight-charts.standalone.production.js"


def say(message):
    print(f"bench: {message}", flush=True)


def die(message, code=1):
    say(f"중단: {message}")
    sys.exit(code)


def children_of(pid):
    found = []
    for task in Path(f"/proc/{pid}/task").glob("*"):
        try:
            found += [int(child) for child in (task / "children").read_text().split()]
        except OSError:
            pass
    return found


def descendants(pid):
    seen, pending = [], [pid]
    while pending:
        current = pending.pop()
        for child in children_of(current):
            seen.append(child)
            pending.append(child)
    return seen


def process_label(pid):
    try:
        arguments = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").split()
    except OSError:
        return None
    if not arguments or os.path.basename(arguments[0]).startswith("bwrap"):
        return "host"
    if os.path.basename(arguments[0]) in SCREEN_PROCESS_NAMES or "--type=renderer" in arguments or "--type=gpu-process" in arguments:
        return "screen"
    return "host"


def cpu_ticks(pid):
    try:
        rest = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    except OSError:
        return None
    return int(rest[11]) + int(rest[12])


def snapshot(root_pid):
    ticks = {"screen": {}, "host": {}}
    for pid in [root_pid, *descendants(root_pid)]:
        label = process_label(pid)
        used = cpu_ticks(pid)
        if label and used is not None:
            ticks[label][pid] = used
    ticks["host"][root_pid] = cpu_ticks(root_pid) or 0
    return {"at": time.monotonic(), "ticks": ticks}


def cpu_percent(before, after, label):
    if before is None or after is None:
        return None
    seconds = after["at"] - before["at"]
    shared = set(before["ticks"][label]) & set(after["ticks"][label])
    used = sum(after["ticks"][label][pid] - before["ticks"][label][pid] for pid in shared)
    return {"percent": round(used / os.sysconf("SC_CLK_TCK") / seconds * 100, 1), "processes": len(shared)}


class Scenario:
    def __init__(self, directory, name, query, serve_only=False):
        self.directory = directory
        self.result_file = directory / f"{name}.json"
        software = {} if os.environ.get("VALLY_BENCH_HARDWARE_GL") else {"LIBGL_ALWAYS_SOFTWARE": "1", "LP_NUM_THREADS": "4"}
        x11 = {"GDK_BACKEND": "x11", "XDG_SESSION_TYPE": "x11"} if sys.platform.startswith("linux") else {}
        self.environment = {**{name: value for name, value in os.environ.items() if name != "WAYLAND_DISPLAY"}, **x11, **software, "VALLY_BENCH_STATIC_DIR": str(directory / "static"), "VALLY_BENCH_RESULT": str(self.result_file), "VALLY_BENCH_QUERY": query}
        if serve_only:
            self.environment["VALLY_BENCH_SERVE_ONLY"] = "1"
        self.process = None

    def marker(self, suffix):
        return Path(f"{self.result_file}.{suffix}")

    def launch(self, command, environment=None):
        self.process = subprocess.Popen(command, env=environment or self.environment, start_new_session=os.name != "nt")
        return self.process

    def stop(self):
        if self.process is None or self.process.poll() is not None:
            return
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(self.process.pid)], capture_output=True)
            self.process.wait()
            return
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
            self.process.wait(timeout=10)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait()


def wait_for(path, deadline_seconds, alive):
    deadline = time.monotonic() + deadline_seconds
    while time.monotonic() < deadline:
        if path.exists():
            return True
        if not alive():
            return path.exists()
        time.sleep(0.05)
    return False


def find_chromium():
    override = os.environ.get("VALLY_BENCH_CHROMIUM")
    if override:
        return override
    cache = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if cache:
        roots = [Path(cache)]
    elif sys.platform == "darwin":
        roots = [Path.home() / "Library" / "Caches" / "ms-playwright"]
    elif os.name == "nt":
        roots = [Path(os.environ.get("LOCALAPPDATA", "")) / "ms-playwright"]
    else:
        roots = [Path.home() / ".cache" / "ms-playwright"]
    patterns = ["chromium-*/chrome-linux*/chrome", "chromium-*/chrome-win*/chrome.exe", "chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium"]
    found = sorted(str(match) for root in roots for pattern in patterns for match in glob.glob(str(root / pattern)))
    if not found:
        die("Playwright Chromium을 찾을 수 없습니다. web/에서 pnpm exec playwright install chromium을 실행하거나 VALLY_BENCH_CHROMIUM을 지정하세요")
    return found[-1]


def prepare(directory):
    static = directory / "static"
    static.mkdir(parents=True)
    for name in ("index.html", "bench.js", "stats.js"):
        shutil.copy(BENCH / "ui" / name, static / name)
    subprocess.run(["pnpm", "install", "--frozen-lockfile", "--ignore-workspace"], cwd=BENCH, check=True, shell=os.name == "nt")
    shutil.copy(LIGHTWEIGHT_CHARTS, static / "lightweight-charts.js")


def build_bench_app(directory):
    subprocess.run([sys.executable, str(CARGO_PY), "bench-build"], check=True)
    app = directory / APP_NAME
    shutil.copy(RELEASE_APP, app)
    return app


def read_result(scenario, label):
    try:
        result = json.loads(scenario.result_file.read_text())
    except (OSError, ValueError):
        die(f"{label}: 결과를 읽을 수 없습니다")
    if "error" in result:
        die(f"{label}: 화면이 실패를 알렸습니다: {result['error']}")
    return result


def measure_tauri(app, directory, name, query, seconds):
    scenario = Scenario(directory, name, query)
    process = scenario.launch([str(app)])
    started = wait_for(scenario.marker("begin"), STARTUP_SECONDS, lambda: process.poll() is None)
    before = snapshot(process.pid) if started and sys.platform.startswith("linux") else None
    ended = wait_for(scenario.marker("end"), seconds + RESULT_GRACE_SECONDS, lambda: process.poll() is None)
    after = snapshot(process.pid) if ended and before and process.poll() is None else None
    finished = wait_for(scenario.result_file, RESULT_GRACE_SECONDS, lambda: process.poll() is None)
    scenario.stop()
    if not finished:
        die(f"{name}: 결과 없이 끝났습니다")
    result = read_result(scenario, name)
    result["cpu"] = {"screen": cpu_percent(before, after, "screen"), "host": cpu_percent(before, after, "host")}
    return result


def measure_chromium(app, chromium, directory, name, query, seconds):
    scenario = Scenario(directory, name, query, serve_only=True)
    server = scenario.launch([str(app)])
    ports_file = scenario.marker("ports")
    if not wait_for(ports_file, STARTUP_SECONDS, lambda: server.poll() is None):
        scenario.stop()
        die(f"{name}: 측정 서버가 시작하지 않았습니다")
    http, websocket = ports_file.read_text().split()
    profile = Path(tempfile.mkdtemp(prefix="chromium-profile-", dir=directory))
    flags = [] if os.environ.get("VALLY_BENCH_HARDWARE_GL") else ["--disable-gpu"]
    flags += (["--ozone-platform=x11"] if sys.platform.startswith("linux") else [])
    flags += ["--no-first-run", "--no-default-browser-check", "--disable-extensions", f"--user-data-dir={profile}", f"--window-size={WINDOW[0]},{WINDOW[1]}", "--window-position=0,0"]
    if os.environ.get("VALLY_BENCH_CHROMIUM_NO_SANDBOX"):
        flags.append("--no-sandbox")
    browser = Scenario(directory, f"{name}-browser", "")
    process = browser.launch([chromium, *flags, f"--app=http://127.0.0.1:{http}/index.html?{query}&websocket={websocket}"])
    started = wait_for(scenario.marker("begin"), STARTUP_SECONDS, lambda: process.poll() is None)
    before = snapshot(process.pid) if started and sys.platform.startswith("linux") else None
    ended = wait_for(scenario.marker("end"), seconds + RESULT_GRACE_SECONDS, lambda: process.poll() is None)
    after = snapshot(process.pid) if ended and before and process.poll() is None else None
    finished = wait_for(scenario.result_file, RESULT_GRACE_SECONDS, lambda: process.poll() is None)
    browser.stop()
    scenario.stop()
    if not finished:
        die(f"{name}: 결과 없이 끝났습니다")
    result = read_result(scenario, name)
    result["cpu"] = {"screen": cpu_percent(before, after, "screen"), "host": None}
    return result


def verify_counts(results, per_second, seconds):
    problems = []
    for result in results:
        expected = per_second(result) * seconds
        if not (result["sent"] == result["received"] == expected):
            problems.append(f"{result['name']}: 기대 {expected}, 보낸 {result['sent']}, 받은 {result['received']}")
    return problems


def webkit_version():
    try:
        return subprocess.run(["pkg-config", "--modversion", "webkit2gtk-4.1"], capture_output=True, text=True).stdout.strip() or None
    except OSError:
        return None


def describe_environment(chromium):
    return {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "cpuCount": os.cpu_count(),
        "display": os.environ.get("DISPLAY"),
        "webkitgtk": webkit_version(),
        "chromium": chromium,
        "softwareRendering": not os.environ.get("VALLY_BENCH_HARDWARE_GL"),
    }


def main():
    parser = argparse.ArgumentParser(description="앱 창의 통신과 차트 그리기 측정")
    parser.add_argument("--seconds", type=int, default=DEFAULT_SECONDS)
    parser.add_argument("--rates", default=",".join(map(str, DEFAULT_RATES)))
    parser.add_argument("--out", type=Path)
    arguments = parser.parse_args()
    rates = [int(rate) for rate in arguments.rates.split(",")]
    if sys.platform.startswith("linux") and not os.environ.get("DISPLAY"):
        die("desktop/bench/run.sh는 xvfb-run -a 아래에서 실행합니다", 2)
    directory = ROOT / "target" / "desktop-bench" / time.strftime("run-%Y%m%d-%H%M%S")
    directory.mkdir(parents=True)
    out = arguments.out or directory / "result.json"
    chromium = find_chromium()
    prepare(directory)
    app = build_bench_app(directory)
    seconds = arguments.seconds
    comm, chart = [], []
    for path in ("ws", "ipc"):
        for rate in rates:
            name = f"comm-{path}-{rate}"
            say(f"{name} {seconds}초")
            result = measure_tauri(app, directory, name, f"kind=comm&path={path}&perSecond={rate}&seconds={seconds}", seconds)
            comm.append({"name": name, **result})
    for browser in ("tauri", "chromium"):
        for rate in rates:
            name = f"chart-{browser}-{rate}"
            say(f"{name} {seconds}초")
            query = f"kind=chart&path=ws&perSecond={rate}&seconds={seconds}"
            result = measure_tauri(app, directory, name, query, seconds) if browser == "tauri" else measure_chromium(app, chromium, directory, name, query, seconds)
            chart.append({"name": name, "browser": browser, **result})
    problems = verify_counts(comm + chart, lambda result: result["perSecond"], seconds)
    document = {"environment": describe_environment(chromium), "seconds": seconds, "rates": rates, "comm": comm, "chart": chart, "countProblems": problems}
    out.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n")
    say(f"결과: {out}")
    if problems:
        die("받은 수와 보낸 수가 다릅니다: " + "; ".join(problems))


if __name__ == "__main__":
    main()
