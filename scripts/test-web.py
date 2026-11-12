import contextlib
import fcntl
import importlib.util
import io
import multiprocessing
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("web_checks", ROOT / "scripts/web.py")
web = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(web)
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
        with patch.object(web, "run", command):
            web.check_web(self.root, ["specific.test.ts"])
        self.assertEqual(calls[0], ["pnpm", "install", "--frozen-lockfile"])
        self.assertEqual(self.build_count(), 1)
        self.assertEqual(calls[-1][-2:], ["run", "specific.test.ts"])

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
                temporary = Path(environment["TMPDIR"])
                self.assertEqual(temporary, temporary.resolve())
                self.assertTrue(temporary.is_relative_to(self.root))
                self.assertEqual((Path(environment["VALLY_E2E_STATIC_DIR"]) / "index.html").read_text(), "new UI")
                self.assertIn("e2e/example.spec.ts", arguments)
                self.assertIn("--workers=3", arguments)
                self.assertEqual(sum(arg.startswith("--workers=") for arg in arguments), 1)
                observations.append((environment["VALLY_E2E_STATIC_DIR"], environment["PLAYWRIGHT_HTML_OUTPUT_DIR"], next(arg for arg in arguments if arg.startswith("--output="))))
        with patch.object(web, "run", command):
            for _ in range(2):
                web.run_e2e(self.root, ["e2e/example.spec.ts", "--workers=3"])
        self.assertNotEqual(observations[0], observations[1])
        self.assertEqual(stale.read_text(), "old UI")
        self.assertEqual(self.build_count(), 1)

    def test_frontend_build_failure_never_runs_playwright_on_stale_assets(self):
        called = []
        def command(arguments, cwd, environment):
            called.append(arguments[0])
            if "vite" in arguments[0]:
                raise subprocess.CalledProcessError(1, arguments)
        with patch.object(web, "run", command), self.assertRaises(subprocess.CalledProcessError):
            web.run_e2e(self.root, [])
        self.assertFalse(any("playwright" in command for command in called))


if __name__ == "__main__":
    with contextlib.redirect_stdout(io.StringIO()):
        unittest.main()
