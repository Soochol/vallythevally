#!/usr/bin/env python3
import json
import sys
from pathlib import Path

PATH_NAMES = {"ws": "루프백 WebSocket", "ipc": "Tauri IPC 채널"}
BROWSER_NAMES = {"tauri": "Tauri 창(WebView)", "chromium": "Playwright Chromium"}


def number(value, digits=2):
    return "-" if value is None else f"{value:.{digits}f}"


def cpu(result):
    screen = result["cpu"]["screen"]
    return "-" if screen is None else f"{screen['percent']:.1f}"


def comm_table(document):
    rows = ["| 길 | 초당 건수 | 보낸 | 받은 | 지연 p50 (ms) | 지연 p99 (ms) | 화면 CPU (%) |", "|---|---:|---:|---:|---:|---:|---:|"]
    for result in document["comm"]:
        latency = result["latencyMs"]
        rows.append(f"| {PATH_NAMES[result['path']]} | {result['perSecond']} | {result['sent']} | {result['received']} | {number(latency['p50'])} | {number(latency['p99'])} | {cpu(result)} |")
    return "\n".join(rows)


def chart_table(document):
    rows = ["| 브라우저 | 초당 건수 | 프레임 p50 (ms) | 프레임 p99 (ms) | 놓친 비율 | fps | 갱신 지연 p99 (ms) | 화면 CPU (%) |", "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for result in document["chart"]:
        frames = result["frames"]
        rows.append(f"| {BROWSER_NAMES[result['browser']]} | {result['perSecond']} | {number(frames['p50'], 1)} | {number(frames['p99'], 1)} | {frames['missedRatio'] * 100:.1f}% | {number(frames['framesPerSecond'], 1)} | {number(result['latencyMs']['p99'])} | {cpu(result)} |")
    return "\n".join(rows)


def tables(document):
    return [comm_table(document), chart_table(document)]


if __name__ == "__main__":
    print("\n\n".join(tables(json.loads(Path(sys.argv[1]).read_text()))))
