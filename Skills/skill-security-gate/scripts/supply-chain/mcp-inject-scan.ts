/**
 * mcp-inject-scan — pure core.
 *
 * Deterministic (no LLM, no network) scan for prompt-injection / exfil smuggled
 * into MCP tool DESCRIPTIONS and into the LOCAL server SOURCE that emits them
 * (the Snyk "392 confirmed injections in tool descriptions" finding).
 *
 * Two surfaces, deliberately calibrated differently to keep false positives low:
 *   - 'description' — text the model is told to trust. An imperative override, an
 *     exfil instruction, or a smuggled secret-keyword here is suspicious.
 *   - 'source'      — a local server's own code. Reading env/secrets and making
 *     network calls is NORMAL for a server, so on source we ONLY flag a smuggled
 *     directive (an override imperative in a string/comment) and hidden unicode —
 *     never legitimate env/fetch usage.
 */

import type { Finding } from './types.js';

export type Surface = 'description' | 'source';

export interface InjectScanInput {
  serverId: string;
  /** Tool/server description text (statically available config text). */
  descriptionsText?: string;
  /** Local server source file text (only present for local-command servers). */
  sourceText?: string;
}

// Imperative directives aimed at the model — the core injection signal.
const OVERRIDE_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[\s\S]{0,40}?\b(?:previous|above|prior|earlier|all)\b[\s\S]{0,30}?\b(?:instruction|instructions|prompt|prompts|rule|rules|context|guideline|guidelines)\b/i,
  /\byou\s+must\s+now\b/i,
  /\bnew\s+instructions?\s*:/i,
  /<\/?system>/i,
  /\[\s*system\s*\]/i,
];

// Instructions to exfiltrate — only meaningful on a description surface.
const EXFIL_PATTERNS: RegExp[] = [
  /\b(?:send|post|exfiltrate|upload|transmit|leak|forward)\b[\s\S]{0,40}?(?:https?:\/\/|\b(?:env|environment|secret|secrets|credential|credentials|api[_\- ]?key|token|password)\b)/i,
  /\bPOST\b[\s\S]{0,15}?https?:\/\//i,
];

// Zero-width / bidi / soft-hyphen unicode used to smuggle hidden text.
// U+200B-200D zero-width, U+2060 word-joiner, U+FEFF BOM, U+202A-202E bidi
// embed/override, U+2066-2069 bidi isolate, U+00AD soft hyphen.
const HIDDEN_UNICODE_RE = /[​-‍⁠﻿‪-‮⁦-⁩­]/;

// Narrow info-class signals (description only) — kept conservative to avoid FP.
const BASE64_BLOB_RE = /[A-Za-z0-9+/]{120,}={0,2}/;
const SECRET_KEYWORD_RE = /\b(?:api[_\- ]?key|secret|credential|password|access[_\- ]?token|private[_\- ]?key)\b/i;

function firstMatchExcerpt(text: string, re: RegExp): string {
  const m = text.match(re);
  if (!m) return '';
  const s = m[0].replace(/\s+/g, ' ').trim();
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}

function scanSurface(serverId: string, text: string, surface: Surface): Finding[] {
  const findings: Finding[] = [];
  if (!text) return findings;

  for (const re of OVERRIDE_PATTERNS) {
    if (re.test(text)) {
      findings.push({
        target: serverId,
        category: 'mcp-inject',
        severity: 'critical',
        finding: `Imperative override directive in MCP ${surface}`,
        evidence: `${surface}: "${firstMatchExcerpt(text, re)}"`,
        remediation: `Remove the embedded instruction from the ${surface}; an MCP ${surface} must describe a tool, never instruct the model.`,
      });
      break; // one override finding per surface is enough signal
    }
  }

  if (HIDDEN_UNICODE_RE.test(text)) {
    findings.push({
      target: serverId,
      category: 'mcp-inject',
      severity: 'warning',
      finding: `Hidden/zero-width unicode in MCP ${surface}`,
      evidence: `${surface} contains zero-width/bidi/soft-hyphen code points`,
      remediation: `Strip non-printing unicode (U+200B-200D, U+2060, U+FEFF, U+202A-202E, U+2066-2069, U+00AD) — it is used to smuggle hidden directives.`,
    });
  }

  if (surface === 'description') {
    for (const re of EXFIL_PATTERNS) {
      if (re.test(text)) {
        findings.push({
          target: serverId,
          category: 'mcp-inject',
          severity: 'critical',
          finding: `Exfiltration instruction in MCP description`,
          evidence: `description: "${firstMatchExcerpt(text, re)}"`,
          remediation: `A tool description must not instruct sending data to a URL or reading secrets/credentials. Treat this server as untrusted.`,
        });
        break;
      }
    }

    if (BASE64_BLOB_RE.test(text)) {
      findings.push({
        target: serverId,
        category: 'mcp-inject',
        severity: 'info',
        finding: `Long base64-like blob in MCP description`,
        evidence: `description: "${firstMatchExcerpt(text, BASE64_BLOB_RE)}"`,
        remediation: `Verify the encoded content; large opaque blobs in a description can hide a smuggled payload.`,
      });
    }
    if (SECRET_KEYWORD_RE.test(text)) {
      findings.push({
        target: serverId,
        category: 'mcp-inject',
        severity: 'info',
        finding: `Secret/credential keyword in MCP description`,
        evidence: `description mentions "${firstMatchExcerpt(text, SECRET_KEYWORD_RE)}"`,
        remediation: `Confirm the description is not coaxing the model to surface secrets; descriptions rarely need to mention credentials.`,
      });
    }
  }

  return findings;
}

/** Scan one server's description + (optional) local source for injection signatures. */
export function scanMcpInjection(input: InjectScanInput): Finding[] {
  return [
    ...scanSurface(input.serverId, input.descriptionsText ?? '', 'description'),
    ...scanSurface(input.serverId, input.sourceText ?? '', 'source'),
  ];
}

/** Scan a batch of servers. */
export function scanMcpInjections(inputs: InjectScanInput[]): Finding[] {
  return inputs.flatMap(scanMcpInjection);
}
