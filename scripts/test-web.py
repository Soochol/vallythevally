import contextlib
import fcntl
import importlib.util
import io
import json
import multiprocessing
from pathlib import Path
import re
import subprocess
import sys
import os
import tempfile
import time
import urllib.request
import unittest
from unittest.mock import MagicMock, patch


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import e2e_rules
SPEC = importlib.util.spec_from_file_location("web_checks", ROOT / "scripts/web.py")
web = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(web)
REAL_PROCESS = web.evidence.Process
TOOLS = {"rustc": "same", "wasm-pack": "same"}


def write_package(root, destination, environment):
    with (root / "build-count").open("a") as stream:
        stream.write("build\n")
    destination.mkdir(parents=True)
    for name in web.WASM_FILES:
        (destination / name).write_bytes(b"\0asm payload" if name.endswith(".wasm") else b"generated API")


def concurrent_wasm(root, barrier):
    valid = web.valid_wasm
    initial = True
    def synchronized_valid(directory, key):
        nonlocal initial
        result = valid(directory, key)
        if initial:
            initial = False
            barrier.wait(10)
        return result
    with patch.object(web, "wasm_tools", return_value=TOOLS), patch.object(web.dev, "output", return_value=str(root / ".git")), patch.object(web, "run_wasm_pack", write_package), patch.object(web, "valid_wasm", synchronized_valid):
        web.ensure_wasm(root, web.environment_for(root, root / "target/tmp"))


