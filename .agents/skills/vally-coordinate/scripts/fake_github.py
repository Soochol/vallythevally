#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys
from urllib.parse import unquote, urlsplit, parse_qs


path = Path(os.environ["FAKE_GH_DATA"])
data = json.loads(path.read_text())
args = sys.argv[1:]
endpoint = args[1]
method = args[args.index("--method") + 1] if "--method" in args else "GET"
payload = json.load(sys.stdin) if "--input" in args else None
with Path(os.environ["FAKE_GH_CALLS"]).open("a") as stream:
    stream.write(json.dumps({"endpoint": endpoint, "method": method, "payload": payload}) + "\n")
parts = urlsplit(endpoint)
route = unquote(parts.path)
prefix = "repos/Soochol/vallythevally/"
route = route.removeprefix(prefix)
bits = route.split("/")
if endpoint == "user":
    result = {"id": data.get("account", 150162001)}
elif bits[0] == "pulls":
    result = data["prs"][bits[1]]
elif bits[:2] == ["issues", "comments"]:
    result = next(c for rows in data["comments"].values() for c in rows if c["id"] == int(bits[2]))
else:
    number = bits[1]
    issue = data["issues"][number]
    if len(bits) == 2:
        if method == "PATCH":
            issue.update(payload)
        if method == "GET":
            data["issue_reads"] = data.get("issue_reads", 0) + 1
            if data.get("change_on_read") == data["issue_reads"]:
                issue["body"] = issue["body"].replace('"goal":', '"goal": "Changed source", "previous_goal":')
        result = issue
    elif bits[2] == "parent":
        result = data["issues"][str(data["parents"][number])]
    elif bits[2] == "sub_issues":
        result = [data["issues"][str(n)] for n in data["children"].get(number, [])]
    elif bits[2] == "dependencies":
        result = [data["issues"][str(n)] for n in data["blockers"].get(number, [])]
    elif bits[2] == "comments":
        rows = data["comments"].setdefault(number, [])
        if method == "POST":
            result = {"id": data.get("next_id", 100), "body": payload["body"], "user": {"id": data.get("account", 150162001)}, "html_url": "https://example.invalid/fixture-comment"}
            data["next_id"] = result["id"] + 1
            rows.append(result)
        else:
            result = rows
    elif bits[2] == "labels":
        if method == "POST":
            names = {label["name"] for label in issue["labels"]} | set(payload["labels"])
            issue["labels"] = [{"name": name} for name in sorted(names)]
        if method == "DELETE":
            if data.get("fail_delete"):
                path.write_text(json.dumps(data))
                sys.exit(7)
            issue["labels"] = [label for label in issue["labels"] if label["name"] != bits[3]]
        result = issue["labels"]
    else:
        sys.exit(9)
if isinstance(result, list) and method == "GET":
    query = parse_qs(parts.query)
    page = int(query.get("page", [1])[0])
    result = result[(page - 1) * 100:page * 100]
path.write_text(json.dumps(data))
if data.get("lose_comment_response") and method == "POST" and route.endswith("/comments"):
    sys.exit(7)
if data.get("lose_close_response") and method == "PATCH":
    sys.exit(7)
if data.get("malformed_response"):
    print("invalid json")
else:
    print(json.dumps(result))
