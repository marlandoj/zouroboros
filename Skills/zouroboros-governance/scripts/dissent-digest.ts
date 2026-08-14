#!/usr/bin/env bun
/**
 * Weekly dissent digest — reads ~/.zouroboros/consensus-gate.json, filters to
 * split or low-confidence verdicts within --since, renders an HTML digest, and
 * either prints to stdout or emails via /zo/ask -> send_email_to_user.
 *
 * Wired by R2 (zouroboros-governance-safety/PROJECT_PLAN.md).
 */
import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";

interface DissentClaim {
  claim: string;
  evidence?: string;
  severity?: "high" | "medium" | "low";
}

interface DissentSummary {
  split_axis: string[];
  aligned_claims: { claim: string; models: string[] }[];
  unique_claims: { claim: string; model: string }[];
  dissent_score: number;
}

interface Verdict {
  model: string;
  pass: boolean;
  issues: string[];
  dissent_claims?: DissentClaim[];
  confidence: number;
}

interface ConsensusResult {
  id: string;
  timestamp: string;
  label: string;
  criteria: string;
  verdicts: Verdict[];
  consensus: { unanimous: boolean; pass: boolean | null; confidence: number };
  status: string;
  dissent_summary?: DissentSummary;
}

const DB_PATH = path.join(process.env.HOME || "/root", ".zouroboros/consensus-gate.json");

const { values } = parseArgs({
  options: {
    since: { type: "string", default: "7d" },
    "min-confidence": { type: "string", default: "0.65" },
    limit: { type: "string", default: "15" },
    send: { type: "boolean", default: false },
    "skip-if-empty": { type: "boolean", default: false },
    to: { type: "string" },
  },
  allowPositionals: true,
});

function parseSince(spec: string): number {
  const m = spec.match(/^(\d+)\s*([smhdw])$/i);
  if (!m) return Date.now() - 7 * 86400e3;
  const n = parseInt(m[1], 10);
  const mult: Record<string, number> = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };
  return Date.now() - n * (mult[m[2].toLowerCase()] || 86400e3);
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function summarizeDissent(verdicts: Verdict[]): DissentSummary {
  const buckets = new Map<string, { claim: string; models: Set<string> }>();
  for (const v of verdicts) {
    const claims = v.dissent_claims ?? (v.issues || []).map((c) => ({ claim: c }));
    for (const c of claims) {
      const key = normalizeForMatch(c.claim || "");
      if (!key) continue;
      const existing = buckets.get(key);
      if (existing) existing.models.add(v.model);
      else buckets.set(key, { claim: c.claim, models: new Set([v.model]) });
    }
  }
  const aligned: { claim: string; models: string[] }[] = [];
  const unique: { claim: string; model: string }[] = [];
  for (const b of buckets.values()) {
    if (b.models.size >= 2) aligned.push({ claim: b.claim, models: [...b.models].sort() });
    else unique.push({ claim: b.claim, model: [...b.models][0] });
  }
  const total = buckets.size;
  const dissent_score = total === 0 ? 0 : 1 - aligned.length / total;
  return { split_axis: [], aligned_claims: aligned, unique_claims: unique, dissent_score };
}

