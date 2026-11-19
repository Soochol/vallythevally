import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import unittest


DEPLOY = Path(__file__).resolve().parent.parent / "deploy"
SCRIPTS = ["server-build", "web-build", "backup", "restart"]


def write_stub(folder, name, body):
    path = folder / name
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(0o755)


class DeployScriptCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "checkout"
        self.stubs = Path(self.temp.name) / "stubs"
        self.calls = Path(self.temp.name) / "calls"
        self.stubs.mkdir()
        shutil.copytree(DEPLOY, self.root / "deploy", ignore=shutil.ignore_patterns("systemd"))
        (self.root / "web").mkdir()
        self.git("init", "-q")
        self.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base")
        self.head = self.git("rev-parse", "HEAD").stdout.strip()

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True, text=True)

    def stub_recording(self, name, extra=""):
        write_stub(self.stubs, name, f'echo "{name} $* jobs=${{CARGO_BUILD_JOBS:-}} cwd=$(pwd)" >> "{self.calls}"\n{extra}')

    def recorded(self):
        return self.calls.read_text().splitlines() if self.calls.exists() else []

    def run_script(self, name, **env):
        full = {key: value for key, value in os.environ.items() if not key.startswith(("VALLY_", "ORCH_DEPLOY_"))}
        full["HOME"] = self.temp.name
        full["PATH"] = f"{self.stubs}:{full['PATH']}"
        full.update(env)
        return subprocess.run([str(self.root / "deploy" / name)], cwd="/", env=full, capture_output=True, text=True, timeout=60)


class ServerBuildTest(DeployScriptCase):
    def setUp(self):
        super().setUp()
        self.stub_recording("cargo")

    def test_calls_cargo_release_build_with_job_count_from_checkout_root(self):
        result = self.run_script("server-build", VALLY_BUILD_JOBS="3", VALLY_CARGO_BIN=str(self.stubs))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded(), [f"cargo build --locked --release -p server jobs=3 cwd={self.root.resolve()}"])

    def test_defaults_to_four_jobs(self):
        result = self.run_script("server-build", VALLY_CARGO_BIN=str(self.stubs))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("jobs=4", self.recorded()[0])

    def test_matching_target_sha_builds(self):
        result = self.run_script("server-build", VALLY_CARGO_BIN=str(self.stubs), ORCH_DEPLOY_SHA=self.head)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.recorded()), 1)

    def test_different_target_sha_fails_without_calling_cargo(self):
        result = self.run_script("server-build", VALLY_CARGO_BIN=str(self.stubs), ORCH_DEPLOY_SHA="0" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(self.head, result.stderr)
        self.assertEqual(self.recorded(), [])


class WebBuildTest(DeployScriptCase):
    def setUp(self):
        super().setUp()
        self.node_bin = Path(self.temp.name) / "node-bin"
        self.node_bin.mkdir()
        self.stub_recording("pnpm")

    def test_missing_node_bin_fails_with_guidance_and_does_not_call_pnpm(self):
        result = self.run_script("web-build")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("VALLY_NODE_BIN", result.stderr)
        self.assertIn("ls ~/.local/share/fnm/node-versions", result.stderr)
        self.assertIn("deploy.json", result.stderr)
        self.assertEqual(self.recorded(), [])

    def test_node_bin_without_pnpm_fails_even_when_another_pnpm_is_on_path(self):
        result = self.run_script("web-build", VALLY_NODE_BIN=str(self.node_bin))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(str(self.node_bin), result.stderr)
        self.assertEqual(self.recorded(), [])

    def test_runs_install_then_build_in_web_folder(self):
        for name in ["pnpm"]:
            (self.stubs / name).rename(self.node_bin / name)
        result = self.run_script("web-build", VALLY_NODE_BIN=str(self.node_bin))
        self.assertEqual(result.returncode, 0, result.stderr)
        web = (self.root / "web").resolve()
        self.assertEqual(self.recorded(), [f"pnpm install --frozen-lockfile jobs=4 cwd={web}", f"pnpm build jobs=4 cwd={web}"])


class BackupTest(DeployScriptCase):
    def setUp(self):
        super().setUp()
        self.data = Path(self.temp.name) / "data"
        (self.data / "server").mkdir(parents=True)
        database = sqlite3.connect(self.data / "server/vally.db")
        database.execute("create table watch (code text)")
        database.execute("insert into watch values ('005930')")
        database.commit()
        database.close()
        self.folder = self.data / "backups"

    def test_copies_database_with_ok_integrity(self):
        result = self.run_script("backup", VALLY_DATA_DIR=str(self.data))
        self.assertEqual(result.returncode, 0, result.stderr)
        [copy_path] = list(self.folder.glob("vally-*.db"))
        copy = sqlite3.connect(copy_path)
        self.assertEqual(copy.execute("pragma integrity_check").fetchone()[0], "ok")
        self.assertEqual(copy.execute("select code from watch").fetchall(), [("005930",)])
        copy.close()
        self.assertEqual(list(self.folder.glob("*.part")), [])

    def test_keep_removes_oldest_first(self):
        self.folder.mkdir()
        old = ["vally-20200101-000000.db", "vally-20200102-000000.db", "vally-20200103-000000.db"]
        for name in old:
            (self.folder / name).write_bytes(b"old")
        result = self.run_script("backup", VALLY_DATA_DIR=str(self.data), VALLY_BACKUP_KEEP="2")
        self.assertEqual(result.returncode, 0, result.stderr)
        remaining = sorted(path.name for path in self.folder.glob("vally-*.db"))
        self.assertEqual(len(remaining), 2)
        self.assertEqual(remaining[0], old[2])
        self.assertTrue(remaining[1] > old[2])

    def test_missing_source_fails_naming_path(self):
        (self.data / "server/vally.db").unlink()
        result = self.run_script("backup", VALLY_DATA_DIR=str(self.data))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(str(self.data / "server/vally.db"), result.stderr)
        self.assertFalse(self.folder.exists())

    def test_data_folder_with_uri_special_characters_is_backed_up(self):
        special = Path(self.temp.name) / "data#1?x"
        shutil.move(self.data, special)
        result = self.run_script("backup", VALLY_DATA_DIR=str(special))
        self.assertEqual(result.returncode, 0, result.stderr)
        [copy_path] = list((special / "backups").glob("vally-*.db"))
        copy = sqlite3.connect(copy_path)
        self.assertEqual(copy.execute("select code from watch").fetchall(), [("005930",)])
        copy.close()

    def test_rejects_keep_below_one(self):
        result = self.run_script("backup", VALLY_DATA_DIR=str(self.data), VALLY_BACKUP_KEEP="0")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("VALLY_BACKUP_KEEP", result.stderr)

    def test_default_data_folder_is_home_vally_data(self):
        default = Path(self.temp.name) / "vally-data"
        shutil.move(self.data, default)
        result = self.run_script("backup")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(list((default / "backups").glob("vally-*.db"))), 1)


