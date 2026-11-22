import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import unittest


DEPLOY = Path(__file__).resolve().parent.parent / "deploy"
SCRIPTS = ["server-build", "web-build", "backup", "restart", "collector-build", "collector-install", "collector-restart"]


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

    def run_script(self, name, *arguments, **env):
        full = {key: value for key, value in os.environ.items() if not key.startswith(("VALLY_", "ORCH_DEPLOY_"))}
        full["HOME"] = self.temp.name
        full["PATH"] = f"{self.stubs}:{full['PATH']}"
        full.update(env)
        return subprocess.run([str(self.root / "deploy" / name), *arguments], cwd="/", env=full, capture_output=True, text=True, timeout=60)


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


class FakeCollectorHost(DeployScriptCase):
    def setUp(self):
        super().setUp()
        self.state = Path(self.temp.name) / "systemd-state"
        self.state.mkdir()
        self.verdict = Path(self.temp.name) / "verdict"
        write_stub(self.stubs, "sleep", "exit 0\n")
        write_stub(self.stubs, "collector", self.collector_body("stub collector"))
        write_stub(self.stubs, "systemctl", f"""echo "systemctl $*" >> "{self.calls}"
case "$2" in
    stop) rm -f "{self.state}/$3"; exit 0 ;;
    restart) [ -z "${{VALLY_COLLECTOR_BIN:-}}" ] || cp "$VALLY_COLLECTOR_BIN" "{self.state}/binary-at-restart"; exit "${{FAKE_RESTART_EXIT:-0}}" ;;
    is-active) [ ! -e "{self.state}/inactive" ] ;;
    daemon-reload) [ ! -e "{self.state}/reload-fails" ] ;;
esac
""")
        write_stub(self.stubs, "systemd-run", f"""echo "systemd-run $*" >> "{self.calls}"
for argument in "$@"; do
    case "$argument" in --unit=*) unit="${{argument#--unit=}}" ;; esac
done
if [ -e "{self.state}/$unit.timer" ]; then echo "Unit $unit.service already exists" >&2; exit 1; fi
echo "$*" > "{self.state}/$unit.timer"
""")

    def collector_body(self, version, record=True):
        recording = f'echo "collector $*" >> "{self.calls}"\n' if record else ""
        return f'{recording}cat "{self.verdict}"\nexit "${{FAKE_VERDICT_EXIT:-0}}"\n# {version}\n'

    def say(self, verdict):
        self.verdict.write_text(verdict + "\n")

    def reservations(self):
        return sorted(path.name for path in self.state.glob("*.timer"))


