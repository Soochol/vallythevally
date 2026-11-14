import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import threading
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("hoga_import", Path(__file__).with_name("import-hoga-watchlists.py"))
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


def snapshot():
    watch = {"schema_version": 4, "folders": [
        {"id": "same", "name": "첫째", "order": 1, "items": [{"kind": "code", "code": "0158S0"}, {"kind": "memo", "id": "memo"}, {"kind": "code", "code": "005930"}]},
        {"id": "second", "name": "둘째", "order": 1, "items": [{"kind": "code", "code": "0158S0"}]},
        {"id": "empty", "name": "빈 그룹", "order": 0, "items": []},
    ], "entries": [{"code": "005930"}, {"code": "0158S0"}]}
    heat = {"schema_version": 4, "folders": [{"id": "same", "name": "히트", "order": 0, "items": []}, {"id": "second", "name": "관찰", "order": 1, "items": []}], "entries": [
        {"folder_id": "same", "code": "005930", "order": 1}, {"folder_id": "second", "code": "0158S0", "order": 0}, {"folder_id": "same", "code": "0158S0", "order": 0},
    ]}
    return importer.SourceSnapshot(importer.encoded(watch), importer.encoded(heat))


class FakeApi:
    def __init__(self):
        self.current = {"lists": [{"id": "old", "name": "기존", "symbols": ["000660"], "groups": []}], "revision": 41}
        self.version = "2"
        self.puts = []
        self.before_put = None
        self.failure = None

    def get(self):
        return copy.deepcopy(self.current), self.version

    def put(self, value):
        self.puts.append(copy.deepcopy(value))
        if self.before_put:
            self.before_put()
        if self.failure == "before":
            raise OSError("network")
        if value["revision"] <= self.current["revision"]:
            raise OSError("conflict")
        self.current = copy.deepcopy(value)
        if self.failure == "after":
            raise OSError("lost response")


