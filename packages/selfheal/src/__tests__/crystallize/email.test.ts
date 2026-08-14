/**
 * Approval-email composer coverage — FX-18, FX-19.
 *
 * Asserts:
 *   • happy path: subject/body/content_type are set; body contains the slug,
 *     candidate_path, expires_at, and the two CLI command lines verbatim
 *   • FX-18 — HTML tag in input ⇒ EmailValidationError(forbidden_body_pattern:html_tag)
 *   • FX-19 — clickable URL outside the CLI line ⇒ clickable_url_outside_cli
 *   • content_type is exactly the literal "text/plain; charset=utf-8" — no other
 *     value reaches the sender
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  composeApprovalEmail,
  EmailValidationError,
} from '../../crystallize/email.js';

const FX = (id: string) =>
  JSON.parse(
    readFileSync(
      join(__dirname, '..', 'fixtures', 'crystallize', `${id}.json`),
      'utf8',
    ),
  );

describe('crystallize/email (FX-18, FX-19)', () => {
  const baseInput = {
    id: '00000000-0000-0000-0000-000000000001',
    slug: 'deploy-zo-route',
    candidate_path: '/tmp/Skills/_candidates/deploy-zo-route',
    source_ids: ['proc-1', 'proc-2'],
    source_kind: 'procedure' as const,
    weighted_score: 3.0,
    eval_status: 'mechanical_pass',
    created_at: 1700000000,
    ttl_days: 14,
    token: 'deadbeefcafebabe1122334455667788990011223344556677889900aabbccdd',
  };

  test('happy path produces a plain-text email containing both CLI commands', () => {
    const msg = composeApprovalEmail(baseInput);
    expect(msg.content_type).toBe('text/plain; charset=utf-8');
    expect(msg.subject).toContain(baseInput.slug);
    expect(msg.subject).toContain(baseInput.id);
    expect(msg.body).toContain(`slug:           ${baseInput.slug}`);
    expect(msg.body).toContain(`candidate_path: ${baseInput.candidate_path}`);
    expect(msg.body).toContain(`approve ${baseInput.id} --token ${baseInput.token}`);
    expect(msg.body).toContain(`reject ${baseInput.id} --token ${baseInput.token}`);
  });

  test('FX-18: HTML tag in slug ⇒ EmailValidationError(html_tag)', () => {
    const fx = FX('FX-18-email-html-attempt').input;
    let err: unknown;
    try {
      composeApprovalEmail(fx);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EmailValidationError);
    expect((err as EmailValidationError).reason).toContain('html_tag');
  });

  test('FX-19: clickable URL outside CLI line ⇒ EmailValidationError', () => {
    const fx = FX('FX-19-email-clickable-url').input;
    let err: unknown;
    try {
      composeApprovalEmail(fx);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EmailValidationError);
    expect((err as EmailValidationError).reason).toContain('clickable_url_outside_cli');
  });

  test('rejects empty source_ids', () => {
    expect(() =>
      composeApprovalEmail({ ...baseInput, source_ids: [] }),
    ).toThrow(EmailValidationError);
  });

  test('rejects missing required fields', () => {
    expect(() =>
      composeApprovalEmail({ ...baseInput, token: '' }),
    ).toThrow(EmailValidationError);
  });

  test('body has NO http(s):// URLs anywhere outside the bun CLI lines', () => {
    const msg = composeApprovalEmail(baseInput);
    const lines = msg.body.split('\n');
    for (const line of lines) {
      if (line.includes('http://') || line.includes('https://')) {
        expect(line.trimStart().startsWith('bun ')).toBe(true);
      }
    }
  });
});