class CollectorBuildTest(DeployScriptCase):
    def setUp(self):
        super().setUp()
        self.stub_recording("cargo")

    def test_builds_only_the_collector_release_from_checkout_root(self):
        result = self.run_script("collector-build", VALLY_BUILD_JOBS="3", VALLY_CARGO_BIN=str(self.stubs))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded(), [f"cargo build --locked --release -p collector jobs=3 cwd={self.root.resolve()}"])

    def test_the_build_runs_under_the_shared_compile_lock(self):
        write_stub(self.stubs, "flock", f'echo "flock $1" >> "{self.calls}"\nshift\nexec "$@"\n')
        result = self.run_script("collector-build", VALLY_CARGO_BIN=str(self.stubs))
        self.assertEqual(result.returncode, 0, result.stderr)
        lock = self.root.resolve() / ".git" / "compile.lock"
        self.assertEqual(self.recorded(), [f"flock {lock}", f"cargo build --locked --release -p collector jobs=4 cwd={self.root.resolve()}"])

    def test_matching_target_sha_builds(self):
        result = self.run_script("collector-build", VALLY_CARGO_BIN=str(self.stubs), ORCH_DEPLOY_SHA=self.head)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.recorded()), 1)

    def test_different_target_sha_fails_without_calling_cargo(self):
        result = self.run_script("collector-build", VALLY_CARGO_BIN=str(self.stubs), ORCH_DEPLOY_SHA="0" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(self.head, result.stderr)
        self.assertEqual(self.recorded(), [])


class CollectorInstallTest(FakeCollectorHost):
    def setUp(self):
        super().setUp()
        shutil.copytree(DEPLOY / "systemd", self.root / "deploy" / "systemd")
        release = self.root / "target/release"
        release.mkdir(parents=True)
        self.built = release / "collector"
        self.build("new collector")
        self.bin = Path(self.temp.name) / "bin"
        self.units = Path(self.temp.name) / "units"
        self.bin.mkdir()
        self.units.mkdir()
        self.say("now\t지금은 수집 시간 밖이다")

    def script_text(self, version):
        return "#!/bin/sh\n" + self.collector_body(version, record=False)

    def build(self, version):
        self.built.write_text(self.script_text(version))
        self.built.chmod(0o755)

    def install_collector(self, version="old collector"):
        target = self.bin / "collector"
        target.write_text(self.script_text(version))
        target.chmod(0o755)
        return target

    def install(self, **env):
        return self.run_script("collector-install", VALLY_COLLECTOR_BIN_DIR=str(self.bin), VALLY_SYSTEMD_USER_DIR=str(self.units), **env)

    def install_units_like_repo(self, *names):
        for name in names:
            shutil.copy(DEPLOY / "systemd" / name, self.units / name)

    def install_everything_old(self):
        self.install_collector()
        (self.bin / "vally-collector-alert-telegram").write_text("old alert\n")
        (self.bin / "vally-collector-alert-telegram").chmod(0o755)
        for name in ["vally-collector.service", "vally-collector-alert.service"]:
            (self.units / name).write_text("[Service]\nExecStart=/old\n")

    def names(self, folder):
        return sorted(path.name for path in folder.iterdir())

    def test_missing_build_fails_without_touching_anything(self):
        self.built.unlink()
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("collector-build", result.stderr)
        self.assertEqual(list(self.bin.iterdir()), [])

    def test_outside_collection_hours_replaces_the_executable_by_rename_so_a_running_copy_keeps_its_file(self):
        target = self.install_collector()
        old_inode = target.stat().st_ino
        with open(target, "rb") as running:
            result = self.install()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(running.read(), self.script_text("old collector").encode())
        self.assertEqual(target.read_text(), self.script_text("new collector"))
        self.assertNotEqual(target.stat().st_ino, old_inode)
        self.assertTrue(target.stat().st_mode & stat.S_IXUSR)
        self.assertEqual(self.names(self.bin), ["collector"])

    def test_installs_the_executable_when_none_is_there_yet_even_inside_collection_hours(self):
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.bin / "collector").read_text(), self.script_text("new collector"))
        self.assertEqual(self.names(self.bin), ["collector"])

    def test_the_window_is_asked_of_the_new_build_with_the_installed_settings(self):
        self.install_collector()
        write_stub(self.stubs, "collector", "exit 99\n")
        recording = self.root / "target/release/collector"
        recording.write_text(f'#!/bin/sh\necho "built $*" >> "{self.calls}"\ncat "{self.verdict}"\n')
        result = self.install(VALLY_DATA="/data/hoga", VALLY_COLLECTOR_FINALIZE_MINUTES="45", VALLY_COLLECTOR_SCHEDULE_ARGS="--close-at 18:00")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded()[0], "built restart-window --data /data/hoga --finalize-allowance-minutes 45 --close-at 18:00")

    def test_unchanged_files_are_left_alone_and_daemon_reload_is_not_called(self):
        self.install_units_like_repo("vally-collector.service", "vally-collector-alert.service")
        shutil.copy(DEPLOY / "systemd/vally-collector-alert-telegram", self.bin / "vally-collector-alert-telegram")
        shutil.copy(self.built, self.bin / "collector")
        inodes = {path.name: path.stat().st_ino for path in [*self.bin.iterdir(), *self.units.iterdir()]}
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(inodes, {path.name: path.stat().st_ino for path in [*self.bin.iterdir(), *self.units.iterdir()]})
        self.assertEqual(self.recorded(), [])

    def test_a_changed_unit_is_replaced_and_daemon_reload_runs_once(self):
        self.install_collector()
        self.install_units_like_repo("vally-collector.service", "vally-collector-alert.service")
        (self.units / "vally-collector.service").write_text("[Service]\nExecStart=/old\n")
        (self.units / "vally-collector-alert.service").write_text("[Service]\nExecStart=/old\n")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ["vally-collector.service", "vally-collector-alert.service"]:
            self.assertEqual((self.units / name).read_text(), (DEPLOY / "systemd" / name).read_text())
        self.assertEqual(self.recorded(), ["systemctl --user daemon-reload"])
        self.assertEqual(self.names(self.units), ["vally-collector-alert.service", "vally-collector.service"])

    def test_one_changed_unit_among_unchanged_ones_still_reloads(self):
        self.install_units_like_repo("vally-collector.service", "vally-collector-alert.service")
        (self.units / "vally-collector-alert.service").write_text("[Service]\nExecStart=/old\n")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded(), ["systemctl --user daemon-reload"])

    def test_units_that_are_not_installed_and_the_app_server_unit_are_not_created(self):
        (self.units / "vally-server.service").write_text("server pc version\n")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.names(self.units), ["vally-server.service"])
        self.assertEqual((self.units / "vally-server.service").read_text(), "server pc version\n")
        self.assertEqual(self.recorded(), [])
        self.assertFalse((self.bin / "vally-collector-alert-telegram").exists())

    def test_alert_script_is_replaced_only_when_it_is_already_installed(self):
        target = self.bin / "vally-collector-alert-telegram"
        target.write_text("old\n")
        target.chmod(0o755)
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(target.read_text(), (DEPLOY / "systemd/vally-collector-alert-telegram").read_text())
        self.assertTrue(target.stat().st_mode & stat.S_IXUSR)
        self.assertEqual(self.recorded(), [])

    def test_inside_collection_hours_only_puts_the_new_files_beside_the_running_ones(self):
        self.install_everything_old()
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.bin / "collector").read_text(), self.script_text("old collector"))
        self.assertEqual((self.bin / "collector.next").read_text(), self.script_text("new collector"))
        self.assertEqual((self.bin / "vally-collector-alert-telegram").read_text(), "old alert\n")
        self.assertEqual((self.bin / "vally-collector-alert-telegram.next").read_text(), (DEPLOY / "systemd/vally-collector-alert-telegram").read_text())
        for name in ["vally-collector.service", "vally-collector-alert.service"]:
            self.assertEqual((self.units / name).read_text(), "[Service]\nExecStart=/old\n")
            self.assertEqual((self.units / f"{name}.next").read_text(), (DEPLOY / "systemd" / name).read_text())
        self.assertEqual(stat.S_IMODE((self.bin / "collector.next").stat().st_mode), 0o755)
        self.assertEqual(self.recorded(), [])
        self.assertIn("옆 자리", result.stdout)

    def test_two_deploys_in_one_day_leave_one_pending_copy_of_the_last_build(self):
        self.install_everything_old()
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        self.install()
        self.build("newer collector")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.names(self.bin), ["collector", "collector.next", "vally-collector-alert-telegram", "vally-collector-alert-telegram.next"])
        self.assertEqual((self.bin / "collector.next").read_text(), self.script_text("newer collector"))
        self.assertEqual((self.bin / "collector").read_text(), self.script_text("old collector"))

    def test_a_deploy_equal_to_the_running_file_drops_a_stale_pending_copy(self):
        self.install_collector()
        (self.bin / "collector.next").write_text("stale")
        self.build("old collector")
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.names(self.bin), ["collector"])

    def test_outside_collection_hours_removes_a_stale_pending_copy_by_installing_over_it(self):
        self.install_collector()
        (self.bin / "collector.next").write_text("stale")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.names(self.bin), ["collector"])
        self.assertEqual((self.bin / "collector").read_text(), self.script_text("new collector"))

    def test_a_window_check_that_fails_leaves_the_running_files_alone(self):
        self.install_collector()
        result = self.install(FAKE_VERDICT_EXIT="2")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("판정하지 못해", result.stderr)
        self.assertEqual((self.bin / "collector").read_text(), self.script_text("old collector"))
        self.assertEqual((self.bin / "collector.next").read_text(), self.script_text("new collector"))

    def test_a_symlinked_unit_keeps_its_link_when_it_is_replaced(self):
        self.install_collector()
        elsewhere = Path(self.temp.name) / "dotfiles"
        elsewhere.mkdir()
        (elsewhere / "vally-collector.service").write_text("[Service]\nExecStart=/old\n")
        (self.units / "vally-collector.service").symlink_to(elsewhere / "vally-collector.service")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.units / "vally-collector.service").is_symlink())
        self.assertEqual((elsewhere / "vally-collector.service").read_text(), (DEPLOY / "systemd/vally-collector.service").read_text())
        self.assertEqual(self.names(elsewhere), ["vally-collector.service"])
        self.assertEqual(self.names(self.units), ["vally-collector.service"])

    def test_a_symlinked_unit_keeps_its_link_while_the_new_copy_waits(self):
        self.install_collector()
        elsewhere = Path(self.temp.name) / "dotfiles"
        elsewhere.mkdir()
        (elsewhere / "vally-collector.service").write_text("[Service]\nExecStart=/old\n")
        (self.units / "vally-collector.service").symlink_to(elsewhere / "vally-collector.service")
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.units / "vally-collector.service").is_symlink())
        self.assertEqual((elsewhere / "vally-collector.service").read_text(), "[Service]\nExecStart=/old\n")
        self.assertEqual((elsewhere / "vally-collector.service.next").read_text(), (DEPLOY / "systemd/vally-collector.service").read_text())
        self.assertEqual(self.names(self.units), ["vally-collector.service"])

    def test_a_daemon_reload_that_failed_is_done_again_by_the_next_run(self):
        self.install_collector()
        self.install_units_like_repo("vally-collector.service", "vally-collector-alert.service")
        (self.units / "vally-collector.service").write_text("[Service]\nExecStart=/old\n")
        (self.state / "reload-fails").write_text("")
        failed = self.install()
        self.assertNotEqual(failed.returncode, 0)
        (self.state / "reload-fails").unlink()
        again = self.install()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(self.recorded(), ["systemctl --user daemon-reload", "systemctl --user daemon-reload"])
        third = self.install()
        self.assertEqual(third.returncode, 0, third.stderr)
        self.assertEqual(len(self.recorded()), 2)
        self.assertEqual(self.names(self.units), ["vally-collector-alert.service", "vally-collector.service"])

    def test_installed_units_are_mode_644_whatever_the_repository_file_mode(self):
        self.install_everything_old()
        (self.root / "deploy/systemd/vally-collector.service").chmod(0o755)
        (self.root / "deploy/systemd/vally-collector-alert.service").chmod(0o600)
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ["vally-collector.service", "vally-collector-alert.service"]:
            self.assertEqual(stat.S_IMODE((self.units / name).stat().st_mode), 0o644, name)
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        (self.root / "deploy/systemd/vally-collector.service").write_text("[Service]\nExecStart=/newer\n")
        (self.root / "deploy/systemd/vally-collector.service").chmod(0o755)
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(stat.S_IMODE((self.units / "vally-collector.service.next").stat().st_mode), 0o644)


