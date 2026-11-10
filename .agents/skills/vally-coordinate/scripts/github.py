import json
import os
from pathlib import Path
import re
import subprocess

from contracts import Refused, canonical, contract, digest, unique_object
from journal import read, write


REPO = "Soochol/vallythevally"
PREFIX = f"repos/{REPO}"
PHASES = {"coord:ready", "coord:working", "coord:review", "coord:waiting"}
START, END = "<!-- vally-ticket:v1 -->", "<!-- /vally-ticket -->"


def configuration(path=None):
    return read(path or Path(__file__).resolve().parent.parent / "config.json")


class GitHub:
    def __init__(self, cli=None):
        self.cli = cli or os.environ.get("GH_CLI_COMMAND", "gh")

    def api(self, endpoint, method="GET", payload=None):
        command = [self.cli, "api", endpoint, "--method", method]
        if payload is not None:
            command += ["--input", "-"]
        result = subprocess.run(command, input=canonical(payload) if payload is not None else None,
                                capture_output=True, text=True, timeout=30)
        if result.returncode:
            raise Refused(f"GitHub {method} {endpoint} failed; a mutation may have taken effect, reconcile before retry")
        try:
            return json.loads(result.stdout) if result.stdout.strip() else None
        except ValueError as exc:
            raise Refused("GitHub returned malformed JSON; inspect operation before retry") from exc

    def pages(self, endpoint):
        rows = []
        for page in range(1, 101):
            sep = "&" if "?" in endpoint else "?"
            part = self.api(f"{endpoint}{sep}per_page=100&page={page}")
            if not isinstance(part, list) or not all(isinstance(row, dict) for row in part):
                raise Refused("Incomplete GitHub list capability; native relations/comments are required")
            rows.extend(part)
            if len(part) < 100:
                return rows
        raise Refused("GitHub bounded pagination incomplete; narrow scope before proceeding")

    def issue(self, number, kind=None):
        if type(number) is not int or number < 1:
            raise Refused("Issue number must be positive")
        row = self.api(f"{PREFIX}/issues/{number}")
        validate_issue(row, kind)
        if row["number"] != number:
            raise Refused("GitHub returned a different Issue")
        return row

    def ticket(self, number):
        row = self.issue(number, "ticket")
        body = row.get("body") or ""
        if body.count(START) != 1 or body.count(END) != 1:
            raise Refused("Ticket requires exactly one canonical vally-ticket:v1 contract block; coordinator must format the source")
        block = body.split(START)[1].split(END)[0].strip()
        match = re.fullmatch(r"```json\s*\n(.*?)\n```", block, re.DOTALL)
        if not match:
            raise Refused("Malformed Ticket contract block")
        value = contract(json.loads(match[1], object_pairs_hook=unique_object))
        parent = self.api(f"{PREFIX}/issues/{number}/parent")
        validate_issue(parent, "feature")
        children = self.pages(f"{PREFIX}/issues/{parent['number']}/sub_issues")
        if not any(child.get("id") == row["id"] for child in children):
            raise Refused("Native parent/child relation is inconsistent")
        blockers = self.pages(f"{PREFIX}/issues/{number}/dependencies/blocked_by")
        for blocker in blockers:
            validate_issue(blocker)
        source = {"repository": REPO, "number": number, "id": row["id"], "node_id": row["node_id"],
                  "revision": digest(value)}
        return {"source": source, "contract": value, "issue": row, "parent": identity(parent),
                "blockers": [identity(b) | {"state": b["state"]} for b in blockers], "phase": phase(row)}

    def feature(self, number):
        feature = self.issue(number, "feature")
        tickets = []
        for child in self.pages(f"{PREFIX}/issues/{number}/sub_issues"):
            ticket = self.ticket(child["number"])
            if ticket["parent"]["id"] != feature["id"]:
                raise Refused("Feature child points to a different native parent")
            tickets.append({"source": ticket["source"], "state": ticket["issue"]["state"],
                            "phase": ticket["phase"], "blockers": ticket["blockers"],
                            "frontier": feature["state"] == "open" and ticket["issue"]["state"] == "open" and ticket["phase"] == "coord:ready"
                            and not any(b["state"] == "open" for b in ticket["blockers"])})
        return {"feature": identity(feature), "tickets": tickets,
                "completion": "Feature overall acceptance requires coordinator integration evidence; children do not auto-close it"}

    def pr(self, number):
        row = self.api(f"{PREFIX}/pulls/{number}")
        if (not isinstance(row, dict) or row.get("number") != number
                or row.get("base", {}).get("repo", {}).get("full_name", "").lower() != REPO.lower()):
            raise Refused("PR belongs to wrong repository or is unavailable")
        return row

    def records(self, ticket, author_ids):
        records = []
        seen = set()
        for comment in self.pages(f"{PREFIX}/issues/{ticket}/comments"):
            body = comment.get("body") or ""
            if "vally-decision:" not in body:
                continue
            match = re.fullmatch(r"<!-- vally-decision:v1 ([A-Za-z0-9_-]{1,100}) ([a-f0-9]{64}) -->\n```json\n(.*)\n```\n?", body, re.DOTALL)
            if not match or comment.get("user", {}).get("id") not in author_ids:
                raise Refused("Malformed or unauthorized-author decision marker; inspect GitHub, never treat it as a verdict")
            value = json.loads(match[3])
            operation, fingerprint = match[1], match[2]
            if operation in seen or digest(value) != fingerprint or decision_body(operation, value) != body.rstrip("\n"):
                raise Refused("Duplicate/conflicting decision marker or payload hash")
            seen.add(operation)
            records.append({"operation": operation, "id": comment["id"], "url": comment.get("html_url"), "payload": value})
        return records


