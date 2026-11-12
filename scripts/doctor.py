import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile

import evidence


def diagnose(root, directory, headed=False):
    checks = {"python": {"status": "available" if sys.version_info >= (3, 11) else "unsupported", "version": sys.version.split()[0]}, "cua": {"status": "not_checked", "scope": "local Chromium only"}}
    for name in ("node", "pnpm"):
        executable = shutil.which(name)
        checks[name] = {"status": "available" if executable else "missing"}
        if executable:
            try:
                version = subprocess.check_output([executable, "--version"], text=True, stderr=subprocess.DEVNULL, env={**os.environ, "COREPACK_ENABLE_NETWORK": "0", "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0"}, timeout=5).strip()
                checks[name]["version"] = evidence.clean(version)
            except (OSError, subprocess.SubprocessError):
                checks[name]["status"] = "execution_failed"
    temporary = Path(os.environ.get("TMPDIR", root / "target/t")).resolve()
    try:
        temporary.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".org.chromium.Chromium.", dir=temporary) as name:
            with socket.socket(socket.AF_UNIX) as probe:
                probe.bind(str(Path(name) / "SingletonSocket"))
        checks["tmpdir"] = {"status": "passed", "path": str(temporary)}
    except OSError as error:
        checks["tmpdir"] = {"status": "unix_socket_path_too_long" if "too long" in str(error).lower() else "unusable", "path": str(temporary)}
    if checks["node"]["status"] == "available":
        try:
            try:
                evidence.bounded(["node", str(root / "scripts/chromium.mjs"), "doctor", str(root), str(directory), "", "yes" if headed else "no"], {**os.environ, "TMPDIR": str(temporary)}, 40)
            except subprocess.CalledProcessError:
                pass
            checks.update(json.loads((directory / "chromium.json").read_text())["checks"])
        except (OSError, ValueError, subprocess.SubprocessError):
            checks["chromium"] = {"status": "probe_failed"}
    else:
        checks["chromium"] = {"status": "not_run"}
    status = "passed" if all(value["status"] in ("passed", "available", "not_checked") for value in checks.values()) else "failed"
    return {"status": status, "checks": checks}


def run_doctor(root, headed, machine):
    with evidence.Run(root, "doctor", ["web.py", "doctor", *(["--headed"] if headed else [])]) as record:
        result = diagnose(root, record.directory, headed)
        record.data["diagnosis"] = result
        (record.directory / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
        if machine:
            print(json.dumps(result, ensure_ascii=False))
        else:
            print("doctor: " + ", ".join(f"{name}={value['status']}" for name, value in result["checks"].items()))
        if result["status"] != "passed":
            raise ValueError("환경 진단 실패: result.json의 단계별 상태를 확인하세요")