class DeferredDeployTest(FakeCollectorHost):
    def setUp(self):
        super().setUp()
        shutil.copytree(DEPLOY / "systemd", self.root / "deploy" / "systemd")
        (self.root / "target/release").mkdir(parents=True)
        self.built = self.root / "target/release/collector"
        self.bin = Path(self.temp.name) / "bin"
        self.units = Path(self.temp.name) / "units"
        self.bin.mkdir()
        self.units.mkdir()
        self.running = self.bin / "collector"
        self.running.write_text(self.script_text("running"))
        self.running.chmod(0o755)
        (self.units / "vally-collector.service").write_text("[Service]\nExecStart=/old\n")
        (self.units / "vally-collector-alert.service").write_text("[Service]\nExecStart=/old\n")
        write_stub(self.stubs, "collector", "exit 99\n")

    def script_text(self, version):
        return "#!/bin/sh\n" + self.collector_body(version, record=False)

    def deploy(self, version):
        self.built.write_text(self.script_text(version))
        self.built.chmod(0o755)
        env = {"VALLY_COLLECTOR_BIN_DIR": str(self.bin), "VALLY_COLLECTOR_BIN": str(self.running), "VALLY_SYSTEMD_USER_DIR": str(self.units), "VALLY_COLLECTOR_STABLE_SECONDS": "2"}
        installed = self.run_script("collector-install", **env)
        self.assertEqual(installed.returncode, 0, installed.stderr)
        restarted = self.run_script("collector-restart", **env)
        self.assertEqual(restarted.returncode, 0, restarted.stderr)
        return env

    def test_a_deploy_inside_collection_hours_waits_and_the_scheduled_run_moves_the_files_then_restarts(self):
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        self.deploy("first")
        self.assertEqual(self.running.read_text(), self.script_text("running"))
        self.assertEqual((self.bin / "collector.next").read_text(), self.script_text("first"))
        self.assertEqual(self.reservations(), ["vally-collector-restart.timer"])
        self.assertFalse(any(" restart " in call for call in self.recorded()))

        env = self.deploy("second")
        self.assertEqual(self.names_with_next(), ["collector.next", "vally-collector-alert.service.next", "vally-collector.service.next"])
        self.assertEqual((self.bin / "collector.next").read_text(), self.script_text("second"))
        self.assertEqual(self.reservations(), ["vally-collector-restart.timer"])
        self.assertFalse(any(" restart " in call for call in self.recorded()))
        reservation = (self.state / "vally-collector-restart.timer").read_text()
        self.assertIn(f"--setenv=VALLY_COLLECTOR_BIN={self.running}", reservation)
        self.assertIn(f"--setenv=VALLY_SYSTEMD_USER_DIR={self.units}", reservation)

        scheduled_env = {key: env[key] for key in ["VALLY_COLLECTOR_BIN", "VALLY_SYSTEMD_USER_DIR", "VALLY_COLLECTOR_STABLE_SECONDS"]}
        result = self.run_script("collector-restart", "--scheduled", **scheduled_env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.running.read_text(), self.script_text("second"))
        self.assertEqual(self.names_with_next(), [])
        self.assertEqual((self.state / "binary-at-restart").read_text(), self.script_text("second"))
        self.assertEqual((self.units / "vally-collector.service").read_text(), (DEPLOY / "systemd/vally-collector.service").read_text())
        calls = self.recorded()
        self.assertLess(calls.index("systemctl --user daemon-reload"), calls.index("systemctl --user restart vally-collector.service"))

    def test_a_deploy_outside_collection_hours_replaces_and_restarts_without_a_pending_copy(self):
        self.say("now\t지금은 수집 시간 밖이다")
        self.deploy("fresh")
        self.assertEqual(self.running.read_text(), self.script_text("fresh"))
        self.assertEqual(self.names_with_next(), [])
        self.assertEqual((self.state / "binary-at-restart").read_text(), self.script_text("fresh"))
        self.assertEqual(self.reservations(), [])
        self.assertIn("systemctl --user restart vally-collector.service", self.recorded())

    def names_with_next(self):
        return sorted(path.name for folder in (self.bin, self.units) for path in folder.iterdir() if path.name.endswith(".next"))


