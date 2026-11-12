import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time


ACTIVE = None
SECRETS = set()


def clean(text):
    for value in SECRETS:
        text = text.replace(value, "[redacted]")
    for name, value in os.environ.items():
        if value and any(word in name.upper() for word in ("KEY", "TOKEN", "SECRET", "PASSWORD")):
            text = text.replace(value, "[redacted]")
    text = re.sub(r"(?i)authorization\s*[:=][^\r\n]*", "Authorization: [redacted]", text)
    text = re.sub(r"(?i)((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+", r"\1[redacted]", text)
    return re.sub(r"(?:https?|wss?)://[^\s\"'<>]+", "[url]", text)


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def hashes(directory):
    return {str(path.relative_to(directory)): file_hash(path) for path in sorted(directory.rglob("*")) if path.is_file()}


def source(root):
    def git(*args):
        return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.DEVNULL)
    try:
        head = git("rev-parse", "HEAD").decode().strip()
        names = git("ls-files", "-z", "--cached", "--others", "--exclude-standard").decode().split("\0")
        inputs = hashlib.sha256()
        for name in sorted(set(names) - {""}):
            if any(part.startswith(".env") for part in Path(name).parts):
                continue
            path = root / name
            inputs.update(name.encode() + b"\0")
            inputs.update(hashlib.sha256(path.read_bytes()).digest() if path.is_file() else b"deleted")
        return {"head": head, "dirty": bool(git("status", "--porcelain")), "sha256": inputs.hexdigest()}
    except (OSError, subprocess.CalledProcessError):
        return {"head": None, "dirty": None, "sha256": None}


class Run:
    def __init__(self, root, kind, command, directory=None):
        self.root = root
        parent = root / "target" / ("dev-runs" if kind.startswith("dev-") else "web-runs")
        parent.mkdir(parents=True, exist_ok=True)
        self.directory = Path(directory or tempfile.mkdtemp(prefix=f"{kind}-", dir=parent)).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.started = time.monotonic()
        self.data = {"format": 1, "kind": kind, "command": [clean(str(arg)) for arg in command], "source": source(root), "started_at": time.time(), "status": "running", "exit_code": None, "steps": {}, "artifacts": {}, "results": {"directory": str(self.directory)}}

    def save(self):
        path = self.directory / "manifest.json"
        staged = path.with_suffix(".tmp")
        staged.write_text(json.dumps(self.data, ensure_ascii=False, indent=2) + "\n")
        staged.replace(path)

    def __enter__(self):
        global ACTIVE
        self.previous = ACTIVE
        ACTIVE = self
        self.save()
        return self

    def __exit__(self, kind, error, traceback):
        global ACTIVE
        self.data.update(status="failed" if error else "passed", exit_code=(130 if isinstance(error, KeyboardInterrupt) else 1) if error else 0, elapsed_seconds=round(time.monotonic() - self.started, 3), source_after=source(self.root))
        if error:
            self.data["failure"] = type(error).__name__
        self.save()
        ACTIVE = self.previous
        print(json.dumps({"status": self.data["status"], "manifest": str(self.directory / "manifest.json"), "exit_code": self.data["exit_code"]}), flush=True)

    def plan(self, *names):
        self.data["steps"].update({name: {"status": "not_run"} for name in names})
        self.save()

    @contextlib.contextmanager
    def step(self, name):
        entry = {"status": "running", "execution": "direct"}
        self.data["steps"][name] = entry
        self.save()
        start = time.monotonic()
        try:
            yield entry
        except BaseException as error:
            entry.update(status="failed", exit_code=getattr(error, "returncode", 1), failure=type(error).__name__)
            raise
        else:
            entry.update(status="passed", exit_code=0)
        finally:
            entry["elapsed_seconds"] = round(time.monotonic() - start, 3)
            self.save()

    def artifact(self, name, path, execution, key=None):
        path = Path(path)
        outputs = hashes(path) if path.is_dir() else ({path.name: hashlib.sha256(path.read_bytes()).hexdigest()} if path.is_file() else {})
        self.data["artifacts"][name] = {"path": str(path), "execution": execution, "key": key, "sha256": outputs}
        self.save()


def artifact(name, path, execution, key=None):
    if ACTIVE:
        ACTIVE.artifact(name, path, execution, key)


def command(arguments, cwd, env):
    if not ACTIVE:
        return subprocess.run(arguments, cwd=cwd, env=env, check=True)
    record = ACTIVE
    number = len(record.data.setdefault("commands", []))
    log = record.directory / f"command-{number}.log"
    entry = {"command": [clean(str(arg)) for arg in arguments], "cwd": str(cwd), "log": str(log), "execution": "direct", "status": "running"}
    record.data["commands"].append(entry)
    record.save()
    start = time.monotonic()
    try:
        with log.open("w") as stream:
            process = subprocess.Popen(arguments, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
            try:
                for line in process.stdout:
                    line = clean(line)
                    stream.write(line)
                    print(line, end="", flush=True)
                code = process.wait()
            except BaseException:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                raise
            finally:
                process.stdout.close()
        entry["exit_code"] = code
        if code:
            raise subprocess.CalledProcessError(code, entry["command"])
        entry["status"] = "passed"
    except BaseException as error:
        entry.update(status="failed", exit_code=getattr(error, "returncode", 1), failure=type(error).__name__)
        raise
    finally:
        entry["elapsed_seconds"] = round(time.monotonic() - start, 3)
        record.save()


def bounded(arguments, environment, timeout):
    process = subprocess.Popen(arguments, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        code = process.wait(timeout=timeout)
        if code:
            raise subprocess.CalledProcessError(code, arguments)
    except BaseException:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        raise
