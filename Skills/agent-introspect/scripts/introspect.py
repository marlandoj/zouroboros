#!/usr/bin/env python3
"""
Weekly skills / identity / script-health introspection audit.

Hardened, version-controlled replacement for the audit that was formerly an
inline Python heredoc inside the "[SYS] Audit Skills & Personas" scheduled
agent. It adds structural skill checks, an atomic machine-status file, a
concurrency lock, a bounded retry budget, interpreter preflight, fail-closed
config validation, and visible accounting of scripts that cannot be probed.
See SKILL.md for the operator contract.

Exit codes (also written to the status file):
  0  OK       audit completed fully (findings may be > 0 — read the status file)
  1  ERROR    config invalid / unrecoverable error
  3  PARTIAL  audit ran but did not finish probing (budget exhausted)
  4  LOCK     another audit run holds the lock; this run did nothing
"""
import argparse
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import yaml
except ModuleNotFoundError:
    yaml = None

EXPECTED_CONFIG_VERSION = 1

WORKSPACE = Path("/home/workspace")
SKILLS_DIR = WORKSPACE / "Skills"
IDENTITY_DIR = WORKSPACE / "IDENTITY"
REPORTS_DIR = WORKSPACE / "Reports" / "Introspections"
STATUS_FILE = REPORTS_DIR / ".introspect-status.json"
LOCK_FILE = REPORTS_DIR / ".introspect.lock"
DEFAULT_CONFIG = Path(__file__).resolve().parent / "config.json"

# Extensions considered "runnable" for the skills-inventory check (parity with inline).
RUNNABLE_EXT = {".ts", ".py", ".sh", ".mjs", ".js"}
# Probe strategy per extension. Anything in RUNNABLE_EXT but not here is "unprobeable".
PROBE_INTERPRETER = {".ts": "bun", ".py": "python3", ".sh": "bash"}

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_PARTIAL = 3
EXIT_LOCK = 4

ALLOWED_CONFIG_KEYS = {
    "version", "probe_timeout_s", "retries", "audit_budget_s", "max_timeouts", "skip_health",
}


class ConfigError(Exception):
    pass


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# --------------------------------------------------------------------------- #
# Config (fail-closed, every key validated, version-guarded)
# --------------------------------------------------------------------------- #
def load_config(path: Path) -> dict:
    if not path.exists():
        raise ConfigError(f"config file not found: {path}")
    try:
        raw = json.loads(path.read_text())
    except Exception as e:
        raise ConfigError(f"config is not valid JSON: {e}")
    if not isinstance(raw, dict):
        raise ConfigError("config root must be a JSON object")

    unknown = set(raw) - ALLOWED_CONFIG_KEYS
    if unknown:
        raise ConfigError(f"unknown config keys: {sorted(unknown)}")

    if "version" not in raw:
        raise ConfigError("missing key: version")
    if raw["version"] != EXPECTED_CONFIG_VERSION:
        raise ConfigError(
            f"config version {raw['version']!r} != expected {EXPECTED_CONFIG_VERSION} "
            "(config.json and introspect.py are out of sync)"
        )

    def need_int(key, lo, hi):
        if key not in raw:
            raise ConfigError(f"missing key: {key}")
        v = raw[key]
        if isinstance(v, bool) or not isinstance(v, int):
            raise ConfigError(f"{key} must be an integer, got {type(v).__name__}")
        if not (lo <= v <= hi):
            raise ConfigError(f"{key}={v} out of range [{lo}..{hi}]")
        return v

    cfg = {
        "version": raw["version"],
        "probe_timeout_s": need_int("probe_timeout_s", 1, 120),
        "retries": need_int("retries", 0, 3),
        "audit_budget_s": need_int("audit_budget_s", 60, 3600),
        "max_timeouts": need_int("max_timeouts", 1, 100),
    }

    if "skip_health" not in raw:
        raise ConfigError("missing key: skip_health")
    sh = raw["skip_health"]
    if not isinstance(sh, list) or not all(isinstance(x, str) for x in sh):
        raise ConfigError("skip_health must be a list of strings")
    if len(sh) != len(set(sh)):
        dups = sorted({x for x in sh if sh.count(x) > 1})
        raise ConfigError(f"skip_health contains duplicates: {dups}")
    cfg["skip_health"] = set(sh)
    return cfg


