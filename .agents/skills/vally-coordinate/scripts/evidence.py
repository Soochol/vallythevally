import os
import subprocess
from datetime import datetime, timezone

from contracts import Refused, digest, nonempty, sha, strings
from github import REPO, configuration
from journal import read, write


def source_identity(source):
    if (not isinstance(source, dict) or set(source) != {"repository", "number", "id", "node_id", "revision"}
            or source["repository"] != REPO or type(source["id"]) is not int
            or type(source["number"]) is not int or not source["node_id"] or len(source["revision"]) != 64):
        raise Refused("Evidence requires immutable repository/Issue identity and semantic source revision")


def provenance(value, expected):
    source = value.get("provenance")
    if not isinstance(source, dict) or source.get("class") != expected:
        raise Refused("Evidence provenance class does not match its role")
    for key in ("ref", "time", "scope", "omissions"):
        nonempty(source.get(key), f"provenance.{key}")


def assignment_time(value):
    nonempty(value, "execution issue time")
    try:
        issued = datetime.fromisoformat(value)
        if issued.tzinfo is None:
            raise ValueError("missing timezone")
        return issued.astimezone(timezone.utc)
    except (ValueError, OverflowError) as exc:
        raise Refused("Execution issue time must be a valid timezone-aware ISO timestamp") from exc


def validate_result(value, journal=None):
    if not isinstance(value, dict) or value.get("kind") != "result":
        raise Refused("Expected a compact result claim")
    source_identity(value.get("source"))
    nonempty(value.get("id"), "stable result id")
    nonempty(value.get("report"), "human report path and availability")
    role = value.get("role")
    if role not in {"worker", "reviewer"}:
        raise Refused("Result role must be worker or reviewer")
    provenance(value, role + "_claim")
    assignment = value.get("assignment")
    if not isinstance(assignment, dict):
        raise Refused("Result requires assignment request plus launch receipt")
    requested, launch = assignment["requested"], assignment["launch"]
    if requested["role"] != role or requested["source"] != value["source"]:
        raise Refused("Assignment source/role differs from result")
    for key in ("agent", "model", "effort"):
        if launch.get(key) != requested.get(key):
            raise Refused("Requested configuration and Orca receipt mismatch")
    if launch.get("runId") != requested.get("run"):
        raise Refused("Assignment Run differs from receipt")
    for key in ("taskId", "dispatchId", "canonical_workspace"):
        nonempty(launch.get(key), key)
    if value["id"] != "result:" + launch["dispatchId"]:
        raise Refused("Result event identity must be result:<actual Dispatch ID>")
    assignment_time(assignment.get("issued_at"))
    nonempty(assignment.get("operation"), "local operation identity")
    subjects = value.get("subjects")
    if not isinstance(subjects, list) or not subjects:
        raise Refused("Results need condition-scoped PR/head subjects, using pr:null before a PR exists")
    covered = set()
    seen = set()
    for subject in subjects:
        pr_subject(subject)
        identity = (subject["pr"], subject["head"])
        if identity in seen:
            raise Refused("Duplicate PR/head subject")
        seen.add(identity)
        if role == "reviewer" and subject["head"] != requested["head"]:
            raise Refused("Independent review must use exact assigned head")
        claims = subject.get("conditions")
        if not isinstance(claims, dict) or not claims:
            raise Refused("Each result subject needs explicit condition claims")
        covered.update(claims)
        for claim in claims.values():
            if not isinstance(claim, dict) or claim.get("outcome") not in {"passed", "failed", "unverified"}:
                raise Refused("Condition outcome must be passed, failed or unverified")
            nonempty(claim.get("evidence"), "condition evidence reference/availability")
        if role != "reviewer" and (subject.get("findings") or subject.get("resolves")):
            raise Refused("Only independent reviewer claims open/resolve proven findings")
        findings = subject.get("findings", [])
        for finding in findings:
            for key in ("id", "summary", "reproduction", "condition"):
                nonempty(finding.get(key), f"finding {key}")
            if finding["condition"] not in claims:
                raise Refused("Finding must name a condition claimed by this subject")
        if {f["id"] for f in findings} & set(subject.get("resolves", [])):
            raise Refused("A review cannot prove and resolve the same finding")
    if covered != set(requested["conditions"]):
        raise Refused("Result must cover exactly the selected task conditions")
    model = value.get("provider_execution")
    if not isinstance(model, dict) or (model.get("model") is not None and not model.get("source")):
        raise Refused("Provider execution is unknown/null unless backed by provider evidence")
    for key in ("capability_observations", "procedure"):
        if not isinstance(value.get(key), dict):
            raise Refused(f"Result needs {key}")
    for item in value["capability_observations"].values():
        if item.get("status") not in {"available", "unavailable", "unverified"} or not item.get("evidence"):
            raise Refused("Required capability observation unavailable or unverified must be explicit")
    for key in ("skills", "playbooks", "skips"):
        if not isinstance(value["procedure"].get(key), list):
            raise Refused("Report actual procedures as lists")
    if journal:
        op = journal.operation(assignment["operation"])
        intent = read(op / "intent.json")
        receipt = read(op / "launched.json")
        if (intent["kind"] != "launch" or receipt["assignment"] != requested
                or receipt["launch"] != launch or intent["issued_at"] != assignment["issued_at"]):
            raise Refused("Result does not match recorded actual launched assignment")
        manifest = receipt["contract"]["capabilities"]
        expected = ({"skill:" + s["path"] for s in manifest["skills"]}
                    | {"tool:" + t for t in manifest["tools"]} | {"scope:" + s for s in manifest["account_data_scope"]})
        if set(value["capability_observations"]) != expected:
            raise Refused("Report every required source capability")
    return value


