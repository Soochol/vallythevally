import argparse
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import shutil
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


if __name__ == "__main__":
    with contextlib.redirect_stdout(io.StringIO()):
        unittest.main()
