#!/usr/bin/env python3
"""plan-closeout — mechanized Definition of Done.

Runs four gates over a change set and emits one consolidated report so the
closeout of a plan does not depend on the agent remembering to do it:

  1. EVAL       Deterministic checks the change declares (tests, py_compile,
                tsc, dry runs). This is the REAL correctness guarantee — trust
                it. HARD gate: any non-zero exit fails the closeout (exit 1).
  2. GAP AUDIT  Wire-what-you-build scan: placeholder/stub markers and
                declared-but-unreferenced functions/exports. ADVISORY by
                default (surfaces suspicions; some are intentional public APIs).
  3. CONSENSUS  Frontier-model review (consensus-gate) per changed single-
                language source file. ADVISORY — mine the findings, not the
                verdict. An `escalate` usually just means the panel degraded;
                a REJECT carries signal but is still a prompt to look, not a veto.
  4. COMPLEXITY Single-axis over-engineering review (ponytail-review) per
                changed source file. ADVISORY ONLY — pure suggestions, never
                failures. One model call per file (~⅓ the cost of consensus).
                Complements CONSENSUS: it is silent on bugs/security by design.

The change set is auto-derived from git (uncommitted work + untracked, plus
optionally a base ref) or given explicitly with --file. Eval commands come from
--eval (repeatable) and/or a --manifest JSON.

Exit codes:
  0   closeout OK (eval passed; advisory findings may exist)
  1   EVAL failure (a declared deterministic check did not pass) — hard gate
  2   --strict and an advisory gate flagged (gap orphan/placeholder or a
      substantive consensus REJECT)
  64  usage / configuration error
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

WORKSPACE = Path("/home/workspace")
DEFAULT_GATE = WORKSPACE / "Skills" / "consensus-gate" / "scripts" / "consensus-gate.ts"
DEFAULT_COMPLEXITY = WORKSPACE / "Skills" / "ponytail-review" / "scripts" / "ponytail-review.ts"

# Closeout state. PLAN_ACTIVE is the gate the Stop hook enforces: while it exists
# the session must not conclude. It is set by --arm (or the ExitPlanMode hook) and
# cleared only by a closeout run whose eval gate passed.
STATE_DIR = WORKSPACE / ".closeout"
PLAN_ACTIVE = STATE_DIR / "PLAN_ACTIVE"
LAST_PASS = STATE_DIR / "last-pass.json"

# Extensions we treat as reviewable source for gap-audit and consensus.
SOURCE_EXTS = {".ts", ".tsx", ".py", ".js", ".mjs", ".sh"}
# Single-language files we send to the consensus gate (the arbiter false-flags
# mixed-language bundles; keep each call to one coherent code file).
CONSENSUS_EXTS = {".ts", ".tsx", ".py", ".js", ".mjs", ".sh"}

# Placeholder / stub markers. Each entry is (label, compiled regex). Kept
# high-precision: bare prose words like "placeholder" fire on documentation,
# so we only flag explicit unfinished-work markers and stub bodies.
PLACEHOLDER_PATTERNS = [
    ("todo-marker", re.compile(r"(?:#|//|/\*|\*)\s*(TODO|FIXME|XXX|HACK)\b")),
    ("not-implemented", re.compile(r"\bNotImplementedError\b|raise NotImplementedError")),
    ("throw-stub", re.compile(r"""throw new Error\(\s*['"][^'"]*not implemented""", re.I)),
    ("py-ellipsis-stub", re.compile(r"^\s*\.\.\.\s*$")),
]

# Names that look like orphans but are entry points / framework-discovered.
ORPHAN_NAME_ALLOW = {"main", "default", "handler", "setup", "teardown"}


# --------------------------------------------------------------------------- #
# Data model
# --------------------------------------------------------------------------- #


@dataclass
class EvalResult:
    command: str
    exit_code: int
    ok: bool
    output_tail: str


@dataclass
class GapFinding:
    file: str
    line: int
    kind: str
    detail: str


@dataclass
class ConsensusFileResult:
    file: str
    status: str  # passed | rejected | escalate | error | skipped
    abstained: int
    consensus_id: str
    findings: list[str] = field(default_factory=list)
    note: str = ""