function modelBadge(model: string): string {
  if (/glm/i.test(model)) return "GLM";
  if (/kimi/i.test(model)) return "Kimi";
  if (/minimax/i.test(model)) return "MiniMax";
  if (/deepseek/i.test(model)) return "DeepSeek";
  if (/qwen/i.test(model)) return "Qwen";
  return model.split("/").pop() || model;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface QualifyingEvent {
  result: ConsensusResult;
  summary: DissentSummary;
}

function collect(sinceMs: number, minConfidence: number, limit: number): QualifyingEvent[] {
  if (!fs.existsSync(DB_PATH)) return [];
  let db: ConsensusResult[] = [];
  try {
    db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  } catch {
    return [];
  }
  const out: QualifyingEvent[] = [];
  for (const r of db) {
    const ts = Date.parse(r.timestamp);
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    const isSplit = r.status === "split";
    const lowConf = r.consensus.confidence < minConfidence;
    if (!isSplit && !lowConf) continue;
    out.push({ result: r, summary: r.dissent_summary ?? summarizeDissent(r.verdicts) });
  }
  out.sort((a, b) => b.result.timestamp.localeCompare(a.result.timestamp));
  return out.slice(0, limit);
}

function renderHtml(events: QualifyingEvent[], windowSpec: string, minConfidence: number): string {
  const generated = new Date().toLocaleString("en-US", { timeZone: "America/Phoenix" });
  const summary = events.length === 0
    ? `<p style="color:#52525b;font-size:13px;">No split or low-confidence verdicts in the last ${windowSpec}. Consensus gate quiet.</p>`
    : `<p style="color:#a1a1aa;font-size:13px;">${events.length} consensus event(s) needed operator review in the last ${windowSpec} (status = split OR mean confidence &lt; ${minConfidence.toFixed(2)}).</p>`;

  const rows = events.map((e) => {
    const r = e.result;
    const confPct = Math.round(r.consensus.confidence * 100);
    const dsPct = Math.round(e.summary.dissent_score * 100);
    const statusColor = r.status === "split" ? "#f59e0b" : r.status === "rejected" ? "#f43f5e" : "#10b981";
    const verdictsHtml = r.verdicts.map((v) => {
      const icon = v.pass ? "✓" : "✗";
      const color = v.pass ? "#10b981" : "#f43f5e";
      const claims = (v.dissent_claims ?? (v.issues || []).map((s) => ({ claim: s }))).length;
      return `<span style="display:inline-block;margin-right:10px;padding:2px 8px;border:1px solid #27272a;border-radius:4px;background:#18181b;font-size:11px;font-family:monospace;color:#d4d4d8;"><span style="color:${color};font-weight:bold;">${icon}</span> ${escapeHtml(modelBadge(v.model))} · ${claims} claim${claims === 1 ? "" : "s"}</span>`;
    }).join("");
    const axisHtml = e.summary.split_axis.map((ax) =>
      `<span style="display:inline-block;margin-right:6px;padding:1px 6px;border:1px solid #92400e;border-radius:3px;background:#451a03;color:#fbbf24;font-size:10px;">${escapeHtml(ax)}</span>`
    ).join("");
    const topClaims = e.summary.unique_claims.slice(0, 3).map((u) =>
      `<li style="font-size:12px;color:#a1a1aa;margin:4px 0;"><span style="color:#71717a;font-family:monospace;font-size:11px;">${escapeHtml(modelBadge(u.model))}:</span> ${escapeHtml(u.claim.slice(0, 220))}${u.claim.length > 220 ? "…" : ""}</li>`
    ).join("");
    const when = new Date(r.timestamp).toLocaleString("en-US", { timeZone: "America/Phoenix" });

    return `
      <div style="border:1px solid #27272a;border-radius:8px;padding:14px;margin-bottom:12px;background:#09090b;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
          <div>
            <div style="font-size:14px;color:#fafafa;font-weight:600;">${escapeHtml(r.label)}</div>
            <div style="font-size:11px;color:#52525b;font-family:monospace;margin-top:2px;">${escapeHtml(r.id)} · ${when}</div>
          </div>
          <span style="font-size:10px;text-transform:uppercase;letter-spacing:1px;font-weight:600;color:${statusColor};border:1px solid ${statusColor};padding:2px 8px;border-radius:999px;">${r.status}</span>
        </div>
        <div style="margin:8px 0;">${verdictsHtml}</div>
        <div style="font-size:11px;color:#a1a1aa;margin-bottom:6px;">
          confidence <span style="color:#d4d4d8;font-family:monospace;">${confPct}%</span>
          &nbsp;·&nbsp; dissent <span style="color:#d4d4d8;font-family:monospace;">${dsPct}%</span>
          &nbsp;${axisHtml}
        </div>
        ${topClaims ? `<ul style="margin:6px 0 0 0;padding:0 0 0 18px;">${topClaims}</ul>` : ""}
      </div>
    `;
  }).join("");

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#09090b;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#fafafa;">
  <div style="max-width:680px;margin:0 auto;">
    <div style="border-bottom:1px solid #27272a;padding-bottom:12px;margin-bottom:20px;">
      <h1 style="margin:0;font-size:20px;color:#fafafa;">Zouroboros · Consensus Dissent Digest</h1>
      <p style="margin:4px 0 0 0;font-size:12px;color:#71717a;">Window: ${escapeHtml(windowSpec)} · Generated ${escapeHtml(generated)} America/Phoenix</p>
    </div>
    ${summary}
    ${rows}
    <div style="margin-top:24px;padding-top:12px;border-top:1px solid #27272a;font-size:11px;color:#52525b;">
      Source: <code>~/.zouroboros/consensus-gate.json</code> · See <a href="https://marlandoj.zo.space/zouroboros/health" style="color:#06b6d4;">/zouroboros/health</a> for the live panel.
      Recommendation R2 — Zouroboros Governance &amp; Safety roadmap.
    </div>
  </div>
</body></html>`;
}

async function sendViaZoAsk(html: string, subject: string): Promise<void> {
  const token = process.env.ZO_API_KEY || process.env.ZO_CLIENT_IDENTITY_TOKEN;
  if (!token) {
    console.error("⚠️  No ZO_API_KEY or ZO_CLIENT_IDENTITY_TOKEN — cannot send digest. Printing instead.");
    console.log(html);
    return;
  }
  const prompt = `Use send_email_to_user to send the user the Zouroboros Consensus Dissent Digest now.

Subject: ${subject}

Body (rich HTML — render verbatim, do NOT add commentary or summary lines):

${html}

Required:
- channel: email
- format: html
- Do not edit, summarize, or annotate the HTML body — it must be sent exactly as-is.
- After sending, respond with only the literal text "sent" so we can verify.`;
  const resp = await fetch("https://api.zo.computer/zo/ask", {
    method: "POST",
    headers: {
      authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ input: prompt }),
  });
  if (!resp.ok) {
    throw new Error(`/zo/ask HTTP ${resp.status}`);
  }
  const data: any = await resp.json();
  console.log(`✓ Digest dispatched. /zo/ask reply: ${String(data?.output || "").slice(0, 200)}`);
}

async function main() {
  const since = values.since || "7d";
  const minConfidence = parseFloat(values["min-confidence"] || "0.65");
  const limit = parseInt(values.limit || "15", 10);
  const send = Boolean(values.send);
  const skipIfEmpty = Boolean(values["skip-if-empty"]);

  const sinceMs = parseSince(since);
  const events = collect(sinceMs, minConfidence, limit);

  if (send && skipIfEmpty && events.length === 0) {
    console.log(`No dissent events in the last ${since}; skipping send (--skip-if-empty).`);
    return;
  }

  const subject = events.length === 0
    ? `✅ Zouroboros Dissent Digest — quiet (${since})`
    : events.some((e) => e.result.status === "rejected")
      ? `❌ Zouroboros Dissent Digest — ${events.length} event(s), includes rejection (${since})`
      : `⚠️ Zouroboros Dissent Digest — ${events.length} split/low-confidence event(s) (${since})`;

  const html = renderHtml(events, since, minConfidence);

  if (!send) {
    console.log(html);
    return;
  }

  await sendViaZoAsk(html, subject);
}

main().catch((err) => {
  console.error("dissent-digest failed:", err);
  process.exit(1);
});