# --------------------------------------------------------------------------- #
# Detection
# --------------------------------------------------------------------------- #
def _skill_frontmatter(skill_md: Path) -> tuple[dict, str | None]:
    try:
        text = skill_md.read_text()
    except Exception as error:
        return {}, f"unreadable SKILL.md: {error}"
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, "missing YAML frontmatter"
    try:
        end = next(index for index, line in enumerate(lines[1:], 1) if line.strip() == "---")
    except StopIteration:
        return {}, "unterminated YAML frontmatter"
    frontmatter = "\n".join(lines[1:end])
    if yaml is not None:
        try:
            parsed = yaml.safe_load(frontmatter)
        except yaml.YAMLError as error:
            return {}, f"invalid YAML frontmatter: {str(error).splitlines()[0]}"
        if not isinstance(parsed, dict):
            return {}, "YAML frontmatter is not a mapping"
        return parsed, None
    fields = {}
    for line in lines[1:end]:
        match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if match:
            fields[match.group(1)] = match.group(2).strip().strip("'\"")
    return fields, None


def audit_skills(skills_dir: Path = SKILLS_DIR) -> list:
    issues = []
    if not skills_dir.exists():
        return issues
    for skill_dir in sorted(skills_dir.iterdir()):
        if not skill_dir.is_dir() or skill_dir.name.startswith((".", "_")):
            continue
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.exists():
            if (skill_dir / "scripts").is_dir():
                issues.append(f"  - {skill_dir.name}: scripts/ exists but SKILL.md is missing")
            continue
        fields, frontmatter_error = _skill_frontmatter(skill_md)
        name = fields.get("name", "")
        description = fields.get("description", "")
        scripts_dir = skill_dir / "scripts"
        script_files = []
        if scripts_dir.exists():
            try:
                script_files = [
                    f.name for f in scripts_dir.iterdir()
                    if f.is_file() and f.suffix in RUNNABLE_EXT
                ]
            except Exception:
                pass
        if frontmatter_error:
            issues.append(f"  - {skill_dir.name}: {frontmatter_error}")
        if not name:
            issues.append(f"  - {skill_dir.name}: missing name in SKILL.md frontmatter")
        elif not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
            issues.append(f"  - {skill_dir.name}: invalid skill name '{name}'")
        elif name != skill_dir.name:
            issues.append(f"  - {skill_dir.name}: name '{name}' does not match directory")
        if not description:
            issues.append(f"  - {skill_dir.name}: empty description in SKILL.md")
        if not script_files and scripts_dir.exists():
            issues.append(f"  - {skill_dir.name}: scripts/ dir exists but has no runnable files")
    return issues


def audit_identity() -> list:
    issues = []
    for name in ["AGENTS.md"]:
        if not (WORKSPACE / name).exists():
            issues.append(f"  - MISSING: {name}")
    if IDENTITY_DIR.exists():
        try:
            now = datetime.now().timestamp()
            stale = [
                md.name for md in sorted(IDENTITY_DIR.glob("*.md"))
                if md.stat().st_mtime < now - 30 * 86400
            ]
            if stale:
                issues.append(
                    f"  - {len(stale)} IDENTITY/ files not updated in 30+ days: "
                    + ", ".join(stale[:5]) + (" ..." if len(stale) > 5 else "")
                )
        except Exception:
            pass
    return issues


def discover_scripts(skip_health: set):
    """Return (to_probe, unprobeable).

    to_probe:    list of (skill_name, Path, suffix) with a known probe strategy.
    unprobeable: list of (skill_name, filename) — runnable extension but no probe
                 strategy (e.g. .mjs/.js). Surfaced, never silently dropped.
    """
    to_probe, unprobeable = [], []
    if not SKILLS_DIR.exists():
        return to_probe, unprobeable
    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        if not skill_dir.is_dir():
            continue
        scripts_dir = skill_dir / "scripts"
        if not scripts_dir.exists():
            continue
        try:
            entries = sorted(scripts_dir.iterdir())
        except Exception:
            continue
        for script in entries:
            if not script.is_file():
                continue
            if script.name in skip_health:
                continue
            suffix = script.suffix
            if suffix in PROBE_INTERPRETER:
                to_probe.append((skill_dir.name, script, suffix))
            elif suffix in RUNNABLE_EXT:
                unprobeable.append((skill_dir.name, script.name))
    return to_probe, unprobeable