@dataclass
class ComplexityFileResult:
    file: str
    findings: list[str] = field(default_factory=list)  # preformatted ledger lines
    net_lines: int = 0
    note: str = ""


# --------------------------------------------------------------------------- #
# Concurrency
# --------------------------------------------------------------------------- #


def _map_concurrent(fn, items: list):
    """Run fn over items concurrently, preserving input order.

    Each item's work is a network-bound subprocess (bun → vendor APIs), so the
    GIL is released during the wait and threads give real wall-clock overlap.
    Per-file reviews are independent and order-preserving keeps the report
    deterministic regardless of which call finishes first."""
    if not items:
        return []
    with ThreadPoolExecutor(max_workers=len(items)) as pool:
        return list(pool.map(fn, items))


# --------------------------------------------------------------------------- #
# Git helpers
# --------------------------------------------------------------------------- #


def _git(args: list[str], cwd: Path = WORKSPACE) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], cwd=str(cwd), capture_output=True, text=True
    )


def changed_files(base: str | None, cwd: Path = WORKSPACE) -> list[str]:
    """Files touched by the current work: uncommitted (staged + unstaged +
    untracked), plus committed diff against `base` when given."""
    paths: set[str] = set()

    status = _git(["status", "--porcelain", "--untracked-files=all"], cwd)
    for line in status.stdout.splitlines():
        if not line.strip():
            continue
        # Porcelain: XY <path>  (renames carry "old -> new"; take new side).
        raw = line[3:]
        if " -> " in raw:
            raw = raw.split(" -> ", 1)[1]
        paths.add(raw.strip().strip('"'))

    if base:
        diff = _git(["diff", "--name-only", f"{base}...HEAD"], cwd)
        if diff.returncode == 0:
            for p in diff.stdout.splitlines():
                if p.strip():
                    paths.add(p.strip())

    out = []
    for p in sorted(paths):
        fp = cwd / p
        if fp.is_file():
            out.append(p)
    return out


# Source-file pathspecs for the reference corpus. We enumerate + read these
# ONCE (cached) rather than running `git grep --untracked` per candidate — on a
# large/dirty working tree, re-walking the untracked corpus per name hangs.
CORPUS_PATHSPECS = ["*.ts", "*.tsx", "*.js", "*.mjs", "*.py", "*.sh"]
_MAX_CORPUS_FILE = 1_000_000  # skip individual files over ~1MB

_corpus_cache: dict[str, str] = {}


def _source_corpus(cwd: Path = WORKSPACE) -> str:
    """All tracked + untracked-not-ignored source text, concatenated, cached."""
    key = str(cwd)
    if key in _corpus_cache:
        return _corpus_cache[key]
    files: set[str] = set()
    for args in (
        ["ls-files", "--", *CORPUS_PATHSPECS],
        ["ls-files", "--others", "--exclude-standard", "--", *CORPUS_PATHSPECS],
    ):
        res = _git(args, cwd)
        if res.returncode == 0:
            files.update(l for l in res.stdout.splitlines() if l.strip())
    parts: list[str] = []
    for rel in files:
        fp = cwd / rel
        try:
            if fp.stat().st_size > _MAX_CORPUS_FILE:
                continue
            parts.append(fp.read_text(errors="replace"))
        except OSError:
            continue
    corpus = "\n".join(parts)
    _corpus_cache[key] = corpus
    return corpus


def grep_count(name: str, cwd: Path = WORKSPACE) -> int:
    """Whole-word occurrences of `name` across the cached source corpus
    (includes the symbol's own definition; orphan == count <= 1)."""
    corpus = _source_corpus(cwd)
    return len(re.findall(r"\b" + re.escape(name) + r"\b", corpus))


# --------------------------------------------------------------------------- #
# Phase 1 — Eval (deterministic, hard gate)
# --------------------------------------------------------------------------- #


