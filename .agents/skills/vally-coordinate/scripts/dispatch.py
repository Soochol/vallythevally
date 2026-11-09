#!/usr/bin/env python3
"""Build a role-specific Vally assignment and start it once through Orca."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


SKILL = Path(__file__).resolve().parent.parent
ROLES = {
    "worker": {"agent": "codex", "model": "gpt-6.1-sol", "effort": "high"},
    "reviewer": {"agent": "codex", "model": "gpt-6-astra", "effort": "high"},
}


class Refused(Exception):
    pass


def git(path, *args):
    result = subprocess.run(
        ["git", "-C", str(path), *args], capture_output=True, text=True
    )
    if result.returncode:
        raise Refused(f"Git check failed: {path}: {' '.join(args)}")
    return result.stdout.strip()


def repository(path):
    root = Path(path).expanduser().resolve(strict=True)
    if not root.is_dir() or Path(git(root, "rev-parse", "--show-toplevel")).resolve() != root:
        raise Refused("Use the exact repository/worktree root")
    remote = git(root, "remote", "get-url", "origin")
    if not re.fullmatch(
        r"(?:https://github\.com/|git@github\.com:)Soochol/vallythevally(?:\.git)?/?",
        remote, re.IGNORECASE,
    ):
        raise Refused("Target must be Soochol/vallythevally")
    return root


def prepare(args):
    coordinator = repository(args.coordinator)
    spec_path = Path(args.spec).expanduser().resolve(strict=True)
    body = spec_path.read_text(encoding="utf-8")
    if not body.strip() or not args.title.strip():
        raise Refused("Spec and title must be nonempty")
    if re.search(r"^(?:역할|배정된 역할|assigned_role)\s*:", body, re.MULTILINE):
        raise Refused("The script owns the role; remove the spec's role header")
    if not re.fullmatch(r"run_[A-Za-z0-9_-]+", args.run):
        raise Refused("Pass an explicit Orca Run ID")
    settings = ROLES[args.role]
    cli = os.environ.get("ORCA_CLI_COMMAND")
    if not cli:
        cli = "orca-dev" if os.environ.get("ORCA_DEV_REPO_ROOT") else (
            "orca-ide" if sys.platform.startswith("linux") else "orca"
        )
    command = [cli, "orchestration", "worker-start", "--spec-file", "-",
               "--task-title", args.title, "--run", args.run,
               "--agent", settings["agent"], "--model", settings["model"],
               "--effort", settings["effort"], "--keep-open", "--json"]
    info = {"role": args.role, "run": args.run, **settings, "title": args.title,
            "coordinator": str(coordinator)}
    if args.worktree:
        if args.repo:
            raise Refused("--repo belongs to --new-worktree")
        root = repository(args.worktree)
        branch = git(root, "branch", "--show-current")
        if not branch or branch in {"main", "master"}:
            raise Refused("Use a worker branch, not main or detached HEAD")
        if coordinator == root:
            raise Refused("Use a separate worker worktree, not the coordinator's checkout")
        dirty = bool(git(root, "status", "--porcelain"))
        if args.allow_dirty and args.role != "worker":
            raise Refused("Only implementation handovers may use --allow-dirty")
        if dirty and not args.allow_dirty:
            raise Refused("Worktree is dirty; preserve it and inspect the existing assignment")
        head = git(root, "rev-parse", "HEAD")
        if args.head and (not re.fullmatch(r"[a-fA-F0-9]{40}", args.head) or args.head.lower() != head):
            raise Refused("Requested head does not match this worktree")
        if args.role == "reviewer" and not args.head:
            raise Refused("A review needs the full --head SHA")
        info.update(worktree=str(root), branch=branch, head=head, dirty=dirty)
        command += ["--worktree", f"path:{root}"]
        location = f"- Worktree: {root}\n- Branch: {branch}\n- Assigned head: {head}\n"
        if dirty:
            location += "- Preserve existing uncommitted work; this is an explicit implementation handover.\n"
    else:
        if args.role != "worker" or not args.repo or args.head or args.allow_dirty:
            raise Refused("New worktrees require worker + --repo; no --head or --allow-dirty")
        root = repository(args.repo)
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", args.new_worktree):
            raise Refused("Use a short lowercase worktree name")
        git(root, "rev-parse", "--verify", f"{args.base}^{{commit}}")
        info.update(repo=str(root), new_worktree=args.new_worktree, base=args.base)
        command += ["--worktree", "new-top-level", "--repo", f"path:{root}",
                    "--name", args.new_worktree, "--base-branch", args.base]
        location = "- Orca allocates the worktree. Use its runtime-provided workspace; create no other checkout.\n"
    protocol = (SKILL / "assets" / f"{args.role}.md").read_text(encoding="utf-8")
    assembled = f"{protocol}\n\n## Workspace\n\n{location}\n## Task spec\n\n{body}"
    return {"assignment": info, "command": command, "spec": assembled}


def rpc(cli, *args):
    result = subprocess.run([cli, "orchestration", *args, "--json"],
                            capture_output=True, text=True)
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise Refused("Orca inventory is not JSON; inspect the CLI error before dispatch") from exc
    if (result.returncode or not isinstance(data, dict) or data.get("ok") is not True
            or not isinstance(data.get("result"), dict)):
        raise Refused("Orca inventory failed; inspect the CLI before dispatch")
    return data["result"]


def pages(cli, verb, key, *args):
    cursor = None
    seen = set()
    while True:
        extra = ["--cursor", str(cursor)] if cursor is not None else []
        page = rpc(cli, verb, *args, "--limit", "100", *extra)
        rows = page.get(key)
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
            raise Refused("Incomplete Orca inventory; inspect before dispatch")
        yield from rows
        cursor = page.get("nextCursor")
        if cursor is None:
            if len(rows) >= 100:
                raise Refused("Inventory reached its limit without a continuation cursor")
            return
        token = str(cursor)
        if token in seen:
            raise Refused("Orca inventory cursor repeated")
        seen.add(token)


def check_assignments(plan):
    cli = plan["command"][0]
    runs = list(pages(cli, "run-list", "runs"))
    if not all(isinstance(row.get("id"), str) and row["id"] for row in runs):
        raise Refused("Orca returned a Run without an ID")
    run_ids = {row["id"] for row in runs}
    assigned = plan["assignment"]
    if assigned["run"] not in run_ids:
        raise Refused("Requested Run is absent; resolve its identity before dispatch")
    target = assigned.get("worktree")
    if target is None:
        return
    for run_id in run_ids:
        for worker in pages(cli, "worker-list", "workers", "--run", run_id):
            workspace = worker.get("workspace", "")
            if not isinstance(workspace, str) or not workspace:
                continue
            observed_path = Path(workspace.rsplit("::", 1)[-1])
            if not observed_path.is_absolute() or observed_path.resolve() != Path(target):
                continue
            state = worker.get("state")
            settled = state in {"succeeded", "stopped", "failed"}
            unsafe_stop = state in {"stopped", "failed"} and worker.get("liveness") != "exited"
            if not settled or unsafe_stop:
                raise Refused(f"Worktree has an unsettled/unproven assignment: {worker.get('dispatchId', 'unknown')}")


def start(plan):
    check_assignments(plan)
    assigned = plan["assignment"]
    if assigned.get("worktree"):
        root = assigned["worktree"]
        if git(root, "rev-parse", "HEAD") != assigned["head"]:
            raise Refused("Worktree head changed during preparation")
        if not assigned["dirty"] and git(root, "status", "--porcelain"):
            raise Refused("Worktree became dirty during preparation")
    result = subprocess.run(plan["command"], input=plan["spec"], text=True,
                            capture_output=True)
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    if result.returncode:
        return result.returncode
    try:
        receipt = json.loads(result.stdout)
        observed = receipt["result"]
        workspace = observed.get("workspace")
        valid = (receipt.get("ok") is True and observed.get("state") == "ready"
                 and all(observed.get(key) == assigned[key] for key in ("agent", "model", "effort"))
                 and observed.get("runId") == assigned["run"]
                 and isinstance(workspace, str) and bool(workspace)
                 and (not assigned.get("worktree") or workspace.rsplit("::", 1)[-1] == assigned["worktree"])
                 and all(isinstance(observed.get(key), str) and observed[key]
                         for key in ("taskId", "dispatchId")))
    except (ValueError, KeyError, TypeError, AttributeError):
        valid = False
    if not valid:
        raise Refused("Launch receipt needs inspection. A worker may exist; preserve this receipt and do not retry.")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("preview", "start"))
    parser.add_argument("--role", choices=ROLES, required=True)
    parser.add_argument("--run", required=True)
    parser.add_argument("--coordinator", required=True)
    parser.add_argument("--spec", required=True)
    parser.add_argument("--title", required=True)
    placement = parser.add_mutually_exclusive_group(required=True)
    placement.add_argument("--worktree")
    placement.add_argument("--new-worktree")
    parser.add_argument("--repo")
    parser.add_argument("--base", default="origin/main")
    parser.add_argument("--head")
    parser.add_argument("--allow-dirty", action="store_true")
    args = parser.parse_args()
    try:
        plan = prepare(args)
        if args.action == "preview":
            print(json.dumps(plan, ensure_ascii=False, indent=2))
            return 0
        return start(plan)
    except (Refused, OSError, UnicodeError) as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