def _probe_once(cmd, timeout, attempts):
    """Run `cmd` up to `attempts` times; retry ONLY on timeout.
    Returns ("ok", CompletedProcess) | ("timeout", None) | ("error", Exception)."""
    result = ("timeout", None)
    for _ in range(attempts):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            return ("ok", r)
        except subprocess.TimeoutExpired:
            result = ("timeout", None)
            continue
        except Exception as e:  # noqa: BLE001 — surface as a finding, never crash the audit
            return ("error", e)
    return result


def run_health_probes(to_probe, cfg, deadline):
    """Probe each discovered script with --help.

    Returns dict: issues, unprobed, timeout_events, missing_interpreters.
    A script times out only if it exceeds the timeout on its FINAL attempt; that
    counts as exactly one timeout event regardless of retry count. After
    max_timeouts events, retries are disabled for the rest of the run. The budget
    deadline is checked before each script; on exhaustion probing stops and the
    remaining count is recorded (PARTIAL).
    """
    issues = []
    needed = {PROBE_INTERPRETER[suf] for (_, _, suf) in to_probe}
    resolved = {interp: shutil.which(interp) for interp in needed}
    missing = sorted(i for i, p in resolved.items() if p is None)

    probe_timeout = cfg["probe_timeout_s"]
    max_retries = cfg["retries"]
    max_timeouts = cfg["max_timeouts"]

    timeout_events = 0
    retries_enabled = True
    unprobed = 0

    total = len(to_probe)
    for idx, (skill, script, suffix) in enumerate(to_probe):
        interp = PROBE_INTERPRETER[suffix]
        if resolved[interp] is None:
            issues.append(f"  - {skill}/{script.name}: interpreter '{interp}' not on PATH")
            continue
        if time.monotonic() >= deadline:
            unprobed = total - idx
            break
        attempts = (max_retries + 1) if retries_enabled else 1
        kind, payload = _probe_once(
            [resolved[interp], str(script), "--help"], probe_timeout, attempts
        )
        if kind == "timeout":
            issues.append(f"  - {skill}/{script.name}: timeout")
            timeout_events += 1
            if timeout_events >= max_timeouts:
                retries_enabled = False
        elif kind == "error":
            issues.append(f"  - {skill}/{script.name}: error — {payload}")
        else:
            r = payload
            if r.returncode not in (0, 1):
                preview = (r.stdout + r.stderr)[:200].replace("\n", " ")
                issues.append(f"  - {skill}/{script.name}: exit {r.returncode} — {preview}")

    return {
        "issues": issues,
        "unprobed": unprobed,
        "timeout_events": timeout_events,
        "missing_interpreters": missing,
    }


# --------------------------------------------------------------------------- #
# Architecture enrichment (advisory only — never affects findings or exit code)
# --------------------------------------------------------------------------- #
# Sourced from the codebase-memory graph (DeusData/codebase-memory-mcp). This is
# read-only context surfaced into the weekly report, NOT a pass/fail check: any
# failure to reach the graph degrades to a single note and leaves the audit's
# findings set — and therefore compat parity — untouched.
ARCH_BIN = Path("/home/workspace/Integrations/codebase-memory-mcp/bin/codebase-memory-mcp")
ARCH_PROJECTS = ("home-workspace-packages", "home-workspace-Skills")
ARCH_TIMEOUT_S = 25
ARCH_TOP_HOTSPOTS = 5
ARCH_LOW_COHESION = 3


def _arch_query(project: str, timeout_s: int):
    """get_architecture for one project via the codebase-memory CLI.
    Returns a parsed dict, or None on any failure (never raises). The binary
    prints an init line to stderr, so JSON is read from stdout only."""
    try:
        r = subprocess.run(
            [str(ARCH_BIN), "cli", "get_architecture", json.dumps({"project": project})],
            capture_output=True, text=True, timeout=timeout_s,
        )
    except Exception:
        return None
    out = (r.stdout or "").strip()
    if r.returncode != 0 or not out:
        return None
    try:
        return json.loads(out)
    except Exception:
        # Tolerate a stray prefix line before the JSON body.
        for line in reversed(out.splitlines()):
            line = line.strip()
            if line.startswith("{"):
                try:
                    return json.loads(line)
                except Exception:
                    continue
        return None


