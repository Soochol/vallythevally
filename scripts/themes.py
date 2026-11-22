import argparse
import copy
from dataclasses import dataclass
import json
import re
import sys
import time
from urllib import error, parse, request
import uuid


DEFAULT_URL = "http://127.0.0.1:8080"
THEMES_PATH = "/api/heatmap/themes"
MAX_ATTEMPTS = 3
STOCK_CODE = re.compile(r"^[0-9A-Z]{6}$")
INDEX_PREFIX = "IDX:"
CANDIDATES_SHOWN = 8


class Refused(Exception):
    pass


class Unreachable(Exception):
    pass


class Stale(Exception):
    pass


@dataclass(frozen=True)
class Stock:
    code: str
    name: str

    def label(self):
        return f"{self.name}({self.code})" if self.name != self.code else self.code


class Server:
    def __init__(self, base_url):
        self.base_url = base_url.rstrip("/")

    def call(self, method, path, body=None):
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        headers = {"Content-Type": "application/json"} if body is not None else {}
        req = request.Request(self.base_url + path, data=data, method=method, headers=headers)
        try:
            with request.urlopen(req, timeout=30) as response:
                return response.status, json.loads(response.read() or b"null")
        except error.HTTPError as failure:
            with failure:
                raw = failure.read()
            try:
                return failure.code, json.loads(raw)
            except ValueError:
                return failure.code, {"error": {"code": "unknown", "message": raw.decode(errors="replace")}}
        except (error.URLError, OSError) as failure:
            raise Unreachable(f"서버 {self.base_url}에 닿지 못했습니다: {failure}") from failure

    def themes(self):
        status, body = self.call("GET", THEMES_PATH)
        if status != 200:
            raise Refused(f"테마를 읽지 못했습니다({status}): {message_of(body)}")
        return body

    def save(self, document):
        status, body = self.call("PUT", THEMES_PATH, document)
        if status == 409:
            raise Stale(message_of(body))
        if status != 200:
            raise Refused(f"서버가 거절했습니다({status}): {message_of(body)}")
        return body

    def symbol(self, code):
        status, body = self.call("GET", "/api/symbols/" + parse.quote(code))
        return body if status == 200 else None

    def search(self, query):
        status, body = self.call("GET", "/api/symbols?" + parse.urlencode({"q": query}))
        if status != 200:
            raise Refused(f"종목을 찾지 못했습니다({status}): {message_of(body)}")
        return body


def message_of(body):
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        return body["error"].get("message", "")
    return json.dumps(body, ensure_ascii=False)


def stock_label(stock_names, code):
    name = stock_names.get(code)
    return f"{name}({code})" if name else code


def theme_named(document, name):
    for theme in document["themes"]:
        if theme["name"] == name:
            return theme
    names = ", ".join(theme["name"] for theme in document["themes"]) or "없음"
    raise Refused(f"없는 테마입니다: {name}. 있는 테마: {names}")


def index_of(document, name):
    return document["themes"].index(theme_named(document, name))


def placed_index(document, before, after, first):
    if before is not None:
        return index_of(document, before)
    if after is not None:
        return index_of(document, after) + 1
    if first:
        return 0
    return len(document["themes"])


class Resolver:
    def __init__(self, server):
        self.server = server
        self.names = {}

    def known(self, code, name):
        self.names[code] = name
        return Stock(code, name)

    def by_code(self, code):
        info = self.server.symbol(code)
        if info is None:
            return None
        if info.get("kind") == "index":
            raise Refused(f"지수는 테마에 넣을 수 없습니다: {code}")
        return self.known(info["code"], info["name"])

    def by_name(self, query):
        found = self.server.search(query)
        if any(hit["name"] == query and hit.get("kind") == "index" for hit in found):
            raise Refused(f"지수는 테마에 넣을 수 없습니다: {query}")
        hits = [hit for hit in found if hit.get("kind") != "index"]
        exact = [hit for hit in hits if hit["name"] == query]
        if len(exact) == 1:
            return self.known(exact[0]["code"], exact[0]["name"])
        if not hits:
            raise Refused(f"맞는 종목이 없습니다: {query}")
        shown = ", ".join(f"{hit['name']}({hit['code']})" for hit in hits[:CANDIDATES_SHOWN])
        raise Refused(f"종목 하나로 정해지지 않습니다: {query}. 이름을 정확히 적거나 코드를 쓰세요. 후보: {shown}")

    def to_add(self, given):
        if given.startswith(INDEX_PREFIX):
            raise Refused(f"지수는 테마에 넣을 수 없습니다: {given}")
        if STOCK_CODE.match(given):
            stock = self.by_code(given)
            if stock is None:
                raise Refused(f"종목 목록에 없는 코드입니다: {given}")
            return stock
        return self.by_name(given)

    def to_remove(self, given, theme):
        if STOCK_CODE.match(given) and given in theme["symbols"]:
            return self.by_code(given) or self.known(given, given)
        return self.to_add(given)