class WebWorkflowTest(unittest.TestCase):
    def setUp(self):
        temporary = ROOT / "target/web-workflow-tests"
        temporary.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=temporary)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        files = {
            "Cargo.toml": '[workspace]\nmembers = ["crates/indicators-wasm", "crates/engine"]\n',
            "Cargo.lock": "locked dependencies",
            "crates/indicators-wasm/Cargo.toml": '[package]\nname = "indicators-wasm"\n[dependencies]\nengine = { path = "../engine" }\n',
            "crates/indicators-wasm/src/lib.rs": "wasm API",
            "crates/engine/Cargo.toml": '[package]\nname = "engine"\n',
            "crates/engine/src/lib.rs": "calculation",
            "scripts/web.py": "builder",
            "scripts/dev.py": "shared helpers",
            "web/scripts/build-wasm.sh": "entry point",
            "web/src/App.tsx": "current UI",
            "web/e2e/rules-baseline.json": "{}",
        }
        for name, value in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value)
        self.environment = web.environment_for(self.root, self.root / "target/tmp")
        self.addCleanup(patch.stopall)
        patch.object(web, "wasm_tools", return_value=TOOLS).start()
        patch.object(web.dev, "output", return_value=str(self.root / ".git")).start()
        patch.object(web, "run_wasm_pack", write_package).start()
        self.static = MagicMock()
        self.static.address.return_value = "http://127.0.0.1:54321"
        patch.object(web.evidence, "Process", return_value=self.static).start()

    def commands(self, command):
        return patch.object(web, "run", command)

    def build_count(self):
        path = self.root / "build-count"
        return len(path.read_text().splitlines()) if path.exists() else 0

    def assert_compile_unlocked(self):
        with (self.root / ".git/compile.lock").open("a") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_unchanged_wasm_skips_lock_and_ui_changes_keep_it_reusable(self):
        web.ensure_wasm(self.root, self.environment)
        (self.root / "web/src/App.tsx").write_text("new UI")
        with patch.object(web.dev, "locked", side_effect=AssertionError("cache hit took compile lock")):
            web.ensure_wasm(self.root, self.environment)
        self.assertEqual(self.build_count(), 1)

    def test_gate_wasm_build_does_not_wait_for_worker_compile_lock(self):
        (self.root / ".git").mkdir(exist_ok=True)
        with (self.root / ".git/compile.lock").open("a") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            with patch.dict(os.environ, {web.dev.COMPILE_LANE_ENV: "gate"}):
                self.assertEqual(web.dev.compile_lock_path(self.root).name, "compile-gate.lock")
                web.ensure_wasm(self.root, self.environment)
        self.assertEqual(self.build_count(), 1)

    def test_transitive_source_settings_and_corrupt_outputs_rebuild(self):
        web.ensure_wasm(self.root, self.environment)
        for name in ["crates/engine/src/lib.rs", "Cargo.lock"]:
            with (self.root / name).open("a") as stream:
                stream.write("changed")
            web.ensure_wasm(self.root, self.environment)
        (self.root / "web/src/wasm/indicators/indicators.js").write_text("damaged")
        web.ensure_wasm(self.root, self.environment)
        self.assertEqual(self.build_count(), 4)

    def test_failed_build_keeps_previous_complete_package_and_retry_recovers(self):
        web.ensure_wasm(self.root, self.environment)
        wasm = self.root / "web/src/wasm/indicators/indicators_bg.wasm"
        before = wasm.read_bytes()
        (self.root / "crates/engine/src/lib.rs").write_text("changed")
        def fail(root, destination, environment):
            destination.mkdir()
            (destination / "indicators.js").write_text("partial")
            raise subprocess.CalledProcessError(1, "wasm-pack")
        with patch.object(web, "run_wasm_pack", fail), self.assertRaises(subprocess.CalledProcessError):
            web.ensure_wasm(self.root, self.environment)
        self.assertEqual(wasm.read_bytes(), before)
        key = web.wasm_key(self.root, web.wasm_environment(self.environment), TOOLS)
        self.assertFalse(web.valid_wasm(self.root, key))
        web.ensure_wasm(self.root, self.environment)
        self.assertTrue(web.valid_wasm(self.root, key))

    def test_input_change_during_build_prevents_publication(self):
        def changing(root, destination, environment):
            write_package(root, destination, environment)
            (root / "crates/engine/src/lib.rs").write_text("edited during build")
        with patch.object(web, "run_wasm_pack", changing), self.assertRaisesRegex(ValueError, "입력이 바뀌어"):
            web.ensure_wasm(self.root, self.environment)
        self.assertFalse((self.root / "target/web/wasm.json").exists())
        self.assertFalse((self.root / "web/src/wasm/indicators").exists())

    def test_concurrent_requests_recheck_after_compile_lock_and_build_once(self):
        context = multiprocessing.get_context("fork")
        barrier = context.Barrier(2)
        processes = [context.Process(target=concurrent_wasm, args=(self.root, barrier)) for _ in range(2)]
        for process in processes:
            process.start()
        for process in processes:
            process.join(15)
            self.assertFalse(process.is_alive())
            self.assertEqual(process.exitcode, 0)
        self.assertEqual(self.build_count(), 1)

    def test_web_checks_prepare_wasm_once_and_run_checks_outside_compile_lock(self):
        calls = []
        def command(arguments, cwd, environment):
            if "tsc" in arguments[0] or "vitest" in arguments[0]:
                self.assert_compile_unlocked()
            calls.append(arguments)
        with self.commands(command):
            web.check_web(self.root, ["specific.test.ts"])
        self.assertEqual(calls[0], ["pnpm", "install", "--frozen-lockfile"])
        self.assertEqual(self.build_count(), 1)
        self.assertEqual(calls[-1][-2:], ["run", "specific.test.ts"])

    def test_e2e_rules_run_first_and_failure_skips_installation(self):
        calls = []
        with self.commands(lambda arguments, cwd, environment: calls.append(arguments)):
            web.check_web(self.root, [])
        self.assertEqual(calls[0], ["pnpm", "install", "--frozen-lockfile"])
        calls.clear()
        (self.root / "web/e2e/bad.spec.ts").write_text("await page.waitForTimeout(10);\n")
        with self.commands(lambda arguments, cwd, environment: calls.append(arguments)), contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(ValueError, "e2e 시험 규칙 위반 1건"):
            web.check_web(self.root, [])
        self.assertEqual(calls, [])
        manifests = sorted((self.root / "target/web-runs").glob("check-*/manifest.json"), key=lambda path: path.stat().st_mtime)
        steps = json.loads(manifests[-1].read_text())["steps"]
        self.assertEqual(list(steps)[0], "e2e-rules")
        self.assertEqual(steps["e2e-rules"]["status"], "failed")
        self.assertEqual(steps["dependencies"]["status"], "not_run")

    def test_e2e_uses_fresh_ui_and_separate_normalized_paths(self):
        stale = self.root / "web/dist/index.html"
        stale.parent.mkdir(parents=True)
        stale.write_text("old UI")
        observations = []
        def command(arguments, cwd, environment):
            if "vite" in arguments[0]:
                self.assert_compile_unlocked()
                directory = Path(arguments[arguments.index("--outDir") + 1])
                directory.mkdir(parents=True)
                (directory / "index.html").write_text("new UI")
            if "playwright" in arguments[0]:
                self.assert_compile_unlocked()
                self.assertEqual(environment["VALLY_E2E_BASE_URL"], "http://127.0.0.1:54321")
                self.assertEqual(environment["VALLY_E2E_PORT"], "0")
                temporary = Path(environment["TMPDIR"])
                self.assertEqual(temporary, temporary.resolve())
                self.assertTrue(temporary.is_relative_to(self.root))
                self.assertEqual((Path(environment["VALLY_E2E_STATIC_DIR"]) / "index.html").read_text(), "new UI")
                self.assertIn("e2e/example.spec.ts", arguments)
                self.assertIn("--workers=3", arguments)
                self.assertEqual(sum(arg.startswith("--workers=") for arg in arguments), 1)
                observations.append((environment["VALLY_E2E_STATIC_DIR"], environment["PLAYWRIGHT_HTML_OUTPUT_DIR"], next(arg for arg in arguments if arg.startswith("--output="))))
        with self.commands(command):
            for _ in range(2):
                web.run_e2e(self.root, ["e2e/example.spec.ts", "--workers=3"])
        self.assertNotEqual(observations[0], observations[1])
        self.assertEqual(stale.read_text(), "old UI")
        self.assertEqual(self.build_count(), 1)

    def playwright_arguments(self, arguments, cpus=32):
        captured = []
        def command(invoked, cwd, environment):
            if "vite" in invoked[0]:
                directory = Path(invoked[invoked.index("--outDir") + 1])
                directory.mkdir(parents=True)
                (directory / "index.html").write_text("new UI")
            if "playwright" in invoked[0]:
                captured.append(invoked[2:])
        output = io.StringIO()
        with self.commands(command), patch.object(web.os, "cpu_count", return_value=cpus), contextlib.redirect_stdout(output):
            web.run_e2e(self.root, arguments)
        notices = [line for line in output.getvalue().splitlines() if line.startswith("dev-web:") and "상한" in line]
        return captured[0], notices

    def worker_arguments(self, arguments):
        return [arg for arg in arguments if arg.startswith(("--workers", "-j"))]

    def test_e2e_workers_above_cap_are_reduced_with_one_notice(self):
        for form in (["--workers=12"], ["--workers", "12"], ["-j", "12"], ["-j12"], ["--workers=2", "--workers=12"]):
            with self.subTest(form):
                arguments, notices = self.playwright_arguments(["e2e/example.spec.ts", *form])
                self.assertEqual([arg for arg in arguments if arg.startswith("--workers")], ["--workers=6"])
                self.assertNotIn("12", arguments)
                self.assertNotIn("-j", arguments)
                self.assertNotIn("-j12", arguments)
                self.assertEqual(len(notices), 1)
                self.assertIn("12", notices[0])
                self.assertIn(str(web.MAX_E2E_WORKERS), notices[0])

    def test_e2e_workers_within_cap_are_kept_without_notice(self):
        for form in (["--workers=3"], ["-j", "3"]):
            with self.subTest(form):
                arguments, notices = self.playwright_arguments(["e2e/example.spec.ts", *form])
                self.assertEqual([arg for arg in arguments if arg.startswith("--workers")], ["--workers=3"])
                self.assertNotIn("-j", arguments)
                self.assertEqual(notices, [])

    def test_e2e_without_workers_uses_default(self):
        arguments, notices = self.playwright_arguments(["e2e/example.spec.ts"])
        self.assertEqual([arg for arg in arguments if arg.startswith("--workers")], ["--workers=2"])
        self.assertEqual(notices, [])

    def test_e2e_worker_percent_follows_cpu_count(self):
        arguments, notices = self.playwright_arguments(["--workers=50%"], cpus=32)
        self.assertEqual([arg for arg in arguments if arg.startswith("--workers")], ["--workers=6"])
        self.assertEqual(len(notices), 1)
        arguments, notices = self.playwright_arguments(["--workers=50%"], cpus=4)
        self.assertEqual([arg for arg in arguments if arg.startswith("--workers")], ["--workers=2"])
        self.assertEqual(notices, [])

    def test_e2e_unreadable_workers_pass_through(self):
        arguments, notices = self.playwright_arguments(["--workers=abc"])
        self.assertIn("--workers=abc", arguments)
        self.assertEqual(self.worker_arguments(arguments), ["--workers=abc"])
        self.assertEqual(notices, [])
        arguments, notices = self.playwright_arguments(["e2e/example.spec.ts", "--workers"])
        self.assertEqual(arguments[-2:][0], "--workers")
        self.assertEqual(notices, [])

    def test_playwright_config_project_workers_match_cap(self):
        config = (ROOT / "web/playwright.config.ts").read_text()
        match = re.search(r'name: "chromium",\s*workers: (\d+)', config)
        self.assertIsNotNone(match)
        self.assertEqual(int(match.group(1)), web.MAX_E2E_WORKERS)

    def test_parallel_static_hosts_use_distinct_ports_and_cleanup_owned_processes(self):
        distribution = self.root / "dist"
        distribution.mkdir()
        (distribution / "index.html").write_text("current browser fixture")
        environment = {**os.environ, "VALLY_E2E_STATIC_DIR": str(distribution), "VALLY_E2E_PORT": "0"}
        with web.evidence.Run(self.root, "static-probe", ["test"]) as record:
            hosts = []
            try:
                for index in range(2):
                    host = REAL_PROCESS(["node", str(ROOT / "web/e2e/serve.mjs")], environment, record.directory / f"static-{index}.log", record)
                    hosts.append(host)
                addresses = [host.address(time.monotonic() + 10) for host in hosts]
                self.assertNotEqual(*addresses)
                for address in addresses:
                    with urllib.request.urlopen(address, timeout=3) as response:
                        self.assertEqual(response.read(), b"current browser fixture")
            finally:
                for host in hosts:
                    host.stop()
            self.assertTrue(all(host.child.poll() is not None for host in hosts))
            self.assertTrue(all(entry["stop_reason"] == "owned_cleanup" for entry in record.data["processes"]))

    def test_frontend_build_failure_never_runs_playwright_on_stale_assets(self):
        called = []
        def command(arguments, cwd, environment):
            called.append(arguments[0])
            if "vite" in arguments[0]:
                raise subprocess.CalledProcessError(1, arguments)
        with self.commands(command), self.assertRaises(subprocess.CalledProcessError):
            web.run_e2e(self.root, [])
        self.assertFalse(any("playwright" in command for command in called))


    def test_static_start_failure_stops_owned_host_and_never_runs_playwright(self):
        commands = []
        def command(arguments, cwd, environment):
            commands.append(arguments[0])
            if "vite" in arguments[0]:
                directory = Path(arguments[arguments.index("--outDir") + 1])
                directory.mkdir()
                (directory / "index.html").write_text("new UI")
        self.static.address.side_effect = TimeoutError("static host startup")
        with self.commands(command), self.assertRaises(TimeoutError):
            web.run_e2e(self.root, [])
        self.static.stop.assert_called_once()
        self.assertFalse(any("playwright" in command for command in commands))
        manifest = self.latest_manifest()
        self.assertEqual(manifest["steps"]["static"]["status"], "failed")
        self.assertEqual(manifest["steps"]["playwright"]["status"], "not_run")

    def test_e2e_prunes_before_creating_its_run_directory(self):
        runs = self.root / "target/web-runs"
        runs.mkdir(parents=True)
        for index in range(7):
            directory = runs / f"e2e-pass{index}"
            directory.mkdir()
            (directory / "manifest.json").write_text(json.dumps({"status": "passed", "started_at": index}))
        seen = []
        original = web.evidence.Run
        def observing_run(*arguments, **options):
            seen.append({path.name for path in runs.iterdir()})
            return original(*arguments, **options)
        def command(arguments, cwd, environment):
            if "vite" in arguments[0]:
                directory = Path(arguments[arguments.index("--outDir") + 1])
                directory.mkdir(parents=True)
                (directory / "index.html").write_text("new UI")
        with self.commands(command), patch.object(web.evidence, "Run", observing_run), contextlib.redirect_stdout(io.StringIO()):
            web.run_e2e(self.root, [])
        self.assertEqual(seen, [{f"e2e-pass{index}" for index in range(2, 7)}])
        current = {path.name for path in runs.iterdir()} - seen[0]
        self.assertEqual(len(current), 1)

    def latest_manifest(self):
        path = next((self.root / "target/web-runs").glob("e2e-*/manifest.json"))
        return json.loads(path.read_text())

    def test_dependency_failure_preserves_manifest_and_never_runs_browser(self):
        calls = []
        def fail(arguments, cwd, environment):
            calls.append(arguments[0])
            if arguments[0] == "pnpm":
                raise subprocess.CalledProcessError(9, arguments)
        with self.commands(fail), self.assertRaises(subprocess.CalledProcessError):
            web.run_e2e(self.root, [])
        manifest = self.latest_manifest()
        self.assertEqual(manifest["status"], "failed")
        self.assertEqual(manifest["exit_code"], 1)
        self.assertEqual(manifest["steps"]["dependencies"]["status"], "failed")
        self.assertEqual(manifest["steps"]["playwright"]["status"], "not_run")
        self.assertFalse(any("playwright" in call for call in calls))

    def test_empty_ui_build_rejects_previous_dist_and_records_failure(self):
        stale = self.root / "web/dist/index.html"
        stale.parent.mkdir(parents=True)
        stale.write_text("old UI")
        with self.commands(lambda *args: None), self.assertRaisesRegex(ValueError, "index.html"):
            web.run_e2e(self.root, [])
        manifest = self.latest_manifest()
        self.assertEqual(manifest["steps"]["ui"]["status"], "failed")
        self.assertEqual(manifest["steps"]["playwright"]["status"], "not_run")
        self.assertNotIn("ui", manifest["artifacts"])

    def test_source_or_ui_tampering_is_rejected_before_playwright(self):
        directory = self.root / "dist"
        directory.mkdir()
        index = directory / "index.html"
        index.write_text("fresh")
        with self.assertRaisesRegex(ValueError, "산출물"), web.evidence.Run(self.root, "probe", ["test"]) as record:
            record.artifact("ui", directory, "direct", "source")
            with patch.object(web.evidence, "source", return_value={"sha256": "new source"}), self.assertRaises(ValueError):
                web.verify_ui(self.root, record)
            index.write_text("stale")
            with patch.object(web.evidence, "source", return_value={"sha256": "source"}), self.assertRaises(ValueError):
                web.verify_ui(self.root, record)

    def test_wasm_manifest_distinguishes_direct_and_reuse(self):
        with web.evidence.Run(self.root, "wasm", ["test"]) as record:
            web.ensure_wasm(self.root, self.environment)
            self.assertEqual(record.data["artifacts"]["wasm"]["execution"], "direct")
            web.ensure_wasm(self.root, self.environment)
            self.assertEqual(record.data["artifacts"]["wasm"]["execution"], "reused")
            self.assertTrue(record.data["artifacts"]["wasm"]["sha256"])

    def test_source_edit_during_preparation_fails_before_browser(self):
        source = self.root / "crates/engine/src/lib.rs"
        original = source.read_text()
        def fingerprint(root):
            return {"head": "fixture", "dirty": False, "sha256": web.hashlib.sha256(source.read_bytes()).hexdigest()}
        called = []
        def command(arguments, cwd, environment):
            called.append(arguments[0])
            if arguments[0] == "pnpm":
                source.write_text(original + "changed")
        with patch.object(web.evidence, "source", fingerprint), self.commands(command), self.assertRaisesRegex(ValueError, "준비 시작"):
            web.run_e2e(self.root, [])
        manifest = self.latest_manifest()
        self.assertEqual(manifest["status"], "failed")
        self.assertEqual(manifest["steps"]["playwright"]["status"], "not_run")
        self.assertFalse(any("playwright" in call for call in called))

    def test_frontend_e2e_never_prepares_native_binaries_or_database(self):
        def command(arguments, cwd, environment):
            self.assertFalse(any("dev.py" in arg or arg in ("cargo", "rustc") for arg in arguments))
            self.assertNotIn("VALLY_E2E_BIN_DIR", environment)
            if "vite" in arguments[0]:
                directory = Path(arguments[arguments.index("--outDir") + 1])
                directory.mkdir()
                (directory / "index.html").write_text("new UI")
        with self.commands(command), patch.object(web, "prepare_dart", side_effect=AssertionError("native preparation")):
            web.run_e2e(self.root, [])
        manifest = self.latest_manifest()
        self.assertEqual(manifest["status"], "passed")
        self.assertNotIn("server", manifest["steps"])
        self.assertNotIn("server", manifest["artifacts"])
        self.assertFalse((self.root / "target/dev").exists())

    def test_wasm_and_ui_replacement_fail_current_run(self):
        for name in ("wasm", "ui"):
            with self.subTest(name=name):
                def command(arguments, cwd, environment):
                    if "vite" in arguments[0]:
                        directory = Path(arguments[arguments.index("--outDir") + 1])
                        directory.mkdir()
                        (directory / "index.html").write_text("new UI")
                    if "playwright" in arguments[0]:
                        record = web.evidence.ACTIVE
                        artifact = record.data["artifacts"][name]
                        path = Path(artifact["path"]) / next(iter(artifact["sha256"]))
                        path.write_text("replaced during browser")
                with self.commands(command), self.assertRaisesRegex(ValueError, "산출물"):
                    web.run_e2e(self.root, [])
                manifests = [json.loads(path.read_text()) for path in (self.root / "target/web-runs").glob("e2e-*/manifest.json")]
                self.assertTrue(all(manifest["status"] == "failed" for manifest in manifests))