class CollectorRestartTest(FakeCollectorHost):
    def restart(self, *arguments, **env):
        env.setdefault("VALLY_COLLECTOR_BIN", str(self.stubs / "collector"))
        env.setdefault("VALLY_COLLECTOR_STABLE_SECONDS", "3")
        full = {key: value for key, value in os.environ.items() if not key.startswith(("VALLY_", "ORCH_DEPLOY_"))}
        full["HOME"] = self.temp.name
        full["PATH"] = f"{self.stubs}:{full['PATH']}"
        full.update(env)
        return subprocess.run([str(self.root / "deploy/collector-restart"), *arguments], cwd="/", env=full, capture_output=True, text=True, timeout=60)

    def test_outside_collection_hours_restarts_now_and_watches_the_daemon(self):
        self.say("now\t지금은 수집 시간(07:20~22:05) 밖이다")
        result = self.restart()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("재시작: 지금은 수집 시간(07:20~22:05) 밖이다", result.stdout)
        calls = self.recorded()
        self.assertIn("systemctl --user restart vally-collector.service", calls)
        self.assertEqual(sum(call.startswith("systemctl --user is-active --quiet vally-collector.service") for call in calls), 3)
        self.assertFalse(any(call.startswith("systemd-run") for call in calls))

    def test_the_check_gets_the_data_folder_allowance_and_schedule_options(self):
        self.say("now\tx")
        self.restart(VALLY_DATA="/data/hoga", VALLY_COLLECTOR_FINALIZE_MINUTES="45", VALLY_COLLECTOR_SCHEDULE_ARGS="--close-at 18:00")
        self.assertEqual(self.recorded()[0], "collector restart-window --data /data/hoga --finalize-allowance-minutes 45 --close-at 18:00")

    def test_inside_collection_hours_does_not_restart_and_reserves_once(self):
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        for _ in range(2):
            result = self.restart()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("재시작하지 않고 예약: 2026-11-24 22:05:00 Asia/Seoul", result.stdout)
        calls = self.recorded()
        self.assertFalse(any(" restart " in call for call in calls))
        self.assertEqual(self.reservations(), ["vally-collector-restart.timer"])
        reservation = (self.state / "vally-collector-restart.timer").read_text()
        self.assertIn("--on-calendar=2026-11-24 22:05:00 Asia/Seoul", reservation)
        self.assertIn(f"{self.root.resolve()}/deploy/collector-restart --scheduled", reservation)

    def test_the_reservation_carries_the_service_and_watch_seconds_to_the_scheduled_run(self):
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        result = self.restart(VALLY_COLLECTOR_SERVICE="demo.service", VALLY_COLLECTOR_STABLE_SECONDS="7")
        self.assertEqual(result.returncode, 0, result.stderr)
        reservation = (self.state / "vally-collector-restart.timer").read_text()
        self.assertIn("--setenv=VALLY_COLLECTOR_SERVICE=demo.service", reservation)
        self.assertIn("--setenv=VALLY_COLLECTOR_STABLE_SECONDS=7", reservation)
        self.assertIn(f"--setenv=VALLY_COLLECTOR_BIN={self.stubs}/collector", reservation)
        self.assertIn(f"--setenv=VALLY_SYSTEMD_USER_DIR={self.temp.name}/.config/systemd/user", reservation)

    def test_a_later_wait_replaces_the_earlier_reservation_time(self):
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\ta")
        self.restart()
        self.say("wait\t2026-11-25 22:05:00 Asia/Seoul\tb")
        result = self.restart()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.reservations(), ["vally-collector-restart.timer"])
        self.assertIn("2026-11-25 22:05:00", (self.state / "vally-collector-restart.timer").read_text())

    def test_an_unreadable_calendar_reservation_is_made_the_same_way(self):
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t달력으로 오늘이 쉬는 날인지 알 수 없다: 특일정보 2026: 받지 않은 해다")
        result = self.restart()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("달력으로 오늘이 쉬는 날인지 알 수 없다", result.stdout)
        self.assertFalse(any(" restart " in call for call in self.recorded()))
        self.assertEqual(self.reservations(), ["vally-collector-restart.timer"])

    def test_restarting_now_cancels_a_pending_reservation(self):
        (self.state / "vally-collector-restart.timer").write_text("old")
        self.say("now\t쉬는 날")
        result = self.restart()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.reservations(), [])

    def test_scheduled_run_restarts_without_asking_the_calendar(self):
        result = self.restart("--scheduled")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.recorded()
        self.assertFalse(any(call.startswith("collector") for call in calls))
        self.assertIn("systemctl --user restart vally-collector.service", calls)

    def test_a_daemon_that_exits_right_after_restart_fails_with_journal_guidance(self):
        self.say("now\tx")
        (self.state / "inactive").write_text("")
        result = self.restart(VALLY_COLLECTOR_SERVICE="demo.service")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("journalctl --user -u demo.service", result.stderr)

    def test_a_scheduled_restart_of_a_dead_daemon_fails_too(self):
        (self.state / "inactive").write_text("")
        result = self.restart("--scheduled")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("journalctl --user -u vally-collector.service", result.stderr)

    def test_a_failed_systemctl_restart_fails_the_step(self):
        self.say("now\tx")
        result = self.restart(FAKE_RESTART_EXIT="1")
        self.assertNotEqual(result.returncode, 0)

    def test_a_failing_check_neither_restarts_nor_reserves(self):
        self.say("")
        result = self.restart(FAKE_VERDICT_EXIT="2")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("재시작하지 않았습니다", result.stderr)
        calls = self.recorded()
        self.assertFalse(any(" restart " in call or call.startswith("systemd-run") for call in calls))

    def test_an_unknown_verdict_fails_without_restarting(self):
        self.say("maybe\twhat")
        result = self.restart()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(" restart " in call for call in self.recorded()))

    def test_scheduled_run_moves_pending_files_into_place_before_restarting(self):
        home_units = Path(self.temp.name) / ".config/systemd/user"
        home_units.mkdir(parents=True)
        (self.stubs / "collector.next").write_text("#!/bin/sh\n# next\n")
        (home_units / "vally-collector.service").write_text("old")
        (home_units / "vally-collector.service.next").write_text("new")
        result = self.restart("--scheduled")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.stubs / "collector").read_text(), "#!/bin/sh\n# next\n")
        self.assertEqual((home_units / "vally-collector.service").read_text(), "new")
        self.assertFalse((self.stubs / "collector.next").exists())
        self.assertFalse((home_units / "vally-collector.service.next").exists())
        calls = self.recorded()
        self.assertEqual(calls[:2], ["systemctl --user daemon-reload", "systemctl --user restart vally-collector.service"])

    def test_restarting_now_moves_pending_files_too(self):
        self.say("now\t쉬는 날")
        (self.stubs / "collector.next").write_text("#!/bin/sh\n# next\n")
        result = self.restart()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.stubs / "collector.next").exists())
        self.assertEqual((self.stubs / "collector").read_text(), "#!/bin/sh\n# next\n")

    def test_the_window_is_judged_by_the_pending_new_build_when_the_installed_one_cannot(self):
        write_stub(self.stubs, "collector", "echo '사용법: collector <collect|supervise>' >&2\nexit 2\n")
        write_stub(self.stubs, "collector.next", f'echo "next $*" >> "{self.calls}"\ncat "{self.verdict}"\n')
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        result = self.restart()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.reservations(), ["vally-collector-restart.timer"])
        self.assertTrue(self.recorded()[0].startswith("next restart-window"))

    def test_waiting_leaves_pending_files_where_they_are(self):
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        (self.stubs / "collector.next").write_text("#!/bin/sh\n# next\n")
        result = self.restart()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.stubs / "collector.next").exists())

    def test_a_daemon_reload_that_failed_earlier_is_retried_before_the_restart(self):
        home_units = Path(self.temp.name) / ".config/systemd/user"
        home_units.mkdir(parents=True)
        (home_units / ".vally-collector-reload-pending").write_text("")
        result = self.restart("--scheduled")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded()[:2], ["systemctl --user daemon-reload", "systemctl --user restart vally-collector.service"])
        self.assertFalse((home_units / ".vally-collector-reload-pending").exists())

    def test_a_failed_daemon_reload_stops_before_restarting(self):
        home_units = Path(self.temp.name) / ".config/systemd/user"
        home_units.mkdir(parents=True)
        (home_units / "vally-collector.service.next").write_text("new")
        (self.state / "reload-fails").write_text("")
        result = self.restart("--scheduled")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(" restart " in call for call in self.recorded()))
        self.assertTrue((home_units / ".vally-collector-reload-pending").exists())

    def test_stable_seconds_above_the_cap_or_not_an_integer_fail_before_anything_runs(self):
        for value in ["601", "99999999999999999999", "-1", "1e3", " 5"]:
            result = self.restart(VALLY_COLLECTOR_STABLE_SECONDS=value)
            self.assertEqual(result.returncode, 2, value)
            self.assertIn("600 이하", result.stderr)
        self.assertEqual(self.recorded(), [])

    def test_the_cap_itself_is_accepted(self):
        result = self.restart("--scheduled", VALLY_COLLECTOR_STABLE_SECONDS="600")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_invalid_stable_seconds_fail_before_anything_runs(self):
        for value in ["0", "00", "abc", "1.5"]:
            result = self.restart(VALLY_COLLECTOR_STABLE_SECONDS=value)
            self.assertEqual(result.returncode, 2, value)
            self.assertIn("VALLY_COLLECTOR_STABLE_SECONDS", result.stderr)
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