def new_theme_id():
    return "t-" + uuid.uuid4().hex[:16]


def next_revision(stored):
    return max(stored + 1, int(time.time() * 1000))


def apply_create(document, args, _resolver):
    if any(theme["name"] == args.name for theme in document["themes"]):
        return [f"이미 있는 테마라 바꾸지 않았습니다: {args.name}"]
    at = placed_index(document, args.before, args.after, args.first)
    document["themes"].insert(at, {"id": new_theme_id(), "name": args.name, "symbols": []})
    return []


def apply_rename(document, args, _resolver):
    theme = theme_named(document, args.name)
    if args.new_name != args.name and any(other["name"] == args.new_name for other in document["themes"]):
        raise Refused(f"이미 있는 테마 이름입니다: {args.new_name}")
    theme["name"] = args.new_name
    return []


def apply_delete(document, args, _resolver):
    theme = theme_named(document, args.name)
    document["themes"].remove(theme)
    return []


def apply_move(document, args, _resolver):
    theme = theme_named(document, args.name)
    if args.name in (args.before, args.after):
        raise Refused("테마를 자기 자신 앞뒤로 옮길 수 없습니다")
    document["themes"].remove(theme)
    at = placed_index(document, args.before, args.after, args.first)
    document["themes"].insert(at, theme)
    return []


def apply_add(document, args, resolver):
    theme = theme_named(document, args.theme)
    notes = []
    for given in args.stocks:
        stock = resolver.to_add(given)
        if stock.code in theme["symbols"]:
            notes.append(f"이미 {theme['name']}에 있습니다: {stock.label()}")
        else:
            theme["symbols"].append(stock.code)
    return notes


def apply_remove(document, args, resolver):
    theme = theme_named(document, args.theme)
    notes = []
    for given in args.stocks:
        stock = resolver.to_remove(given, theme)
        if stock.code in theme["symbols"]:
            theme["symbols"].remove(stock.code)
        else:
            notes.append(f"{theme['name']}에 없습니다: {stock.label()}")
    return notes


def changes(before, after, names):
    lines = []
    old = {theme["id"]: theme for theme in before["themes"]}
    new = {theme["id"]: theme for theme in after["themes"]}
    for theme in after["themes"]:
        if theme["id"] not in old:
            lines.append(f"+ 테마 {theme['name']}")
    for theme in before["themes"]:
        if theme["id"] not in new:
            lines.append(f"- 테마 {theme['name']} (종목 {len(theme['symbols'])}개)")
    for theme in after["themes"]:
        previous = old.get(theme["id"])
        if previous is None:
            added, removed = theme["symbols"], []
        else:
            if previous["name"] != theme["name"]:
                lines.append(f"~ 테마 이름 {previous['name']} → {theme['name']}")
            added = [code for code in theme["symbols"] if code not in previous["symbols"]]
            removed = [code for code in previous["symbols"] if code not in theme["symbols"]]
        for code in added:
            lines.append(f"  {theme['name']}: + {stock_label(names, code)}")
        for code in removed:
            lines.append(f"  {theme['name']}: - {stock_label(names, code)}")
    kept_before = [theme["id"] for theme in before["themes"] if theme["id"] in new]
    kept_after = [theme["id"] for theme in after["themes"] if theme["id"] in old]
    if kept_before != kept_after:
        lines.append("~ 테마 순서: " + " · ".join(theme["name"] for theme in after["themes"]))
    return lines


def summary(document):
    return [f"{position}. {theme['name']} ({len(theme['symbols'])}종목)" for position, theme in enumerate(document["themes"], 1)]


