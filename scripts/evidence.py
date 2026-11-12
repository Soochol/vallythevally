import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time


ACTIVE = None
SECRETS = set()


class Interrupted(SystemExit):
    def __init__(self, number):
        self.signal = number
        super().__init__(128 + number)


def failure(error):
    number = error.signal if isinstance(error, Interrupted) else (signal.SIGINT if isinstance(error, KeyboardInterrupt) else None)
    return {"failure": type(error).__name__, "exit_code": 128 + number if number else getattr(error, "returncode", 1), "termination_reason": "signal" if number else ("timeout" if isinstance(error, TimeoutError | subprocess.TimeoutExpired) else "exception"), **({"signal": signal.Signals(number).name} if number else {})}


@contextlib.contextmanager
def interrupts():
    if threading.current_thread() is not threading.main_thread():
        yield
        return
    previous = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGINT)}
    if all(getattr(handler, "vally_interrupt", False) for handler in previous.values()):
        yield
        return
    def stop(number, frame):
        for owned in previous:
            signal.signal(owned, signal.SIG_IGN)
        raise Interrupted(number)
    stop.vally_interrupt = True
    try:
        for number in previous:
            signal.signal(number, stop)
        yield
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


@contextlib.contextmanager
def defer_interrupts():
    if threading.current_thread() is not threading.main_thread():
        yield
        return
    previous = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGINT)}
    pending = []
    def queue(number, frame):
        pending.append((number, frame))
    try:
        for number in previous:
            signal.signal(number, queue)
        yield
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
        if pending:
            number, frame = pending[0]
            handler = previous[number]
            if callable(handler):
                handler(number, frame)
            elif handler == signal.SIG_DFL:
                signal.raise_signal(number)


def stop_process(process):
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)


def spawn(arguments, **options):
    with defer_interrupts():
        process = subprocess.Popen(arguments, start_new_session=True, **options)
        if ACTIVE:
            ACTIVE.children.append(process)
    return process


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
        self.result = None
        self.children = []
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
        self.signals = interrupts()
        self.signals.__enter__()
        try:
            self.save()
        except BaseException:
            ACTIVE = self.previous
            self.signals.__exit__(*sys.exc_info())
            raise
        return self

    def __exit__(self, kind, error, traceback):
        global ACTIVE
        mismatch = None
        try:
            for process in reversed(self.children):
                stop_process(process)
            if error is None:
                try:
                    self.verify()
                except (OSError, ValueError) as changed:
                    mismatch = error = changed
            self.data.update(status="failed" if error else "passed", exit_code=0, elapsed_seconds=round(time.monotonic() - self.started, 3), source_after=source(self.root))
            if error:
                self.data.update(failure(error))
                if not isinstance(error, Interrupted | KeyboardInterrupt):
                    self.data["exit_code"] = 1
            if error and self.result is not None:
                self.result.update(status="not_configured" if self.result["status"] == "not_configured" else "failed", **failure(error))
                (self.directory / "result.json").write_text(clean(json.dumps(self.result, ensure_ascii=False, indent=2)) + "\n")
                self.data["results"]["source_status"] = self.result["status"]
            self.save()
            print(json.dumps({"status": self.data["status"], "manifest": str(self.directory / "manifest.json"), "exit_code": self.data["exit_code"]}), flush=True)
        finally:
            ACTIVE = self.previous
            self.signals.__exit__(kind, error, traceback)
        if mismatch:
            raise mismatch

    def verify(self):
        if source(self.root) != self.data["source"]:
            raise ValueError("준비 시작 이후 source가 바뀌었습니다. 이 실행을 다시 준비하세요")
        for name, artifact in self.data["artifacts"].items():
            path = Path(artifact["path"])
            actual = hashes(path) if path.is_dir() else ({path.name: file_hash(path)} if path.is_file() else {})
            if not actual or actual != artifact["sha256"]:
                raise ValueError(f"기록한 {name} 산출물과 실제 파일이 다릅니다. 이 실행을 다시 준비하세요")

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
            self.verify()
            yield entry
            self.verify()
        except BaseException as error:
            entry.update(status="failed", **failure(error))
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
    process = None
    try:
        with log.open("w") as stream:
            process = spawn(arguments, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            try:
                for line in process.stdout:
                    line = clean(line)
                    stream.write(line)
                    print(line, end="", flush=True)
                code = process.wait()
            except BaseException:
                stop_process(process)
                raise
            finally:
                process.stdout.close()
        entry["exit_code"] = code
        if code:
            raise subprocess.CalledProcessError(code, entry["command"])
        entry["status"] = "passed"
    except BaseException as error:
        entry.update(status="failed", **failure(error))
        raise
    finally:
        entry["elapsed_seconds"] = round(time.monotonic() - start, 3)
        entry["process_exit_code"] = process.returncode if process else None
        record.save()


def bounded(arguments, environment, timeout):
    record = ACTIVE
    entry = {"command": [clean(str(arg)) for arg in arguments], "execution": "direct", "status": "running"}
    if record:
        record.data.setdefault("bounded_commands", []).append(entry)
        record.save()
    started = time.monotonic()
    process = None
    with interrupts() if record is None else contextlib.nullcontext():
        try:
            with defer_interrupts():
                process = spawn(arguments, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            entry["pid"] = process.pid
            if record:
                record.save()
            code = process.wait(timeout=timeout)
            if code:
                raise subprocess.CalledProcessError(code, arguments)
            entry.update(status="passed", exit_code=0)
        except BaseException as error:
            if process is not None:
                stop_process(process)
            entry.update(status="failed", **failure(error))
            raise
        finally:
            entry.update(process_exit_code=process.returncode if process else None, elapsed_seconds=round(time.monotonic() - started, 3))
            if record:
                record.save()
