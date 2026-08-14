# Legacy inline instruction — rollback snapshot

This is the **pre-refactor** instruction for the `[SYS] Audit Skills & Personas`
scheduled agent (`automation_id 1f8e4dbc-d879-4e2b-bc45-3cfae24d4333`, weekly
Sun 14:00 Phoenix), captured **2026-06-15** immediately before it was shrunk to
invoke `Skills/agent-introspect/scripts/introspect.py`.

Keep for **one rollback cycle**. If the script-based version misbehaves, paste
this back via `mcp__zo__edit_automation` (automation_id + instruction only).
Detection criteria here are identical to the refactored script — the inline
`SKIP_HEALTH` set below (18 entries) matches `config.json:skip_health` and the
`FROZEN_SKIP_HEALTH` snapshot in `test_introspect.py`.

---

Agent Purpose Summary

- Purpose: Weekly self-audit of the Zo skill/persona/agent ecosystem to surface drift, breakage, and capability gaps before they bite.
- Actions: Runs inline skills/identity/health audit (no external script dependency), writes a dated report to /home/workspace/Reports/Introspections/, emails findings, and archives the report to NotebookLM.
- Goal: Maintain a clean, trustworthy capability surface — no stale skills, no broken scripts, no undocumented identity drift.

EMAIL FOOTER: When sending the result email, append the Agent Purpose Summary block (verbatim, copied from the top of these instructions) at the bottom of the email body so the recipient always sees the agent's purpose.

Run the inline audit across skills, identity files, and script health.

Steps:

1. Run the audit inline (all three checks in one pass). Use run_bash_command:

```
mkdir -p /home/workspace/Reports/Introspections
python3 << 'PYEOF'
import os, subprocess, sys
from pathlib import Path
from datetime import datetime

WORKSPACE = Path("/home/workspace")
SKILLS_DIR = WORKSPACE / "Skills"
IDENTITY_DIR = WORKSPACE / "IDENTITY"

# Scripts to skip in --help health checks (daemons, servers, orchestrators that never exit,
# DB-backed scripts with heavy import-time deps that legitimately exceed 10s, and OAuth-gated scripts)
SKIP_HEALTH = {
    "gemini-daemon.ts", "mcp-server-http.ts", "test-bridges.ts",
    "test-harness.ts", "deploy-tts-endpoint.ts", "orchestrate.ts",
    # DB-backed: heavy import-time dependencies (SQLite, Qdrant, OpenAI), legitimately >10s startup
    "benchmark-v2-v3.ts", "demo.ts", "feedback-promote.ts",
    "ingest-hermes-docs-hybrid.ts", "seed-mimir-corpus.ts", "test-pka-briefing.ts",
    # OAuth-gated: Consensus MCP manifest now requires Bearer token (HTTP 401 as of 2026-06)
    "mcp-trust-check.ts",
    # agent-doctor: times out at 10s during DB preflight
    "doctor.ts",
    # Audit noise (approved 2026-06-14): heavy network/import startup or no --help handler by design.
    # drift-guard/auto-heal fetch live site CSS at startup; raptor_hierarchy imports numpy/openai/qdrant
    # (>10s cold start); memory-gate is the production hook gate that expects a real user message.
    "auto-heal.ts", "drift-guard.ts", "raptor_hierarchy.py", "memory-gate.ts",
}

findings = []

# --- Skills inventory ---
skills_issues = []
if SKILLS_DIR.exists():
    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        if not skill_dir.is_dir(): continue
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.exists(): continue
        description = ""
        try:
            for line in skill_md.read_text().splitlines():
                if line.startswith("description:"):
                    description = line.split(":",1)[1].strip().strip("'\"")
                    break
        except Exception: pass
        scripts_dir = skill_dir / "scripts"
        script_files = []
        if scripts_dir.exists():
            try:
                script_files = [f.name for f in scripts_dir.iterdir() if f.is_file() and f.suffix in (".ts",".py",".sh",".mjs",".js")]
            except Exception: pass
        if not description:
            skills_issues.append(f"  - {skill_dir.name}: empty description in SKILL.md")
        if not script_files and scripts_dir.exists():
            skills_issues.append(f"  - {skill_dir.name}: scripts/ dir exists but has no runnable files")
if skills_issues:
    findings.append("### Skills Issues\n" + "\n".join(skills_issues))

# --- Identity files ---
identity_issues = []
for name in ["AGENTS.md"]:
    p = WORKSPACE / name
    if not p.exists():
        identity_issues.append(f"  - MISSING: {name}")
if IDENTITY_DIR.exists():
    try:
        now = datetime.now().timestamp()
        stale = [md.name for md in sorted(IDENTITY_DIR.glob("*.md")) if md.stat().st_mtime < now - 30*86400]
        if stale:
            identity_issues.append(f"  - {len(stale)} IDENTITY/ files not updated in 30+ days: {', '.join(stale[:5])}" + (" ..." if len(stale)>5 else ""))
    except Exception: pass
if identity_issues:
    findings.append("### Identity Issues\n" + "\n".join(identity_issues))

# --- Script health checks (no shell=True — avoids injection) ---
health_issues = []
if SKILLS_DIR.exists():
    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        if not skill_dir.is_dir(): continue
        scripts_dir = skill_dir / "scripts"
        if not scripts_dir.exists(): continue
        try:
            for script in sorted(scripts_dir.iterdir()):
                if not script.is_file(): continue
                if script.name in SKIP_HEALTH: continue
                if script.suffix == ".ts": cmd = ["bun", str(script), "--help"]
                elif script.suffix == ".py": cmd = ["python3", str(script), "--help"]
                elif script.suffix == ".sh": cmd = ["bash", str(script), "--help"]
                else: continue
                try:
                    r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
                    if r.returncode not in (0, 1):
                        preview = (r.stdout + r.stderr)[:200].replace("\n"," ")
                        health_issues.append(f"  - {skill_dir.name}/{script.name}: exit {r.returncode} — {preview}")
                except subprocess.TimeoutExpired:
                    health_issues.append(f"  - {skill_dir.name}/{script.name}: timeout")
                except Exception as e:
                    health_issues.append(f"  - {skill_dir.name}/{script.name}: error — {e}")
        except Exception: pass
if health_issues:
    findings.append("### Script Health Issues\n" + "\n".join(health_issues))

# --- Write report ---
date_str = datetime.now().strftime("%Y-%m-%d")
report_path = Path(f"/home/workspace/Reports/Introspections/{date_str}-introspection.md")
report_path.parent.mkdir(parents=True, exist_ok=True)
lines = [f"# Introspection Report — {date_str}", ""]
if findings:
    lines += ["## Findings", ""] + [f for finding in findings for f in [finding, ""]]
else:
    lines += ["## Result", "", "All checks passed. No skills issues, no identity issues, no broken scripts.", ""]
lines += [f"*Generated {datetime.now().isoformat()}*"]
report_path.write_text("\n".join(lines))
print(f"FINDINGS={len(findings)}")
print(f"REPORT={report_path}")
PYEOF
```

2. Read the exit output. If FINDINGS > 0, email the user a summary with the report contents.

3. Archive the report to the NotebookLM knowledge base regardless of findings:

```
/home/workspace/Skills/notebooklm-skill/scripts/notebook-capture.sh agent-introspect --file /home/workspace/Reports/Introspections/$(date +%Y-%m-%d)-introspection.md
```

If the capture command fails, log it and continue — do not block the agent on capture failures.

4. If zero findings, do not email. Just the archive above.

Do not edit any files. Do not delete anything. Report only.