def pr_subject(subject):
    sha(subject.get("head"))
    if subject.get("pr") is not None and (type(subject["pr"]) is not int or subject["pr"] < 1):
        raise Refused("PR subject needs a positive number or null")


def validate_decision(value, github=None, journal=None):
    if not isinstance(value, dict):
        raise Refused("Decision must be a JSON object")
    source_identity(value.get("source"))
    kind = value.get("kind")
    if kind not in {"accept", "final_check", "approval", "exclusion", "phase", "close"}:
        raise Refused("Only explicit coordinator decisions can be published")
    provenance(value, "user_instruction" if kind in {"approval", "exclusion"} else "coordinator_verdict")
    nonempty(value.get("summary"), "decision summary")
    effect = value.get("effect", {"action": "comment"})
    if effect.get("action") not in {"comment", "phase", "close"}:
        raise Refused("Unsupported business effect")
    if effect["action"] == "phase" and (kind != "phase" or effect.get("phase") not in {"coord:ready", "coord:working", "coord:review", "coord:waiting"}):
        raise Refused("Phase changes require an explicit scoped phase decision")
    if effect["action"] == "close" and kind != "close":
        raise Refused("Ticket closure requires its own explicit coordinator decision")
    if kind == "accept":
        claim = validate_result(value.get("claim"), journal)
        if journal and read(journal.operation(claim["assignment"]["operation"]) / "result.json") != claim:
            raise Refused("Acceptance must match this execution's immutable recorded result")
        if claim["source"] != value["source"] or value.get("claim_hash") != digest(claim):
            raise Refused("Acceptance must identify its exact immutable claim hash/source")
        strings(value.get("conditions"), "accepted condition IDs")
        if not set(value["conditions"]) <= set(claim["assignment"]["requested"]["conditions"]):
            raise Refused("Cannot accept conditions outside this execution")
        subjects = claim["subjects"]
    elif kind in {"approval", "exclusion", "final_check"}:
        subjects = value.get("subjects")
        if not isinstance(subjects, list) or not subjects:
            raise Refused("Decision requires explicit PR/head/condition scope")
        for subject in subjects:
            pr_subject(subject)
            strings(subject.get("conditions"), "decision condition IDs")
        if kind == "approval" and value.get("approval_kind") not in {"merge", "close", "design", "account"}:
            raise Refused("Approval kind is explicit; design/account never substitute for merge/close")
        if kind in {"approval", "exclusion"} and value.get("decision") not in {"approved", "revoked"}:
            raise Refused("Approval/exclusion decision must be approved or revoked")
        if kind == "exclusion":
            nonempty(value.get("reason"), "unverified exclusion reason")
        if kind == "final_check":
            nonempty(value.get("report"), "coordinator final check report")
            if value.get("outcome") not in {"passed", "failed", "unverified"}:
                raise Refused("Invalid final check outcome")
    else:
        subjects = []
    if github:
        snapshot = github.ticket(value["source"]["number"])
        conditions = {c["id"] for c in snapshot["contract"]["acceptance_conditions"]}
        if snapshot["source"] != value["source"]:
            raise Refused("Decision is stale against current canonical contract")
        if kind == "accept" and journal:
            for _, intent in journal.executions(value["source"]):
                assigned = intent["plan"]["assignment"]
                if (assigned["role"] == claim["role"] and assignment_time(intent["issued_at"]) > assignment_time(claim["assignment"]["issued_at"])
                        and set(assigned["conditions"]) & set(value["conditions"])):
                    raise Refused("A newer local execution covers these conditions; an earlier attempt cannot advance it")
        for subject in subjects:
            if not set(subject["conditions"]) <= conditions:
                raise Refused("Decision names conditions absent from source Ticket")
            selected = kind != "accept" or set(subject["conditions"]) & set(value["conditions"])
            if selected and subject["pr"] is not None and github.pr(subject["pr"])["head"]["sha"] != subject["head"]:
                raise Refused("Current remote PR head differs from evidence/approval")
    return value