class WebRunsRetentionTest(unittest.TestCase):
    HOUR = 60 * 60

    def setUp(self):
        temporary = ROOT / "target/web-workflow-tests"
        temporary.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=temporary)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.runs = self.root / "target/web-runs"
        self.runs.mkdir(parents=True)

    def make(self, name, status="passed", started_at=None, age=0, manifest=True):
        directory = self.runs / name
        directory.mkdir()
        (directory / "payload.bin").write_bytes(b"x" * 1024)
        if manifest:
            data = {"status": status}
            if started_at is not None:
                data["started_at"] = started_at
            (directory / "manifest.json").write_text(json.dumps(data))
        past = time.time() - age
        for path in (directory / "manifest.json", directory):
            if path.exists():
                os.utime(path, (past, past))
        return directory

    def names(self):
        return {path.name for path in self.runs.iterdir()}

    def prune(self):
        output = io.StringIO()
        errors = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            web.prune_web_runs(self.root)
        return output.getvalue(), errors.getvalue()

    def test_keeps_newest_passed_and_failed_per_kind(self):
        for index in range(7):
            self.make(f"e2e-pass{index}", "passed", started_at=1000 + index)
        for index in range(12):
            self.make(f"e2e-fail{index}", "failed", started_at=2000 + index)
        for index in range(3):
            self.make(f"check-pass{index}", "passed", started_at=3000 + index)
        output, errors = self.prune()
        expected = {f"e2e-pass{index}" for index in range(2, 7)} | {f"e2e-fail{index}" for index in range(2, 12)} | {f"check-pass{index}" for index in range(3)}
        self.assertEqual(self.names(), expected)
        self.assertIn("dev-web: target/web-runs 정리: 4개 삭제", errors)
        self.assertEqual(output, "")

    def test_nothing_to_remove_prints_nothing(self):
        self.make("e2e-a", "passed", started_at=1)
        self.assertEqual(self.prune(), ("", ""))

    def test_manifest_without_started_at_is_ordered_by_folder_time(self):
        for index in range(7):
            self.make(f"e2e-old{index}", "passed", age=(100 - index) * self.HOUR)
        self.prune()
        self.assertEqual(self.names(), {f"e2e-old{index}" for index in range(2, 7)})

    def test_started_at_wins_over_folder_time(self):
        for index in range(6):
            self.make(f"e2e-run{index}", "passed", started_at=1000 + index, age=index * self.HOUR)
        self.prune()
        self.assertEqual(self.names(), {f"e2e-run{index}" for index in range(1, 6)})

    def test_unreadable_started_at_and_manifest_fall_back_to_folder_time(self):
        for index in range(5):
            self.make(f"e2e-pass{index}", "passed", started_at=1000 + index, age=100 * self.HOUR)
        nan = self.make("e2e-nan", "passed", age=self.HOUR)
        (nan / "manifest.json").write_text('{"status": "passed", "started_at": NaN}')
        deep = self.make("e2e-deep", "passed", age=2 * self.HOUR)
        (deep / "manifest.json").write_text("[" * 200000)
        self.make("e2e-pass5", "passed", started_at=1005, age=100 * self.HOUR)
        self.prune()
        self.assertEqual(self.names(), {"e2e-pass5", "e2e-pass4", "e2e-pass3", "e2e-pass2", "e2e-nan", "e2e-deep"})

    def test_recent_running_and_manifestless_are_protected_and_uncounted(self):
        for index in range(10):
            self.make(f"e2e-fail{index}", "failed", started_at=100 + index)
        self.make("e2e-running", "running", started_at=1, age=self.HOUR)
        self.make("e2e-bare", manifest=False, age=self.HOUR)
        self.prune()
        self.assertEqual(len(self.names()), 12)

    def test_stale_running_and_manifestless_count_as_failed(self):
        for index in range(10):
            self.make(f"e2e-fail{index}", "failed", started_at=time.time() + index)
        self.make("e2e-running", "running", started_at=1, age=7 * self.HOUR)
        self.make("e2e-bare", manifest=False, age=7 * self.HOUR)
        self.make("e2e-broken", age=7 * self.HOUR)
        (self.runs / "e2e-broken/manifest.json").write_text("{not json")
        os.utime(self.runs / "e2e-broken/manifest.json", (time.time() - 7 * self.HOUR,) * 2)
        os.utime(self.runs / "e2e-broken", (time.time() - 7 * self.HOUR,) * 2)
        self.prune()
        self.assertEqual(self.names(), {f"e2e-fail{index}" for index in range(10)})

    def test_links_files_other_names_and_dev_runs_are_untouched(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "keep.txt").write_text("outside")
        for index in range(8):
            self.make(f"e2e-pass{index}", "passed", started_at=index)
        (self.runs / "e2e-link").symlink_to(outside, target_is_directory=True)
        (self.runs / "e2e-file").write_text("file")
        self.make("notes", "passed", started_at=0)
        self.make("-nokind", "passed", started_at=0)
        self.make("e2e-", "passed", started_at=0)
        dev_runs = self.root / "target/dev-runs"
        dev_runs.mkdir()
        for index in range(8):
            (dev_runs / f"dev-build-{index}").mkdir()
        self.prune()
        self.assertEqual(self.names(), {f"e2e-pass{index}" for index in range(3, 8)} | {"e2e-link", "e2e-file", "notes", "-nokind", "e2e-"})
        self.assertEqual((outside / "keep.txt").read_text(), "outside")
        self.assertEqual(len(list(dev_runs.iterdir())), 8)

    def test_removal_error_warns_and_continues(self):
        for index in range(7):
            self.make(f"e2e-pass{index}", "passed", started_at=index)
        with patch.object(web.shutil, "rmtree", side_effect=PermissionError("denied")):
            output, errors = self.prune()
        self.assertEqual(len(self.names()), 7)
        self.assertEqual(output, "")
        self.assertEqual(errors.count("dev-web: 경고:"), 2)

    def test_directory_removed_by_another_process_is_not_an_error(self):
        for index in range(7):
            self.make(f"e2e-pass{index}", "passed", started_at=index)
        with patch.object(web.shutil, "rmtree", side_effect=FileNotFoundError):
            output, errors = self.prune()
        self.assertEqual((output, errors), ("", ""))

    def test_missing_web_runs_directory_is_not_an_error(self):
        self.runs.rmdir()
        self.assertEqual(self.prune(), ("", ""))


