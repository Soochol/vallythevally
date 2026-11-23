#!/usr/bin/env python3
import ctypes
import ctypes.util
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "desktop" / "src-tauri" / "target" / "debug" / "vally-desktop"
ENGINE = ROOT / "target" / "dev" / "bin" / "vally-server"
WEB_DIR = Path(os.environ.get("VALLY_DESKTOP_WEB_DIR") or ROOT / "web" / "dist")
RUNS = ROOT / "target" / "desktop-smoke"
APP_DATA_FOLDER = "com.vallythevally.desktop"
WINDOW_TITLE = "vally"
SAME_ORIGIN_TIMEOUT = 60
ORPHAN_DEADLINE = 5.0
WINDOW_CLOSE_DEADLINE = 25.0
SECOND_LAUNCH_DEADLINE = 15.0
UPDATE_SILENCE_SECONDS = 8.0
BROKER_LINE = re.compile(r"(키움|한투|kiwoom|kis).*(연결했|연결되었|연결 성공|접속|인증 성공|토큰을 받)", re.IGNORECASE)
REQUEST_LINE = re.compile(r"\b(GET|POST|PUT|DELETE) (/[^ \\\"]*) HTTP/1\.1")
CONNECT_LINE = re.compile(r'connect\(\d+, \{sa_family=(AF_INET6?), sin6?_port=htons\((\d+)\), (?:sin_addr=inet_addr\(|sin6_addr=inet_pton\(AF_INET6, )"([^"]+)"')
HOST_SECRETS = {
    "VALLY_KIWOOM_APP_KEY": "smoke-canary-key",
    "VALLY_KIWOOM_APP_SECRET": "smoke-canary-secret",
    "VALLY_KIS_APP_KEY": "smoke-canary-kis",
    "VALLY_KIS_APP_SECRET": "smoke-canary-kis",
    "KIWOOM_APP_KEY": "smoke-canary-bare",
    "KIS_APP_SECRET": "smoke-canary-bare",
    "VALLY_BIND": "127.0.0.1:1",
}
HOST_CANARY_FILE_NAME = "host-canary.db"

failures = []
cleanup_processes = []


def say(message):
    print(f"smoke: {message}", flush=True)


def check(condition, message):
    if condition:
        say(f"통과: {message}")
    else:
        failures.append(message)
        say(f"실패: {message}")
    return condition


def fatal(message):
    say(f"중단: {message}")
    finish()
    sys.exit(1)


def children_of(pid):
    found = []
    for task in Path(f"/proc/{pid}/task").glob("*"):
        try:
            found += [int(child) for child in (task / "children").read_text().split()]
        except OSError:
            pass
    return found


def exe_name(pid):
    try:
        return os.path.basename(os.readlink(f"/proc/{pid}/exe"))
    except OSError:
        return None


def is_gone(pid):
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("State:"):
                return "Z" in line.split()[1]
    except OSError:
        return True
    return False


def wait_until(deadline_seconds, condition, pause=0.05):
    deadline = time.monotonic() + deadline_seconds
    while time.monotonic() < deadline:
        value = condition()
        if value:
            return value
        time.sleep(pause)
    return None


def process_environment(pid):
    raw = Path(f"/proc/{pid}/environ").read_bytes()
    return dict(entry.decode(errors="replace").split("=", 1) for entry in raw.split(b"\0") if b"=" in entry)


def engine_child(app_pid):
    return next((child for child in children_of(app_pid) if exe_name(child) == ENGINE.name), None)