def identity(row):
    return {key: row[key] for key in ("id", "node_id", "number")}


def validate_issue(row, kind=None):
    if (not isinstance(row, dict) or row.get("repository_url", "").lower() != f"https://api.github.com/{PREFIX}".lower()
            or row.get("pull_request") or not all(row.get(k) for k in ("id", "node_id", "number"))):
        raise Refused("Expected a native Issue in Soochol/vallythevally, not a PR or foreign Issue")
    labels = {label["name"] for label in row["labels"]}
    if kind and ({"coord:feature", "coord:ticket"} & labels) != {"coord:" + kind}:
        raise Refused(f"Expected exactly one coord:{kind} issue type")


def phase(row):
    values = {label["name"] for label in row["labels"]} & PHASES
    if row["state"] == "open" and len(values) != 1:
        raise Refused("Open executable Ticket needs exactly one coordination phase; preserve and reconcile conflicting labels")
    return next(iter(values)) if len(values) == 1 else None


def relevant(snapshot):
    return {"source": snapshot["source"], "parent": snapshot["parent"], "blockers": snapshot["blockers"],
            "phase": snapshot["phase"], "state": snapshot["issue"]["state"]}


def decision_body(operation, payload):
    return f"<!-- vally-decision:v1 {operation} {digest(payload)} -->\n```json\n{canonical(payload)}\n```"