def collect_architecture_hotspots(timeout_s=ARCH_TIMEOUT_S):
    """Advisory architecture signal from the codebase-memory graph.

    Best-effort and fully non-fatal: a missing binary, timeout, or parse error
    yields an 'unavailable' note rather than affecting the audit's findings or
    exit code. Returns a list of markdown lines (possibly just a note line)."""
    if not (ARCH_BIN.exists() and os.access(ARCH_BIN, os.X_OK)):
        return ["- codebase-memory graph unavailable (binary not found)"]
    lines = []
    for project in ARCH_PROJECTS:
        data = _arch_query(project, timeout_s)
        if not data:
            lines.append(f"- {project}: graph query unavailable")
            continue
        nodes = data.get("total_nodes", "?")
        edges = data.get("total_edges", "?")
        lines.append(f"- **{project}** — {nodes} nodes / {edges} edges")
        for h in (data.get("hotspots") or [])[:ARCH_TOP_HOTSPOTS]:
            qn = h.get("qualified_name") or h.get("name") or "?"
            lines.append(f"  - hotspot `{qn}` — fan-in {h.get('fan_in', '?')}")
        clusters = [
            c for c in (data.get("clusters") or [])
            if isinstance(c.get("cohesion"), (int, float))
        ]
        clusters.sort(key=lambda c: c["cohesion"])
        for c in clusters[:ARCH_LOW_COHESION]:
            lines.append(
                f"  - low-cohesion cluster `{c.get('label', '?')}` "
                f"({c.get('members', '?')} members, cohesion {c['cohesion']:.2f})"
            )
    return lines


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #
def build_report(date_str, skills_issues, identity_issues, health_issues,
                 meta, unprobeable, status, arch_lines=None):
    findings = []
    if skills_issues:
        findings.append("### Skills Issues\n" + "\n".join(skills_issues))
    if identity_issues:
        findings.append("### Identity Issues\n" + "\n".join(identity_issues))
    if health_issues:
        findings.append("### Script Health Issues\n" + "\n".join(health_issues))

    lines = [f"# Introspection Report — {date_str}", ""]
    if findings:
        lines += ["## Findings", ""]
        for f in findings:
            lines += [f, ""]
    else:
        lines += ["## Result", "",
                  "All checks passed. No skills issues, no identity issues, no broken scripts.",
                  ""]

    # Additive metadata — does not affect the findings set used for compat parity.
    notes = []
    if status != "OK":
        notes.append(f"- Status: **{status}**")
    if meta.get("unprobed"):
        notes.append(f"- Unprobed (budget exhausted): {meta['unprobed']}")
    if unprobeable:
        listed = ", ".join(f"{s}/{n}" for s, n in unprobeable[:10])
        notes.append(f"- Skipped (no probe strategy): {len(unprobeable)} — {listed}"
                     + (" ..." if len(unprobeable) > 10 else ""))
    if meta.get("missing_interpreters"):
        notes.append(f"- Interpreters not on PATH: {', '.join(meta['missing_interpreters'])}")
    if meta.get("timeout_events"):
        notes.append(f"- Timeout events: {meta['timeout_events']}")
    if notes:
        lines += ["## Audit Metadata", ""] + notes + [""]

    # Advisory architecture appendix — additive, excluded from the findings count
    # so compat parity with the inline audit is preserved.
    if arch_lines:
        lines += [
            "## Architecture Hotspots", "",
            "_Advisory signal from the codebase-memory graph — highest blast-radius "
            "functions (fan-in) and fuzziest module boundaries (low cohesion). "
            "Not audit findings._", "",
        ] + arch_lines + [""]

    lines += [f"*Generated {datetime.now().isoformat()}*"]
    return "\n".join(lines), len(skills_issues) + len(identity_issues) + len(health_issues)