def phase_eval(commands: list[str], cwd: Path = WORKSPACE) -> list[EvalResult]:
    results: list[EvalResult] = []
    for cmd in commands:
        # shell=True is intentional: --eval / manifest "eval" entries ARE the
        # operator's declared check commands (e.g. "bun test x && tsc"), trusted
        # like a CI config or Makefile target — not untrusted external input.
        proc = subprocess.run(
            cmd, shell=True, cwd=str(cwd), capture_output=True, text=True
        )
        combined = (proc.stdout + proc.stderr).strip()
        tail = "\n".join(combined.splitlines()[-15:])
        results.append(
            EvalResult(
                command=cmd,
                exit_code=proc.returncode,
                ok=proc.returncode == 0,
                output_tail=tail,
            )
        )
    return results


# --------------------------------------------------------------------------- #
# Phase 2 — Gap audit (wire-what-you-build, advisory)
# --------------------------------------------------------------------------- #


def scan_placeholders(files: list[str], cwd: Path = WORKSPACE) -> list[GapFinding]:
    findings: list[GapFinding] = []
    for rel in files:
        if Path(rel).suffix not in SOURCE_EXTS:
            continue
        fp = cwd / rel
        try:
            lines = fp.read_text(errors="replace").splitlines()
        except OSError:
            continue
        for i, line in enumerate(lines, 1):
            for label, rx in PLACEHOLDER_PATTERNS:
                if rx.search(line):
                    findings.append(
                        GapFinding(rel, i, label, line.strip()[:120])
                    )
                    break
    return findings


def _python_orphans(rel: str, cwd: Path) -> list[GapFinding]:
    fp = cwd / rel
    try:
        tree = ast.parse(fp.read_text(errors="replace"), filename=rel)
    except (SyntaxError, OSError):
        return []
    findings: list[GapFinding] = []
    for node in tree.body:  # top-level defs only
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if node.decorator_list:  # routes / CLI commands / fixtures
            continue
        name = node.name
        if name in ORPHAN_NAME_ALLOW or name.startswith("_") or len(name) < 4:
            continue
        if name.startswith("test_"):  # pytest discovers these
            continue
        n = grep_count(name, cwd)
        if n == 1:  # exactly its own definition, nothing else (0 => absent
            #            from corpus, e.g. file >1MB — can't judge, don't flag)
            findings.append(
                GapFinding(rel, node.lineno, "orphan-def",
                           f"def {name}() — no caller found in repo")
            )
    return findings


_TS_EXPORT_RX = re.compile(
    r"^export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)"
)


def _ts_orphans(rel: str, cwd: Path) -> list[GapFinding]:
    fp = cwd / rel
    try:
        lines = fp.read_text(errors="replace").splitlines()
    except OSError:
        return []
    findings: list[GapFinding] = []
    for i, line in enumerate(lines, 1):
        m = _TS_EXPORT_RX.match(line)
        if not m:
            continue
        name = m.group(1)
        if name in ORPHAN_NAME_ALLOW or len(name) < 4:
            continue
        n = grep_count(name, cwd)
        if n == 1:  # exactly its own declaration (0 => absent from corpus)
            findings.append(
                GapFinding(rel, i, "orphan-export",
                           f"export {name} — no reference found in repo")
            )
    return findings


def phase_gap_audit(files: list[str], cwd: Path = WORKSPACE) -> list[GapFinding]:
    findings = scan_placeholders(files, cwd)
    for rel in files:
        suffix = Path(rel).suffix
        if suffix == ".py":
            findings.extend(_python_orphans(rel, cwd))
        elif suffix in (".ts", ".tsx", ".js", ".mjs"):
            findings.extend(_ts_orphans(rel, cwd))
    return findings


# --------------------------------------------------------------------------- #
# Phase 3 — Consensus (advisory; mine findings, not verdict)
# --------------------------------------------------------------------------- #

_CONSENSUS_STATUS_RX = re.compile(r"Consensus:\s*(\w+)")
_CONSENSUS_ID_RX = re.compile(r"^ID:\s*(\S+)", re.M)
_CONSENSUS_ABSTAIN_RX = re.compile(r"(\d+)\s*reviewer\(s\)\s*abstained")
_CONSENSUS_BULLET_RX = re.compile(r"^\s*•\s*(.+)$", re.M)


