#!/usr/bin/env python3
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(root / "scripts"))
import web

if len(sys.argv) != 2:
    sys.exit("usage: build_ui.py <out-dir>")
out = Path(sys.argv[1]).resolve()
environment = web.environment_for(root, root / "target/t")
web.prepare_web(root, environment)
web.run([str(root / "web/node_modules/.bin/vite"), "build", "--outDir", str(out), "--emptyOutDir"], root / "web", environment)
if not (out / "index.html").is_file():
    sys.exit("build_ui: index.html missing")
print(f"build_ui: ok {out}")