def write_status(status, exit_code, findings, report, partial_reason,
                 unprobed, unprobeable_ext, error):
    payload = {
        "status": status,
        "exit_code": exit_code,
        "findings": findings,
        "report": str(report) if report else None,
        "partial_reason": partial_reason,
        "unprobed": unprobed,
        "unprobeable_ext": unprobeable_ext,
        "error": error,
        "ran_at": _now_iso(),
    }
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(REPORTS_DIR), prefix=".introspect-status.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, STATUS_FILE)
    except Exception:
        try:
            os.unlink(tmp)
        except Exception:
            pass
        raise


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
def run_audit(cfg):
    """Run all three checks. Returns (skills, identity, health_meta, unprobeable)."""
    skills_issues = audit_skills()
    identity_issues = audit_identity()
    to_probe, unprobeable = discover_scripts(cfg["skip_health"])
    deadline = time.monotonic() + cfg["audit_budget_s"]
    meta = run_health_probes(to_probe, cfg, deadline)
    return skills_issues, identity_issues, meta, unprobeable


def main():
    parser = argparse.ArgumentParser(
        description="Weekly skills/identity/script-health introspection audit."
    )
    parser.add_argument("--config", default=str(DEFAULT_CONFIG),
                        help="path to config.json (default: sibling of this script)")
    parser.add_argument("--compat", action="store_true",
                        help="compat mode: force retries=0, budget=3600 (for A/B parity vs inline)")
    parser.add_argument("--findings-only", action="store_true",
                        help="print findings JSON to stdout; skip report, status file and lock")
    parser.add_argument("--report-path", default=None,
                        help="override report output path (testing)")
    args = parser.parse_args()

    # Config first — a bad config is ERROR regardless of mode.
    try:
        cfg = load_config(Path(args.config))
    except ConfigError as e:
        if not args.findings_only:
            try:
                write_status("ERROR", EXIT_ERROR, 0, None, None, 0, 0, f"config: {e}")
            except Exception:
                pass
        print(f"ERROR: {e}", file=sys.stderr)
        return EXIT_ERROR

    if args.compat:
        cfg["retries"] = 0
        cfg["audit_budget_s"] = 3600

    # --findings-only is a read-only parity probe: no lock, no report, no status.
    if args.findings_only:
        skills_issues, identity_issues, meta, _ = run_audit(cfg)
        print(json.dumps({
            "skills": skills_issues,
            "identity": identity_issues,
            "health": meta["issues"],
        }))
        return EXIT_OK

    # Concurrency guard: exclusive non-blocking lock. Held for process lifetime.
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    lock_fp = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock_fp.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("ERROR: another audit run holds the lock; doing nothing", file=sys.stderr)
        lock_fp.close()
        return EXIT_LOCK

    try:
        skills_issues, identity_issues, meta, unprobeable = run_audit(cfg)

        unprobed = meta["unprobed"]
        if unprobed > 0:
            status, exit_code = "PARTIAL", EXIT_PARTIAL
            partial_reason = f"audit budget exhausted; {unprobed} scripts unprobed"
        else:
            status, exit_code = "OK", EXIT_OK
            partial_reason = None

        date_str = datetime.now().strftime("%Y-%m-%d")
        report_path = Path(args.report_path) if args.report_path else \
            REPORTS_DIR / f"{date_str}-introspection.md"
        try:
            arch_lines = collect_architecture_hotspots()
        except Exception:
            arch_lines = None  # advisory only — never block the report
        report_text, findings_count = build_report(
            date_str, skills_issues, identity_issues, meta["issues"],
            meta, unprobeable, status, arch_lines=arch_lines,
        )
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(report_text)

        write_status(status, exit_code, findings_count, report_path,
                     partial_reason, unprobed, len(unprobeable), None)

        print(f"STATUS={status}")
        print(f"FINDINGS={findings_count}")
        print(f"REPORT={report_path}")
        return exit_code
    except Exception as e:  # noqa: BLE001 — guarantee a status flush on any failure
        try:
            write_status("ERROR", EXIT_ERROR, 0, None, None, 0, 0, repr(e))
        except Exception:
            pass
        print(f"ERROR: {e}", file=sys.stderr)
        return EXIT_ERROR
    finally:
        try:
            fcntl.flock(lock_fp.fileno(), fcntl.LOCK_UN)
        except Exception:
            pass
        lock_fp.close()


if __name__ == "__main__":
    sys.exit(main())