def parse_consensus_output(text: str) -> dict:
    """Extract status / id / abstain-count / finding bullets from gate stdout.

    Kept pure and importable so unit tests can exercise parsing without
    invoking the gate."""
    status_m = _CONSENSUS_STATUS_RX.search(text)
    id_m = _CONSENSUS_ID_RX.search(text)
    abstain_m = _CONSENSUS_ABSTAIN_RX.search(text)
    status = (status_m.group(1).lower() if status_m else "error")
    # Normalize the gate's vocabulary to our ConsensusFileResult statuses.
    if status == "passed":
        norm = "passed"
    elif status == "rejected":
        norm = "rejected"
    elif status == "escalate":
        norm = "escalate"
    else:
        norm = status
    bullets = [b.strip() for b in _CONSENSUS_BULLET_RX.findall(text)]
    # Drop pure-noise bullets (abstainers emit infra strings, not findings).
    findings = [
        b for b in bullets
        if not re.search(r"Empty response|API error|Call failed|JSON Parse",
                         b, re.I)
    ]
    return {
        "status": norm,
        "consensus_id": id_m.group(1) if id_m else "",
        "abstained": int(abstain_m.group(1)) if abstain_m else 0,
        "findings": findings,
    }


def run_consensus_one(
    rel: str, criteria: str, gate_path: Path, arbiter: bool, cwd: Path
) -> ConsensusFileResult:
    cmd = [
        "bun", str(gate_path), "validate",
        "--file", str(cwd / rel),
        "--criteria", criteria,
        "--label", f"closeout:{rel}",
    ]
    if arbiter:
        cmd.append("--arbiter")
    try:
        proc = subprocess.run(
            cmd, cwd=str(cwd), capture_output=True, text=True, timeout=180
        )
    except subprocess.TimeoutExpired:
        return ConsensusFileResult(rel, "error", 0, "", note="timed out")
    except FileNotFoundError:
        return ConsensusFileResult(
            rel, "error", 0, "", note="bun not found — cannot run consensus gate"
        )
    parsed = parse_consensus_output(proc.stdout)
    if parsed["status"] == "error" and proc.returncode != 0:
        tail = "\n".join((proc.stdout + proc.stderr).splitlines()[-5:])
        return ConsensusFileResult(rel, "error", 0, "", note=tail[:300])
    return ConsensusFileResult(
        file=rel,
        status=parsed["status"],
        abstained=parsed["abstained"],
        consensus_id=parsed["consensus_id"],
        findings=parsed["findings"],
    )


def phase_consensus(
    files: list[str], criteria: str, gate_path: Path,
    arbiter: bool, cap: int, cwd: Path = WORKSPACE
) -> tuple[list[ConsensusFileResult], list[str]]:
    candidates = [f for f in files if Path(f).suffix in CONSENSUS_EXTS]
    skipped: list[str] = []
    if len(candidates) > cap:
        skipped = candidates[cap:]
        candidates = candidates[:cap]
    results = _map_concurrent(
        lambda rel: run_consensus_one(rel, criteria, gate_path, arbiter, cwd),
        candidates,
    )
    return results, skipped


# --------------------------------------------------------------------------- #
# Phase 4 — Complexity (ponytail-review; advisory ONLY, never gates)
# --------------------------------------------------------------------------- #


