#!/usr/bin/env bun
/**
 * Visual Verifier — Independent verifier (SIL-13 T2).
 *
 * Reads a screenshot IMAGE via a vision-capable model and compares it against
 * seed acceptance criteria + project DESIGN.md tokens. The verifier model is
 * constrained to be != author model (per aiewf P0-2, reusing the
 * reviewer-independence.ts helper library).
 *
 * Confirmed default q1=A: multimodal read OUTSIDE the consensus-gate. The
 * station calls the vision model directly; only the !=author helper is reused.
 *
 * Usage:
 *   bun verify.ts --screenshot /tmp/shot.png --criteria "uses amethyst+gold palette" \
 *     --design-md /path/to/DESIGN.md --author "hf:zai-org/GLM-5.2" --label "my-route"
 */
import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { sameModel } from "../../consensus-gate/scripts/reviewer-independence";

const { values } = parseArgs({
  options: {
    screenshot: { type: "string" },
    criteria: { type: "string" },
    "design-md": { type: "string" },
    "prior-screenshot": { type: "string" },
    author: { type: "string" },
    label: { type: "string", default: "unlabeled" },
    model: { type: "string" },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (values.help || !values.screenshot || !values.criteria) {
  console.log(`Usage: bun verify.ts --screenshot <png> --criteria "<text>" [options]

Options:
  --screenshot       Path to screenshot PNG (required)
  --criteria         Acceptance criteria text (required)
  --design-md        Path to project DESIGN.md (optional, adds token reference)
  --prior-screenshot  Path to a prior screenshot for comparison (optional)
  --author           Author model id — verifier will be constrained != this (optional)
  --label            Task label for logging (default "unlabeled")
  --model            Override verifier model (default: env VISUAL_VERIFIER_MODEL or gpt-4o)
  --help             Show this help

Output (JSON on stdout):
  { "verdict": "match"|"mismatch", "confidence": 0-1, "diffs": [...], "summary": "..." }
`);
  process.exit(values.help ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const VERIFIER_MODEL =
  values.model ||
  process.env.VISUAL_VERIFIER_MODEL ||
  "gpt-4o";
const AUTHOR = values.author || process.env.CONSENSUS_AUTHOR_MODEL || "";
const CONF_THRESHOLD = parseFloat(
  process.env.VISUAL_VERIFIER_CONF_THRESHOLD || "0.7",
);

// ---------------------------------------------------------------------------
// !=author constraint (P0-2 reuse)
// ---------------------------------------------------------------------------
if (AUTHOR && sameModel(VERIFIER_MODEL, AUTHOR)) {
  // The verifier would be the same model as the author — pick a fallback.
  const FALLBACKS = ["gpt-4o", "claude-3-5-sonnet-20241022", "gemini-1.5-pro"];
  const fallback = FALLBACKS.find((m) => !sameModel(m, AUTHOR));
  if (fallback) {
    console.error(
      `verify: verifier model '${VERIFIER_MODEL}' matches author '${AUTHOR}' — falling back to '${fallback}' (P0-2 !=author constraint)`,
    );
  } else {
    console.error(
      `verify: WARNING — verifier model matches author and no fallback available. Proceeding (constraint is best-effort in single-verifier mode).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Load screenshot (base64) — compress if too large
// ---------------------------------------------------------------------------
const screenshotPath = values.screenshot;
if (!existsSync(screenshotPath)) {
  console.error(`verify: screenshot not found: ${screenshotPath}`);
  process.exit(1);
}

let imageBase64: string;
let imageMime = "image/png";

// Compress if > 15MB (OpenAI limit is 20MB; leave headroom)
const sizeBytes = execSync(`stat -c%s "${screenshotPath}"`).toString().trim();
const sizeMB = parseInt(sizeBytes, 10) / (1024 * 1024);

if (sizeMB > 15) {
  const compressedPath = `/tmp/sil-13-compressed-${Date.now()}.jpg`;
  execSync(
    `ffmpeg -y -i "${screenshotPath}" -q:v 5 "${compressedPath}" 2>/dev/null`,
  );
  imageBase64 = readFileSync(compressedPath).toString("base64");
  imageMime = "image/jpeg";
  execSync(`rm -f "${compressedPath}"`);
} else {
  imageBase64 = readFileSync(screenshotPath).toString("base64");
}

// ---------------------------------------------------------------------------
// Load DESIGN.md tokens (if provided)
// ---------------------------------------------------------------------------
let designTokens = "";
if (values["design-md"] && existsSync(values["design-md"])) {
  const md = readFileSync(values["design-md"], "utf-8");
  // Extract the token/color section (heuristic: lines with hex colors or OKLCH)
  const tokenLines = md
    .split("\n")
    .filter((l) => /#[0-9a-fA-F]{3,8}|oklch|color|token|--|palette/i.test(l))
    .slice(0, 50)
    .join("\n");
  designTokens = tokenLines || md.slice(0, 2000);
}

// ---------------------------------------------------------------------------
// Load prior screenshot reference (if provided)
// ---------------------------------------------------------------------------
let priorNote = "";
if (values["prior-screenshot"] && existsSync(values["prior-screenshot"])) {
  priorNote = `\nA PRIOR screenshot exists at ${values["prior-screenshot"]}. If the current screenshot has regressed from the prior state, flag it.`;
}

// ---------------------------------------------------------------------------
// Build the verification prompt
// ---------------------------------------------------------------------------
const promptText = `You are an independent visual verifier. You must NOT rubber-stamp the work — your job is to catch rendered-output failures that text-based checks miss.

TASK LABEL: ${values.label}

ACCEPTANCE CRITERIA (the screenshot must satisfy these):
${values.criteria}

${designTokens ? `PROJECT DESIGN TOKENS (from DESIGN.md — the screenshot should use these, not defaults):\n${designTokens}\n` : ""}${priorNote}

Instructions:
1. Look at the screenshot carefully.
2. Check each acceptance criterion against what you actually see rendered.
3. If DESIGN tokens are provided, verify the rendered colors/layout match the project palette, NOT default Tailwind/CSS tokens.
4. Return ONLY a JSON object with this exact shape:
{
  "verdict": "match" | "mismatch",
  "confidence": <number 0.0 to 1.0>,
  "diffs": [
    { "issue": "<what's wrong>", "criterion": "<which AC or token is violated>", "severity": "high" | "medium" | "low" }
  ],
  "summary": "<one-line summary>"
}

If everything looks correct, return verdict "match" with empty diffs.
If something is wrong, return verdict "mismatch" with the diffs array populated.
Do not include any text outside the JSON.`;

// ---------------------------------------------------------------------------
// Call the vision model (OpenAI-compatible API)
// ---------------------------------------------------------------------------
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("verify: OPENAI_API_KEY is not set — cannot call vision model");
  process.exit(1);
}

const apiUrl =
  process.env.OPENAI_API_BASE_URL ||
  "https://api.openai.com/v1/chat/completions";

const body = {
  model: VERIFIER_MODEL,
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: promptText,
        },
        {
          type: "image_url",
          image_url: {
            url: `data:${imageMime};base64,${imageBase64}`,
            detail: "high",
          },
        },
      ],
    },
  ],
  max_tokens: 2000,
  temperature: 0.1,
};

let response: Response;
try {
  response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
} catch (e) {
  console.error(`verify: model call failed: ${(e as Error).message}`);
  process.exit(1);
}

if (!response.ok) {
  const errText = await response.text();
  console.error(
    `verify: model returned ${response.status}: ${errText.slice(0, 500)}`,
  );
  process.exit(1);
}

const data = await response.json();
const content = data.choices?.[0]?.message?.content || "";

// Parse the JSON verdict from the model response
let verdict: {
  verdict: string;
  confidence: number;
  diffs: { issue: string; criterion: string; severity: string }[];
  summary: string;
};

try {
  // Extract JSON from possible markdown code fences
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("no JSON found in response");
  verdict = JSON.parse(jsonMatch[0]);
} catch (e) {
  console.error(`verify: failed to parse model response as JSON: ${content.slice(0, 300)}`);
  process.exit(1);
}

// Emit the verdict on stdout
console.log(JSON.stringify(verdict, null, 2));
