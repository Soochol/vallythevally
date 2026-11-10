import hashlib
import json
from pathlib import Path
import re


class Refused(Exception):
    pass


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Refused(f"Duplicate JSON field: {key}")
        result[key] = value
    return result


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def nonempty(value, name):
    if not isinstance(value, str) or not value.strip():
        raise Refused(f"{name} must be a nonempty string")
    return value


def strings(value, name):
    if not isinstance(value, list) or not value:
        raise Refused(f"{name} must be a nonempty list")
    for item in value:
        nonempty(item, name)
    return value


def sha(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{40}", value):
        raise Refused("head must be a full lowercase Git SHA")
    return value


def contract(value):
    if not isinstance(value, dict) or value.get("version") != 1:
        raise Refused("Assignment envelope requires version: 1")
    if "brief" in value:
        raise Refused("Runtime brief belongs to execution request, not the business source")
    for key in ("goal", "scope"):
        nonempty(value.get(key), key)
    for key in ("constraints", "evidence_outputs"):
        strings(value.get(key), key)
    conditions = value.get("acceptance_conditions")
    if not isinstance(conditions, list) or not conditions:
        raise Refused("Task-specific acceptance_conditions are required")
    ids = set()
    for condition in conditions:
        if not isinstance(condition, dict):
            raise Refused("Each condition needs id and outcome")
        key = nonempty(condition.get("id"), "condition id")
        if key in ids:
            raise Refused("Condition IDs must be unique")
        ids.add(key)
        nonempty(condition.get("outcome"), "observable condition outcome")
    plan = value.get("verification_plan")
    if not isinstance(plan, list) or not plan:
        raise Refused("Task-specific verification_plan is required")
    planned = set()
    for item in plan:
        if not isinstance(item, dict) or item.get("condition") not in ids:
            raise Refused("Verification must name an acceptance condition")
        planned.add(item["condition"])
        nonempty(item.get("method"), "verification method")
        nonempty(item.get("evidence"), "planned evidence")
    if planned != ids:
        raise Refused("Every condition needs planned verification/evidence")
    capabilities = value.get("capabilities")
    if not isinstance(capabilities, dict):
        raise Refused("capabilities manifest is required")
    for key in ("skills", "tools", "account_data_scope"):
        if not isinstance(capabilities.get(key), list):
            raise Refused(f"capabilities.{key} must be a list, possibly empty")
    for skill in capabilities["skills"]:
        if not isinstance(skill, dict):
            raise Refused("Skill manifest entries need path, revision and dependencies")
        nonempty(skill.get("path"), "skill path")
        nonempty(skill.get("revision"), "skill revision or explicitly unverified")
        if not isinstance(skill.get("dependencies"), list):
            raise Refused("Skill dependencies must be a list")
    for tool in capabilities["tools"]:
        nonempty(tool, "tool")
    for scope in capabilities["account_data_scope"]:
        nonempty(scope, "account/data scope")
    if value.get("product_checks_inapplicable") is not None:
        nonempty(value["product_checks_inapplicable"], "product checks inapplicable reason")
    if "delivery" in value:
        delivery = value["delivery"]
        if not isinstance(delivery, dict) or delivery.get("kind") not in {"pull_request", "no_repository_change"}:
            raise Refused("Source delivery kind must be pull_request or no_repository_change")
        nonempty(delivery.get("reason"), "task-specific delivery reason")
    for snapshot in value.get("supplied_evidence", []):
        for key in ("source", "scope", "time", "omissions", "path"):
            nonempty(snapshot.get(key), f"supplied evidence {key}")
    return value


def load_request(path):
    path = Path(path).expanduser().resolve(strict=True)
    value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    if (not isinstance(value, dict) or set(value) != {"ticket", "conditions", "revision", "brief"}
            or type(value["ticket"]) is not int or value["ticket"] < 1):
        raise Refused("Execution request needs only ticket, conditions, revision and brief")
    strings(value["conditions"], "selected conditions")
    nonempty(value["revision"], "expected source revision")
    nonempty(value["brief"], "execution brief")
    brief = Path(value["brief"]).expanduser()
    if not brief.is_absolute():
        brief = path.parent / brief
    body = brief.read_text(encoding="utf-8")
    nonempty(body, "freeform brief")
    if re.search(r"^(?:역할|배정된 역할|assigned_role)\s*:", body, re.MULTILINE):
        raise Refused("The script owns the role; remove the spec's role header")
    return value, body