def parse_complexity_output(text: str) -> dict:
    """Turn ponytail-review.ts --json stdout into ledger lines + net_lines.

    Pure/importable so unit tests can exercise parsing without invoking bun.
    On any parse failure returns an empty ledger with a note — a complexity
    review that can't be read must never break the closeout."""
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return {"findings": [], "net_lines": 0, "note": "unparseable review output"}
    if not isinstance(data, dict):
        return {"findings": [], "net_lines": 0, "note": "unexpected review shape"}
    findings: list[str] = []
    for f in data.get("findings", []) or []:
        if not isinstance(f, dict):
            continue
        what = str(f.get("what", "")).strip()
        if not what:
            continue
        loc = str(f.get("loc", f.get("line", "?")))
        tag = str(f.get("tag", "shrink"))
        repl = str(f.get("replacement", "")).strip() or "nothing"
        findings.append(f"{loc}: {tag}: {what}. {repl}.")
    net = data.get("net_lines", 0)
    try:
        net = int(net)
    except (TypeError, ValueError):
        net = 0
    # The review reports its own reason (no key vs. transient error vs. empty);
    # surface it verbatim. Only synthesize a note if the review omitted one.
    note = str(data.get("note") or "")
    if not note and data.get("api") in (None, "none") and not findings:
        note = "review unavailable"
    return {"findings": findings, "net_lines": max(0, net), "note": note}


def run_complexity_one(
    rel: str, review_script: Path, cwd: Path
) -> ComplexityFileResult:
    cmd = ["bun", str(review_script), "--file", str(cwd / rel), "--json"]
    try:
        proc = subprocess.run(
            cmd, cwd=str(cwd), capture_output=True, text=True, timeout=120
        )
    except subprocess.TimeoutExpired:
        return ComplexityFileResult(rel, note="timed out")
    except FileNotFoundError:
        return ComplexityFileResult(
            rel, note="bun not found — cannot run complexity review"
        )
    parsed = parse_complexity_output(proc.stdout)
    return ComplexityFileResult(
        file=rel,
        findings=parsed["findings"],
        net_lines=parsed["net_lines"],
        note=parsed["note"],
    )


def phase_complexity(
    files: list[str], review_script: Path, cap: int, cwd: Path = WORKSPACE
) -> tuple[list[ComplexityFileResult], list[str]]:
    candidates = [f for f in files if Path(f).suffix in SOURCE_EXTS]
    skipped: list[str] = []
    if len(candidates) > cap:
        skipped = candidates[cap:]
        candidates = candidates[:cap]
    results = _map_concurrent(
        lambda rel: run_complexity_one(rel, review_script, cwd), candidates
    )
    return results, skipped


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #


def build_report(
    files: list[str],
    evals: list[EvalResult],
    gaps: list[GapFinding],
    consensus: list[ConsensusFileResult],
    consensus_skipped: list[str],
    consensus_ran: bool,
    strict: bool = False,
    complexity: list[ComplexityFileResult] | None = None,
    complexity_skipped: list[str] | None = None,
    complexity_ran: bool = False,
) -> dict:
    complexity = complexity or []
    complexity_skipped = complexity_skipped or []
    eval_ok = all(e.ok for e in evals)
    substantive_reject = [c for c in consensus if c.status == "rejected"]
    # In strict mode the advisory gates also block, so the verdict tracks the
    # exit code (eval-only otherwise — eval is the real guarantee). COMPLEXITY is
    # deliberately excluded: it is suggestions, not failures, even under --strict.
    advisory_clean = not gaps and not substantive_reject
    gate_pass = eval_ok and (not strict or advisory_clean)
    return {
        "change_set": files,
        "eval": {
            "ran": bool(evals),
            "ok": eval_ok,
            "results": [vars(e) for e in evals],
        },
        "gap_audit": {
            "count": len(gaps),
            "findings": [vars(g) for g in gaps],
        },
        "consensus": {
            "ran": consensus_ran,
            "skipped_over_cap": consensus_skipped,
            "results": [vars(c) for c in consensus],
            "substantive_rejects": [c.file for c in substantive_reject],
        },
        "complexity": {
            "ran": complexity_ran,
            "skipped_over_cap": complexity_skipped,
            "results": [vars(c) for c in complexity],
            "net_lines_possible": sum(c.net_lines for c in complexity),
            "finding_count": sum(len(c.findings) for c in complexity),
        },
        "verdict": {
            "definition_of_done_met": gate_pass,
            "eval_is_the_guarantee": True,
            "strict": strict,
        },
    }


