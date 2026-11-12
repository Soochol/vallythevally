import argparse
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import doctor
import evidence
import live
import web


ROOT = Path(__file__).resolve().parent.parent


def signal_fixture(mode, root):
    if mode == "live":
        binaries = root / "target/dev/bin"
        binaries.mkdir(parents=True)
        for name in ("vally-server", "fake-kiwoom"):
            path = binaries / name
            path.write_text("#!" + sys.executable + '\nimport time\nprint("addr=127.0.0.1:54321",flush=True)\ntime.sleep(120)\n')
            path.chmod(0o755)
        def prepare(arguments, cwd, environment):
            with evidence.Run(root, "dev-build", arguments, environment["VALLY_EVIDENCE_DIR"]) as record:
                record.artifact("server", binaries, "direct", "fixture")
        def collect(*args):
            record = evidence.ACTIVE
            (root / "ready.json").write_text(json.dumps([process["pid"] for process in record.data["processes"]]))
            time.sleep(120)
        with patch.object(web, "run", prepare), patch.object(live, "collect", collect):
            live.run_live(root, argparse.Namespace(mode="connect", timeout=10, headed=False, key_file=None), web)
    else:
        script = "\n".join([
            "import json,os,signal,subprocess,sys,time",
            "from pathlib import Path",
            "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)'])",
            "def stop(number, frame):",
            " child.terminate(); child.wait(); sys.exit(0)",
            "signal.signal(signal.SIGTERM,stop)",
            "Path(sys.argv[1]).write_text(json.dumps([os.getpid(),child.pid]))",
            "time.sleep(120)",
        ])
        arguments = [sys.executable, "-u", "-c", script, str(root / "ready.json")]
        with evidence.Run(root, "signal-test", [mode]) as record:
            record.plan("child")
            with record.step("child"):
                if mode == "command":
                    evidence.command(arguments, root, os.environ.copy())
                else:
                    evidence.bounded(arguments, os.environ.copy(), 120)



