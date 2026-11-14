import argparse
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib import error, parse, request
import uuid


NAMESPACE = uuid.UUID("26fd6b15-6383-54ef-bcec-31011d7842bb")
MAX_REVISION = 9_007_199_254_740_991


class ImportFailure(Exception):
    pass


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def document_hash(value):
    return digest(encoded(value))


def require(condition, message):
    if not condition:
        raise ImportFailure(message)


def unique_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, f"duplicate JSON key: {key}")
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ImportFailure("invalid JSON document") from exc


def symbol(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9A-Z]{6}", value), "invalid source symbol")
    return value


def named(value):
    require(isinstance(value, str) and value == value.strip() and 1 <= len(value) <= 20, "invalid group name")
    return value


def ordered(rows):
    require(isinstance(rows, list), "expected source rows")
    for row in rows:
        require(isinstance(row, dict) and type(row.get("order")) is int, "missing integer source order")
    return sorted(rows, key=lambda row: row["order"])


@dataclass(frozen=True)
class SourceSnapshot:
    watchlist: bytes
    heatmap: bytes

    @property
    def hashes(self):
        return {"watchlist": digest(self.watchlist), "heatmap": digest(self.heatmap)}


def read_source_snapshot(watchlist_path, heatmap_path):
    paths = [Path(watchlist_path), Path(heatmap_path)]
    for _ in range(3):
        first = [path.read_bytes() for path in paths]
        second = [path.read_bytes() for path in paths]
        if first == second:
            return SourceSnapshot(*first)
    raise ImportFailure("source changed during all three snapshot attempts")


def project(raw, namespace, name):
    source = unique_json(raw)
    require(isinstance(source, dict) and source.get("schema_version") == 4, "expected source schema_version 4")
    folders = ordered(source.get("folders"))
    entries = source.get("entries")
    require(isinstance(entries, list) and all(isinstance(entry, dict) for entry in entries), "invalid entries")
    require(len(folders) <= 100, "more than 100 source groups")
    folder_ids = set()
    names = set()
    groups = []
    exclusions = []
    for folder in folders:
        fid = folder.get("id")
        require(isinstance(fid, str) and fid and fid not in folder_ids, "duplicate or missing source folder id")
        folder_ids.add(fid)
        group_name = named(folder.get("name"))
        require(group_name not in names, "duplicate source group name")
        names.add(group_name)
        groups.append({"id": str(uuid.uuid5(NAMESPACE, f"{namespace}:folder:{fid}")), "name": group_name, "symbols": []})
    by_folder = dict(zip((folder["id"] for folder in folders), groups))
    metadata = set()
    if namespace == "watchlist":
        for entry in entries:
            code = symbol(entry.get("code"))
            require(code not in metadata, "duplicate watchlist metadata code")
            metadata.add(code)
        for folder in folders:
            items = folder.get("items")
            require(isinstance(items, list), "missing watchlist items")
            for index, item in enumerate(items):
                require(isinstance(item, dict), "invalid watchlist item")
                if item.get("kind") == "memo":
                    exclusions.append({"group": folder["name"], "index": index, "kind": "memo"})
                    continue
                require(item.get("kind") == "code", "unknown watchlist item kind")
                code = symbol(item.get("code"))
                require(code in metadata, "watchlist membership has no metadata")
                members = by_folder[folder["id"]]["symbols"]
                require(code not in members, "duplicate source membership")
                members.append(code)
    else:
        for folder in folders:
            require(folder.get("items") == [], "heatmap folder items conflict with entry memberships")
        for entry in ordered(entries):
            fid = entry.get("folder_id")
            require(isinstance(fid, str) and fid in by_folder, "missing referenced heatmap folder")
            code = symbol(entry.get("code"))
            members = by_folder[fid]["symbols"]
            require(code not in members, "duplicate source membership")
            members.append(code)
    symbols = list(dict.fromkeys(code for group in groups for code in group["symbols"]))
    require(not metadata.difference(symbols), "watchlist metadata has no authoritative folder membership")
    return {"id": str(uuid.uuid5(NAMESPACE, f"{namespace}:list")), "name": name, "symbols": symbols, "groups": groups}, exclusions


def build_plan(snapshot):
    watchlist, exclusions = project(snapshot.watchlist, "watchlist", "관심종목")
    heatmap, _ = project(snapshot.heatmap, "heatmap", "히트맵")
    lists = [watchlist, heatmap]
    counts = [{"name": item["name"], "groups": len(item["groups"]), "symbols": len(item["symbols"]), "memberships": sum(len(group["symbols"]) for group in item["groups"])} for item in lists]
    return {"lists": lists, "counts": counts, "exclusions": exclusions, "source_hashes": snapshot.hashes}


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ImportFailure("API redirect refused")


class Api:
    def __init__(self, base):
        url = parse.urlsplit(base)
        require(url.scheme in ("http", "https") and url.hostname and not url.username and not url.password and not url.query and not url.fragment, "invalid API base URL")
        self.endpoint = base.rstrip("/") + "/api/watchlists"
        self.opener = request.build_opener(request.ProxyHandler({}), NoRedirect())

    def get(self):
        with self.opener.open(self.endpoint, timeout=15) as response:
            value = unique_json(response.read())
            version = response.headers.get("X-Vally-Watchlists-Version")
        require(isinstance(value, dict) and isinstance(value.get("lists"), list) and value["lists"], "invalid target lists")
        require(type(value.get("revision")) is int and 0 <= value["revision"] < MAX_REVISION, "invalid target revision")
        return value, version

    def put(self, value):
        req = request.Request(self.endpoint, data=encoded(value), method="PUT", headers={"Content-Type": "application/json"})
        with self.opener.open(req, timeout=15) as response:
            response.read()