def render_text(report: dict) -> str:
    L: list[str] = []
    L.append("=" * 64)
    L.append("PLAN CLOSEOUT — Definition of Done")
    L.append("=" * 64)
    cs = report["change_set"]
    L.append(f"\nChange set: {len(cs)} file(s)")
    for f in cs:
        L.append(f"  · {f}")

    # Eval
    ev = report["eval"]
    L.append("\n" + "-" * 64)
    if not ev["ran"]:
        L.append("1. EVAL ........... SKIPPED (no --eval commands declared)")
        L.append("   ⚠️ No deterministic checks ran — this is the real")
        L.append("      correctness guarantee. Declare them with --eval.")
    else:
        status = "PASS ✅" if ev["ok"] else "FAIL ❌"
        L.append(f"1. EVAL ........... {status}  (hard gate)")
        for r in ev["results"]:
            mark = "✅" if r["ok"] else "❌"
            L.append(f"   {mark} exit {r['exit_code']}: {r['command']}")
            if not r["ok"] and r["output_tail"]:
                for line in r["output_tail"].splitlines():
                    L.append(f"        | {line}")

    # Gap audit
    ga = report["gap_audit"]
    L.append("\n" + "-" * 64)
    if ga["count"] == 0:
        L.append("2. GAP AUDIT ...... CLEAN ✅  (no placeholders/orphans)")
    else:
        L.append(f"2. GAP AUDIT ...... {ga['count']} finding(s) ⚠️  (advisory)")
        for g in ga["findings"]:
            L.append(f"   • {g['file']}:{g['line']} [{g['kind']}] {g['detail']}")
        L.append("   ↳ Some may be intentional (public APIs, future hooks).")
        L.append("     Confirm each is wired or deliberately deferred.")

    # Consensus
    co = report["consensus"]
    L.append("\n" + "-" * 64)
    if not co["ran"]:
        L.append("3. CONSENSUS ...... SKIPPED (--no-consensus)")
    elif not co["results"]:
        L.append("3. CONSENSUS ...... no source files to review")
    else:
        L.append("3. CONSENSUS ...... advisory — mine findings, not verdict")
        for c in co["results"]:
            icon = {"passed": "✅", "rejected": "❌",
                    "escalate": "⚠️", "error": "🚫"}.get(c["status"], "?")
            extra = f" (abstained: {c['abstained']})" if c["abstained"] else ""
            note = f" — {c['note']}" if c["note"] else ""
            L.append(f"   {icon} {c['file']}: {c['status'].upper()}{extra}{note}")
            for finding in c["findings"]:
                L.append(f"        • {finding}")
        if co["skipped_over_cap"]:
            L.append(f"   ⓘ {len(co['skipped_over_cap'])} file(s) skipped "
                     "(over --consensus-cap):")
            for f in co["skipped_over_cap"]:
                L.append(f"        - {f}")
        L.append("   ↳ Reminder: an ESCALATE usually means the panel degraded;")
        L.append("     a REJECT is a prompt to look, not a veto. Resolve")
        L.append("     substantive findings; ignore infra/format noise.")

    # Complexity (ponytail-review) — advisory only, never gates.
    cx = report.get("complexity", {"ran": False, "results": []})
    L.append("\n" + "-" * 64)
    if not cx.get("ran"):
        L.append("4. COMPLEXITY ..... SKIPPED (--no-complexity)")
    elif not cx.get("results"):
        L.append("4. COMPLEXITY ..... no source files to review")
    elif cx.get("finding_count", 0) == 0:
        L.append("4. COMPLEXITY ..... LEAN ✅  (no over-engineering flagged)")
    else:
        L.append(f"4. COMPLEXITY ..... {cx['finding_count']} suggestion(s) ✂️  "
                 "(advisory — over-engineering only)")
        for c in cx["results"]:
            if c.get("note"):
                L.append(f"   🚫 {c['file']}: {c['note']}")
            for finding in c.get("findings", []):
                L.append(f"   • {c['file']}:{finding}")
        if cx.get("skipped_over_cap"):
            L.append(f"   ⓘ {len(cx['skipped_over_cap'])} file(s) skipped "
                     "(over --complexity-cap):")
            for f in cx["skipped_over_cap"]:
                L.append(f"        - {f}")
        L.append(f"   ↳ net: -{cx.get('net_lines_possible', 0)} lines possible. "
                 "Suggestions, not failures — cut what's genuine, ignore the rest.")

    # Verdict
    v = report["verdict"]
    has_advisory = bool(ga["count"] or co.get("substantive_rejects"))
    L.append("\n" + "=" * 64)
    if v["definition_of_done_met"]:
        L.append("VERDICT: ✅ Definition of Done MET — eval passed.")
        if has_advisory:
            L.append("         (advisory findings above — review before shipping)")
    elif not ev["ok"] and ev["ran"]:
        L.append("VERDICT: ❌ Definition of Done NOT met — eval failed (hard gate).")
    else:
        # eval passed but strict mode blocks on advisory findings
        L.append("VERDICT: ❌ Definition of Done NOT met (--strict) — eval "
                 "passed but advisory gate flagged.")
    L.append("=" * 64)
    return "\n".join(L)


