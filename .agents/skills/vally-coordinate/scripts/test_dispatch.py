"""Exercise dispatch boundaries with real temporary Git worktrees and fake Orca."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

from contracts import digest
from journal import Journal, read


SCRIPT = Path(__file__).with_name("dispatch.py")
FAKE = '''#!/usr/bin/env python3
import json, os, pathlib, sys, subprocess, time
a = sys.argv[1:]
c = json.loads(pathlib.Path(os.environ["FAKE_CONFIG"]).read_text())
verb = a[1]
body = sys.stdin.read() if verb == "worker-start" else None
with open(os.environ["FAKE_CALLS"], "a") as f:
    f.write(json.dumps({"args": a, "body": body}) + "\\n")
def value(key):
    return a[a.index(key) + 1]
if verb == "run-list":
    result = {"runs": [{"id": r} for r in c.get("runs", ["run_test"])]}
elif verb == "worker-list":
    result = {"workers": c.get("workers", {}).get(value("--run"), [])}
elif verb == "worker-show":
    result = json.loads(pathlib.Path(os.environ["FAKE_RUNTIME"]).read_text())[value("--dispatch")]
elif verb == "worker-start":
    time.sleep(c.get("delay_start", 0))
    if c.get("start_failure"):
        print(json.dumps({"ok": False, "result": {"dispatchId": "ctx_partial", "state": "outcome_unknown"}}))
        sys.exit(7)
    workspace = value("--worktree").removeprefix("path:")
    if workspace in {"new-child", "new-top-level"}:
        workspace = str(pathlib.Path(os.environ["FAKE_COORDINATOR"]).parent / value("--name"))
        subprocess.run(["git", "-C", os.environ["FAKE_COORDINATOR"], "worktree", "add", "-b", value("--name"), workspace, value("--base-branch")], check=True, capture_output=True)
        time.sleep(c.get("delay_after_creation", 0))
    if c.get("malformed_start"):
        print("not json")
        sys.exit(0)
    result = {"dispatchId": "ctx_new", "taskId": "task_new", "runId": value("--run"),
              "state": "ready", "agent": value("--agent"), "model": value("--model"),
              "effort": value("--effort"), "workspace": "repo::" + workspace}
    result.update(c.get("receipt", {}))
    runtime = pathlib.Path(os.environ["FAKE_RUNTIME"])
    assignments = json.loads(runtime.read_text()) if runtime.exists() else {}
    assignments[result["dispatchId"]] = dict(result, state="succeeded")
    runtime.write_text(json.dumps(assignments))
elif a[0] == "repo" and verb == "list":
    result = {"repos": [{"id": "repo", "path": c.get("registered_path", os.environ["FAKE_COORDINATOR"])}]}
elif a[0] == "worktree" and verb in {"current", "show"}:
    coordinator = os.environ["FAKE_COORDINATOR"]
    path = c.get("caller", coordinator) if verb == "current" else value("--worktree").removeprefix("path:")
    is_parent = path == coordinator
    result = {"worktree": {"id": "repo::" + path, "path": path, "instanceId": "parent" if is_parent else "child", "repoId": "repo", "hostId": "local",
        "parentWorktreeId": None if is_parent else c.get("observed_parent", "repo::" + coordinator),
        "lineage": {"parentWorktreeInstanceId": "parent"}}}
else:
    sys.exit(9)
if c.get("inventory_invalid") and verb != "worker-start":
    print("[]")
else:
    print(json.dumps({"ok": True, "result": result}))
'''


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vally-coordinate-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "coordinator repo"
        self.repo.mkdir()
        self.git(self.repo, "init", "-b", "main")
        self.git(self.repo, "remote", "add", "origin", "https://github.com/Soochol/vallythevally.git")
        (self.repo / "tracked").write_text("initial\n")
        self.git(self.repo, "add", "tracked")
        self.git(self.repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "-m", "fixture")
        self.head = self.git(self.repo, "rev-parse", "HEAD")
        self.git(self.repo, "update-ref", "refs/remotes/origin/main", self.head)
        self.worktree = self.root / "worker space"
        self.git(self.repo, "worktree", "add", "-b", "feat/fixture", str(self.worktree))
        self.brief = self.root / "작업 명세.md"
        self.brief.write_text("# Goal\n문자 그대로 `$(touch SHOULD_NOT_EXIST)` 와 공백을 보존한다.\n")
        self.spec = self.root / "assignment.json"
        self.envelope = {"version": 1, "goal": "Preserve literal shell text and test dispatch guards",
            "scope": "isolated fixture only", "constraints": ["No live services"],
            "acceptance_conditions": [{"id": "literal", "outcome": "Worker receives the literal Korean brief without shell execution"}],
            "verification_plan": [{"condition": "literal", "method": "Inspect fake Orca received body", "evidence": "calls.jsonl"}],
            "evidence_outputs": ["report.md", "result.json"], "capabilities": {"skills": [], "tools": ["python3", "git"], "account_data_scope": ["temporary Git only"]}}
        self.request = {"ticket": 2, "conditions": ["literal"], "revision": digest(self.envelope), "brief": str(self.brief)}
        self.spec.write_text(json.dumps(self.request))
        self.state_dir = self.root / "journal"
        self.counter = 0
        self.request_lock = threading.Lock()
        self.config = self.root / "config.json"
        self.calls = self.root / "calls.jsonl"
        self.fake = self.root / "fake orca"
        self.fake.write_text(FAKE)
        self.fake.chmod(0o755)
        self.settings = {}
        self.config.write_text("{}")
        self.env = {**os.environ, "ORCA_CLI_COMMAND": str(self.fake),
                    "FAKE_CONFIG": str(self.config), "FAKE_CALLS": str(self.calls),
                    "FAKE_COORDINATOR": str(self.repo),
                    "FAKE_RUNTIME": str(self.root / "runtime.json"),
                    "PYTHONDONTWRITEBYTECODE": "1"}
        for key in ("ORCA_PAIRING_CODE", "ORCA_ENVIRONMENT"):
            self.env.pop(key, None)
        self.gh_data = self.root / "github.json"
        self.gh_calls = self.root / "github-calls.jsonl"
        def issue(number, kind):
            return {"id": number * 100, "node_id": "ISSUE" + str(number), "number": number,
                "repository_url": "https://api.github.com/repos/Soochol/vallythevally", "state": "open",
                "labels": [{"name": "coord:" + kind}] + ([{"name": "coord:ready"}, {"name": "needs-triage"}] if kind == "ticket" else []),
                "body": "<!-- vally-ticket:v1 -->\n```json\n" + json.dumps(self.envelope) + "\n```\n<!-- /vally-ticket -->"}
        self.gh_state = {"issues": {"1": issue(1, "feature"), "2": issue(2, "ticket")},
            "parents": {"2": 1}, "children": {"1": [2]}, "blockers": {"2": []}, "comments": {}, "prs": {}}
        self.gh_data.write_text(json.dumps(self.gh_state))
        self.env.update(GH_CLI_COMMAND=str(Path(__file__).with_name("fake_github.py")),
                        FAKE_GH_DATA=str(self.gh_data), FAKE_GH_CALLS=str(self.gh_calls))

    def git(self, root, *args):
        return subprocess.run(["git", "-C", str(root), *args], text=True,
                              capture_output=True, check=True).stdout.strip()

    def run_script(self, action="preview", role="reviewer", extra=(), head=True, placement=True):
        with self.request_lock:
            self.counter += 1
            sequence = self.counter
            config_path = self.root / f"orca-{sequence}.json"
            config_path.write_text(json.dumps(self.settings))
        args = [sys.executable, str(SCRIPT), action, "--role", role, "--run", "run_test",
                "--coordinator", str(self.repo),
                "--spec", str(self.spec), "--title", "리뷰 `$(touch ALSO_NOT_CREATED)`"]
        args += ["--operation", "launch-" + str(sequence), "--state-dir", str(self.state_dir)]
        if placement:
            args += ["--worktree", str(self.worktree)]
        if head:
            args += ["--head", self.head]
        return subprocess.run(args + list(extra), cwd=self.repo, env={**self.env, "FAKE_CONFIG": str(config_path)},
                              text=True, capture_output=True)

    def recorded(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def launches(self):
        return [r for r in self.recorded() if r["args"][1] == "worker-start"]

    def test_preview_has_no_orca_or_git_mutation(self):
        before = self.git(self.repo, "worktree", "list", "--porcelain")
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual(plan["assignment"]["model"], "gpt-6-astra")
        self.assertIn("independent reviewer", plan["spec"])
        self.assertIn(self.brief.read_text(), plan["spec"])
        self.assertIn(self.envelope["acceptance_conditions"][0]["outcome"], plan["spec"])
        self.assertEqual(self.recorded(), [])
        self.assertEqual(self.git(self.repo, "worktree", "list", "--porcelain"), before)
        self.assertEqual(self.git(self.worktree, "status", "--porcelain"), "")
        self.assertFalse((self.repo / "SHOULD_NOT_EXIST").exists())

    def test_start_models_and_spec_are_real_arguments(self):
        for role, model in [("reviewer", "gpt-6-astra"), ("worker", "gpt-6.1-sol")]:
            with self.subTest(role=role):
                self.calls.unlink(missing_ok=True)
                self.release_reservations()
                result = self.run_script("start", role=role)
                self.assertEqual(result.returncode, 0, result.stderr)
                launch, = self.launches()
                self.assertEqual(launch["args"][launch["args"].index("--model") + 1], model)
                self.assertIn(self.brief.read_text(), launch["body"])
                self.assertIn("--keep-open", launch["args"])
                self.assertFalse((self.repo / "ALSO_NOT_CREATED").exists())

    def test_review_requires_matching_head(self):
        for include, extra in [(False, ()), (False, ("--head", "0" * 40))]:
            with self.subTest(extra=extra):
                result = self.run_script("start", head=include, extra=extra)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.recorded(), [])

    def test_review_rejects_dirty_and_allow_dirty(self):
        (self.worktree / "unfinished").write_text("preserve")
        for extra in [(), ("--allow-dirty",)]:
            result = self.run_script("start", extra=extra)
            self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.worktree / "unfinished").read_text(), "preserve")
        self.assertEqual(self.recorded(), [])

    def test_worker_dirty_handover_is_explicit_and_preserved(self):
        (self.worktree / "unfinished").write_text("preserve")
        denied = self.run_script("start", role="worker")
        self.assertNotEqual(denied.returncode, 0)
        allowed = self.run_script("start", role="worker", extra=("--allow-dirty",))
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        self.assertIn("Preserve existing", self.launches()[0]["body"])
        self.assertEqual((self.worktree / "unfinished").read_text(), "preserve")

    def test_main_and_unrelated_remote_are_refused(self):
        main = self.run_script("start", placement=False, extra=("--worktree", str(self.repo)))
        self.assertNotEqual(main.returncode, 0)
        self.git(self.repo, "remote", "set-url", "origin", "https://github.com/other/other.git")
        other = self.run_script("start")
        self.assertNotEqual(other.returncode, 0)
        self.assertEqual(self.recorded(), [])

    def test_active_assignment_in_another_run_blocks_start(self):
        self.settings = {"runs": ["run_test", "run_other"], "workers": {"run_other": [
            {"workspace": "repo::" + str(self.worktree), "state": "ready",
             "liveness": "unverifiable", "dispatchId": "ctx_busy"}]}}
        result = self.run_script("start")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ctx_busy", result.stderr)
        self.assertEqual(self.launches(), [])

    def test_coordinator_checkout_is_refused_from_the_skill_directory(self):
        self.git(self.repo, "checkout", "-b", "coordinator")
        self.config.write_text("{}")
        result = subprocess.run([
            sys.executable, str(SCRIPT), "start", "--role", "reviewer", "--run", "run_test",
            "--coordinator", str(self.repo), "--spec", str(self.spec), "--title", "review",
            "--operation", "direct-refusal", "--state-dir", str(self.state_dir),
            "--worktree", str(self.repo), "--head", self.head,
        ], cwd=SCRIPT.parent.parent, env=self.env, text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.recorded(), [])

    def test_symlinked_active_assignment_blocks_start(self):
        alias = self.root / "worker-alias"
        alias.symlink_to(self.worktree, target_is_directory=True)
        self.settings = {"workers": {"run_test": [
            {"workspace": "repo::" + str(alias), "state": "ready",
             "liveness": "unverifiable", "dispatchId": "ctx_alias"}]}}
        result = self.run_script("start")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ctx_alias", result.stderr)
        self.assertEqual(self.launches(), [])

    def test_unproven_stop_blocks_but_proven_exit_allows(self):
        worker = {"workspace": "repo::" + str(self.worktree), "state": "stopped",
                  "liveness": "unverifiable", "dispatchId": "ctx_old"}
        self.settings = {"workers": {"run_test": [worker]}}
        self.assertNotEqual(self.run_script("start").returncode, 0)
        self.assertEqual(self.launches(), [])
        worker["liveness"] = "exited"
        result = self.run_script("start")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.launches()), 1)

    def test_failed_launch_preserves_receipt_without_retry(self):
        self.settings = {"start_failure": True}
        result = self.run_script("start")
        self.assertEqual(result.returncode, 7)
        self.assertIn("ctx_partial", result.stdout)
        self.assertEqual(len(self.launches()), 1)

    def test_wrong_model_or_workspace_needs_inspection_without_retry(self):
        for receipt in [{"model": "gpt-6.1-sol"}, {"workspace": "repo::/wrong/place"}]:
            with self.subTest(receipt=receipt):
                self.calls.unlink(missing_ok=True)
                self.release_reservations()
                self.settings = {"receipt": receipt}
                result = self.run_script("start")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("ctx_new", result.stdout)
                self.assertIn("may exist", result.stderr)
                self.assertEqual(len(self.launches()), 1)

    def test_inventory_failure_never_starts_worker(self):
        self.settings = {"inventory_invalid": True}
        result = self.run_script("start")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.launches(), [])

    def test_new_worktree_preview_does_not_create_checkout(self):
        before = self.git(self.repo, "worktree", "list", "--porcelain")
        result = self.run_script(role="worker", head=False, placement=False,
                                 extra=("--new-worktree", "new-feature", "--repo", str(self.repo)))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("new-child", json.loads(result.stdout)["command"])
        self.assertEqual(before, self.git(self.repo, "worktree", "list", "--porcelain"))
        self.assertEqual(self.recorded(), [])

    def test_role_header_and_unknown_run_are_refused(self):
        self.brief.write_text("역할: reviewer\n# Goal\n")
        self.assertNotEqual(self.run_script("start").returncode, 0)
        self.assertEqual(self.recorded(), [])
        self.brief.write_text("# Goal\nReview\n")
        self.settings = {"runs": ["run_other"]}
        self.assertNotEqual(self.run_script("start").returncode, 0)
        self.assertEqual(self.launches(), [])

    def release_reservations(self):
        journal = Journal(self.state_dir)
        for op in (journal.root / "operations").glob("*"):
            if (op / "recovery.json").exists():
                continue
            receipt = read(op / "launched.json") if (op / "launched.json").exists() else None
            journal.recover(op.name, {"proof": "exited", "runtime_evidence": "fake boundary process exited",
                                      "dispatch": receipt["launch"]["dispatchId"] if receipt else None})


if __name__ == "__main__":
    unittest.main()
