import fcntl
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import threading
import time
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
        return sorted(path.name for path in folder.iterdir() if not path.name.startswith("."))

    def inodes(self):
        return {path.name: path.stat().st_ino for path in [*self.bin.iterdir(), *self.units.iterdir()] if not path.name.startswith(".")}

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
        self.assertEqual(self.names(self.bin), ["collector", "vally-collector-restart"])

    def test_installs_the_executable_when_none_is_there_yet_even_inside_collection_hours(self):
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.bin / "collector").read_text(), self.script_text("new collector"))
        self.assertEqual(self.names(self.bin), ["collector", "vally-collector-restart"])

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
        shutil.copy(DEPLOY / "collector-restart", self.bin / "vally-collector-restart")
        inodes = self.inodes()
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(inodes, self.inodes())
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

    def test_the_financials_unit_is_replaced_when_it_is_already_installed(self):
        self.install_collector()
        self.install_units_like_repo("vally-collector.service", "vally-collector-alert.service")
        (self.units / "vally-financials.service").write_text("[Service]\nExecStart=/old\n")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.units / "vally-financials.service").read_text(), (DEPLOY / "systemd/vally-financials.service").read_text())
        self.assertEqual(self.recorded(), ["systemctl --user daemon-reload"])

    def test_the_financials_unit_is_not_created_when_it_is_not_installed(self):
        self.install_collector()
        self.install_units_like_repo("vally-collector.service", "vally-collector-alert.service")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("설치 안 됨, 건너뜀", result.stdout)
        self.assertFalse((self.units / "vally-financials.service").exists())
        self.assertFalse((self.units / "vally-financials.service.next").exists())
        self.assertEqual(self.recorded(), [])

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
        self.assertEqual(self.names(self.bin), ["collector", "collector.next", "vally-collector-alert-telegram", "vally-collector-alert-telegram.next", "vally-collector-restart.next"])
        self.assertEqual((self.bin / "collector.next").read_text(), self.script_text("newer collector"))
        self.assertEqual((self.bin / "collector").read_text(), self.script_text("old collector"))

    def test_a_deploy_equal_to_the_running_file_drops_a_stale_pending_copy(self):
        self.install_collector()
        (self.bin / "collector.next").write_text("stale")
        self.build("old collector")
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.names(self.bin), ["collector", "vally-collector-restart.next"])

    def test_outside_collection_hours_removes_a_stale_pending_copy_by_installing_over_it(self):
        self.install_collector()
        (self.bin / "collector.next").write_text("stale")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.names(self.bin), ["collector", "vally-collector-restart"])
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

    def test_the_install_step_judging_now_leaves_a_verdict_for_the_restart_step_and_waiting_removes_it(self):
        self.install_collector()
        verdict = self.units / ".vally-collector-install-verdict"
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(verdict.read_text(), "now\n")
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        self.build("newer collector")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(verdict.exists())

    def test_a_promotion_that_fails_leaves_no_verdict_for_the_restart_step_to_trust(self):
        self.install_collector()
        self.install_units_like_repo("vally-collector-alert.service")
        (self.units / "vally-collector.service").write_text("[Service]\nExecStart=/old\n")
        (self.units / ".vally-collector-install-verdict").write_text("now\n")
        (self.state / "reload-fails").write_text("")
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.units / ".vally-collector-install-verdict").exists())

    def test_a_pending_copy_with_the_same_content_but_a_wrong_mode_gets_the_right_mode(self):
        self.install_everything_old()
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        self.install()
        for name, wrong in [("vally-collector.service.next", 0o600), ("vally-collector-alert.service.next", 0o755)]:
            (self.units / name).chmod(wrong)
        (self.bin / "collector.next").chmod(0o644)
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ["vally-collector.service.next", "vally-collector-alert.service.next"]:
            self.assertEqual(stat.S_IMODE((self.units / name).stat().st_mode), 0o644, name)
        self.assertEqual(stat.S_IMODE((self.bin / "collector.next").stat().st_mode), 0o755)

    def test_a_deploy_inside_collection_hours_retries_a_daemon_reload_that_failed_earlier(self):
        self.install_everything_old()
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        marker = self.units / ".vally-collector-reload-pending"
        marker.write_text("")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded(), ["systemctl --user daemon-reload"])
        self.assertFalse(marker.exists())
        self.assertEqual((self.units / "vally-collector.service").read_text(), "[Service]\nExecStart=/old\n")

    def test_a_retry_that_fails_inside_collection_hours_warns_and_keeps_the_mark(self):
        self.install_everything_old()
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        marker = self.units / ".vally-collector-reload-pending"
        marker.write_text("")
        (self.state / "reload-fails").write_text("")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("daemon-reload", result.stderr)
        self.assertTrue(marker.exists())

    def test_a_link_that_cannot_be_resolved_is_not_replaced_by_a_regular_file(self):
        self.install_collector()
        elsewhere = Path(self.temp.name) / "dotfiles"
        elsewhere.mkdir()
        (elsewhere / "vally-collector.service").write_text("[Service]\nExecStart=/old\n")
        (self.units / "vally-collector.service").symlink_to(elsewhere / "vally-collector.service")
        write_stub(self.stubs, "readlink", '[ "$1" = -f ] && exit 1\nexec /usr/bin/readlink "$@"\n')
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("심볼릭 링크를 풀지 못해", result.stderr)
        self.assertTrue((self.units / "vally-collector.service").is_symlink())
        self.assertEqual((elsewhere / "vally-collector.service").read_text(), "[Service]\nExecStart=/old\n")

    def test_the_restart_helper_the_daemon_unit_calls_before_it_starts_is_installed_with_the_daemon(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        helper = self.bin / "vally-collector-restart"
        self.assertEqual(helper.read_text(), (DEPLOY / "collector-restart").read_text())
        self.assertTrue(helper.stat().st_mode & stat.S_IXUSR)
        unit = (DEPLOY / "systemd/vally-collector.service").read_text()
        self.assertIn("ExecStartPre=-%h/.local/bin/vally-collector-restart --before-start\n", unit)

    def test_an_install_waits_for_the_deploy_lock_and_fails_when_it_is_held_too_long(self):
        self.install_collector()
        with open(self.units / ".vally-collector-deploy.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = self.install(VALLY_COLLECTOR_LOCK_SECONDS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("잠금", result.stderr)
        self.assertEqual((self.bin / "collector").read_text(), self.script_text("old collector"))
        self.assertEqual(self.install().returncode, 0)

    def seed_everything_old_with_a_pending_reload(self):
        self.install_everything_old()
        (self.units / ".vally-collector-reload-pending").write_text("")
        return self.seed_snapshot()

    def test_bad_lock_or_stable_seconds_fail_the_install_before_any_file_changes_or_systemctl_runs(self):
        before = self.seed_everything_old_with_a_pending_reload()
        for name in ["VALLY_COLLECTOR_LOCK_SECONDS", "VALLY_COLLECTOR_STABLE_SECONDS"]:
            for value in ["1.5", "abc", "0", "00", "-1"]:
                result = self.install(**{name: value})
                self.assertNotEqual(result.returncode, 0, (name, value))
                self.assertIn(name, result.stderr)
                self.assertEqual(len(result.stderr.strip().splitlines()), 1, result.stderr)
                self.assertEqual(self.recorded(), [], (name, value))
                self.assertEqual(self.seed_snapshot(), before, (name, value))

    def seed_snapshot(self):
        return self.inodes(), {path.name: path.read_text() for path in [*self.bin.iterdir(), *self.units.iterdir()]}

    def test_a_bad_lock_seconds_fails_the_install_even_when_nothing_is_installed_yet(self):
        result = self.install(VALLY_COLLECTOR_LOCK_SECONDS="1.5")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("VALLY_COLLECTOR_LOCK_SECONDS", result.stderr)
        self.assertEqual(list(self.bin.iterdir()), [])
        self.assertEqual(list(self.units.iterdir()), [])
        self.assertEqual(self.recorded(), [])

    def test_the_install_accepts_the_cap_leading_zeros_and_no_value(self):
        for env in [{}, {"VALLY_COLLECTOR_LOCK_SECONDS": "3600", "VALLY_COLLECTOR_STABLE_SECONDS": "600"}, {"VALLY_COLLECTOR_LOCK_SECONDS": "007"}]:
            self.install_collector()
            result = self.install(**env)
            self.assertEqual(result.returncode, 0, (env, result.stderr))

    def test_the_install_runs_without_home_when_the_paths_are_given(self):
        for data_given, installed in [(True, False), (True, True), (False, True)]:
            with self.subTest(data_given=data_given, installed=installed):
                full = {key: value for key, value in os.environ.items() if not key.startswith(("VALLY_", "ORCH_DEPLOY_", "HOME"))}
                full["PATH"] = f"{self.stubs}:{full['PATH']}"
                full.update(VALLY_COLLECTOR_BIN_DIR=str(self.bin), VALLY_SYSTEMD_USER_DIR=str(self.units))
                if data_given:
                    full["VALLY_DATA"] = str(self.root / "data")
                if installed:
                    self.install_collector()
                result = subprocess.run([str(self.root / "deploy/collector-install")], cwd="/", env=full, capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_the_installed_restart_helper_runs_alone_without_the_repository(self):
        self.assertEqual(self.install().returncode, 0)
        helper = self.bin / "vally-collector-restart"
        lone = Path(self.temp.name) / "lone"
        lone.mkdir()
        shutil.copy(helper, lone / "vally-collector-restart")
        env = {"HOME": self.temp.name, "PATH": f"{self.stubs}:{os.environ['PATH']}", "VALLY_SYSTEMD_USER_DIR": str(self.units), "VALLY_COLLECTOR_BIN": str(self.bin / "collector")}
        for path in ["--before-start", "--promote", "--retry-reload", "--validate"]:
            result = subprocess.run([str(lone / "vally-collector-restart"), path], cwd="/", env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, (path, result.stderr))


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
        self.assertEqual(self.names_with_next(), ["collector.next", "vally-collector-alert.service.next", "vally-collector-restart.next", "vally-collector.service.next"])
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

    def test_an_installed_financials_unit_waits_beside_inside_collection_hours_and_the_scheduled_run_moves_it(self):
        (self.units / "vally-financials.service").write_text("[Service]\nExecStart=/old\n")
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        env = self.deploy("first")
        self.assertEqual((self.units / "vally-financials.service").read_text(), "[Service]\nExecStart=/old\n")
        self.assertEqual((self.units / "vally-financials.service.next").read_text(), (DEPLOY / "systemd/vally-financials.service").read_text())
        scheduled_env = {key: env[key] for key in ["VALLY_COLLECTOR_BIN", "VALLY_SYSTEMD_USER_DIR", "VALLY_COLLECTOR_STABLE_SECONDS"]}
        result = self.run_script("collector-restart", "--scheduled", **scheduled_env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.units / "vally-financials.service").read_text(), (DEPLOY / "systemd/vally-financials.service").read_text())
        self.assertEqual(self.names_with_next(), [])

    def test_a_deploy_outside_collection_hours_replaces_and_restarts_without_a_pending_copy(self):
        self.say("now\t지금은 수집 시간 밖이다")
        self.deploy("fresh")
        self.assertEqual(self.running.read_text(), self.script_text("fresh"))
        self.assertEqual(self.names_with_next(), [])
        self.assertEqual((self.state / "binary-at-restart").read_text(), self.script_text("fresh"))
        self.assertEqual(self.reservations(), [])
        self.assertIn("systemctl --user restart vally-collector.service", self.recorded())

    def test_a_deploy_that_judged_now_restarts_even_when_the_hours_began_before_the_restart_step(self):
        self.say("now\t지금은 수집 시간 밖이다")
        self.built.write_text(self.script_text("fresh"))
        self.built.chmod(0o755)
        env = {"VALLY_COLLECTOR_BIN_DIR": str(self.bin), "VALLY_COLLECTOR_BIN": str(self.running), "VALLY_SYSTEMD_USER_DIR": str(self.units), "VALLY_COLLECTOR_STABLE_SECONDS": "2"}
        self.assertEqual(self.run_script("collector-install", **env).returncode, 0)
        self.assertEqual(self.running.read_text(), self.script_text("fresh"))
        self.say("wait\t2026-11-25 22:05:00 Asia/Seoul\t수집 시간 안이다")
        restarted = self.run_script("collector-restart", **env)
        self.assertEqual(restarted.returncode, 0, restarted.stderr)
        self.assertIn("systemctl --user restart vally-collector.service", self.recorded())
        self.assertEqual(self.reservations(), [])
        self.assertFalse((self.units / ".vally-collector-install-verdict").exists())

    def test_a_deploy_that_judged_wait_follows_the_calendar_of_the_restart_step_when_the_hours_ended_between(self):
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        self.built.write_text(self.script_text("late"))
        self.built.chmod(0o755)
        env = {"VALLY_COLLECTOR_BIN_DIR": str(self.bin), "VALLY_COLLECTOR_BIN": str(self.running), "VALLY_SYSTEMD_USER_DIR": str(self.units), "VALLY_COLLECTOR_STABLE_SECONDS": "2"}
        self.assertEqual(self.run_script("collector-install", **env).returncode, 0)
        self.assertEqual(self.running.read_text(), self.script_text("running"))
        self.say("now\t마감 정리 여유가 끝났다")
        restarted = self.run_script("collector-restart", **env)
        self.assertEqual(restarted.returncode, 0, restarted.stderr)
        self.assertEqual(self.running.read_text(), self.script_text("late"))
        self.assertEqual(self.names_with_next(), [])
        self.assertIn("systemctl --user restart vally-collector.service", self.recorded())

    def test_a_scheduled_run_and_the_restart_step_at_the_same_time_both_succeed_and_leave_the_new_files(self):
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        env = self.deploy("racing")
        scheduled_env = {key: env[key] for key in ["VALLY_COLLECTOR_BIN", "VALLY_SYSTEMD_USER_DIR", "VALLY_COLLECTOR_STABLE_SECONDS"]}
        self.say("now\t마감 정리 여유가 끝났다")
        (self.stubs / "sleep").unlink()
        results = []
        def run(arguments):
            results.append(self.run_script("collector-restart", *arguments, **scheduled_env))
        threads = [threading.Thread(target=run, args=(arguments,)) for arguments in [("--scheduled",), ()]]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        for result in results:
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len([call for call in self.recorded() if " restart " in call]), 1, self.recorded())
        self.assertEqual(self.running.read_text(), self.script_text("racing"))
        self.assertEqual(self.names_with_next(), [])

    def test_a_daemon_reload_that_fails_in_the_scheduled_run_leaves_the_old_files_and_tells_the_alert_script(self):
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        env = self.deploy("new")
        write_stub(self.bin, "vally-collector-alert-telegram", f'echo "alert $1" >> "{self.calls}"\n')
        (self.state / "reload-fails").write_text("")
        scheduled_env = {key: env[key] for key in ["VALLY_COLLECTOR_BIN", "VALLY_SYSTEMD_USER_DIR", "VALLY_COLLECTOR_STABLE_SECONDS"]}
        result = self.run_script("collector-restart", "--scheduled", **scheduled_env)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.running.read_text(), self.script_text("running"))
        self.assertEqual((self.units / "vally-collector.service").read_text(), "[Service]\nExecStart=/old\n")
        self.assertEqual((self.units / "vally-collector-alert.service").read_text(), "[Service]\nExecStart=/old\n")
        self.assertEqual((self.bin / "collector.next").read_text(), self.script_text("new"))
        self.assertEqual((self.units / "vally-collector.service.next").read_text(), (DEPLOY / "systemd/vally-collector.service").read_text())
        self.assertEqual(sorted(path.name for path in self.bin.iterdir() if path.name.endswith(".prev")), [])
        self.assertFalse(any(" restart " in call for call in self.recorded()))
        alerts = [call for call in self.recorded() if call.startswith("alert ")]
        self.assertEqual(len(alerts), 1, self.recorded())
        self.assertIn("daemon-reload", alerts[0])
        (self.state / "reload-fails").unlink()
        again = self.run_script("collector-restart", "--scheduled", **scheduled_env)
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(self.running.read_text(), self.script_text("new"))
        self.assertEqual(self.names_with_next(), [])
        self.assertEqual(len([call for call in self.recorded() if call.startswith("alert ")]), 1)

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


    def test_the_paths_that_only_move_files_or_reload_reject_a_bad_lock_wait_before_touching_anything(self):
        units = self.home_units()
        (units / ".vally-collector-reload-pending").write_text("")
        (self.stubs / "collector.next").write_text("#!/bin/sh\n# next\n")
        (units / "vally-collector.service").write_text("old")
        (units / "vally-collector.service.next").write_text("new")
        before = (self.stubs / "collector").read_text()
        for path in ["--promote", "--retry-reload", "--before-start"]:
            for value in ["1.5", "abc", "0", "3601"]:
                result = self.restart(path, VALLY_COLLECTOR_LOCK_SECONDS=value)
                self.assertEqual(result.returncode, 2, (path, value))
                self.assertIn("VALLY_COLLECTOR_LOCK_SECONDS", result.stderr)
                self.assertEqual(len(result.stderr.strip().splitlines()), 1, result.stderr)
                self.assertEqual(self.recorded(), [], (path, value))
                self.assertEqual((self.stubs / "collector").read_text(), before)
                self.assertTrue((self.stubs / "collector.next").exists())
                self.assertEqual((units / "vally-collector.service").read_text(), "old")
                self.assertTrue((units / "vally-collector.service.next").exists())
                self.assertTrue((units / ".vally-collector-reload-pending").exists())

    def test_the_paths_that_only_move_files_or_reload_still_work_with_a_valid_lock_wait(self):
        (self.stubs / "collector.next").write_text("#!/bin/sh\n# next\n")
        for path in ["--promote", "--retry-reload", "--before-start"]:
            result = self.restart(path, VALLY_COLLECTOR_LOCK_SECONDS="3600")
            self.assertEqual(result.returncode, 0, (path, result.stderr))
        self.assertEqual((self.stubs / "collector").read_text(), "#!/bin/sh\n# next\n")

    def home_units(self):
        folder = Path(self.temp.name) / ".config/systemd/user"
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    def alert_stub(self):
        write_stub(self.stubs, "vally-collector-alert-telegram", f'echo "alert $1" >> "{self.calls}"\n')

    def alerts(self):
        return [call for call in self.recorded() if call.startswith("alert ")]

    def test_a_fresh_install_verdict_of_now_restarts_even_when_the_check_now_says_wait_and_is_used_up(self):
        units = self.home_units()
        verdict = units / ".vally-collector-install-verdict"
        verdict.write_text("now\n")
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        result = self.restart()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("systemctl --user restart vally-collector.service", self.recorded())
        self.assertFalse(any(call.startswith(("collector", "systemd-run")) for call in self.recorded()))
        self.assertFalse(verdict.exists())

    def test_an_old_install_verdict_is_ignored_and_removed(self):
        units = self.home_units()
        verdict = units / ".vally-collector-install-verdict"
        verdict.write_text("now\n")
        long_ago = time.time() - 3 * 3600
        os.utime(verdict, (long_ago, long_ago))
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        result = self.restart()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(" restart " in call for call in self.recorded()))
        self.assertEqual(self.reservations(), ["vally-collector-restart.timer"])
        self.assertFalse(verdict.exists())

    def test_a_daemon_reload_that_fails_puts_every_moved_file_back_beside_the_running_ones(self):
        units = self.home_units()
        (self.stubs / "collector.next").write_text("#!/bin/sh\n# next\n")
        (units / "vally-collector.service").write_text("old")
        (units / "vally-collector.service.next").write_text("new")
        (self.state / "reload-fails").write_text("")
        before = (self.stubs / "collector").read_text()
        result = self.restart("--scheduled")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.stubs / "collector").read_text(), before)
        self.assertEqual((self.stubs / "collector.next").read_text(), "#!/bin/sh\n# next\n")
        self.assertEqual((units / "vally-collector.service").read_text(), "old")
        self.assertEqual((units / "vally-collector.service.next").read_text(), "new")
        self.assertFalse(list(self.stubs.glob("*.prev")) or list(units.glob("*.prev")))
        self.assertTrue((units / ".vally-collector-reload-pending").exists())
        self.assertIn("옛 판 그대로", result.stderr)

    def test_a_failed_scheduled_promotion_is_told_to_the_alert_script_but_a_missing_script_is_skipped(self):
        units = self.home_units()
        (units / "vally-collector.service.next").write_text("new")
        (self.state / "reload-fails").write_text("")
        self.assertNotEqual(self.restart("--scheduled").returncode, 0)
        self.assertEqual(self.alerts(), [])
        self.alert_stub()
        self.assertNotEqual(self.restart("--scheduled").returncode, 0)
        self.assertEqual(len(self.alerts()), 1)
        self.assertIn("daemon-reload", self.alerts()[0])

    def test_a_failure_of_the_restart_step_run_by_the_deploy_is_not_sent_to_the_alert_script(self):
        units = self.home_units()
        (units / "vally-collector.service.next").write_text("new")
        (self.state / "reload-fails").write_text("")
        self.alert_stub()
        self.say("now\tx")
        self.assertNotEqual(self.restart().returncode, 0)
        self.assertEqual(self.alerts(), [])

    def test_the_cleanup_before_the_daemon_starts_moves_every_pending_file_without_asking_the_calendar(self):
        units = self.home_units()
        (self.stubs / "collector.next").write_text("#!/bin/sh\n# next\n")
        (units / "vally-collector.service").write_text("old")
        (units / "vally-collector.service.next").write_text("new")
        self.say("wait\t2026-11-24 22:05:00 Asia/Seoul\t수집 시간 안이다")
        result = self.restart("--before-start")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.stubs / "collector").read_text(), "#!/bin/sh\n# next\n")
        self.assertEqual((units / "vally-collector.service").read_text(), "new")
        calls = self.recorded()
        self.assertEqual(calls[0], "systemctl --user daemon-reload")
        self.assertFalse(any(call.startswith("collector") for call in calls))
        self.assertFalse(any(" restart vally-collector.service" in call and call.startswith("systemctl") for call in calls))
        self.assertTrue(any(call.startswith("systemd-run --user --unit=vally-collector-restart-after-start --on-active=10 --collect systemctl --user restart vally-collector.service") for call in calls), calls)

    def test_the_cleanup_before_the_daemon_starts_does_not_schedule_a_restart_when_no_unit_changed(self):
        (self.stubs / "collector.next").write_text("#!/bin/sh\n# next\n")
        result = self.restart("--before-start")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.stubs / "collector").read_text(), "#!/bin/sh\n# next\n")
        self.assertEqual(self.recorded(), [])

    def test_the_cleanup_before_the_daemon_starts_leaves_the_daemon_alone_when_only_the_alert_unit_changed(self):
        units = self.home_units()
        (units / "vally-collector-alert.service").write_text("old")
        (units / "vally-collector-alert.service.next").write_text("new")
        result = self.restart("--before-start")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((units / "vally-collector-alert.service").read_text(), "new")
        self.assertEqual(self.recorded(), ["systemctl --user daemon-reload"])

    def test_a_restart_waits_for_another_restart_to_finish_and_fails_when_it_takes_too_long(self):
        units = self.home_units()
        with open(units / ".vally-collector-restart.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = self.restart("--scheduled", VALLY_COLLECTOR_LOCK_SECONDS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("다른 재시작", result.stderr)
        self.assertEqual(self.recorded(), [])
        self.assertEqual(self.restart("--scheduled").returncode, 0)

    def overlapped_restarts(self, **env):
        (self.stubs / "sleep").unlink()
        results = []
        def run(arguments):
            results.append(self.restart(*arguments, **env))
        first = threading.Thread(target=run, args=(("--scheduled",),))
        first.start()
        deadline = time.time() + 10
        while not any(" restart " in call for call in self.recorded()) and time.time() < deadline:
            time.sleep(0.05)
        second = threading.Thread(target=run, args=(("--scheduled",),))
        second.start()
        first.join()
        second.join()
        return results

    def test_a_restart_that_overlaps_another_with_the_same_files_does_not_restart_the_daemon_again(self):
        results = self.overlapped_restarts(VALLY_COLLECTOR_STABLE_SECONDS="2")
        for result in results:
            self.assertEqual(result.returncode, 0, result.stderr)
        restarts = [call for call in self.recorded() if call == "systemctl --user restart vally-collector.service"]
        self.assertEqual(len(restarts), 1, self.recorded())
        self.assertEqual(sum("다시 시작하지 않습니다" in result.stdout for result in results), 1)

    def test_a_restart_that_overlaps_another_still_restarts_when_the_files_changed_in_between(self):
        (self.stubs / "sleep").unlink()
        results = []
        first = threading.Thread(target=lambda: results.append(self.restart("--scheduled", VALLY_COLLECTOR_STABLE_SECONDS="2")))
        first.start()
        deadline = time.time() + 10
        while not any(" restart " in call for call in self.recorded()) and time.time() < deadline:
            time.sleep(0.05)
        (self.stubs / "collector.next").write_text("#!/bin/sh\n# newer\n")
        second = self.restart("--scheduled", VALLY_COLLECTOR_STABLE_SECONDS="2")
        first.join()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(results[0].returncode, 0, results[0].stderr)
        restarts = [call for call in self.recorded() if call == "systemctl --user restart vally-collector.service"]
        self.assertEqual(len(restarts), 2, self.recorded())
        self.assertEqual((self.stubs / "collector").read_text(), "#!/bin/sh\n# newer\n")

    def test_a_restart_after_another_one_finished_restarts_again_even_with_the_same_files(self):
        self.assertEqual(self.restart("--scheduled", VALLY_COLLECTOR_STABLE_SECONDS="1").returncode, 0)
        self.assertEqual(self.restart("--scheduled", VALLY_COLLECTOR_STABLE_SECONDS="1").returncode, 0)
        restarts = [call for call in self.recorded() if call == "systemctl --user restart vally-collector.service"]
        self.assertEqual(len(restarts), 2)

    def test_a_restart_that_failed_its_check_does_not_make_an_overlapping_one_skip_its_own(self):
        write_stub(self.stubs, "systemctl", f'echo "systemctl $*" >> "{self.calls}"\ncase "$*" in *is-active*) exit 3 ;; esac\nexit 0\n')
        results = self.overlapped_restarts(VALLY_COLLECTOR_STABLE_SECONDS="2")
        self.assertEqual([result.returncode for result in results], [1, 1])
        restarts = [call for call in self.recorded() if call == "systemctl --user restart vally-collector.service"]
        self.assertEqual(len(restarts), 2, self.recorded())

    def seed_marker_of_a_restart_finishing_in_the_future(self):
        units = self.home_units()
        marker = units / ".vally-collector-last-restart"
        fingerprint = "\n".join([subprocess.run(["cksum"], input=(self.stubs / "collector").read_bytes(), capture_output=True).stdout.decode().strip(), "missing"])
        marker.write_text(f"{time.time_ns() + 60_000_000_000}\n{fingerprint}\n")
        return marker

    def test_a_restart_does_not_skip_when_the_daemon_is_no_longer_active(self):
        self.seed_marker_of_a_restart_finishing_in_the_future()
        write_stub(self.stubs, "systemctl", f'echo "systemctl $*" >> "{self.calls}"\ncase "$*" in *is-active*) exit 3 ;; esac\nexit 0\n')
        result = self.restart("--scheduled", VALLY_COLLECTOR_STABLE_SECONDS="1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("systemctl --user restart vally-collector.service", self.recorded())

    def test_a_restart_that_fails_its_check_forgets_the_earlier_restart_so_nothing_skips_on_it(self):
        marker = self.seed_marker_of_a_restart_finishing_in_the_future()
        write_stub(self.stubs, "systemctl", f'echo "systemctl $*" >> "{self.calls}"\ncase "$*" in *is-active*) exit 3 ;; esac\nexit 0\n')
        self.restart("--scheduled", VALLY_COLLECTOR_STABLE_SECONDS="1")
        self.assertEqual(len(marker.read_text().splitlines()), 1)

    def test_lock_seconds_with_leading_zeros_count_by_their_value_and_restart_without_complaint(self):
        for value in ["08", "010", "3600"]:
            result = self.restart("--scheduled", VALLY_COLLECTOR_STABLE_SECONDS="1", VALLY_COLLECTOR_LOCK_SECONDS=value)
            self.assertEqual(result.returncode, 0, f"{value}: {result.stderr}")
            self.assertEqual(result.stderr, "")

    def test_lock_seconds_that_are_decimal_text_zero_or_above_the_cap_fail_before_anything_runs(self):
        for value in ["1.5", "abc", "0", "000", "-1", " 5", "3601", "99999999999999999999"]:
            result = self.restart("--scheduled", VALLY_COLLECTOR_STABLE_SECONDS="1", VALLY_COLLECTOR_LOCK_SECONDS=value)
            self.assertEqual(result.returncode, 2, f"{value!r}: {result.stderr}")
            self.assertIn("VALLY_COLLECTOR_LOCK_SECONDS", result.stderr)
        self.assertEqual(self.recorded(), [])

    def test_a_value_with_control_characters_gets_a_one_line_message_naming_the_variable(self):
        for name in ["VALLY_COLLECTOR_LOCK_SECONDS", "VALLY_COLLECTOR_STABLE_SECONDS"]:
            for value, shown in [("5\n6", "5\\n6"), ("5\t6", "5\\t6"), ("5\r\n", "5\\r\\n"), ("5\x1b6", "5\\x1b6")]:
                result = self.restart("--scheduled", **{name: value})
                self.assertEqual(result.returncode, 2, (name, value))
                self.assertEqual(len(result.stderr.splitlines()), 1, (name, value, result.stderr))
                self.assertIn(name, result.stderr)
                self.assertIn(f"({shown})", result.stderr)
        self.assertEqual(self.recorded(), [])

    def test_a_value_with_other_control_or_line_separator_characters_is_shown_escaped_on_one_line(self):
        cases = [
            ("5\\6", "5\\\\6"),
            ("5\\n6", "5\\\\n6"),
            ("5\\\n6", "5\\\\\\n6"),
            ("5\\x1b6", "5\\\\x1b6"),
            ("5\x016", "5\\x016"),
            ("5\x0b6", "5\\x0b6"),
            ("5\x7f6", "5\\x7f6"),
            ("5\u00856", "5\\u00856"),
            ("5\u20286", "5\\u20286"),
            ("5\u20296", "5\\u20296"),
            ("5\u00806", "5\\u00806"),
            ("5\u009f6", "5\\u009f6"),
            ("5\u00a06", "5\u00a06"),
            ("5\udcff6", "5\\xff6"),
            ("5\udc806", "5\\x806"),
            ("5\udcc26", "5\\xc26"),
            ("5\udce2\udc80", "5\\xe2\\x80"),
            ("5\udced\udca0\udc80", "5\\xed\\xa0\\x80"),
            ("5\u00e96", "5\u00e96"),
            ("5\ud55c\uae00", "5\ud55c\uae00"),
        ]
        for name in ["VALLY_COLLECTOR_LOCK_SECONDS", "VALLY_COLLECTOR_STABLE_SECONDS"]:
            for value, shown in cases:
                for locale in ["C", "C.UTF-8"]:
                    result = self.restart("--scheduled", LC_ALL=locale, **{name: value})
                    self.assertEqual(result.returncode, 2, (name, value))
                    self.assertEqual(len(result.stderr.splitlines()), 1, (name, value, result.stderr))
                    self.assertIn(f"({shown})", result.stderr)
        self.assertEqual(self.recorded(), [])

    def test_a_decimal_lock_seconds_does_not_shorten_the_wait_for_another_restart(self):
        units = self.home_units()
        with open(units / ".vally-collector-restart.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = self.restart("--scheduled", VALLY_COLLECTOR_STABLE_SECONDS="1", VALLY_COLLECTOR_LOCK_SECONDS="1.5")
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("다른 재시작", result.stderr)
        self.assertEqual(self.recorded(), [])

    def test_a_marker_whose_numbers_are_not_a_generation_never_skips_a_restart(self):
        units = self.home_units()
        marker = units / ".vally-collector-last-restart"
        fingerprint = "\n".join([subprocess.run(["cksum"], input=(self.stubs / "collector").read_bytes(), capture_output=True).stdout.decode().strip(), "missing"])
        for first_line in ["", "abc", "9" * 40, "-5"]:
            marker.write_text(f"{first_line}\n{fingerprint}\n")
            result = self.restart("--scheduled", VALLY_COLLECTOR_STABLE_SECONDS="1")
            self.assertEqual(result.returncode, 0, result.stderr)
        restarts = [call for call in self.recorded() if call == "systemctl --user restart vally-collector.service"]
        self.assertEqual(len(restarts), 4, self.recorded())

    def test_a_marker_the_script_cannot_read_still_lets_the_restart_happen(self):
        marker = self.home_units() / ".vally-collector-last-restart"
        marker.write_text("5\nfingerprint\n")
        marker.chmod(0)
        result = self.restart("--scheduled", VALLY_COLLECTOR_STABLE_SECONDS="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("systemctl --user restart vally-collector.service", self.recorded())

    def test_a_marker_stamped_with_a_future_time_does_not_make_the_run_skip_a_restart_that_never_happened(self):
        marker = self.seed_marker_of_a_restart_finishing_in_the_future()
        result = self.restart("--scheduled", VALLY_COLLECTOR_STABLE_SECONDS="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("다시 시작하지 않습니다", result.stdout)
        self.assertIn("systemctl --user restart vally-collector.service", self.recorded())
        self.assertTrue(marker.exists())

    def test_the_restart_records_count_up_so_an_overlapping_one_only_skips_for_a_restart_finished_after_it_asked(self):
        marker = self.home_units() / ".vally-collector-last-restart"
        for expected in ["1", "2", "3"]:
            self.assertEqual(self.restart("--scheduled", VALLY_COLLECTOR_STABLE_SECONDS="1").returncode, 0)
            self.assertEqual(marker.read_text().splitlines()[0], expected)
        restarts = [call for call in self.recorded() if call == "systemctl --user restart vally-collector.service"]
        self.assertEqual(len(restarts), 3)

    def test_the_wait_for_another_restart_is_longer_than_that_restarts_check_even_when_the_check_outlasts_the_lock_seconds(self):
        results = self.overlapped_restarts(VALLY_COLLECTOR_STABLE_SECONDS="3", VALLY_COLLECTOR_LOCK_SECONDS="2")
        for result in results:
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("끝나지 않습니다", "".join(result.stderr for result in results))

    def test_the_cleanup_before_the_daemon_starts_does_nothing_without_pending_files(self):
        result = self.restart("--before-start")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded(), [])

    def test_the_cleanup_before_the_daemon_starts_never_blocks_the_start_and_reports_a_failed_reload(self):
        units = self.home_units()
        (units / "vally-collector.service").write_text("old")
        (units / "vally-collector.service.next").write_text("new")
        (self.state / "reload-fails").write_text("")
        self.alert_stub()
        result = self.restart("--before-start")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((units / "vally-collector.service").read_text(), "old")
        self.assertEqual(len(self.alerts()), 1)
        self.assertFalse(any(call.startswith("systemd-run") for call in self.recorded()))

    def test_a_link_that_cannot_be_resolved_is_left_alone_instead_of_becoming_a_regular_file(self):
        units = self.home_units()
        elsewhere = Path(self.temp.name) / "dotfiles"
        elsewhere.mkdir()
        (elsewhere / "vally-collector.service").write_text("old")
        (elsewhere / "vally-collector.service.next").write_text("new")
        (units / "vally-collector.service").symlink_to(elsewhere / "vally-collector.service")
        (units / "vally-collector.service.next").write_text("beside the link")
        write_stub(self.stubs, "readlink", '[ "$1" = -f ] && exit 1\nexec /usr/bin/readlink "$@"\n')
        result = self.restart("--scheduled")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((units / "vally-collector.service").is_symlink())
        self.assertEqual((elsewhere / "vally-collector.service").read_text(), "old")
        self.assertFalse(any(" restart " in call for call in self.recorded()))

    def test_the_promotion_waits_for_the_deploy_lock_and_fails_when_it_is_held_too_long(self):
        units = self.home_units()
        (units / "vally-collector.service.next").write_text("new")
        with open(units / ".vally-collector-deploy.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = self.restart("--scheduled", VALLY_COLLECTOR_LOCK_SECONDS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("잠금", result.stderr)
        self.assertTrue((units / "vally-collector.service.next").exists())
        self.assertEqual(self.recorded(), [])

    def test_a_late_run_after_the_files_were_moved_succeeds_with_nothing_to_move(self):
        (self.stubs / "collector.next").write_text("#!/bin/sh\n# next\n")
        first = self.restart("--scheduled")
        second = self.restart("--scheduled")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual((self.stubs / "collector").read_text(), "#!/bin/sh\n# next\n")

    def test_stable_seconds_with_leading_zeros_count_by_their_value(self):
        for value in ["00600", "0600", "007", "01"]:
            result = self.restart("--scheduled", VALLY_COLLECTOR_STABLE_SECONDS=value)
            self.assertEqual(result.returncode, 0, f"{value}: {result.stderr}")
            self.assertIn(f"{int(value)}초 동안 active", result.stdout)
        for value in ["00601", "0000", "000"]:
            result = self.restart("--scheduled", VALLY_COLLECTOR_STABLE_SECONDS=value)
            self.assertEqual(result.returncode, 2, value)


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

    def test_server_unit_sets_hoga_data_dir_matching_collector(self):
        def env_value(unit_name, key):
            prefix = f"Environment={key}="
            for line in (DEPLOY / "systemd" / unit_name).read_text().splitlines():
                if line.startswith(prefix):
                    return line[len(prefix):]
            return None

        collector_dir = env_value("vally-collector.service", "VALLY_DATA")
        server_dir = env_value("vally-server.service", "VALLY_HOGA_DATA_DIR")
        self.assertIsNotNone(collector_dir)
        self.assertEqual(server_dir, collector_dir)


if __name__ == "__main__":
    unittest.main()