def publish(github, journal, operation, payload, reconcile=False):
    from evidence import validate_decision, readiness
    authors = configuration()["decision_author_ids"]
    validate_decision(payload)
    if len(canonical(payload).encode()) > 60000:
        raise Refused("Publish compact evidence summaries, not copied logs")
    ticket = payload["source"]["number"]
    snapshot = github.ticket(ticket)
    if payload["source"] != snapshot["source"]:
        raise Refused("Source contract/Issue identity changed; do not apply an old decision")
    if github.api("user").get("id") not in authors:
        raise Refused("Current GitHub account is not a configured decision author; no implicit access expansion")
    intent = {"kind": "publication", "payload": payload, "source_observation": relevant(snapshot)}
    op = journal.operation(operation)
    if reconcile:
        saved = read(op / "intent.json")
        if saved["payload"] != payload:
            raise Refused("Conflicting reconciliation payload")
        intent = saved
    else:
        op = journal.begin(operation, intent)
    body = decision_body(operation, payload)
    records = github.records(ticket, authors)
    found = [row for row in records if row["operation"] == operation]
    if found and found[0]["payload"] != payload:
        raise Refused("Remote operation marker conflicts with requested payload")
    if not found:
        if reconcile or (op / "comment-request.json").exists():
            raise Refused("Unknown publication: exact marker absent; no automatic second POST")
        if relevant(github.ticket(ticket)) != intent["source_observation"]:
            write(op / "rejected.json", {"reason": "source changed before comment request", "mutated": False})
            raise Refused("Source state changed before publication")
        validate_decision(payload, github=github, journal=journal)
        write(op / "comment-request.json", {"body_hash": digest(body)})
        response = github.api(f"{PREFIX}/issues/{ticket}/comments", "POST", {"body": body})
        if not isinstance(response, dict) or not response.get("id"):
            raise Refused("Comment request has no verified remote identity; reconcile")
        observed = github.api(f"{PREFIX}/issues/comments/{response['id']}")
        if observed.get("body") != body or observed.get("user", {}).get("id") not in authors:
            raise Refused("Comment read-back mismatch; reconcile before any further effect")
        found = [{"id": observed["id"], "payload": payload, "operation": operation}]
    write(op / "comment-ack.json", {"id": found[0]["id"], "body_hash": digest(body)})
    effect = payload.get("effect", {"action": "comment"})
    action = effect["action"]
    if action == "comment":
        write(op / "ack.json", {"comment": found[0]["id"], "effect": "comment"})
        return {"acknowledged": True, "comment": found[0]["id"], "effect": "comment"}
    current = github.ticket(ticket)
    if action == "close" and not readiness(github, ticket, journal)["ticket_close_ready"]:
        raise Refused("Whole Ticket current conditions/delivery/review/approval are not ready; comment alone cannot close it")
    desired = (action == "phase" and current["phase"] == effect["phase"]) or (action == "close" and current["issue"]["state"] == "closed" and current["issue"].get("state_reason") == "completed")
    if desired:
        write(op / "ack.json", {"comment": found[0]["id"], "effect": effect})
        return {"acknowledged": True, "comment": found[0]["id"], "effect": effect}
    if reconcile or (op / "effect-request.json").exists():
        raise Refused("Remote comment exists but phase/closure effect incomplete; inspect actual GitHub state, never blind retry")
    if relevant(current) != intent["source_observation"]:
        raise Refused("Source/phase changed after comment; effect not acknowledged")
    write(op / "effect-request.json", effect)
    if action == "phase":
        old = current["phase"]
        github.api(f"{PREFIX}/issues/{ticket}/labels", "POST", {"labels": [effect["phase"]]})
        after = github.issue(ticket, "ticket")
        phases = {x["name"] for x in after["labels"]} & PHASES
        if phases != {old, effect["phase"]}:
            raise Refused("Concurrent phase change during label update; partial effect requires reconciliation")
        github.api(f"{PREFIX}/issues/{ticket}/labels/{old.replace(':', '%3A')}", "DELETE")
    else:
        github.api(f"{PREFIX}/issues/{ticket}", "PATCH", {"state": "closed", "state_reason": "completed"})
    observed = github.ticket(ticket)
    valid = observed["phase"] == effect.get("phase") if action == "phase" else observed["issue"]["state"] == "closed" and observed["issue"].get("state_reason") == "completed"
    if not valid or observed["source"] != snapshot["source"]:
        raise Refused("Remote effect read-back mismatch; operation incomplete")
    write(op / "ack.json", {"comment": found[0]["id"], "effect": effect})
    return {"acknowledged": True, "comment": found[0]["id"], "effect": effect}