class E2eRulesTest(unittest.TestCase):
    CASES = {
        "waitForTimeout": ("a.spec.ts", "test('x', async ({ page }) => {\n  await page.waitForTimeout(10);\n});\n", 2, "fixedWait"),
        "serial-describe": ("a.spec.ts", "test.describe.serial('x', () => {});\n", 1, "scenario"),
        "serial-configure": ("a.spec.ts", "test.describe.configure({ mode: 'serial' });\n", 1, "scenario"),
        "beforeAll": ("a.spec.ts", "\ntest.beforeAll(async () => {});\n", 2, "scenario"),
        "afterAll": ("a.spec.ts", "test.afterAll(async () => {});\n", 1, "scenario"),
        "let": ("a.spec.ts", "import x from 'y';\nlet shared = 1;\n", 2, "scenario"),
        "export let": ("a.spec.ts", "export let shared = 1;\n", 1, "scenario"),
        "var": ("a.spec.ts", "var shared = 1;\n", 1, "scenario"),
        "setTimeout": ("a.spec.ts", "test('x', async () => {\n  test.setTimeout(120_000);\n});\n", 2, "그룹별"),
        "slow": ("a.spec.ts", "test.slow();\n", 1, "그룹별"),
        "testInfo setTimeout": ("a.spec.ts", "testInfo.setTimeout(1);\n", 1, "그룹별"),
        "configure nested timeout": ("a.spec.ts", "test.describe.configure({ retries: { x: 1 }, timeout: 90000 });\n", 1, "그룹별"),
        "spaced waitForTimeout": ("a.spec.ts", "await page.waitForTimeout (5);\n", 1, "fixedWait"),
        "spaced serial": ("a.spec.ts", "test.describe . serial('x', () => {});\n", 1, "scenario"),
        "tab let": ("a.spec.ts", "let\tshared = 1;\n", 1, "scenario"),
        "optional waitForTimeout": ("a.spec.ts", "await page.waitForTimeout?.(10);\n", 1, "fixedWait"),
        "bound waitForTimeout": ("a.spec.ts", "const wait = page.waitForTimeout.bind(page);\n", 1, "fixedWait"),
        "info setTimeout": ("a.spec.ts", "test.info().setTimeout(1);\n", 1, "그룹별"),
        "split test setTimeout": ("a.spec.ts", "test\n  .setTimeout(1);\n", 1, "그룹별"),
        "backtick serial": ("a.spec.ts", "test.describe.configure({ mode: `serial` });\n", 1, "scenario"),
        "configure timeout": ("a.spec.ts", "test.describe.configure({\n  timeout: 120_000,\n});\n", 1, "그룹별"),
    }

    def setUp(self):
        temporary = ROOT / "target/web-workflow-tests"
        temporary.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=temporary)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "web/e2e").mkdir(parents=True)
        self.baseline({})

    def baseline(self, value):
        (self.root / "web/e2e/rules-baseline.json").write_text(json.dumps(value))

    def write(self, name, text):
        (self.root / "web/e2e" / name).write_text(text)

    def test_clean_tree_passes(self):
        self.write("a.spec.ts", "import { test } from './harness';\ntest('x', async ({ page }) => {\n  let local = 1;\n  test.describe.configure({ mode: 'parallel' });\n});\n")
        self.assertEqual(e2e_rules.check(self.root), [])

    def test_each_rule_reports_file_line_and_fix(self):
        for name, (file, text, line, fix) in self.CASES.items():
            with self.subTest(name):
                self.write(file, text)
                problems = e2e_rules.check(self.root)
                self.assertEqual(len(problems), 1, problems)
                self.assertTrue(problems[0].startswith(f"web/e2e/{file}:{line} "), problems[0])
                self.assertIn(fix, problems[0])

    def test_harness_may_wait_and_indented_let_is_not_module_level(self):
        self.write("harness.ts", "await page.waitForTimeout(ms);\n")
        self.write("probe.ts", "let shared = 1;\n")
        self.assertEqual(e2e_rules.check(self.root), [])

    def test_baseline_must_match_exactly(self):
        self.write("a.spec.ts", "await page.waitForTimeout(1);\nawait page.waitForTimeout(2);\n")
        self.baseline({"waitForTimeout": {"a.spec.ts": 2}})
        self.assertEqual(e2e_rules.check(self.root), [])
        self.baseline({"waitForTimeout": {"a.spec.ts": 1}})
        self.assertEqual(len(e2e_rules.check(self.root)), 2)
        self.baseline({"waitForTimeout": {"a.spec.ts": 3}})
        lowered = e2e_rules.check(self.root)
        self.assertEqual(len(lowered), 1)
        self.assertIn("허용 목록을 2으로 낮춘다", lowered[0])

    def test_file_missing_from_baseline_is_new_violation(self):
        self.write("a.spec.ts", "await page.waitForTimeout(1);\n")
        self.write("b.spec.ts", "await page.waitForTimeout(1);\n")
        self.baseline({"waitForTimeout": {"a.spec.ts": 1}})
        problems = e2e_rules.check(self.root)
        self.assertEqual(len(problems), 1)
        self.assertTrue(problems[0].startswith("web/e2e/b.spec.ts:1 "))

    def test_entry_point_exits_nonzero_with_location(self):
        self.write("a.spec.ts", "test.beforeAll(async () => {});\n")
        with patch("sys.stdout", io.StringIO()) as output:
            self.assertEqual(e2e_rules.main(self.root), 1)
        self.assertIn("web/e2e/a.spec.ts:1", output.getvalue())


if __name__ == "__main__":
    with contextlib.redirect_stdout(io.StringIO()):
        unittest.main()
