#!/usr/bin/env python3
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
RUNS = ROOT / "target/verify-vally/runs"
SERVER_BIN = ROOT / "target/dev/bin/vally-server"
UI_DIR = ROOT / "target/verify-vally/ui"
CLOCK_START = "20261109090000"
USER_SERVER_PORT = 8080


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def alive(pid):
    try:
        os.kill(pid, 0)
        return Path(f"/proc/{pid}/stat").read_text().split()[2] != "Z"
    except (OSError, FileNotFoundError):
        return False


def newest_run():
    runs = sorted(RUNS.glob("*/state.json"))
    return runs[-1].parent if runs else None


def load(run_dir):
    return json.loads((run_dir / "state.json").read_text())


NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def start_time(pid):
    return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]


def spawn(run_dir, state, name, argv, **options):
    blocked = {signal.SIGTERM, signal.SIGINT}
    signal.pthread_sigmask(signal.SIG_BLOCK, blocked)
    try:
        process = subprocess.Popen(argv, start_new_session=True, **options)
        state[f"{name}_pid"] = process.pid
        state[f"{name}_start"] = start_time(process.pid)
        save(run_dir, state)
        return process
    finally:
        signal.pthread_sigmask(signal.SIG_UNBLOCK, blocked)


def save(run_dir, state):
    (run_dir / "state.json").write_text(json.dumps(state, indent=1))


def http(url, timeout=3):
    with NO_PROXY_OPENER.open(url, timeout=timeout) as r:
        return r.status, r.read()


def up():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    for needed in (SERVER_BIN, UI_DIR / "index.html"):
        if not needed.is_file():
            sys.exit(f"up: missing {needed}. Build first: python3 scripts/dev.py build ; python3 .claude/skills/verify-vally/scripts/build_ui.py {UI_DIR}")
    run_id = time.strftime("%Y%m%d-%H%M%S") + f"-{os.getpid()}"
    run_dir = RUNS / run_id
    for sub in ("data", "evidence", "run"):
        (run_dir / sub).mkdir(parents=True)
    (run_dir / "run").chmod(0o700)
    try:
        return start(run_id, run_dir)
    except BaseException:
        stop(run_dir)
        raise


def start(run_id, run_dir):
    state = {"run_id": run_id, "dir": str(run_dir)}
    save(run_dir, state)
    kiwoom_port_file = run_dir / "kiwoom.port"
    kiwoom_log = run_dir / "evidence/kiwoom-requests.jsonl"
    kiwoom = spawn(run_dir, state, "kiwoom", [sys.executable, str(HERE / "verification_loopback_kiwoom.py"), str(kiwoom_port_file), str(kiwoom_log)],
                   stdout=open(run_dir / "kiwoom.out", "w"), stderr=subprocess.STDOUT)
    for _ in range(100):
        if kiwoom_port_file.is_file() and kiwoom_port_file.read_text():
            break
        time.sleep(0.1)
    else:
        sys.exit(f"up: loopback Kiwoom stand-in never reported its port; see {run_dir}/kiwoom.out")
    kiwoom_port = int(kiwoom_port_file.read_text())
    port = free_port()
    assert port != USER_SERVER_PORT
    env_file = run_dir / "server.env"
    env_file.write_text("\n".join([
        "VALLY_KIWOOM_APP_KEY=FAKE-verify-vally-key",
        "VALLY_KIWOOM_APP_SECRET=FAKE-verify-vally-secret",
        f"VALLY_KIWOOM_BASE_URL=http://127.0.0.1:{kiwoom_port}",
        f"VALLY_KIWOOM_WS_URL=ws://127.0.0.1:{kiwoom_port}/api/dostk/websocket",
        f"VALLY_CLOCK_START={CLOCK_START}",
        f"VALLY_BIND=127.0.0.1:{port}",
        f"VALLY_STATIC_DIR={UI_DIR}",
        f"VALLY_DB_PATH={run_dir}/data/vally.db",
        f"VALLY_SCREENER_DB_PATH={run_dir}/data/screener.duckdb",
        f"VALLY_FINANCIAL_DB_PATH={run_dir}/data/financials.db",
        f"VALLY_LOCK_PATH={run_dir}/run/server.lock",
        f"VALLY_TOKEN_PATH={run_dir}/run/token.json",
        "VALLY_SCREENER_UPDATE_ON_START=off",
        "VALLY_FINANCIAL_AUTOMATIC=off",
        "VALLY_LOG=info",
        "",
    ]))
    env = {k: v for k, v in os.environ.items() if not k.startswith("VALLY_") and k != "OPENDART_API_KEY" and not k.lower().endswith("_proxy")}
    env["NO_PROXY"] = env["no_proxy"] = "127.0.0.1,localhost"
    env["VALLY_ENV_FILE"] = str(env_file)
    state.update(base_url=f"http://127.0.0.1:{port}", kiwoom_url=f"http://127.0.0.1:{kiwoom_port}")
    server = spawn(run_dir, state, "server", [str(SERVER_BIN)], cwd=run_dir, env=env, stdout=open(run_dir / "server.log", "w"), stderr=subprocess.STDOUT)
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        if server.poll() is not None:
            stop(run_dir)
            sys.exit(f"up: server exited early (code {server.returncode}); see {run_dir}/server.log")
        try:
            status, body = http(f"{state['base_url']}/api/symbols?q=005930", timeout=2)
            if status == 200 and b"005930" in body:
                print(json.dumps(state))
                return state
        except Exception:
            pass
        time.sleep(0.2)
    stop(run_dir)
    sys.exit(f"up: not ready (symbols never loaded); see {run_dir}/server.log")


