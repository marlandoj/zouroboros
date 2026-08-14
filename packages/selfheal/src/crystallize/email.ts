/**
 * email.ts — Plain-text approval email composer.
 *
 * Per Sec Eng + seed AC:
 *   • Plain-text content type ONLY. No HTML body, no multipart/alternative.
 *   • The CLI command is the SINGLE permitted "URL-like" string in the body
 *     (it's a `bun ...` invocation, not a clickable http link). Any other
 *     `http://` / `https://` substring outside that command line MUST cause
 *     compose() to throw — verified by FX-19.
 *   • The body is the same regardless of mail transport; compose() returns
 *     the structured EmailMessage and the caller chooses delivery.
 *
 * The CLI in PR3 will queue messages via `mcp__zo__send_email_to_user` (per
 * the workspace email rules). Tests use a stub sender to assert content +
 * content-type without contacting Gmail.
 */

export interface ApprovalEmailInputs {
  /** Crystallization id (UUID). */
  id: string;
  /** Skill slug being proposed. */
  slug: string;
  /** Workspace-relative or absolute candidate path. */
  candidate_path: string;
  /** Source ids that triggered crystallization (for the recipient's review). */
  source_ids: string[];
  /** Source kind (procedure | episode | skill_execution | mixed). */
  source_kind: string;
  /** Weighted score that crossed threshold. */
  weighted_score: number;
  /** 'mechanical_pass' | 'replay_pass' | 'mechanical_only' — pass states only. */
  eval_status: string;
  /** Created_at (unix seconds) — used to render expiry deadline. */
  created_at: number;
  /** approval_token_ttl_days; defaults to 14. */
  ttl_days?: number;
  /** Pre-signed HMAC token (hex). */
  token: string;
}

export interface EmailMessage {
  subject: string;
  /** MUST be exactly "text/plain; charset=utf-8" — checked by composeApprovalEmail. */
  content_type: 'text/plain; charset=utf-8';
  /** Plain-text body — newline-separated lines. */
  body: string;
}

const FORBIDDEN_BODY_PATTERNS: { id: string; rx: RegExp }[] = [
  { id: 'html_tag', rx: /<\s*[a-zA-Z][^>]*>/ },
  { id: 'html_entity', rx: /&[a-zA-Z]+;/ },
  // Markdown autolinks render clickable in many readers; bracketed URLs too.
  { id: 'markdown_autolink', rx: /<https?:\/\/[^>]+>/ },
  { id: 'markdown_link', rx: /\[[^\]]+\]\(https?:\/\/[^)]+\)/ },
];

const URL_RX = /https?:\/\/[^\s)>\]"']+/gi;

const APPROVAL_CLI_PREFIX = 'bun ';

export class EmailValidationError extends Error {
  reason: string;
  constructor(reason: string) {
    super(`email validation failed: ${reason}`);
    this.reason = reason;
    this.name = 'EmailValidationError';
  }
}

function buildBody(i: ApprovalEmailInputs): string {
  const ttlDays = i.ttl_days ?? 14;
  const expiresAt = new Date((i.created_at + ttlDays * 86_400) * 1000)
    .toISOString();

  const approveCmd =
    `bun zouroboros/packages/selfheal/src/cli/crystallize.ts approve ${i.id} --token ${i.token}`;
  const rejectCmd =
    `bun zouroboros/packages/selfheal/src/cli/crystallize.ts reject ${i.id} --token ${i.token}`;

  return [
    `Skill Crystallization v1 — candidate ready for review`,
    ``,
    `id:             ${i.id}`,
    `slug:           ${i.slug}`,
    `candidate_path: ${i.candidate_path}`,
    `source_kind:    ${i.source_kind}`,
    `source_ids:     ${i.source_ids.join(', ')}`,
    `weighted_score: ${i.weighted_score.toFixed(2)}`,
    `eval_status:    ${i.eval_status}`,
    `expires_at:     ${expiresAt}`,
    ``,
    `To approve, run this CLI command exactly:`,
    `  ${approveCmd}`,
    ``,
    `To reject, run:`,
    `  ${rejectCmd}`,
    ``,
    `The token expires after ${ttlDays} days. Approval is one-shot.`,
    `If neither command is run before expiry, the candidate is auto-archived.`,
    ``,
    `— Skill Crystallization v1 (Zouroboros)`,
  ].join('\n');
}

/**
 * Validate the body does not contain any clickable URL outside the approve/
 * reject CLI lines. The CLI lines are explicitly allowlisted by inspecting
 * each URL match's surrounding context.
 *
 * Throws EmailValidationError on any violation; never silently masks.
 */
function assertPlainText(body: string): void {
  for (const { id, rx } of FORBIDDEN_BODY_PATTERNS) {
    if (rx.test(body)) {
      throw new EmailValidationError(`forbidden_body_pattern:${id}`);
    }
  }

  const lines = body.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    URL_RX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_RX.exec(line))) {
      // Permit URLs only inside an approve/reject CLI line; the line must
      // start (after optional indent) with `bun `.
      const trimmed = line.trimStart();
      if (!trimmed.startsWith(APPROVAL_CLI_PREFIX)) {
        throw new EmailValidationError(
          `clickable_url_outside_cli:${m[0].slice(0, 64)}`,
        );
      }
    }
  }
}

export function composeApprovalEmail(i: ApprovalEmailInputs): EmailMessage {
  if (!i.id || !i.slug || !i.candidate_path || !i.token) {
    throw new EmailValidationError('missing_required_field');
  }
  if (i.source_ids.length === 0) {
    throw new EmailValidationError('source_ids_empty');
  }
  const body = buildBody(i);
  assertPlainText(body);

  return {
    subject: `Skill candidate ready: ${i.slug} (${i.id})`,
    content_type: 'text/plain; charset=utf-8',
    body,
  };
}

/**
 * Pluggable sender — production CLI wires `mcp__zo__send_email_to_user` here.
 * The interface is sync-text-payload only; never accepts HTML.
 */
export type EmailSender = (msg: EmailMessage) => Promise<void>;