class ImportTests(unittest.TestCase):
    def setUp(self):
        target = Path(__file__).resolve().parents[1] / "target"
        target.mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=target)
        self.root = Path(self.tmp.name)
        self.source = snapshot()
        self.plan = importer.build_plan(self.source)
        self.api = FakeApi()

    def tearDown(self):
        self.tmp.cleanup()

    def apply(self, name="apply", apply=True):
        return importer.apply_plan(self.plan, self.source, self.api, self.root / name, apply)

    def test_projection_preserves_order_overlap_empty_folders_and_namespace(self):
        watch, heat = self.plan["lists"]
        self.assertEqual([g["name"] for g in watch["groups"]], ["빈 그룹", "첫째", "둘째"])
        self.assertEqual([g["symbols"] for g in watch["groups"]], [[], ["0158S0", "005930"], ["0158S0"]])
        self.assertEqual(watch["symbols"], ["0158S0", "005930"])
        self.assertEqual(heat["groups"][0]["symbols"], ["0158S0", "005930"])
        self.assertNotEqual(watch["groups"][1]["id"], heat["groups"][0]["id"])
        self.assertEqual(len(self.plan["exclusions"]), 1)
        self.assertEqual(importer.build_plan(self.source), self.plan)

    def test_dry_run_captures_exact_sources_and_never_puts(self):
        before = copy.deepcopy(self.api.current)
        result = self.apply(apply=False)
        self.assertEqual(result["status"], "dry-run")
        self.assertEqual(self.api.puts, [])
        self.assertEqual(self.api.current, before)
        self.assertEqual((self.root / "apply/watchlist-source.json").read_bytes(), self.source.watchlist)
        self.assertEqual((self.root / "apply/heatmap-source.json").read_bytes(), self.source.heatmap)
        self.assertEqual(os.stat(self.root / "apply/plan.json").st_mode & 0o777, 0o600)
        self.assertFalse((self.root / "apply/backup.json").exists())

    def test_apply_fsyncs_original_and_desired_before_single_revision_plus_one_put(self):
        before = copy.deepcopy(self.api.current)
        def inspect():
            journal = json.loads((self.root / "apply/journal.json").read_bytes())
            self.assertEqual(journal["original"], before)
            self.assertEqual(journal["desired"], self.api.puts[0])
            self.assertEqual(journal["source_hashes"], self.source.hashes)
            self.assertEqual(json.loads((self.root / "apply/backup.json").read_bytes()), before)
        self.api.before_put = inspect
        self.assertEqual(self.apply()["status"], "applied")
        self.assertEqual(len(self.api.puts), 1)
        self.assertEqual(self.api.current["revision"], 42)
        self.api.before_put = None
        self.assertEqual(self.apply("rerun")["status"], "unchanged")
        self.assertEqual(len(self.api.puts), 1)

    def test_old_server_refuses_apply_but_allows_read_only_plan(self):
        self.api.version = None
        self.assertEqual(self.apply(apply=False)["status"], "dry-run")
        with self.assertRaisesRegex(importer.ImportFailure, "Version: 2"):
            self.apply("old")
        self.assertEqual(self.api.puts, [])

    def test_lost_response_reconciles_without_second_put_and_can_restore(self):
        before = copy.deepcopy(self.api.current)
        self.api.failure = "after"
        self.assertTrue(self.apply()["reconciled"])
        self.assertEqual(len(self.api.puts), 1)
        self.api.failure = None
        restored = importer.restore_backup(self.root / "apply/backup.json", self.api, self.root / "restore")
        self.assertEqual(restored["status"], "applied")
        self.assertEqual(self.api.current, {**before, "revision": 43})
        self.assertEqual(importer.restore_backup(self.root / "apply/backup.json", self.api, self.root / "again")["status"], "already-restored")
        self.assertEqual(len(self.api.puts), 2)

    def test_concurrent_identical_document_cannot_be_claimed_for_restore(self):
        def concurrent_save():
            self.api.current = {"lists": copy.deepcopy(self.plan["lists"]), "revision": 43}
        self.api.before_put = concurrent_save
        self.assertEqual(self.apply()["status"], "satisfied-concurrent")
        with self.assertRaisesRegex(importer.ImportFailure, "target changed"):
            importer.restore_backup(self.root / "apply/backup.json", self.api, self.root / "restore")
        self.assertEqual(len(self.api.puts), 1)

    def test_failed_verification_leaves_journal_for_conditional_recovery(self):
        real_get = self.api.get
        def failed_verification():
            if self.api.puts:
                raise OSError("GET unavailable")
            return real_get()
        self.api.get = failed_verification
        with self.assertRaisesRegex(importer.ImportFailure, "outcome unknown"):
            self.apply()
        self.assertEqual(json.loads((self.root / "apply/receipt.json").read_bytes())["status"], "ambiguous")
        self.api.get = real_get
        importer.restore_backup(self.root / "apply/backup.json", self.api, self.root / "restore")
        self.assertEqual(self.api.current["lists"][0]["id"], "old")

    def test_same_content_user_save_after_import_blocks_restore(self):
        self.apply()
        self.api.current["revision"] += 1
        with self.assertRaisesRegex(importer.ImportFailure, "target changed"):
            importer.restore_backup(self.root / "apply/backup.json", self.api, self.root / "restore")
        self.assertEqual(len(self.api.puts), 1)

    def test_failure_before_commit_keeps_original(self):
        self.api.failure = "before"
        original = copy.deepcopy(self.api.current)
        with self.assertRaisesRegex(importer.ImportFailure, "unchanged"):
            self.apply()
        self.assertEqual(self.api.current, original)
        self.assertEqual(json.loads((self.root / "apply/receipt.json").read_bytes())["status"], "unchanged")

    def test_conflict_never_rebases_or_restores_over_an_edit(self):
        def concurrent_edit():
            self.api.current["revision"] = 42
            self.api.current["lists"][0]["name"] = "외부 편집"
        self.api.before_put = concurrent_edit
        with self.assertRaisesRegex(importer.ImportFailure, "ambiguous"):
            self.apply()
        self.assertEqual(len(self.api.puts), 1)
        with self.assertRaisesRegex(importer.ImportFailure, "target changed"):
            importer.restore_backup(self.root / "apply/backup.json", self.api, self.root / "restore")

    def test_restore_blocks_content_and_revision_changes(self):
        self.apply()
        imported = copy.deepcopy(self.api.current)
        for mutated in [{**imported, "revision": 43}, {**imported, "lists": [{**imported["lists"][0], "name": "편집"}, imported["lists"][1]]}]:
            self.api.current = mutated
            with self.assertRaisesRegex(importer.ImportFailure, "target changed"):
                importer.restore_backup(self.root / "apply/backup.json", self.api, self.root / "restore")
        self.assertEqual(len(self.api.puts), 1)

    def test_journal_recovers_committed_write_without_receipt(self):
        self.apply()
        (self.root / "apply/receipt.json").unlink()
        importer.restore_backup(self.root / "apply/backup.json", self.api, self.root / "restore")
        self.assertEqual(self.api.current["lists"][0]["id"], "old")

    def test_backup_failure_never_writes_target(self):
        with patch.object(importer.os, "fsync", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.apply()
        self.assertEqual(self.api.puts, [])

    def test_bad_sources_are_rejected_without_silent_losses(self):
        watch = json.loads(self.source.watchlist)
        heat = json.loads(self.source.heatmap)
        variants = []
        for change in [lambda d: d.update(schema_version=5), lambda d: d["folders"].append(d["folders"][0]), lambda d: d["folders"][1].update(name="첫째"), lambda d: d["folders"][0]["items"].append({"kind": "code", "code": "0158S0"}), lambda d: d["entries"].append({"code": "999999"}), lambda d: d["folders"][0]["items"].append({"kind": "code", "code": "bad"})]:
            value = copy.deepcopy(watch)
            change(value)
            variants.append(importer.SourceSnapshot(importer.encoded(value), self.source.heatmap))
        heat["entries"][0]["folder_id"] = "missing"
        variants.append(importer.SourceSnapshot(self.source.watchlist, importer.encoded(heat)))
        for source in variants:
            with self.assertRaises(importer.ImportFailure):
                importer.build_plan(source)

    def test_invalid_and_duplicate_json_are_rejected(self):
        for raw in [b"{", b'{"schema_version":4,"schema_version":4}', b"\xff"]:
            with self.assertRaises(importer.ImportFailure):
                importer.unique_json(raw)

    def test_double_read_retries_and_refuses_persistent_drift(self):
        with patch.object(Path, "read_bytes", side_effect=[b"a", b"b", b"changed", b"b", b"a", b"b", b"a", b"b"]):
            result = importer.read_source_snapshot("watch", "heat")
            self.assertEqual(result, importer.SourceSnapshot(b"a", b"b"))
        with patch.object(Path, "read_bytes", side_effect=[b"a", b"b", b"c", b"d"] * 3):
            with self.assertRaisesRegex(importer.ImportFailure, "three"):
                importer.read_source_snapshot("watch", "heat")

    def test_real_loopback_http_uses_one_atomic_put(self):
        api = self.api
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header("X-Vally-Watchlists-Version", "2")
                self.end_headers()
                self.wfile.write(importer.encoded(api.current))

            def do_PUT(self):
                api.put(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(importer.encoded(api.current))
        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                endpoint = importer.Api(f"http://127.0.0.1:{server.server_port}")
                watch_path, heat_path = self.root / "watchlist.json", self.root / "heatmap.json"
                watch_path.write_bytes(self.source.watchlist)
                heat_path.write_bytes(self.source.heatmap)
                before = copy.deepcopy(api.current)
                for name, flags in [("default", []), ("explicit", ["--dry-run"])]:
                    result = subprocess.run([sys.executable, str(Path(importer.__file__).resolve()), "--watchlist", str(watch_path), "--heatmap", str(heat_path), "--url", f"http://127.0.0.1:{server.server_port}", "--output", str(self.root / name), *flags], capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout)["status"], "dry-run")
                    self.assertEqual(watch_path.read_bytes(), self.source.watchlist)
                    self.assertEqual(heat_path.read_bytes(), self.source.heatmap)
                    self.assertEqual(api.current, before)
                    self.assertEqual(api.puts, [])
                importer.apply_plan(self.plan, self.source, endpoint, self.root / "http", True)
                self.assertEqual(len(api.puts), 1)
                self.assertEqual(endpoint.get()[0]["lists"], self.plan["lists"])
            finally:
                server.shutdown()
                thread.join()


if __name__ == "__main__":
    unittest.main()
