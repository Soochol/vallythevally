import json
import os
from pathlib import Path
import re

from contracts import Refused, canonical, digest, unique_object


def default_root():
    return Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state") / "vallythevally/orchestration"


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def directory(path):
    path = Path(path)
    if not path.exists():
        directory(path.parent)
        try:
            path.mkdir()
            sync_dir(path.parent)
        except FileExistsError:
            pass
    return path


def read(path):
    try:
        return json.loads(Path(path).read_text(), object_pairs_hook=unique_object)
    except (OSError, ValueError) as exc:
        raise Refused(f"Incomplete/unreadable immutable record: {path}; inspect before recovery") from exc


def write(path, value):
    path = Path(path)
    directory(path.parent)
    data = canonical(value)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if canonical(read(path)) != data:
            raise Refused(f"Conflicting immutable record: {path}")
        return False
    with os.fdopen(fd, "w") as stream:
        stream.write(data + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    sync_dir(path.parent)
    return True


class Journal:
    def __init__(self, root=None):
        self.root = Path(root or default_root()).expanduser().resolve()

    def operation(self, identity):
        if not isinstance(identity, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", identity):
            raise Refused("Use a stable short operation ID with letters, numbers, hyphens or underscores")
        return self.root / "operations" / identity

    def begin(self, identity, intent):
        op = self.operation(identity)
        directory(op.parent)
        try:
            op.mkdir()
            sync_dir(op.parent)
        except FileExistsError:
            old = read(op / "intent.json")
            comparable = lambda value: {k: v for k, v in value.items() if k != "issued_at"}
            if comparable(old) != comparable(intent):
                raise Refused("Conflicting operation ID reuse")
            raise Refused("Operation already exists; inspect/reconcile it, never repeat the external request blindly")
        write(op / "intent.json", intent)
        return op

    def reserve(self, resource, identity):
        path = self.root / "reservations" / digest(resource)
        directory(path.parent)
        try:
            path.mkdir()
            sync_dir(path.parent)
        except FileExistsError:
            owner = read(path / "owner.json")
            if owner == {"resource": resource, "operation": identity}:
                return
            raise Refused(f"Local resource is reserved by {owner.get('operation')}; inspect exact runtime recovery")
        write(path / "owner.json", {"resource": resource, "operation": identity})

    def release(self, resource, identity):
        path = self.root / "reservations" / digest(resource)
        if not path.exists():
            return
        if read(path / "owner.json") != {"resource": resource, "operation": identity}:
            raise Refused("Cannot release another operation's reservation")
        (path / "owner.json").unlink()
        sync_dir(path)
        path.rmdir()
        sync_dir(path.parent)

    def recover(self, identity, evidence):
        op = self.operation(identity)
        intent = read(op / "intent.json")
        if evidence.get("proof") not in {"never_started", "exited"} or not evidence.get("runtime_evidence"):
            raise Refused("Recovery requires exact never-started/exited proof, not elapsed time or missing inventory")
        launched = op / "launched.json"
        if launched.exists():
            receipt = read(launched)
            if evidence.get("proof") != "exited" or evidence.get("dispatch") != receipt["launch"]["dispatchId"]:
                raise Refused("Recovery must prove this exact dispatch exited")
        write(op / "recovery.json", evidence)
        for path in sorted((self.root / "reservations").glob("*/owner.json")):
            owner = read(path)
            if owner.get("operation") == identity:
                self.release(owner["resource"], identity)
        return {"recovered": identity, "intent_kind": intent["kind"], "evidence": str(op / "recovery.json")}

    def executions(self, source):
        rows = []
        for path in sorted((self.root / "operations").glob("*/intent.json")):
            intent = read(path)
            if intent["kind"] == "launch" and intent["plan"]["assignment"]["source"] == source:
                if (path.parent / "rejected.json").exists():
                    continue
                rows.append((path.parent, intent))
        return rows