# --------------------------------------------------------------------------- #
# Manifest
# --------------------------------------------------------------------------- #


def load_manifest(path: Path) -> dict:
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError("manifest must be a JSON object")
    return data


# --------------------------------------------------------------------------- #
# Plan-active sentinel (the gate the Stop hook enforces)
# --------------------------------------------------------------------------- #


def _now_iso() -> str:
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def arm_plan(label: str) -> int:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    PLAN_ACTIVE.write_text(json.dumps({"label": label, "armed_at": _now_iso()}))
    print(f"plan-closeout: armed — {label!r}. The Stop hook now blocks conclusion "
          f"until a passing closeout clears {PLAN_ACTIVE}.", file=sys.stderr)
    return 0


def disarm_plan() -> int:
    existed = PLAN_ACTIVE.exists()
    PLAN_ACTIVE.unlink(missing_ok=True)
    print("plan-closeout: disarmed." if existed
          else "plan-closeout: no active plan to disarm.", file=sys.stderr)
    return 0


def record_pass(report: dict) -> None:
    """A passing closeout clears the gate and leaves a timestamped receipt."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    LAST_PASS.write_text(json.dumps({
        "passed_at": _now_iso(),
        "files": report.get("change_set", []),
        "eval_ok": report.get("eval", {}).get("ok"),
    }, indent=2))
    PLAN_ACTIVE.unlink(missing_ok=True)


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="closeout",
        description="Mechanized Definition of Done: eval + gap audit + consensus.",
    )
    p.add_argument("--file", action="append", default=[],
                   help="Explicit file in the change set (repeatable). "
                        "If omitted, derived from git.")
    p.add_argument("--base", default=None,
                   help="Git ref to additionally diff against (base...HEAD).")
    p.add_argument("--eval", action="append", default=[], dest="eval_cmds",
                   help="Deterministic check command (repeatable). Hard gate.")
    p.add_argument("--manifest", default=None,
                   help="JSON file: {eval:[...], criteria, files:[...], consensus}.")
    p.add_argument("--criteria", default="correctness,security,wiring",
                   help="Consensus review criteria.")
    p.add_argument("--no-consensus", action="store_true",
                   help="Skip the consensus phase.")
    p.add_argument("--no-arbiter", action="store_true",
                   help="Drop the mechanical arbiter rung from consensus.")
    p.add_argument("--consensus-cap", type=int, default=5,
                   help="Max files to send to consensus (default 5).")
    p.add_argument("--consensus-gate", default=str(DEFAULT_GATE),
                   help="Path to consensus-gate.ts.")
    p.add_argument("--no-complexity", action="store_true",
                   help="Skip the complexity (ponytail-review) phase.")
    p.add_argument("--complexity-cap", type=int, default=5,
                   help="Max files to send to complexity review (default 5).")
    p.add_argument("--complexity-review", default=str(DEFAULT_COMPLEXITY),
                   help="Path to ponytail-review.ts.")
    p.add_argument("--cwd", default=str(WORKSPACE),
                   help="Repository root (default /home/workspace).")
    p.add_argument("--strict", action="store_true",
                   help="Exit 2 if gap audit or consensus flags (default: "
                        "only eval gates the exit code).")
    p.add_argument("--json", action="store_true",
                   help="Emit the report as JSON instead of text.")
    p.add_argument("--arm", metavar="LABEL", default=None,
                   help="Mark a plan active (write the PLAN_ACTIVE sentinel) and "
                        "exit. The Stop hook then blocks conclusion until a "
                        "passing closeout clears it.")
    p.add_argument("--disarm", action="store_true",
                   help="Clear the PLAN_ACTIVE sentinel without running gates "
                        "(abandon a plan).")
    args = p.parse_args(argv)

    # Sentinel-only operations: no git/change-set needed.
    if args.arm is not None:
        return arm_plan(args.arm)
    if args.disarm:
        return disarm_plan()

    cwd = Path(args.cwd)
    if not (cwd / ".git").exists():
        print(f"error: {cwd} is not a git repository", file=sys.stderr)
        return 64

    # Merge manifest (flags take precedence / extend).
    eval_cmds = list(args.eval_cmds)
    criteria = args.criteria
    explicit_files = list(args.file)
    consensus_enabled = not args.no_consensus
    complexity_enabled = not args.no_complexity
    if args.manifest:
        try:
            man = load_manifest(Path(args.manifest))
        except (OSError, ValueError, json.JSONDecodeError) as e:
            print(f"error: bad manifest: {e}", file=sys.stderr)
            return 64
        eval_cmds = list(man.get("eval", [])) + eval_cmds
        # An explicit --criteria flag wins; otherwise fall back to the manifest.
        flag_is_default = args.criteria == p.get_default("criteria")
        if flag_is_default and "criteria" in man:
            criteria = man["criteria"]
        explicit_files = explicit_files or list(man.get("files", []))
        if man.get("consensus") is False:
            consensus_enabled = False
        if man.get("complexity") is False:
            complexity_enabled = False

    files = explicit_files or changed_files(args.base, cwd)
    if not files:
        print("error: empty change set — nothing to close out. Pass --file or "
              "make changes git can see.", file=sys.stderr)
        return 64

    gate_path = Path(args.consensus_gate)

    evals = phase_eval(eval_cmds, cwd) if eval_cmds else []
    gaps = phase_gap_audit(files, cwd)
    if consensus_enabled:
        if not gate_path.is_file():
            consensus, skipped = [], []
            consensus_ran = False
            print(f"warning: consensus gate not found at {gate_path}; skipping "
                  "consensus phase", file=sys.stderr)
        else:
            consensus, skipped = phase_consensus(
                files, criteria, gate_path,
                arbiter=not args.no_arbiter,
                cap=args.consensus_cap, cwd=cwd,
            )
            consensus_ran = True
    else:
        consensus, skipped, consensus_ran = [], [], False

    if complexity_enabled:
        review_script = Path(args.complexity_review)
        if not review_script.is_file():
            complexity, complexity_skipped, complexity_ran = [], [], False
            print(f"warning: complexity review not found at {review_script}; "
                  "skipping complexity phase", file=sys.stderr)
        else:
            complexity, complexity_skipped = phase_complexity(
                files, review_script, cap=args.complexity_cap, cwd=cwd,
            )
            complexity_ran = True
    else:
        complexity, complexity_skipped, complexity_ran = [], [], False

    report = build_report(files, evals, gaps, consensus, skipped, consensus_ran,
                          strict=args.strict,
                          complexity=complexity,
                          complexity_skipped=complexity_skipped,
                          complexity_ran=complexity_ran)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(render_text(report))

    # Exit code: eval is the hard gate.
    if evals and not report["eval"]["ok"]:
        return 1
    if args.strict and (gaps or report["consensus"]["substantive_rejects"]):
        return 2
    # A real closeout cleared the gate only if a deterministic check actually
    # ran and passed — a no-eval invocation must not silently disarm the plan.
    if evals:
        record_pass(report)
    elif PLAN_ACTIVE.exists():
        print("plan-closeout: no --eval declared; PLAN_ACTIVE left set. A closeout "
              "must run at least one deterministic check to clear the gate.",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
