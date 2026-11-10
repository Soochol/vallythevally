#!/usr/bin/env python3
"""Build a role-specific Vally assignment and start it once through Orca."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timezone

from contracts import Refused, digest, load_request
from github import GitHub, configuration, relevant
from journal import Journal, write


SKILL = Path(__file__).resolve().parent.parent
ROLES = ("worker", "reviewer")


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
    if any(os.environ.get(key) for key in ("ORCA_PAIRING_CODE", "ORCA_ENVIRONMENT")):
        raise Refused("This harness supports local placement only; unset remote routing and ask for an allowed placement")
    coordinator = repository(args.coordinator)
    spec_path = Path(args.spec).expanduser().resolve(strict=True)
    request, body = load_request(spec_path)
    snapshot = GitHub().ticket(request["ticket"])
    if request["revision"] != snapshot["source"]["revision"]:
        raise Refused("Execution request has an old source contract revision")
    selected = set(request["conditions"])
    envelope = dict(snapshot["contract"])
    if not selected <= {c["id"] for c in envelope["acceptance_conditions"]}:
        raise Refused("Selected conditions are absent from canonical Ticket")
    envelope["acceptance_conditions"] = [c for c in envelope["acceptance_conditions"] if c["id"] in selected]
    envelope["verification_plan"] = [p for p in envelope["verification_plan"] if p["condition"] in selected]
    if not body.strip() or not args.title.strip():
        raise Refused("Spec and title must be nonempty")
    if re.search(r"^(?:역할|배정된 역할|assigned_role)\s*:", body, re.MULTILINE):
        raise Refused("The script owns the role; remove the spec's role header")
    if not re.fullmatch(r"run_[A-Za-z0-9_-]+", args.run):
        raise Refused("Pass an explicit Orca Run ID")
    config = configuration(args.config)
    if set(config) != set(ROLES) | {"decision_author_ids"} or any(
        not isinstance(value, dict) or set(value) != {"agent", "model", "effort"}
        or any(not isinstance(x, str) or not x.strip() for x in value.values())
        for value in (config[role] for role in ROLES)
    ):
        raise Refused("Config must define worker/reviewer agent, model and effort")
    settings = config[args.role]
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
            "source": snapshot["source"], "conditions": sorted(selected), "contract_hash": digest(envelope),
            "config_hash": digest(config), "spec_path": str(spec_path),
            "coordinator": str(coordinator), "repository_lock": "launch:" + str(common_dir(coordinator))}
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
        info["resource"] = "checkout:" + str(root)
        command += ["--worktree", f"path:{root}"]
        location = f"- Worktree: {root}\n- Branch: {branch}\n- Assigned head: {head}\n"
        if dirty:
            location += "- Preserve existing uncommitted work; this is an explicit implementation handover.\n"
    else:
        if args.allow_dirty or (args.role == "reviewer" and not args.head):
            raise Refused("New worktrees cannot be dirty; reviewers require an exact --head")
        root = repository(args.repo or coordinator)
        if common_dir(root) != common_dir(coordinator):
            raise Refused("Local creation must use the coordinator's registered Git repository")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", args.new_worktree):
            raise Refused("Use a short lowercase worktree name")
        base_head = git(root, "rev-parse", "--verify", f"{args.base}^{{commit}}")
        if args.head and args.head != base_head:
            raise Refused("New review base must resolve to the assigned exact head")
        info.update(repo=str(root), new_worktree=args.new_worktree, base=args.base,
                    base_head=base_head, head=args.head, setup=args.setup,
                    placement=args.placement, requested_parent=str(coordinator) if args.placement == "child" else None,
                    resource="allocation:" + str(common_dir(root)) + ":" + args.new_worktree)
        command += ["--worktree", "new-child" if args.placement == "child" else "new-top-level",
                    "--name", args.new_worktree, "--base-branch", base_head, "--setup", args.setup]
        location = "- Orca allocates the worktree. Use its runtime-provided workspace; create no other checkout.\n"
    protocol = (SKILL / "assets" / f"{args.role}.md").read_text(encoding="utf-8")
    assembled = (f"{protocol}\n\n## Workspace\n\n{location}\n"
                 f"## Validated assignment contract\n\n```json\n{json.dumps(envelope, ensure_ascii=False, indent=2)}\n```\n"
                 f"\n## Freeform brief\n\n{body}\n\n"
                 f"Return a human report and compact JSON result per {SKILL / 'references/contracts.md'}. "
                 "Report unavailable or unverified capabilities first; do not install tools or broaden access. "
                 "Coordinator-supplied evidence remains supplied evidence. Receipt model values are not provider-model proof.")
    return {"assignment": info, "command": command, "spec": assembled, "contract": envelope,
            "source_observation": relevant(snapshot)}


def common_dir(root):
    return Path(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()


def rpc(cli, *args, group="orchestration"):
    result = subprocess.run([cli, group, *args, "--json"],
                            capture_output=True, text=True, timeout=30)
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
            unsafe_stop = settled and worker.get("liveness") != "exited"
            if not settled or unsafe_stop:
                raise Refused(f"Worktree has an unsettled/unproven assignment: {worker.get('dispatchId', 'unknown')}")


def worktree_info(cli, selector=None):
    args = ("show", "--worktree", selector) if selector else ("current",)
    row = rpc(cli, *args, group="worktree").get("worktree")
    if (not isinstance(row, dict) or row.get("hostId") != "local"
            or not all(isinstance(row.get(k), str) and row[k] for k in ("id", "path", "repoId", "instanceId"))):
        raise Refused("Cannot prove local worktree identity; inspect installed Orca placement guide")
    return row


def creation_preflight(plan):
    assigned = plan["assignment"]
    if assigned.get("worktree"):
        return
    cli = plan["command"][0]
    coordinator = Path(assigned["coordinator"])
    caller = worktree_info(cli)
    expected = worktree_info(cli, "path:" + str(coordinator))
    if (Path(caller["path"]).resolve() != coordinator or caller["id"] != expected["id"]
            or caller["instanceId"] != expected["instanceId"] or caller["repoId"] != expected["repoId"]):
        raise Refused("Actual Orca caller differs from --coordinator; run from that coordinator's Orca session and checkout")
    repos = rpc(cli, "list", group="repo").get("repos")
    if not isinstance(repos, list):
        raise Refused("Registered repository inventory is incomplete")
    matches = [r for r in repos if isinstance(r, dict) and r.get("id") == caller["repoId"]]
    if len(matches) != 1 or common_dir(repository(matches[0]["path"])) != common_dir(coordinator):
        raise Refused("Registered repository does not match canonical Git common directory")
    assigned["registered_repo"] = caller["repoId"]
    assigned["requested_parent_identity"] = {k: caller[k] for k in ("id", "instanceId", "repoId", "path")} if assigned["placement"] == "child" else None
    if assigned["placement"] == "top-level":
        plan["command"] += ["--repo", "id:" + caller["repoId"]]


def validate_receipt(plan, receipt):
    assigned = plan["assignment"]
    observed = receipt["result"]
    workspace = observed.get("workspace")
    valid = (receipt.get("ok") is True and observed.get("state") == "ready"
             and all(observed.get(key) == assigned[key] for key in ("agent", "model", "effort"))
             and observed.get("runId") == assigned["run"]
             and isinstance(workspace, str) and bool(workspace)
             and all(isinstance(observed.get(key), str) and observed[key] for key in ("taskId", "dispatchId")))
    if not valid:
        raise Refused("Launch receipt mismatch")
    path = Path(workspace.rsplit("::", 1)[-1])
    if not path.is_absolute():
        raise Refused("Launch receipt has no absolute canonical workspace")
    root = repository(path)
    actual = worktree_info(plan["command"][0], "path:" + str(root))
    if Path(actual["path"]).resolve() != root:
        raise Refused("Worktree read-back differs from launch receipt")
    if assigned.get("worktree"):
        if root != Path(assigned["worktree"]):
            raise Refused("Launch receipt workspace mismatch")
    else:
        if actual["repoId"] != assigned["registered_repo"] or common_dir(root) != common_dir(assigned["coordinator"]):
            raise Refused("Created workspace has wrong registered repository")
        requested_parent = assigned["requested_parent_identity"]
        lineage = actual.get("lineage", {})
        if requested_parent:
            if (actual.get("parentWorktreeId") != requested_parent["id"]
                    or lineage.get("parentWorktreeInstanceId") != requested_parent["instanceId"]):
                raise Refused("Created workspace parent identity mismatch or unverified")
        elif actual.get("parentWorktreeId") is not None:
            raise Refused("Explicit top-level creation returned a child")
        if git(root, "rev-parse", "HEAD") != assigned["base_head"]:
            raise Refused("Created workspace base head mismatch")
    observed["placement_observation"] = {k: actual.get(k) for k in ("id", "instanceId", "repoId", "parentWorktreeId", "lineage")}
    observed["canonical_workspace"] = str(root)
    return observed


def start(plan, operation, state_dir=None, timeout=120):
    journal = Journal(state_dir)
    issued = datetime.now(timezone.utc).isoformat()
    plan["spec"] += f"\n\n## Local evidence linkage\n\nOperation: {operation}\nSource: {json.dumps(plan['assignment']['source'])}\n"
    intent = {"kind": "launch", "issued_at": issued, "plan": plan}
    op = journal.begin(operation, intent)
    assigned = plan["assignment"]
    resources = [assigned["repository_lock"], assigned["resource"]]
    try:
        for resource in resources:
            journal.reserve(resource, operation)
        creation_preflight(plan)
        check_assignments(plan)
        recheck_git(plan)
        if relevant(GitHub().ticket(assigned["source"]["number"])) != plan["source_observation"]:
            raise Refused("Canonical source/relations/phase changed before dispatch")
        observed = plan["source_observation"]
        if observed["state"] != "open" or any(b["state"] == "open" for b in observed["blockers"]):
            raise Refused("Ticket is closed or has open native blockers")
    except (Refused, OSError, subprocess.TimeoutExpired, KeyError, TypeError) as exc:
        write(op / "rejected.json", {"reason": str(exc), "worker_start_invoked": False})
        for resource in resources:
            path = journal.root / "reservations" / digest(resource) / "owner.json"
            if path.exists() and json.loads(path.read_text()).get("operation") == operation:
                journal.release(resource, operation)
        raise Refused(f"Read-only preflight rejected; worker-start never invoked: {exc}") from exc
    write(op / "request.json", {"plan": plan, "brief_hash": digest(plan["spec"]), "worker_start_may_be_invoked": True})
    try:
        result = subprocess.run(plan["command"], input=plan["spec"], text=True,
                                capture_output=True, timeout=timeout)
        write(op / "output.json", {"stdout": result.stdout, "stderr": result.stderr, "exit": result.returncode})
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        if result.returncode:
            write(op / "uncertain.json", {"report": str(op / "output.json"), "exit": result.returncode})
            return result.returncode
        receipt = json.loads(result.stdout)
        observed = validate_receipt(plan, receipt)
        checkout = "checkout:" + observed["canonical_workspace"]
        journal.reserve(checkout, operation)
        write(op / "launched.json", {"assignment": assigned, "launch": observed, "contract": plan["contract"],
                                      "provider_execution": "unknown; receipt is not provider model verification"})
        for resource in resources:
            if resource != checkout:
                journal.release(resource, operation)
        return 0
    except (ValueError, KeyError, TypeError, AttributeError, OSError, Refused, subprocess.TimeoutExpired) as exc:
        detail = {"reason": str(exc), "provider_execution": "unknown"}
        if isinstance(exc, subprocess.TimeoutExpired):
            decode = lambda value: value.decode(errors="replace") if isinstance(value, bytes) else value
            write(op / "timeout-output.json", {"stdout": decode(exc.stdout), "stderr": decode(exc.stderr)})
        write(op / "uncertain.json", detail)
        raise Refused("Launch needs inspection. A worker may exist; preserve operation/receipt and do not retry.") from exc


def recheck_git(plan):
    assigned = plan["assignment"]
    if assigned.get("worktree"):
        root = assigned["worktree"]
        if git(root, "rev-parse", "HEAD") != assigned["head"]:
            raise Refused("Worktree head changed during preparation")
        if not assigned["dirty"] and git(root, "status", "--porcelain"):
            raise Refused("Worktree became dirty during preparation")


def arguments(parser):
    parser.add_argument("action", choices=("preview", "start"))
    parser.add_argument("--role", choices=ROLES, required=True)
    parser.add_argument("--run", required=True)
    parser.add_argument("--coordinator", required=True)
    parser.add_argument("--spec", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--operation", required=True)
    parser.add_argument("--state-dir")
    parser.add_argument("--config")
    parser.add_argument("--timeout", type=float, default=120)
    placement = parser.add_mutually_exclusive_group(required=True)
    placement.add_argument("--worktree")
    placement.add_argument("--new-worktree")
    parser.add_argument("--repo")
    parser.add_argument("--base", default="origin/main")
    parser.add_argument("--head")
    parser.add_argument("--allow-dirty", action="store_true")
    parser.add_argument("--placement", choices=("child", "top-level"), default="child")
    parser.add_argument("--setup", choices=("run", "skip", "inherit"), default="run")


def execute(args):
    plan = prepare(args)
    if args.action == "preview":
        print(json.dumps(plan, ensure_ascii=False, indent=2))
        return 0
    return start(plan, args.operation, args.state_dir, args.timeout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    arguments(parser)
    args = parser.parse_args()
    try:
        return execute(args)
    except (Refused, OSError, UnicodeError, ValueError, TypeError, KeyError) as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