def durable_json(path, value):
    durable_bytes(path, encoded(value) + b"\n")


def durable_bytes(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def prepare_output(output):
    output = Path(output)
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    return output


def write_once(api, original, desired, output, source_hashes):
    incoming = {"lists": desired, "revision": original["revision"] + 1}
    journal = {"original": original, "desired": incoming, "source_hashes": source_hashes, "original_hash": document_hash(original), "desired_hash": document_hash(incoming)}
    durable_json(output / "backup.json", original)
    durable_json(output / "journal.json", journal)
    failure = None
    rejected = False
    try:
        api.put(incoming)
    except error.HTTPError as exc:
        failure = type(exc).__name__
        rejected = True
        exc.close()
    except (OSError, error.URLError, ImportFailure) as exc:
        failure = type(exc).__name__
    else:
        durable_json(output / "ack.json", {"revision": incoming["revision"], "document_hash": journal["desired_hash"]})
    try:
        current, _ = api.get()
    except (OSError, error.URLError, ImportFailure) as exc:
        durable_json(output / "receipt.json", {"status": "ambiguous", "error": type(exc).__name__})
        raise ImportFailure("PUT outcome unknown; journal retained, rerun dry-run before recovery") from exc
    if current["lists"] == desired:
        owned = failure is None and current["revision"] == incoming["revision"]
        status = "applied" if owned else "satisfied-concurrent"
        if failure is not None and not rejected and current["revision"] == incoming["revision"]:
            status = "satisfied-unowned"
        receipt = {"status": status, "observed_revision": current["revision"], "document_hash": document_hash(current), "reconciled": failure is not None}
        if owned:
            receipt["revision"] = incoming["revision"]
        durable_json(output / "receipt.json", receipt)
        return receipt
    status = "unchanged" if current == original else "ambiguous"
    durable_json(output / "receipt.json", {"status": status, "put_error": failure})
    raise ImportFailure(f"PUT not verified ({status}); target left untouched after reconciliation")


def apply_plan(plan, snapshot, api, output, apply=False):
    current, version = api.get()
    unchanged = current["lists"] == plan["lists"]
    output = prepare_output(output)
    durable_bytes(output / "watchlist-source.json", snapshot.watchlist)
    durable_bytes(output / "heatmap-source.json", snapshot.heatmap)
    durable_json(output / "plan.json", plan)
    durable_json(output / "target.json", current)
    summary = {"status": "unchanged" if unchanged else "dry-run", "counts": plan["counts"], "exclusions": plan["exclusions"], "source_hashes": plan["source_hashes"], "target_revision": current["revision"], "target_hash": document_hash(current), "desired_lists_hash": document_hash(plan["lists"]), "target_counts": [{"name": item["name"], "groups": len(item.get("groups", [])), "symbols": len(item["symbols"])} for item in current["lists"]], "capability": version}
    if apply and not unchanged:
        require(version == "2", "apply requires X-Vally-Watchlists-Version: 2; run matching server/UI and retire old writers first")
        summary.update(write_once(api, current, plan["lists"], output, plan["source_hashes"]))
    durable_json(output / "report.json", summary)
    return summary


def restore_backup(backup_path, api, output):
    backup_path = Path(backup_path)
    original = unique_json(backup_path.read_bytes())
    journal = unique_json(backup_path.with_name("journal.json").read_bytes())
    require(journal["original"] == original and document_hash(original) == journal["original_hash"] and document_hash(journal["desired"]) == journal["desired_hash"], "backup/journal mismatch")
    current, version = api.get()
    require(version == "2", "restore requires X-Vally-Watchlists-Version: 2")
    if current["lists"] == original["lists"]:
        return {"status": "already-restored"}
    expected_revision = journal["desired"]["revision"]
    require(current["lists"] == journal["desired"]["lists"] and current["revision"] == expected_revision, "restore refused: target changed after import")
    ack_path = backup_path.with_name("ack.json")
    require(ack_path.exists(), "restore refused: successful PUT acknowledgment missing; journal alone does not establish ownership")
    acknowledgment = unique_json(ack_path.read_bytes())
    require(expected_revision == original["revision"] + 1 and acknowledgment == {"revision": expected_revision, "document_hash": journal["desired_hash"]}, "restore refused: PUT acknowledgment does not match journal")
    output = prepare_output(output)
    return write_once(api, current, original["lists"], output, journal["source_hashes"])


def main():
    parser = argparse.ArgumentParser(description="Import hoga schema 4 groups through the atomic watchlists API. Defaults to dry-run.")
    parser.add_argument("--watchlist", type=Path)
    parser.add_argument("--heatmap", type=Path)
    parser.add_argument("--url", default="http://127.0.0.1:8080")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--restore", type=Path)
    parser.add_argument("--output", type=Path, required=True, help="new private artifact directory")
    args = parser.parse_args()
    try:
        api = Api(args.url)
        if args.restore:
            require(not args.watchlist and not args.heatmap, "restore does not take source paths")
            report = restore_backup(args.restore, api, args.output)
        else:
            require(args.watchlist and args.heatmap, "both source paths are required")
            snapshot = read_source_snapshot(args.watchlist, args.heatmap)
            report = apply_plan(build_plan(snapshot), snapshot, api, args.output, args.apply)
        print(json.dumps(report, ensure_ascii=False))
        return 0
    except (ImportFailure, OSError, error.URLError, ValueError, KeyError, TypeError) as exc:
        print(f"hoga-import: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
