import contextlib
import hashlib
import importlib.util
import io
import json
import multiprocessing
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("dev", ROOT / "scripts/dev.py")
dev = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dev)


def write_binaries(root):
    destination = root / "target/debug"
    destination.mkdir(parents=True, exist_ok=True)
    for name in dev.BINARIES:
        path = destination / name
        path.write_text(f"#!/bin/sh\nprintf '{name}\\n'\n")
        path.chmod(0o755)


def concurrent_build(root, cache):
    def build():
        with (cache / "build-count").open("a") as stream:
            stream.write("build\n")
        write_binaries(root)
    dev.cached_build(root, cache, "same-inputs", lambda: "same-inputs", build)


class DevCacheTest(unittest.TestCase):
    def setUp(self):
        temporary = ROOT / "target/dev-build-tests"
        temporary.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=temporary)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "worktree"
        self.cache = Path(self.directory.name) / "shared"
        self.root.mkdir()
        self.cache.mkdir()

    def test_identical_worktrees_share_key_but_build_inputs_invalidate(self):
        for name in ("Cargo.toml", "Cargo.lock", "scripts/dev.py", "scripts/duckdb-prebuilt.json", "crates/server/src/main.rs", ".cargo/config.toml"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name)
        second = self.root.parent / "second"
        shutil.copytree(self.root, second)
        key = dev.fingerprint(self.root, {"rustc": "same"}, False, {})
        self.assertEqual(key, dev.fingerprint(second, {"rustc": "same"}, False, {}))
        (second / "web").mkdir()
        (second / "web/App.tsx").write_text("new UI")
        self.assertEqual(key, dev.fingerprint(second, {"rustc": "same"}, False, {}))
        (second / "crates/server/target/sqlx").mkdir(parents=True)
        (second / "crates/server/target/sqlx/test.sqlite").write_bytes(b"test output")
        self.assertEqual(key, dev.fingerprint(second, {"rustc": "same"}, False, {}))
        for name in ("crates/server/src/main.rs", "Cargo.lock", ".cargo/config.toml"):
            before = (second / name).read_text()
            (second / name).write_text("changed")
            self.assertNotEqual(key, dev.fingerprint(second, {"rustc": "same"}, False, {}))
            (second / name).write_text(before)
        self.assertNotEqual(key, dev.fingerprint(second, {"rustc": "different"}, False, {}))
        self.assertNotEqual(key, dev.fingerprint(second, {"rustc": "same"}, False, {"RUSTFLAGS": "-C opt-level=1"}))
        self.assertNotEqual(key, dev.fingerprint(second, {"rustc": "same"}, False, {}, ("vally-server",)))

    def test_binaries_restore_to_new_worktree_and_corruption_rebuilds(self):
        calls = []
        def build():
            calls.append("build")
            write_binaries(self.root)
        dev.cached_build(self.root, self.cache, "key", lambda: "key", build)
        shutil.rmtree(self.root / "target")
        dev.cached_build(self.root, self.cache, "key", lambda: "key", build)
        self.assertEqual(calls, ["build"])
        self.assertTrue((self.root / "target/dev/bin/fake-kiwoom").is_file())
        (self.cache / "binaries/key/vally-server").write_text("damaged")
        dev.cached_build(self.root, self.cache, "key", lambda: "key", build)
        self.assertEqual(calls, ["build", "build"])

    def test_binding_version_and_user_cargo_config_are_checked(self):
        (self.root / "scripts").mkdir()
        (self.root / "scripts/duckdb-prebuilt.json").write_text(json.dumps({"crate_version": "expected"}))
        (self.root / "Cargo.lock").write_text('[[package]]\nname = "duckdb"\nversion = "different"\n')
        with self.assertRaisesRegex(ValueError, "함께 갱신"):
            dev.load_pin(self.root)
        for name in ("Cargo.toml", "scripts/dev.py"):
            (self.root / name).write_text(name)
        for name in ("crates", ".cargo"):
            (self.root / name).mkdir()
        cargo_home = self.root.parent / "cargo-home"
        cargo_home.mkdir()
        config = cargo_home / "config.toml"
        config.write_text('some = "before"')
        environment = {"CARGO_HOME": str(cargo_home)}
        before = dev.fingerprint(self.root, {}, False, environment)
        config.write_text('some = "after"')
        self.assertNotEqual(before, dev.fingerprint(self.root, {}, False, environment))

    def test_failed_first_build_and_partial_publish_never_become_reusable(self):
        entry = self.cache / "binaries/key"
        def fail():
            raise RuntimeError("compile failed")
        with self.assertRaises(RuntimeError):
            dev.cached_build(self.root, self.cache, "key", lambda: "key", fail)
        self.assertFalse(entry.exists())
        write_binaries(self.root)
        copy = shutil.copy2
        calls = []
        def partial(source, destination):
            calls.append(source)
            if len(calls) == 2:
                raise OSError("disk failure")
            return copy(source, destination)
        with patch.object(dev.shutil, "copy2", partial), self.assertRaises(OSError):
            dev.publish_binaries(self.root / "target/debug", entry, "key")
        self.assertFalse(dev.valid_binaries(entry, "key"))
        dev.cached_build(self.root, self.cache, "key", lambda: "key", lambda: write_binaries(self.root))
        self.assertTrue(dev.valid_binaries(entry, "key"))

    def test_input_changes_during_compilation_prevent_publication(self):
        with self.assertRaisesRegex(ValueError, "빌드 입력이 바뀌어"):
            dev.cached_build(self.root, self.cache, "before", lambda: "after", lambda: write_binaries(self.root))
        self.assertFalse((self.cache / "binaries/before").exists())

    def test_concurrent_worktrees_build_once(self):
        second = self.root.parent / "second"
        second.mkdir()
        context = multiprocessing.get_context("fork")
        processes = [context.Process(target=concurrent_build, args=(root, self.cache)) for root in (self.root, second)]
        for process in processes:
            process.start()
        for process in processes:
            process.join(10)
            self.assertFalse(process.is_alive())
            self.assertEqual(process.exitcode, 0)
        self.assertEqual((self.cache / "build-count").read_text(), "build\n")
        self.assertEqual(dev.digest(self.root / "target/dev/bin/vally-server"), dev.digest(second / "target/dev/bin/vally-server"))

    def archive(self):
        content = b"library bytes"
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            member = tarfile.TarInfo("libduckdb.so")
            member.size = len(content)
            archive.addfile(member, io.BytesIO(content))
        packed = buffer.getvalue()
        artifact = {"library": "libduckdb.so", "url": "https://example.invalid/duckdb", "archive_sha256": hashlib.sha256(packed).hexdigest(), "library_sha256": hashlib.sha256(content).hexdigest()}
        return packed, {"engine_version": "version", "artifacts": {"host": artifact}}

    def test_download_checksums_reuse_and_recovery(self):
        packed, pin = self.archive()
        with patch.object(dev.urllib.request, "urlopen", return_value=io.BytesIO(b"wrong archive")), self.assertRaisesRegex(ValueError, "아카이브 SHA"):
            dev.prepare_duckdb(self.cache, pin, "host")
        artifact = pin["artifacts"]["host"]
        entry = dev.library_entry(self.cache, artifact)
        self.assertFalse(entry.exists())
        with patch.object(dev.urllib.request, "urlopen", return_value=io.BytesIO(packed)), patch.object(dev, "verify_engine"):
            dev.prepare_duckdb(self.cache, pin, "host")
        with patch.object(dev.urllib.request, "urlopen", side_effect=AssertionError("unexpected download")), patch.object(dev, "verify_engine"):
            dev.prepare_duckdb(self.cache, pin, "host")
        (entry / "libduckdb.so").write_bytes(b"damaged")
        with patch.object(dev.urllib.request, "urlopen", return_value=io.BytesIO(packed)), patch.object(dev, "verify_engine"):
            dev.prepare_duckdb(self.cache, pin, "host")
        self.assertTrue(dev.valid_library(entry, artifact))

    def test_interrupted_download_never_publishes_partial_library(self):
        packed, pin = self.archive()
        class Interrupted(io.BytesIO):
            def read(self, size=-1):
                if self.tell():
                    raise OSError("connection lost")
                return super().read(5)
        with patch.object(dev.urllib.request, "urlopen", return_value=Interrupted(packed)), self.assertRaisesRegex(OSError, "connection lost"):
            dev.prepare_duckdb(self.cache, pin, "host")
        entry = dev.library_entry(self.cache, pin["artifacts"]["host"])
        self.assertFalse(entry.exists())

    def test_cargo_test_compiles_with_lock_then_executes_without_it(self):
        command = dev.cargo_command(["test", "-p", "server", "--", "test_name"], False)
        events = []
        with patch.object(dev, "compile_command", side_effect=lambda root, cmd, env: events.append(("compile", cmd))), patch.object(dev.subprocess, "run", side_effect=lambda cmd, **kwargs: events.append(("execute", cmd))):
            dev.run_cargo(self.root, command, {})
        self.assertEqual([kind for kind, _ in events], ["compile", "execute"])
        self.assertIn("--no-run", events[0][1][:events[0][1].index("--")])
        self.assertNotIn("--no-run", events[1][1])
        self.assertIn("--no-default-features", command)
        self.assertNotIn("--no-default-features", dev.cargo_command(["build"], True))
        with self.assertRaises(ValueError):
            dev.cargo_command(["build", "--release"], False)

    def test_fake_only_tests_do_not_prepare_duckdb(self):
        self.assertFalse(dev.needs_duckdb(["cargo", "test", "-p", "fake-kiwoom"]))
        self.assertTrue(dev.needs_duckdb(["cargo", "test", "--workspace"]))
        self.assertTrue(dev.needs_duckdb(["cargo", "build", "-p", "server", "-p", "fake-kiwoom"]))


if __name__ == "__main__":
    with contextlib.redirect_stdout(io.StringIO()):
        unittest.main()