def server_mode_status(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/server-mode", timeout=2) as response:
            return response.status
    except OSError:
        return None


class Run:
    def __init__(self, name, bus_address, app_trace=None):
        self.name = name
        self.directory = RUNS / name
        self.data_home = self.directory / "xdg-data"
        self.data_home.mkdir(parents=True)
        self.host_canary = self.directory / HOST_CANARY_FILE_NAME
        self.log_path = self.directory / "app.log"
        self.bus_address = bus_address
        self.app_trace = app_trace
        self.launcher = self.launch()
        self.app = self.launcher
        if app_trace is not None:
            app_pid = wait_until(30, lambda: next((child for child in children_of(self.launcher.pid) if exe_name(child) == APP.name), None))
            if app_pid is None:
                fatal(f"{self.name}: strace 아래에서 앱이 뜨지 않았습니다\n{self.log_text()[-3000:]}")
            self.app = ProcessId(app_pid)
            cleanup_processes.append(self.app)
        engine_pid = wait_until(30, lambda: engine_child(self.app.pid))
        if engine_pid is None:
            fatal(f"{self.name}: 앱이 엔진 자식 프로세스를 띄우지 않았습니다\n{self.log_text()[-3000:]}")
        self.engine_pid = engine_pid
        cleanup_processes.append(ProcessId(engine_pid))
        self.port = int(process_environment(engine_pid)["VALLY_BIND"].rsplit(":", 1)[1])
        if not wait_until(SAME_ORIGIN_TIMEOUT, lambda: server_mode_status(self.port) == 200):
            fatal(f"{self.name}: 엔진이 응답하지 않습니다\n{self.log_text()[-3000:]}")

    def environment(self):
        environment = {key: value for key, value in os.environ.items() if not key.startswith(("VALLY_", "KIWOOM_", "KIS_", "OPENDART", "WAYLAND_"))}
        environment.update(HOST_SECRETS)
        environment["VALLY_DB_PATH"] = str(self.host_canary)
        environment["VALLY_DESKTOP_WEB_DIR"] = str(WEB_DIR)
        environment["XDG_DATA_HOME"] = str(self.data_home)
        environment["DBUS_SESSION_BUS_ADDRESS"] = self.bus_address
        environment["GDK_BACKEND"] = "x11"
        return environment

    def launch(self):
        log = open(self.log_path, "ab")
        command = [str(APP)]
        if self.app_trace is not None:
            command = ["strace", "-f", "-qq", "-e", "trace=connect", "-o", str(self.app_trace), "--", *command]
        process = subprocess.Popen(command, env=self.environment(), stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        cleanup_processes.append(process)
        return process

    def log_text(self):
        return self.log_path.read_text(errors="replace")


class ProcessId:
    def __init__(self, pid):
        self.pid = pid

    def poll(self):
        return None if not is_gone(self.pid) else 0

    def kill(self):
        try:
            os.kill(self.pid, signal.SIGKILL)
        except OSError:
            pass


def start_session_bus():
    address = f"unix:abstract=vally-smoke-{os.getpid()}"
    configuration = RUNS / "bus.conf"
    configuration.write_text(
        '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">\n'
        f"<busconfig><type>session</type><listen>{address}</listen><auth>EXTERNAL</auth>"
        '<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>\n'
    )
    bus = subprocess.Popen(["dbus-daemon", f"--config-file={configuration}", "--nofork"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    cleanup_processes.append(bus)
    time.sleep(0.5)
    if bus.poll() is not None:
        fatal("dbus-daemon을 띄우지 못했습니다")
    return address


def send_close_request(window_id):
    x11 = ctypes.CDLL(ctypes.util.find_library("X11"))

    class ClientMessage(ctypes.Structure):
        _fields_ = [
            ("type", ctypes.c_int),
            ("serial", ctypes.c_ulong),
            ("send_event", ctypes.c_int),
            ("display", ctypes.c_void_p),
            ("window", ctypes.c_ulong),
            ("message_type", ctypes.c_ulong),
            ("format", ctypes.c_int),
            ("data", ctypes.c_long * 5),
        ]

    class Event(ctypes.Union):
        _fields_ = [("client", ClientMessage), ("padding", ctypes.c_long * 24)]

    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XInternAtom.restype = ctypes.c_ulong
    x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x11.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.c_void_p]
    x11.XFlush.argtypes = [ctypes.c_void_p]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = x11.XOpenDisplay(None)
    if not display:
        return False
    event = Event()
    event.client.type = 33
    event.client.window = window_id
    event.client.message_type = x11.XInternAtom(display, b"WM_PROTOCOLS", 0)
    event.client.format = 32
    event.client.data[0] = x11.XInternAtom(display, b"WM_DELETE_WINDOW", 0)
    event.client.data[1] = 0
    sent = x11.XSendEvent(display, window_id, 0, 0, ctypes.byref(event))
    x11.XFlush(display)
    x11.XCloseDisplay(display)
    return bool(sent)


def window_id():
    tree = subprocess.run(["xwininfo", "-root", "-tree"], capture_output=True, text=True).stdout
    for line in tree.splitlines():
        match = re.match(rf'\s*(0x[0-9a-f]+) "{re.escape(WINDOW_TITLE)}":', line)
        if match:
            return int(match.group(1), 16)
    return None


def trace_engine(pid, path):
    tracer = subprocess.Popen(["strace", "-f", "-qq", "-p", str(pid), "-e", "trace=connect,read,recvfrom", "-s", "300", "-o", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    cleanup_processes.append(tracer)
    return tracer


def stop_tracer(tracer):
    tracer.send_signal(signal.SIGINT)
    try:
        tracer.wait(timeout=10)
    except subprocess.TimeoutExpired:
        tracer.kill()


def inet_connects(trace_text):
    return [(found.group(3), int(found.group(2))) for line in trace_text.splitlines() if (found := CONNECT_LINE.search(line))]


def non_loopback_connects(trace_text):
    outside = []
    loopback = 0
    for line in trace_text.splitlines():
        found = CONNECT_LINE.search(line)
        if not found:
            continue
        family, port, address = found.groups()
        if address.startswith("127.") or address == "::1":
            loopback += 1
        else:
            outside.append(f"{family} {address}:{port}")
    return outside, loopback


def scenario_window_and_lifetime(bus):
    run = Run("window", bus)
    port = run.port
    engine = run.engine_pid
    app_pid = run.app.pid
    say(f"앱 pid={app_pid}, 엔진 pid={engine}, 엔진 포트={port}")
    trace_path = run.directory / "engine-trace.txt"
    tracer = trace_engine(engine, trace_path)

    environment = process_environment(engine)
    leaked = sorted(name for name in environment if name.startswith(("KIWOOM_", "KIS_")) or name in ("VALLY_KIWOOM_APP_KEY", "VALLY_KIWOOM_APP_SECRET", "VALLY_KIS_APP_KEY", "VALLY_KIS_APP_SECRET", "OPENDART_API_KEY"))
    check(not leaked, f"엔진 환경에 부모의 키 변수가 없다 (있다면 {leaked})")
    check(environment["VALLY_BIND"] == f"127.0.0.1:{port}" and environment["VALLY_BIND"] != HOST_SECRETS["VALLY_BIND"], "엔진 바인드는 앱이 고른 루프백 포트다")
    data_root = run.data_home / APP_DATA_FOLDER
    own = [value for name, value in environment.items() if name.endswith(("_PATH", "_DIR")) and name != "VALLY_STATIC_DIR"]
    check(own and all(Path(value).is_relative_to(data_root) for value in own), "엔진의 모든 자료 경로가 앱 자료 폴더 아래다")
    check((data_root / "data" / "vally.db").exists() and not run.host_canary.exists(), "사용자 DB는 앱 자료 폴더에 생겼고 부모가 준 경로에는 없다")

    def seen_requests():
        return REQUEST_LINE.findall(trace_path.read_text(errors="replace")) if trace_path.exists() else []

    wait_until(30, lambda: any(path == "/" for _, path in seen_requests()) and any(path.startswith("/api/") for _, path in seen_requests()))
    requests = seen_requests()
    paths = sorted({path for _, path in requests})
    check(any(path == "/" for _, path in requests), "(가) 창이 /를 불렀다")
    check(any(path.startswith("/api/") for _, path in requests), f"(가) 창이 /api/*를 불렀다 (본 경로 {len(paths)}개, 예: {paths[:4]})")

    say("(라) 두 번째 실행을 띄운다")
    second = run.launch()
    try:
        second_exit = second.wait(timeout=SECOND_LAUNCH_DEADLINE)
    except subprocess.TimeoutExpired:
        second_exit = None
    check(second_exit == 0, f"(라) 두 번째 실행은 곧바로 정상 종료한다 (종료 코드 {second_exit})")
    check(children_of(second.pid) == [] and engine_child(app_pid) == engine and len([c for c in children_of(app_pid) if exe_name(c) == ENGINE.name]) == 1, "(라) 엔진은 하나뿐이고 두 번째 실행은 엔진을 띄우지 않았다")
    check(window_id() is not None and run.app.poll() is None, "(라) 기존 창은 그대로 떠 있다")

    stop_tracer(tracer)
    outside, loopback = non_loopback_connects(trace_path.read_text(errors="replace"))
    check(not outside, f"엔진이 루프백 밖으로 연결을 시도하지 않았다 (시도 {outside}, 루프백 연결 {loopback}건)")
    check(not BROKER_LINE.search(run.log_text()), "엔진 로그에 증권사 연결 시도가 없다")

    say("(나) 창을 닫는다")
    window = wait_until(10, window_id)
    if not check(window is not None, "창을 찾았다"):
        run.app.kill()
        return
    check(send_close_request(window), "창 닫기 요청을 보냈다")
    started = time.monotonic()
    app_exit = wait_until(WINDOW_CLOSE_DEADLINE, lambda: run.app.poll() is not None)
    elapsed = time.monotonic() - started
    check(app_exit is not None, f"(나) 창을 닫으면 앱이 끝난다 ({elapsed:.1f}초)")
    check(is_gone(engine), "(나) 창을 닫으면 엔진도 끝났다")


def scenario_default_build_sends_no_update_request(bus):
    trace_path = RUNS / "silent" / "app-trace.txt"
    (RUNS / "silent").mkdir(parents=True)
    run = Run("silent-run", bus, app_trace=trace_path)
    say(f"앱 pid={run.app.pid}, 엔진 pid={run.engine_pid}, 엔진 포트={run.port}")
    time.sleep(UPDATE_SILENCE_SECONDS)
    os.kill(run.app.pid, signal.SIGTERM)
    wait_until(WINDOW_CLOSE_DEADLINE, lambda: run.launcher.poll() is not None)
    connects = inet_connects(trace_path.read_text(errors="replace"))
    strangers = [target for target in connects if target not in {("127.0.0.1", run.port), ("::1", run.port)}]
    check(any(target == ("127.0.0.1", run.port) for target in connects), f"앱 프로세스 트리의 연결을 strace가 봤다 (엔진 루프백 연결 {sum(1 for target in connects if target[1] == run.port)}건)")
    check(not strangers, f"기본 설정 앱은 엔진 밖으로 연결을 시도하지 않는다. 갱신 확인도 없다 (시도 {strangers})")


def scenario_killed_app(bus):
    run = Run("killed", bus)
    engine = run.engine_pid
    say(f"앱 pid={run.app.pid}, 엔진 pid={engine}")
    run.app.send_signal(signal.SIGKILL)
    run.app.wait()
    started = time.monotonic()
    gone = wait_until(ORPHAN_DEADLINE, lambda: is_gone(engine), pause=0.02)
    check(bool(gone), f"(다) 앱을 SIGKILL하면 {ORPHAN_DEADLINE:.0f}초 안에 엔진도 없다 ({time.monotonic() - started:.2f}초)")


def finish():
    for process in reversed(cleanup_processes):
        try:
            if process.poll() is None:
                process.kill()
        except OSError:
            pass


def main():
    for path, hint in ((APP, "python3 desktop/scripts/cargo.py build"), (ENGINE, "python3 scripts/dev.py build"), (WEB_DIR / "index.html", "화면 빌드(web/dist) 또는 VALLY_DESKTOP_WEB_DIR")):
        if not path.is_file():
            sys.exit(f"smoke: 준비가 안 됐습니다: {path}\n  {hint}")
    if not os.environ.get("DISPLAY"):
        sys.exit("smoke: DISPLAY가 없습니다. xvfb-run -a 아래에서 실행합니다")
    if shutil.which("strace") is None or shutil.which("xwininfo") is None or shutil.which("dbus-daemon") is None:
        sys.exit("smoke: strace, xwininfo, dbus-daemon이 필요합니다")
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
    shutil.rmtree(RUNS, ignore_errors=True)
    RUNS.mkdir(parents=True)
    bus = start_session_bus()
    try:
        scenario_window_and_lifetime(bus)
        scenario_killed_app(bus)
        scenario_default_build_sends_no_update_request(bus)
    finally:
        finish()
    if failures:
        say(f"실패 {len(failures)}건: {failures}")
        sys.exit(1)
    say("모두 통과")


if __name__ == "__main__":
    main()