class RestartTest(DeployScriptCase):
    def stub_flaky(self, name, failures, restart_ok=False):
        counter = Path(self.temp.name) / f"{name}.count"
        restart_case = f'if [ "$2" = restart ]; then echo "{name} $*" >> "{self.calls}"; exit 0; fi\n' if restart_ok else ""
        write_stub(self.stubs, name, f'''{restart_case}echo "{name} $*" >> "{self.calls}"
count=$(cat "{counter}" 2>/dev/null || echo 0)
echo $((count + 1)) > "{counter}"
[ "$count" -ge {failures} ]
''')

    def test_succeeds_after_transient_failures(self):
        self.stub_flaky("systemctl", 1, restart_ok=True)
        self.stub_flaky("curl", 1)
        result = self.run_script("restart", VALLY_SERVICE="demo.service", VALLY_HEALTH_URL="http://127.0.0.1:1/health")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.recorded()
        self.assertEqual(calls[0], "systemctl --user restart demo.service")
        self.assertIn("systemctl --user is-active --quiet demo.service", calls)
        self.assertGreaterEqual(sum(call.startswith("curl") for call in calls), 2)
        self.assertTrue(all("http://127.0.0.1:1/health" in call for call in calls if call.startswith("curl")))

    def test_invalid_wait_fails_before_restarting(self):
        self.stub_flaky("systemctl", 0, restart_ok=True)
        for wait in ["0", "abc", "1.5"]:
            result = self.run_script("restart", VALLY_RESTART_WAIT=wait)
            self.assertEqual(result.returncode, 2, wait)
            self.assertIn("VALLY_RESTART_WAIT", result.stderr)
        self.assertEqual(self.recorded(), [])

    def test_fails_with_journal_guidance_when_never_healthy(self):
        self.stub_flaky("systemctl", 0, restart_ok=True)
        write_stub(self.stubs, "curl", "exit 22\n")
        result = self.run_script("restart", VALLY_RESTART_WAIT="2", VALLY_SERVICE="demo.service")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("journalctl --user -u demo.service", result.stderr)
        self.assertIn("2초", result.stderr)


class CommittedModeTest(unittest.TestCase):
    def test_all_scripts_are_committed_executable(self):
        listing = subprocess.run(["git", "ls-files", "-s", "deploy/"], cwd=DEPLOY.parent, check=True, capture_output=True, text=True).stdout
        modes = {line.split("\t")[1]: line.split()[0] for line in listing.splitlines()}
        for name in SCRIPTS:
            self.assertEqual(modes.get(f"deploy/{name}"), "100755", name)

    def test_working_copy_is_executable(self):
        for name in SCRIPTS:
            self.assertTrue((DEPLOY / name).stat().st_mode & stat.S_IXUSR, name)


if __name__ == "__main__":
    unittest.main()