def record_result(journal, value):
    validate_result(value, journal)
    identity = digest(value["id"])
    path = journal.root / "results" / (identity + ".json")
    created = write(path, value)
    write(journal.operation(value["assignment"]["operation"]) / "result.json", value)
    return {"recorded": str(path), "duplicate": not created, "authority": "worker/reviewer claim only; no GitHub business mutation"}


def readiness(github, ticket, journal=None):
    snapshot = github.ticket(ticket)
    records = github.records(ticket, configuration()["decision_author_ids"])
    result_hashes = {}
    for record in records:
        validate_decision(record["payload"])
        if any(record["payload"]["source"][key] != snapshot["source"][key] for key in ("repository", "number", "id", "node_id")):
            raise Refused("Decision marker is attached to the wrong source Issue identity")
        if record["payload"]["kind"] == "accept":
            claim = record["payload"]["claim"]
            fingerprint = digest(claim)
            if claim["id"] in result_hashes and result_hashes[claim["id"]] != fingerprint:
                raise Refused("Conflicting remote reuse of completion event identity")
            result_hashes[claim["id"]] = fingerprint
    current = [r for r in records if r["payload"]["source"] == snapshot["source"]]
    heads, prs = {}, {}
    for record in current:
        value = record["payload"]
        subjects = value["claim"]["subjects"] if value["kind"] == "accept" else value.get("subjects", [])
        for subject in subjects:
            if subject["pr"] is not None and subject["pr"] not in heads:
                prs[subject["pr"]] = github.pr(subject["pr"])
                heads[subject["pr"]] = prs[subject["pr"]]["head"]["sha"]
    live = lambda s: s["pr"] is None or heads.get(s["pr"]) == s["head"]
    selected = {}
    findings = {}
    accepted = sorted((r for r in records if r["payload"]["kind"] == "accept"),
                      key=lambda r: assignment_time(r["payload"]["claim"]["assignment"]["issued_at"]))
    for record in accepted:
        value = record["payload"]
        claim = value["claim"]
        issued = assignment_time(claim["assignment"]["issued_at"])
        for subject in claim["subjects"]:
            if claim["role"] == "reviewer":
                for finding in subject.get("findings", []):
                    if finding["condition"] not in value["conditions"]:
                        continue
                    key = (subject["pr"], finding["condition"], finding["id"])
                    if key not in findings or assignment_time(findings[key]["issued_at"]) <= issued:
                        findings[key] = {**finding, "pr": subject["pr"], "issued_at": claim["assignment"]["issued_at"],
                                         "execution": claim["id"], "resolved": False}
                if value["source"] == snapshot["source"] and live(subject):
                    for resolved in subject.get("resolves", []):
                        for condition in set(subject["conditions"]) & set(value["conditions"]):
                            key = (subject["pr"], condition, resolved)
                            if key in findings and assignment_time(findings[key]["issued_at"]) < issued:
                                findings[key]["resolved"] = True
            if value["source"] != snapshot["source"] or not live(subject):
                continue
            for condition, result in subject["conditions"].items():
                if condition not in value["conditions"]:
                    continue
                key = (subject["pr"], subject["head"], condition, claim["role"])
                if key not in selected or (selected[key]["issued_at"], selected[key]["comment"]) < (issued, record["id"]):
                    selected[key] = {"issued_at": issued, "claim": claim, "result": result, "comment": record["id"]}
    if journal:
        for _, intent in journal.executions(snapshot["source"]):
            assigned = intent["plan"]["assignment"]
            for key, item in list(selected.items()):
                if key[3] == assigned["role"] and key[2] in assigned["conditions"] and item["issued_at"] < assignment_time(intent["issued_at"]):
                    del selected[key]
    all_conditions = {c["id"] for c in snapshot["contract"]["acceptance_conditions"]}
    subjects = {(pr, head) for pr, head, _, _ in selected}
    gates = []
    covered = set()
    for pr, head in sorted(subjects, key=str):
        conditions = {c for p, h, c, _ in selected if (p, h) == (pr, head)}
        exclusions = set()
        approved = set()
        final = {}
        for record in current:
            value = record["payload"]
            for subject in value.get("subjects", []):
                if (subject["pr"], subject["head"]) != (pr, head):
                    continue
                if value["kind"] == "exclusion":
                    exclusions.difference_update(subject["conditions"])
                    if value["decision"] == "approved":
                        exclusions.update(subject["conditions"])
                if value["kind"] == "approval" and value["approval_kind"] in {"merge" if pr else "close"}:
                    approved.difference_update(subject["conditions"])
                    if value["decision"] == "approved":
                        approved.update(subject["conditions"])
                if value["kind"] == "final_check":
                    for condition in subject["conditions"]:
                        final[condition] = (record["id"], value["outcome"])
        worker_pass, review_pass = set(exclusions), set(exclusions)
        actual_review_pass = set()
        last_accept = {condition: 0 for condition in conditions}
        for condition in conditions:
            worker = selected.get((pr, head, condition, "worker"))
            review = selected.get((pr, head, condition, "reviewer"))
            if worker:
                last_accept[condition] = max(last_accept[condition], worker["comment"])
                if worker["result"]["outcome"] == "passed":
                    worker_pass.add(condition)
            if review:
                last_accept[condition] = max(last_accept[condition], review["comment"])
                distinct = (worker and review["issued_at"] > worker["issued_at"]
                            and all(review["claim"]["assignment"]["launch"][k] != worker["claim"]["assignment"]["launch"][k] for k in ("taskId", "dispatchId")))
                if distinct and review["result"]["outcome"] == "passed":
                    review_pass.add(condition)
                    actual_review_pass.add(condition)
        final_ok = all(condition in final and final[condition][0] > last_accept[condition]
                       and final[condition][1] == "passed" for condition in conditions)
        worker_ok = conditions <= worker_pass
        review_ok = worker_ok and conditions <= review_pass
        approval_ok = conditions <= approved
        stage = "implementation_pending"
        if worker_ok:
            covered.update(conditions)
            stage = "ready_for_review"
        if review_ok:
            stage = "waiting_for_final_check"
        if review_ok and final_ok:
            stage = "waiting_for_merge_approval" if pr else "waiting_for_close_approval"
        if review_ok and final_ok and approval_ok:
            no_pr = snapshot["contract"].get("delivery", {}).get("kind") == "no_repository_change"
            stage = "merge_ready" if pr else ("ticket_subject_ready" if no_pr else "delivery_unverified")
        if pr and (prs[pr].get("draft") or (prs[pr].get("state") == "closed" and not prs[pr].get("merged"))):
            stage = "delivery_unverified"
        gates.append({"pr": pr, "head": head, "conditions": sorted(conditions), "stage": stage,
                      "unverified_exclusions": sorted(exclusions), "review_passed": worker_ok and conditions <= actual_review_pass,
                      "review_requirement_satisfied": review_ok, "final_check_passed": final_ok,
                      "approval_recorded": approval_ok})
    open_findings = [f for f in findings.values() if not f["resolved"]]
    runtime = []
    dispatches = {item["claim"]["assignment"]["launch"]["dispatchId"]: item["claim"]["assignment"]["launch"] for item in selected.values()}
    for dispatch_id, receipt in dispatches.items():
        try:
            from dispatch import rpc
            cli = os.environ.get("ORCA_CLI_COMMAND")
            if not cli:
                raise Refused("Guide-selected ORCA_CLI_COMMAND unavailable")
            observed = rpc(cli, "worker-show", "--dispatch", dispatch_id)
            matches = all(observed.get(k) == receipt[k] for k in ("dispatchId", "taskId", "runId"))
            matches = matches and isinstance(observed.get("workspace"), str) and observed["workspace"].rsplit("::", 1)[-1] == receipt["canonical_workspace"]
            runtime.append({"dispatch": dispatch_id, "observation": observed,
                            "settled_identity_verified": matches and observed.get("state") == "succeeded"})
        except (Refused, OSError, subprocess.TimeoutExpired) as exc:
            runtime.append({"dispatch": dispatch_id, "unverified": str(exc), "settled_identity_verified": False})
    uncertain = []
    open_blockers = [b for b in snapshot["blockers"] if b["state"] == "open"]
    if journal:
        for path, _ in journal.executions(snapshot["source"]):
            if not any((path / name).exists() for name in ("launched.json", "recovery.json")):
                uncertain.append(path.name)
    complete = (all_conditions <= covered and bool(gates) and all(g["stage"] in {"merge_ready", "ticket_subject_ready"} for g in gates)
                and not open_findings and not uncertain and not open_blockers and all(r["settled_identity_verified"] for r in runtime))
    if open_findings or uncertain or open_blockers:
        stage = "blocked"
    elif snapshot["issue"]["state"] == "closed":
        stage = "closed_completed" if complete and snapshot["issue"].get("state_reason") == "completed" else "closed_unverified"
    elif complete:
        stage = "ticket_close_ready"
    elif not gates or not all_conditions <= covered:
        stage = "implementation_pending"
    else:
        order = ["implementation_pending", "ready_for_review", "waiting_for_final_check", "waiting_for_merge_approval",
                 "waiting_for_close_approval", "delivery_unverified"]
        stage = next((candidate for candidate in order if any(g["stage"] == candidate for g in gates)), "waiting_for_runtime_confirmation")
    actions = {
        "blocked": "resolve proven findings/native blockers or reconcile uncertain operations",
        "implementation_pending": "obtain current-source condition-scoped worker evidence and coordinator acceptance",
        "ready_for_review": "arrange fresh independent exact-head review",
        "waiting_for_final_check": "coordinator performs required final checks after evidence acceptance",
        "waiting_for_merge_approval": "obtain or cite actual user approval for this PR/head/condition scope",
        "waiting_for_close_approval": "obtain or cite actual user closure approval for this source/scope",
        "ticket_close_ready": "coordinator reconciles live authority and explicitly publishes Ticket closure; no automatic action",
        "waiting_for_runtime_confirmation": "verify exact Task/Dispatch identity settled successfully in Orca",
    }
    return {"source": snapshot["source"], "stage": stage, "phase": snapshot["phase"], "subjects": gates,
            "missing_ticket_conditions": sorted(all_conditions - covered), "open_findings": open_findings,
            "uncertain_local_executions": uncertain,
            "open_blockers": open_blockers,
            "runtime_observations": runtime,
            "ticket_close_ready": complete, "next_action": actions.get(stage, "coordinator inspects delivery/closed outcome; no automatic close or merge"),
            "authority": "GitHub source/acknowledged decisions and current PR heads; authors/role strings are attributed assertions, not capabilities"}
