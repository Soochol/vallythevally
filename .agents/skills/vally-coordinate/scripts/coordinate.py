#!/usr/bin/env python3
"""Inspect GitHub work, dispatch once, record evidence, and report scoped readiness."""

import argparse
import json
from pathlib import Path
import subprocess
import sys

from contracts import Refused
import dispatch
from evidence import readiness, record_result
from github import GitHub, configuration, publish
from journal import Journal, read


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    launch = commands.add_parser("dispatch")
    dispatch.arguments(launch)
    for verb in ("status", "ready", "record"):
        command = commands.add_parser(verb)
        command.add_argument("--state-dir")
        if verb == "record":
            command.add_argument("--file", required=True)
            command.add_argument("--operation")
            mode = command.add_mutually_exclusive_group()
            mode.add_argument("--publish", action="store_true", help="Explicit coordinator publication; grants no authorization")
            mode.add_argument("--reconcile", action="store_true", help="Read back a possible remote publication without reposting")
            mode.add_argument("--recover-launch", action="store_true", help="Record exact installed-Orca recovery evidence and release local reservations")
        elif verb == "status":
            selector = command.add_mutually_exclusive_group(required=True)
            selector.add_argument("--feature", type=int)
            selector.add_argument("--ticket", type=int)
        else:
            command.add_argument("--ticket", type=int, required=True)
    args = parser.parse_args()
    try:
        if args.command == "dispatch":
            return dispatch.execute(args)
        github = GitHub()
        journal = Journal(args.state_dir)
        if args.command == "record":
            value = read(args.file)
            if args.publish or args.reconcile:
                if not args.operation:
                    raise Refused("Publication/reconciliation requires a stable --operation")
                output = publish(github, journal, args.operation, value, args.reconcile)
            elif args.recover_launch:
                if not args.operation:
                    raise Refused("Recovery requires an exact --operation")
                output = journal.recover(args.operation, value)
            else:
                output = record_result(journal, value)
        elif args.command == "ready":
            output = readiness(github, args.ticket, journal)
        elif args.feature:
            output = github.feature(args.feature)
        else:
            output = github.ticket(args.ticket)
            output["decisions"] = github.records(args.ticket, configuration()["decision_author_ids"])
            output["readiness"] = readiness(github, args.ticket, journal)
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0
    except (Refused, OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.TimeoutExpired) as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
