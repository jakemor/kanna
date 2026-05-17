#!/usr/bin/env python3
"""Compact summary of a Kanna chat transcript JSONL.

Reads ~/.kanna/data/transcripts/<chatId>.jsonl and prints a one-line-per-entry
timeline so Claude can scan a huge session without pulling the whole file into
context. Each line shows: index, timestamp, kind, and a kind-specific preview.

Usage:
    python3 summarize_transcript.py <path-to-jsonl> [flags]

Flags:
    --kinds K1,K2          comma list of kinds to keep
    --tool T1,T2           filter tool_call/tool_result to these tool names
    --errors-only          show only tool_result with isError=true
    --last N               only the last N entries (post-filter)
    --around ENTRY_ID      5 entries before/after the entry whose _id matches
    --json                 emit JSON lines instead of human format
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


@dataclass
class Entry:
    index: int
    raw: dict[str, Any]

    @property
    def kind(self) -> str:
        return self.raw.get("kind", "?")

    @property
    def created_at(self) -> int:
        return int(self.raw.get("createdAt", 0))

    @property
    def entry_id(self) -> str:
        return self.raw.get("_id", "")

    @property
    def tool_name(self) -> str | None:
        if self.kind == "tool_call":
            return self.raw.get("tool", {}).get("toolName")
        return None

    @property
    def tool_id(self) -> str | None:
        if self.kind == "tool_call":
            return self.raw.get("tool", {}).get("toolId")
        if self.kind == "tool_result":
            return self.raw.get("toolId")
        return None

    @property
    def is_error(self) -> bool:
        return self.kind == "tool_result" and bool(self.raw.get("isError"))


def load(path: str) -> list[Entry]:
    out: list[Entry] = []
    with open(path, "r", encoding="utf-8") as fh:
        for i, line in enumerate(fh):
            line = line.strip()
            if not line:
                continue
            try:
                out.append(Entry(i, json.loads(line)))
            except json.JSONDecodeError as exc:
                print(f"warning: skipping malformed line {i}: {exc}", file=sys.stderr)
    return out


def fmt_ts(ms: int) -> str:
    if ms <= 0:
        return "?"
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%H:%M:%S")


def preview(entry: Entry, width: int = 100) -> str:
    raw = entry.raw
    kind = entry.kind
    if kind == "user_prompt":
        text = raw.get("content", "").replace("\n", " ")
        attachments = raw.get("attachments") or []
        suffix = f" [+{len(attachments)} attachments]" if attachments else ""
        return _trim(text, width) + suffix
    if kind == "assistant_text":
        return _trim(raw.get("text", "").replace("\n", " "), width)
    if kind == "tool_call":
        tool = raw.get("tool", {}) or {}
        name = tool.get("toolName", "?")
        tool_id = tool.get("toolId", "")
        input_blob = json.dumps(tool.get("input", {}), ensure_ascii=False)
        return f"{name}({_trim(input_blob, width)}) id={_short(tool_id)}"
    if kind == "tool_result":
        tool_id = raw.get("toolId", "")
        err = "ERROR " if raw.get("isError") else ""
        content = raw.get("content", "")
        if isinstance(content, list):
            content = json.dumps(content, ensure_ascii=False)
        if not isinstance(content, str):
            content = str(content)
        return f"{err}id={_short(tool_id)} {_trim(content.replace(chr(10), ' '), width)}"
    if kind == "system_init":
        return f"model={raw.get('model','?')} provider={raw.get('provider','?')} tools={len(raw.get('tools') or [])}"
    if kind == "account_info":
        info = raw.get("accountInfo", {}) or {}
        return f"tokenSource={info.get('tokenSource','?')} apiProvider={info.get('apiProvider','?')}"
    return _trim(json.dumps({k: v for k, v in raw.items() if k != "debugRaw"}, ensure_ascii=False), width)


def _trim(s: str, n: int) -> str:
    if len(s) <= n:
        return s
    return s[: n - 1] + "…"


def _short(tool_id: str) -> str:
    return tool_id[-8:] if tool_id else "?"


def apply_filters(entries: list[Entry], args: argparse.Namespace) -> list[Entry]:
    kinds = set(args.kinds.split(",")) if args.kinds else None
    tools = set(args.tool.split(",")) if args.tool else None

    keep: list[Entry] = []
    for e in entries:
        if kinds and e.kind not in kinds:
            continue
        if tools and e.tool_name and e.tool_name not in tools:
            continue
        if tools and e.kind == "tool_result":
            # keep tool_results whose paired tool_call passes the filter
            keep.append(e)
            continue
        if args.errors_only and not e.is_error:
            continue
        keep.append(e)

    if args.around:
        anchor_idx = next((i for i, e in enumerate(keep) if e.entry_id == args.around), None)
        if anchor_idx is None:
            print(f"--around: no entry with _id={args.around} after filters", file=sys.stderr)
            return []
        lo = max(0, anchor_idx - 5)
        hi = min(len(keep), anchor_idx + 6)
        keep = keep[lo:hi]

    if args.last:
        keep = keep[-args.last :]
    return keep


def print_human(entries: list[Entry], total: int) -> None:
    print(f"# Kanna transcript summary — {len(entries)}/{total} entries")
    print()
    print(f"{'idx':>4}  {'time':<8}  {'kind':<14}  preview")
    print("-" * 100)
    for e in entries:
        print(f"{e.index:>4}  {fmt_ts(e.created_at):<8}  {e.kind:<14}  {preview(e)}")
    if entries:
        print()
        print("# next steps")
        print('# - full detail: jq -c \'select(._id == "<id>")\' <transcript>')
        print('# - context around one entry: --around <id>')


def print_json(entries: list[Entry]) -> None:
    for e in entries:
        out = {
            "index": e.index,
            "_id": e.entry_id,
            "createdAt": e.created_at,
            "kind": e.kind,
            "preview": preview(e, width=200),
        }
        if e.tool_name:
            out["toolName"] = e.tool_name
        if e.tool_id:
            out["toolId"] = e.tool_id
        if e.is_error:
            out["isError"] = True
        print(json.dumps(out, ensure_ascii=False))


def main() -> int:
    p = argparse.ArgumentParser(description="Summarize a Kanna chat transcript JSONL.")
    p.add_argument("path")
    p.add_argument("--kinds", help="comma list of kinds to keep")
    p.add_argument("--tool", help="comma list of tool names to keep")
    p.add_argument("--errors-only", action="store_true")
    p.add_argument("--last", type=int)
    p.add_argument("--around", help="entry _id to center on (5 before / 5 after)")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    entries = load(args.path)
    if not entries:
        print("empty transcript", file=sys.stderr)
        return 1
    filtered = apply_filters(entries, args)
    if args.json:
        print_json(filtered)
    else:
        print_human(filtered, total=len(entries))
    return 0


if __name__ == "__main__":
    sys.exit(main())