def edit(server, apply, args, out):
    resolver = Resolver(server)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        before = server.themes()
        after = copy.deepcopy(before)
        notes = apply(after, args, resolver)
        lines = changes(before, after, resolver.names)
        if not lines:
            report(out, args, {"result": "unchanged", "notes": notes, "changes": [], "revision": before["revision"]}, notes + ["바뀐 것이 없어 보내지 않았습니다"])
            return 0
        if args.dry_run:
            report(out, args, {"result": "dry_run", "notes": notes, "changes": lines, "revision": before["revision"]}, notes + lines + ["--dry-run이라 보내지 않았습니다"])
            return 0
        after["revision"] = next_revision(before["revision"])
        try:
            saved = server.save(after)
        except Stale as stale:
            if attempt == MAX_ATTEMPTS:
                raise Refused(f"다른 편집과 {MAX_ATTEMPTS}번 겹쳐 저장하지 못했습니다: {stale}")
            continue
        report(out, args, {"result": "saved", "notes": notes, "changes": lines, "revision": saved["revision"]}, notes + lines + [f"저장했습니다(revision {saved['revision']})"])
        return 0
    raise AssertionError("시도 횟수 안에서 돌아온다")


def report(out, args, data, text):
    if args.json:
        print(json.dumps(data, ensure_ascii=False), file=out)
    else:
        for line in text:
            print(line, file=out)


def run_list(server, args, out):
    document = server.themes()
    if args.json:
        print(json.dumps(document, ensure_ascii=False), file=out)
    else:
        for line in summary(document) or ["테마가 없습니다"]:
            print(line, file=out)
    return 0


def run_show(server, args, out):
    theme = theme_named(server.themes(), args.name)
    resolver = Resolver(server)
    stocks = [resolver.by_code(code) or Stock(code, code) for code in theme["symbols"]]
    if args.json:
        print(json.dumps({"id": theme["id"], "name": theme["name"], "symbols": [{"code": s.code, "name": s.name} for s in stocks]}, ensure_ascii=False), file=out)
    else:
        print(f"{theme['name']} ({len(stocks)}종목)", file=out)
        for position, stock in enumerate(stocks, 1):
            print(f"{position}. {stock.label()}", file=out)
    return 0


def placement(parser):
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--before", metavar="테마")
    group.add_argument("--after", metavar="테마")
    group.add_argument("--first", action="store_true")
    return group


def parser():
    root = argparse.ArgumentParser(prog="themes.py", description="히트맵 테마를 바꾼다. 매 명령마다 최신 테마 문서를 읽어 그 명령만 적용한다.")
    root.add_argument("--url", default=DEFAULT_URL, help=f"앱 서버 주소(기본 {DEFAULT_URL})")
    root.add_argument("--json", action="store_true", help="결과를 JSON 한 줄로 낸다")
    commands = root.add_subparsers(dest="command", required=True)

    commands.add_parser("list", help="테마 목록")
    show = commands.add_parser("show", help="테마 하나의 종목")
    show.add_argument("name")

    create = commands.add_parser("create", help="빈 테마 만들기")
    create.add_argument("name")
    placement(create)
    rename = commands.add_parser("rename", help="테마 이름 바꾸기")
    rename.add_argument("name")
    rename.add_argument("new_name")
    move = commands.add_parser("move", help="테마 순서 바꾸기")
    move.add_argument("name")
    placement(move).add_argument("--last", action="store_true")
    delete = commands.add_parser("delete", help="테마 지우기")
    delete.add_argument("name")
    add = commands.add_parser("add", help="테마에 종목 넣기(이름이나 코드)")
    add.add_argument("theme")
    add.add_argument("stocks", nargs="+")
    remove = commands.add_parser("remove", help="테마에서 종목 빼기(이름이나 코드)")
    remove.add_argument("theme")
    remove.add_argument("stocks", nargs="+")

    for editing in (create, rename, move, delete, add, remove):
        editing.add_argument("--dry-run", action="store_true", help="바뀔 내용만 보이고 보내지 않는다")
    return root


EDITS = {"create": apply_create, "rename": apply_rename, "move": apply_move, "delete": apply_delete, "add": apply_add, "remove": apply_remove}


def main(argv=None, out=sys.stdout, err=sys.stderr):
    args = parser().parse_args(argv)
    server = Server(args.url)
    try:
        if args.command == "list":
            return run_list(server, args, out)
        if args.command == "show":
            return run_show(server, args, out)
        return edit(server, EDITS[args.command], args, out)
    except Refused as refused:
        print(f"themes: {refused}", file=err)
        return 1
    except Unreachable as unreachable:
        print(f"themes: {unreachable}", file=err)
        return 2


if __name__ == "__main__":
    sys.exit(main())
