#!/usr/bin/env python3
"""ponytail-debt — deterministic ledger of `ponytail:` shortcut markers.

Pure grep, no LLM. Harvests every `ponytail:` comment into a debt ledger so a
deliberate deferral can't quietly rot into permanent. The convention is:

    <comment> ponytail: <ceiling>, <upgrade path>

`<ceiling>` is the limit the shortcut is good up to; `<upgrade path>` is the
trigger to revisit. A marker with no upgrade path is tagged `no-trigger` — those
are the rows that silently rot.

    python3 ponytail-debt.py --path .            # print the ledger
    python3 ponytail-debt.py --path . --json     # machine-readable
    python3 ponytail-debt.py --path . --write PONYTAIL-DEBT.md
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import asdict, dataclass

# Comment prefixes we recognize, then `ponytail:`, then the payload. The prefix
# keeps prose that merely mentions the convention out of the ledger.
MARKER_RE = re.compile(r"(?:#|//|--|;|/\*|\*|<!--)\s*ponytail:\s*(.*)", re.IGNORECASE)

SKIP_DIRS = {
    ".git", "node_modules", "dist", "build", "out", ".next", "__pycache__",
    ".venv", "venv", "env", "target", "vendor", "coverage", ".cache",
    ".mypy_cache", ".pytest_cache", ".turbo", ".swarm", "egg-info",
}
SKIP_SUFFIXES = (".min.js", ".lock", ".map", ".egg-info")


@dataclass
class Marker:
    file: str
    line: int
    ceiling: str
    upgrade: str  # "" when absent
    raw: str

    @property
    def no_trigger(self) -> bool:
        return self.upgrade == ""


def parse_payload(text: str) -> tuple[str, str]:
    """Split `<ceiling>, <upgrade>` off the text after `ponytail:`.

    Returns (ceiling, upgrade). upgrade is "" when no trigger is named.
    """
    # Strip trailing close-comment tokens.
    text = re.sub(r"\s*(?:\*/|-->)\s*$", "", text).strip()
    if not text:
        return "", ""
    ceiling, sep, upgrade = text.partition(",")
    return ceiling.strip(), upgrade.strip() if sep else ""


def _should_skip_dir(name: str) -> bool:
    return name in SKIP_DIRS or name.endswith(".egg-info")


def iter_files(root: str):
    if os.path.isfile(root):
        yield root
        return
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not _should_skip_dir(d)]
        for fn in filenames:
            if fn.endswith(SKIP_SUFFIXES):
                continue
            yield os.path.join(dirpath, fn)


def scan(root: str) -> list[Marker]:
    markers: list[Marker] = []
    for path in iter_files(root):
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as fh:
                for lineno, line in enumerate(fh, 1):
                    m = MARKER_RE.search(line)
                    if not m:
                        continue
                    ceiling, upgrade = parse_payload(m.group(1))
                    rel = os.path.relpath(path, root) if os.path.isdir(root) else path
                    markers.append(
                        Marker(
                            file=rel,
                            line=lineno,
                            ceiling=ceiling,
                            upgrade=upgrade,
                            raw=line.strip(),
                        )
                    )
        except (OSError, UnicodeDecodeError):
            continue
    markers.sort(key=lambda mk: (mk.file, mk.line))
    return markers


def render_text(markers: list[Marker]) -> str:
    if not markers:
        return "No ponytail: debt. Clean ledger."
    lines: list[str] = []
    current_file = None
    no_trigger = 0
    for mk in markers:
        if mk.file != current_file:
            lines.append(f"\n{mk.file}")
            current_file = mk.file
        upgrade = mk.upgrade if mk.upgrade else "(none)"
        tag = " [no-trigger]" if mk.no_trigger else ""
        ceiling = mk.ceiling if mk.ceiling else "(unspecified)"
        lines.append(f"  L{mk.line} — ceiling: {ceiling}. upgrade: {upgrade}.{tag}")
        if mk.no_trigger:
            no_trigger += 1
    lines.append(f"\n{len(markers)} markers, {no_trigger} with no trigger.")
    return "\n".join(lines).lstrip("\n")


def render_json(markers: list[Marker]) -> str:
    rows = []
    for mk in markers:
        d = asdict(mk)
        d["no_trigger"] = mk.no_trigger
        rows.append(d)
    payload = {
        "markers": rows,
        "count": len(markers),
        "no_trigger_count": sum(1 for mk in markers if mk.no_trigger),
    }
    return json.dumps(payload, indent=2)


def render_markdown(markers: list[Marker]) -> str:
    if not markers:
        return "# Ponytail Debt Ledger\n\nNo `ponytail:` debt. Clean ledger.\n"
    no_trigger = sum(1 for mk in markers if mk.no_trigger)
    out = [
        "# Ponytail Debt Ledger",
        "",
        f"{len(markers)} markers, {no_trigger} with no trigger.",
        "",
        "| File | Line | Ceiling | Upgrade | Rot risk |",
        "|---|---|---|---|---|",
    ]
    for mk in markers:
        ceiling = (mk.ceiling or "(unspecified)").replace("|", "\\|")
        upgrade = (mk.upgrade or "(none)").replace("|", "\\|")
        risk = "⚠️ no-trigger" if mk.no_trigger else ""
        out.append(f"| `{mk.file}` | {mk.line} | {ceiling} | {upgrade} | {risk} |")
    out.append("")
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Harvest ponytail: debt markers into a ledger.")
    ap.add_argument("--path", default=".", help="file or directory to scan (default: .)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--write", metavar="FILE", help="persist a markdown ledger to FILE")
    args = ap.parse_args(argv)

    markers = scan(args.path)

    if args.write:
        with open(args.write, "w", encoding="utf-8") as fh:
            fh.write(render_markdown(markers))
        print(f"Wrote {len(markers)} markers to {args.write}")
        return 0

    print(render_json(markers) if args.json else render_text(markers))
    return 0


if __name__ == "__main__":
    sys.exit(main())
