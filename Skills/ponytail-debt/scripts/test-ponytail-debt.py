#!/usr/bin/env python3
"""Unit tests for ponytail-debt.py — deterministic, no LLM, no network."""
import importlib.util
import os
import sys
import tempfile

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "ponytail_debt", os.path.join(_here, "ponytail-debt.py")
)
pd = importlib.util.module_from_spec(_spec)
sys.modules["ponytail_debt"] = pd  # dataclass needs the module in sys.modules to resolve annotations
_spec.loader.exec_module(pd)

PASS = 0
FAIL = 0


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok  {name}")
    else:
        FAIL += 1
        print(f"FAIL  {name}")


# --- parse_payload ---------------------------------------------------------
def test_parse_payload():
    c, u = pd.parse_payload("caps at 1k rows, swap to sqlite when it grows")
    check("payload: ceiling parsed", c == "caps at 1k rows")
    check("payload: upgrade parsed", u == "swap to sqlite when it grows")

    c, u = pd.parse_payload("good enough for now")
    check("payload: no comma -> empty upgrade", u == "")
    check("payload: no comma -> ceiling is whole text", c == "good enough for now")

    c, u = pd.parse_payload("single fallback, ")
    check("payload: trailing comma + space -> no-trigger", u == "")

    c, u = pd.parse_payload("in-memory cache, evict at 10MB */")
    check("payload: strips trailing */", u == "evict at 10MB")

    c, u = pd.parse_payload("hardcoded list, replace with config -->")
    check("payload: strips trailing -->", u == "replace with config")

    c, u = pd.parse_payload("")
    check("payload: empty -> empty/empty", c == "" and u == "")


# --- MARKER_RE -------------------------------------------------------------
def test_marker_regex():
    check("regex: hash prefix", pd.MARKER_RE.search("# ponytail: x, y") is not None)
    check("regex: slash prefix", pd.MARKER_RE.search("// ponytail: x, y") is not None)
    check("regex: dash prefix", pd.MARKER_RE.search("-- ponytail: x, y") is not None)
    check("regex: block prefix", pd.MARKER_RE.search(" * ponytail: x, y") is not None)
    check("regex: case-insensitive", pd.MARKER_RE.search("# Ponytail: x") is not None)
    # Prose mention without a comment prefix should NOT match.
    check(
        "regex: bare prose not matched",
        pd.MARKER_RE.search("the ponytail: convention is great") is None,
    )


# --- scan over a temp tree -------------------------------------------------
def test_scan():
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "src"))
        os.makedirs(os.path.join(d, "node_modules"))
        with open(os.path.join(d, "src", "a.py"), "w") as f:
            f.write("x = 1  # ponytail: list caps at 1k, move to db when bigger\n")
            f.write("y = 2  # ponytail: single retry only\n")  # no-trigger
        with open(os.path.join(d, "src", "b.ts"), "w") as f:
            f.write("// ponytail: inline regex ok, extract when reused\n")
        # Marker inside node_modules must be skipped.
        with open(os.path.join(d, "node_modules", "junk.js"), "w") as f:
            f.write("// ponytail: vendored, never touch\n")

        markers = pd.scan(d)
        check("scan: finds 3 markers (skips node_modules)", len(markers) == 3)
        nt = [m for m in markers if m.no_trigger]
        check("scan: 1 no-trigger flagged", len(nt) == 1)
        check("scan: no-trigger is the retry line", nt[0].ceiling == "single retry only")
        check("scan: sorted by file", markers[0].file <= markers[-1].file)

        # min.js and lock files skipped by suffix
        with open(os.path.join(d, "src", "bundle.min.js"), "w") as f:
            f.write("// ponytail: minified, ignore\n")
        markers2 = pd.scan(d)
        check("scan: skips .min.js by suffix", len(markers2) == 3)


# --- render ---------------------------------------------------------------
def test_render():
    empty = pd.render_text([])
    check("render: empty -> clean ledger", empty == "No ponytail: debt. Clean ledger.")

    markers = [
        pd.Marker(file="a.py", line=5, ceiling="caps at 1k", upgrade="use db", raw="x"),
        pd.Marker(file="a.py", line=9, ceiling="retry once", upgrade="", raw="y"),
    ]
    txt = pd.render_text(markers)
    check("render: ends with summary", txt.strip().endswith("2 markers, 1 with no trigger."))
    check("render: no-trigger tagged", "[no-trigger]" in txt)
    check("render: ceiling shown", "caps at 1k" in txt)

    import json as _json

    parsed = _json.loads(pd.render_json(markers))
    check("render_json: count", parsed["count"] == 2)
    check("render_json: no_trigger_count", parsed["no_trigger_count"] == 1)
    check("render_json: marker has no_trigger field", parsed["markers"][1]["no_trigger"] is True)

    md = pd.render_markdown(markers)
    check("render_md: table header", "| File | Line |" in md)
    check("render_md: rot risk emoji", "no-trigger" in md)


def main():
    test_parse_payload()
    test_marker_regex()
    test_scan()
    test_render()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    import sys

    sys.exit(main())