def connections(pid):
    out = subprocess.run(["ss", "-tnpH"], capture_output=True, text=True).stdout
    return [line for line in out.splitlines() if f"pid={pid}," in line]


def doctor(run_dir):
    state = load(run_dir)
    problems = []
    env = dict(line.split("=", 1) for line in (run_dir / "server.env").read_text().splitlines() if "=" in line)
    for key in ("VALLY_KIWOOM_BASE_URL", "VALLY_KIWOOM_WS_URL"):
        if not env[key].split("//")[1].startswith("127.0.0.1:"):
            problems.append(f"{key} is not loopback: {env[key]}")
    if "kiwoom.com" in (run_dir / "server.env").read_text():
        problems.append("real Kiwoom host in env file")
    for name in ("server_pid", "kiwoom_pid"):
        if not ours(state, name):
            problems.append(f"{name} {state[name]} is not running")
    if state["base_url"].endswith(f":{USER_SERVER_PORT}"):
        problems.append("run targets the user's server port")
    listening = subprocess.run(["ss", "-ltnpH", f"sport = :{state['base_url'].rsplit(':', 1)[1]}"], capture_output=True, text=True).stdout
    if f"pid={state['server_pid']}," not in listening:
        problems.append(f"port {state['base_url']} is not owned by our server pid {state['server_pid']}")
    external = [c for c in connections(state["server_pid"]) if "127.0.0.1" not in c.split()[3] or "127.0.0.1" not in c.split()[4]]
    if external:
        problems.append(f"non-loopback connections: {external}")
    try:
        status, _ = http(f"{state['base_url']}/")
        if status != 200:
            problems.append(f"GET / -> {status}")
        status, body = http(f"{state['base_url']}/api/symbols/005930")
        if b"005930" not in body:
            problems.append("symbol 005930 not loaded")
    except Exception as e:
        problems.append(f"http: {e}")
    result = {"ok": not problems, "problems": problems, "base_url": state["base_url"], "run_dir": str(run_dir)}
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return not problems


def ours(state, name):
    pid = state.get(name)
    expected = state.get(name.replace("_pid", "_start"))
    if not pid or not expected or not alive(pid):
        return None
    try:
        return pid if start_time(pid) == expected else None
    except FileNotFoundError:
        return None


def signal_ours(pid, sig):
    try:
        if os.getpgid(pid) == pid:
            os.killpg(pid, sig)
        else:
            os.kill(pid, sig)
    except ProcessLookupError:
        pass


def stop(run_dir):
    state = load(run_dir) if (run_dir / "state.json").is_file() else {}
    for name in ("server_pid", "kiwoom_pid"):
        if pid := ours(state, name):
            signal_ours(pid, signal.SIGTERM)
    for name in ("server_pid", "kiwoom_pid"):
        for _ in range(50):
            if not ours(state, name):
                break
            time.sleep(0.1)
        if pid := ours(state, name):
            signal_ours(pid, signal.SIGKILL)


def run_all(journeys):
    state = up()
    run_dir = Path(state["dir"])
    failed = False
    try:
        failed = not doctor(run_dir)
        seen = set()
        for journey in journeys:
            drive = subprocess.Popen(["node", str(HERE / "drive.mjs"), state["base_url"], str(run_dir / "evidence"), journey])
            while drive.poll() is None:
                seen.update(connections(state["server_pid"]))
                time.sleep(0.2)
            failed = failed or drive.returncode != 0
        seen.update(connections(state["server_pid"]))
        conns = [c for c in seen if "127.0.0.1" not in c.split()[4] or "127.0.0.1" not in c.split()[3]]
        (run_dir / "evidence/network-interfaces.txt").write_text(Path("/proc/net/dev").read_text())
        (run_dir / "evidence/server-connections.txt").write_text("\n".join(sorted(seen)) + "\n")
        failed = failed or bool(conns)
    finally:
        stop(run_dir)
    print(f"all: {'FAILED' if failed else 'ok'}; evidence in {run_dir}/evidence")
    sys.exit(1 if failed else 0)


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("up", "doctor", "down", "all"):
        sys.exit("usage: vv.py up | doctor [run-dir] | down <run-dir> | all [journey...]")
    if sys.argv[1] == "up":
        return up()
    if sys.argv[1] == "all":
        return run_all(sys.argv[2:] or ["search-chart"])
    if sys.argv[1] == "down" and len(sys.argv) < 3:
        sys.exit("down: pass the run dir printed by up (a bare down could stop another agent's run)")
    run_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else newest_run()
    if not run_dir:
        sys.exit("no run found")
    if sys.argv[1] == "doctor":
        sys.exit(0 if doctor(run_dir) else 1)
    stop(run_dir)
    print(f"down: stopped {run_dir.name}; evidence kept in {run_dir}/evidence")


main()