class LiveToolsTest(unittest.TestCase):
    def setUp(self):
        parent = ROOT / "target/live-tool-tests"
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "scripts").mkdir()
        shutil.copy2(ROOT / "scripts/chromium.mjs", self.root / "scripts/chromium.mjs")
        (self.root / "web").mkdir()
        (self.root / "web/package.json").write_text('{}')
        self.result = self.root / "result"
        self.result.mkdir()

    def chromium_fixture(self, executable, launch):
        package = self.root / "web/node_modules/@playwright/test"
        package.mkdir(parents=True)
        (package / "package.json").write_text('{"main":"index.cjs"}')
        (package / "index.cjs").write_text('module.exports = {chromium:{executablePath:()=>'+json.dumps(str(executable))+',launch:async()=>{'+launch+'}},expect:()=>({toHaveText:async()=>{}})}')

    def probe(self, headed="no"):
        code = subprocess.run(["node", str(self.root / "scripts/chromium.mjs"), "doctor", str(self.root), str(self.result), "", headed], stdout=subprocess.DEVNULL, env={**os.environ, "DISPLAY": ""}).returncode
        return code, json.loads((self.result / "chromium.json").read_text())

    def test_missing_playwright_and_browser_are_distinct(self):
        code, result = self.probe()
        self.assertEqual(code, 1)
        self.assertEqual(result["failure"], "playwright_missing")
        self.chromium_fixture(self.root / "absent-browser", 'throw Error("must not launch")')
        code, result = self.probe()
        self.assertEqual(code, 1)
        self.assertEqual(result["failure"], "browser_missing")

    def test_chromium_launch_failure_and_success_and_headed_display(self):
        executable = self.root / "browser"
        executable.touch()
        self.chromium_fixture(executable, 'return {version:()=>"fixture",close:async()=>{},newContext:async()=>({newPage:async()=>({setContent:async()=>{},locator:()=>({})})})}')
        code, result = self.probe()
        self.assertEqual(code, 0)
        self.assertEqual(result["checks"]["headless"]["status"], "passed")
        code, result = self.probe("yes")
        self.assertEqual(code, 1)
        self.assertEqual(result["checks"]["headed"]["status"], "display_missing")
        package = self.root / "web/node_modules/@playwright/test/index.cjs"
        package.write_text('module.exports={chromium:{executablePath:()=>'+json.dumps(str(executable))+',launch:async()=>{throw Error("fixture launch failure")}}}')
        code, result = self.probe()
        self.assertEqual(code, 1)
        self.assertEqual(result["checks"]["headless"]["status"], "launch_or_page_failed")

    def test_doctor_missing_node_and_pnpm_never_installs_or_builds(self):
        with patch.object(doctor.shutil, "which", return_value=None), patch.object(doctor.evidence, "bounded", side_effect=AssertionError("must not launch")):
            result = doctor.diagnose(self.root, self.result)
        self.assertEqual(result["checks"]["node"]["status"], "missing")
        self.assertEqual(result["checks"]["pnpm"]["status"], "missing")
        self.assertEqual(result["checks"]["chromium"]["status"], "not_run")
        self.assertEqual(result["checks"]["cua"]["status"], "not_checked")

    def test_long_tmpdir_is_reported_separately(self):
        with patch.dict(os.environ, {"TMPDIR": str(self.root / ("x" * 100))}), patch.object(doctor.shutil, "which", return_value=None):
            result = doctor.diagnose(self.root, self.result)
        self.assertEqual(result["checks"]["tmpdir"]["status"], "unix_socket_path_too_long")

    def fixture_server(self, pages):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                if self.path.endswith("financial-source"):
                    value = {"security": {"stock_code": "005930", "company": {"corp_code": "00126380"}, "evidence": "loopback"}}
                else:
                    value = pages.pop(0) if len(pages) > 1 else pages[0]
                self.wfile.write(json.dumps(value).encode())
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}"

    def test_connect_does_not_claim_collection_or_ui(self):
        result = {}
        base = self.fixture_server([])
        self.assertIsNone(live.collect(base, "connect", time.monotonic() + 5, result))
        self.assertEqual(result["status"], "connected")
        self.assertEqual(result["collection"], "not_verified")
        self.assertEqual(result["ui"], "not_run")

    def test_full_requires_ready_available_not_intermediate_or_failed(self):
        point = {"status": "available", "value": 123, "reason": None}
        available = {"status": "collecting", "series": [{"metric": "revenue", "points": [point]}]}
        final = {**available, "status": "partial_failure", "failure": "network"}
        result = {}
        base = self.fixture_server([available, final])
        with patch.object(live.time, "sleep"), self.assertRaises(ValueError):
            live.collect(base, "full", time.monotonic() + 5, result)
        self.assertEqual(result["api"]["status"], "partial_failure")
        self.assertNotIn("status", result)
        base = self.fixture_server([{**available, "status": "ready"}])
        self.assertEqual(live.collect(base, "full", time.monotonic() + 5, {})["status"], "ready")
        base = self.fixture_server([{**available, "status": "ready", "series": []}])
        with self.assertRaisesRegex(ValueError, "available"):
            live.collect(base, "full", time.monotonic() + 5, {})

    def test_missing_key_is_nonzero_with_manifest_before_build(self):
        args = argparse.Namespace(mode="connect", timeout=10, headed=False, key_file=None)
        with patch.dict(os.environ, {"OPENDART_API_KEY": ""}), patch.object(web, "run", side_effect=AssertionError("must not build")), self.assertRaisesRegex(ValueError, "OPENDART_API_KEY"):
            live.run_live(self.root, args, web)
        path = next((self.root / "target/web-runs").glob("live-*/manifest.json"))
        manifest = json.loads(path.read_text())
        self.assertEqual(manifest["status"], "failed")
        self.assertEqual(manifest["steps"]["source"]["status"], "not_run")
        self.assertEqual(json.loads(path.with_name("result.json").read_text())["status"], "not_configured")

    def test_key_file_reads_only_key_and_environment_discards_owner_settings(self):
        path = self.root / "private.env"
        path.write_text('VALLY_ENV_FILE=/unsafe\nOPENDART_API_KEY="fixture-key"\nVALLY_KIWOOM_APP_KEY=real-owner\n')
        self.assertEqual(live.read_key(path), "fixture-key")
        with patch.dict(os.environ, {"VALLY_ENV_FILE": "/unsafe", "VALLY_KIWOOM_APP_KEY": "real-owner", "HTTPS_PROXY": "https://secret@host", "OPENDART_API_KEY": "fixture-key"}):
            environment = live.isolated_environment()
        self.assertFalse(any(name.startswith(("VALLY_KIWOOM", "OPENDART", "VALLY_ENV")) for name in environment))
        self.assertNotIn("HTTPS_PROXY", environment)

    def test_logs_commands_and_manifest_redact_secrets_urls_headers(self):
        secret = "fixture-never-persist"
        with patch.dict(os.environ, {"OPENDART_API_KEY": secret}):
            with evidence.Run(self.root, "probe", ["probe", "https://example.test/auth?key="+secret]) as record:
                evidence.command([sys.executable, "-c", "print('https://example.test/auth?key='+__import__('os').environ['OPENDART_API_KEY']); print('Authorization: Bearer token=private')"], self.root, os.environ.copy())
                directory = record.directory
        for path in directory.rglob("*"):
            if path.is_file():
                text = path.read_text()
                self.assertNotIn(secret, text)
                self.assertNotIn("https://example.test", text)
                self.assertNotIn("token=private", text)

    def test_owned_process_is_stopped_and_server_log_is_sanitized(self):
        evidence.SECRETS.add("fixture-secret")
        with evidence.Run(self.root, "probe", ["test"]) as record:
            process = live.Process([sys.executable, "-u", "-c", "import time; print('fixture-secret https://source.test/key?token=hidden addr=127.0.0.1:12345'); time.sleep(20)"], {}, record.directory / "child.log", record)
            self.assertEqual(process.address(time.monotonic() + 5), "http://127.0.0.1:12345")
            process.stop()
            self.assertIsNotNone(process.child.poll())
            text = process.log.read_text()
            self.assertNotIn("fixture-secret", text)
            self.assertNotIn("https://source.test", text)

    def test_parent_pid_signals_cleanup_live_command_and_bounded(self):
        for mode in ("live", "command", "bounded"):
            for number in (signal.SIGTERM, signal.SIGINT):
                with self.subTest(mode=mode, signal=number.name):
                    root = self.root / f"{mode}-{number.name}"
                    root.mkdir()
                    environment = {name: os.environ[name] for name in ("PATH", "HOME", "LANG") if name in os.environ}
                    environment["OPENDART_API_KEY"] = "fixture-only"
                    pids = []
                    with (root / "parent.log").open("w") as stream:
                        process = subprocess.Popen([sys.executable, __file__, "--signal-fixture", mode, str(root)], env=environment, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
                        try:
                            deadline = time.monotonic() + 10
                            ready = root / "ready.json"
                            while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                                time.sleep(.02)
                            self.assertTrue(ready.exists(), (root / "parent.log").read_text())
                            pids = json.loads(ready.read_text())
                            process.send_signal(number)
                            self.assertEqual(process.wait(timeout=12), 128 + number)
                            self.assertTrue(all(not Path(f"/proc/{pid}").exists() for pid in pids))
                            path = next((root / "target/web-runs").glob("*/manifest.json"))
                            manifest = json.loads(path.read_text())
                            self.assertEqual(manifest["status"], "failed")
                            self.assertEqual(manifest["exit_code"], 128 + number)
                            self.assertEqual(manifest["signal"], number.name)
                            if mode == "live":
                                result = json.loads(path.with_name("result.json").read_text())
                                self.assertEqual(result["status"], "failed")
                                self.assertEqual(result["signal"], number.name)
                                self.assertEqual(result["exit_code"], process.returncode)
                            else:
                                self.assertEqual(manifest["steps"]["child"]["exit_code"], process.returncode)
                                if mode == "command":
                                    self.assertEqual(manifest["commands"][0]["termination_reason"], "signal")
                                    self.assertIsNotNone(manifest["commands"][0]["process_exit_code"])
                                else:
                                    self.assertEqual(manifest["bounded_commands"][0]["exit_code"], process.returncode)
                                    self.assertIsNotNone(manifest["bounded_commands"][0]["process_exit_code"])
                        finally:
                            if process.poll() is None:
                                os.killpg(process.pid, signal.SIGKILL)
                                process.wait()
                            for pid in pids:
                                if Path(f"/proc/{pid}").exists():
                                    with contextlib.suppress(ProcessLookupError):
                                        os.kill(pid, signal.SIGKILL)

    def test_signal_handlers_are_scoped_and_import_has_no_signal_side_effect(self):
        previous = signal.getsignal(signal.SIGTERM)
        def existing(number, frame):
            pass
        signal.signal(signal.SIGTERM, existing)
        try:
            with evidence.Run(self.root, "probe", ["test"]):
                self.assertIsNot(signal.getsignal(signal.SIGTERM), existing)
            self.assertIs(signal.getsignal(signal.SIGTERM), existing)
        finally:
            signal.signal(signal.SIGTERM, previous)
        subprocess.run([sys.executable, "-c", "import signal; before=signal.getsignal(signal.SIGTERM); import evidence; assert signal.getsignal(signal.SIGTERM)==before"], cwd=ROOT / "scripts", check=True)

    def test_bounded_timeout_cleans_actual_child_and_records_timeout(self):
        with self.assertRaises(subprocess.TimeoutExpired), evidence.Run(self.root, "timeout", ["test"]) as record:
            directory = record.directory
            with record.step("child"):
                evidence.bounded([sys.executable, "-c", "import time; time.sleep(30)"], {}, .1)
        manifest = json.loads((directory / "manifest.json").read_text())
        self.assertEqual(manifest["status"], "failed")
        self.assertEqual(manifest["steps"]["child"]["termination_reason"], "timeout")
        self.assertTrue(all(child.poll() is not None for child in record.children))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--signal-fixture":
        signal_fixture(sys.argv[2], Path(sys.argv[3]))
    else:
        with contextlib.redirect_stdout(io.StringIO()):
            unittest.main()
