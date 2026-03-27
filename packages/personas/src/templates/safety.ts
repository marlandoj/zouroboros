/**
 * Safety rules template generator
 * 
 * Generates safety rules for a persona.
 */

import type { PersonaConfig, SafetyRule } from '../types.js';

const DOMAIN_SAFETY_RULES: Record<string, SafetyRule[]> = {
  financial: [
    { id: 'fin-1', rule: 'Never execute trades without explicit user confirmation', category: 'safety', severity: 'critical' },
    { id: 'fin-2', rule: 'Position size must not exceed 5% of portfolio per recommendation', category: 'safety', severity: 'critical' },
    { id: 'fin-3', rule: 'Always include stop-loss levels with buy recommendations', category: 'safety', severity: 'high' },
    { id: 'fin-4', rule: 'Include disclaimers that this is not professional financial advice', category: 'compliance', severity: 'critical' },
  ],
  healthcare: [
    { id: 'health-1', rule: 'Clarify that you are not a medical doctor or licensed healthcare provider', category: 'compliance', severity: 'critical' },
    { id: 'health-2', rule: 'Recommend consulting healthcare providers for medical conditions', category: 'safety', severity: 'critical' },
    { id: 'health-3', rule: 'Verify recommendations align with user\'s stated goals and conditions', category: 'safety', severity: 'high' },
  ],
  legal: [
    { id: 'legal-1', rule: 'Clarify that you are not an attorney and cannot provide legal advice', category: 'compliance', severity: 'critical' },
    { id: 'legal-2', rule: 'Recommend consulting qualified legal counsel for specific matters', category: 'safety', severity: 'critical' },
  ],
  security: [
    { id: 'sec-1', rule: 'Never expose API keys, passwords, or credentials in output', category: 'security', severity: 'critical' },
    { id: 'sec-2', rule: 'Require explicit confirmation for destructive security operations', category: 'safety', severity: 'critical' },
  ],
};

export function generateSafetyRules(config: PersonaConfig): SafetyRule[] {
  const domainRules = DOMAIN_SAFETY_RULES[config.domain.toLowerCase()] || [];
  
  const baseRules: SafetyRule[] = [
    { id: 'base-1', rule: 'Always verify information before providing recommendations', category: 'safety', severity: 'high' },
    { id: 'base-2', rule: 'Include disclaimers for all advice', category: 'compliance', severity: 'medium' },
    { id: 'base-3', rule: 'Respect user privacy and data security', category: 'privacy', severity: 'critical' },
    { id: 'base-4', rule: 'Stay within defined expertise scope', category: 'safety', severity: 'high' },
  ];

  return [...baseRules, ...domainRules];
}

export function generateSafetyMarkdown(config: PersonaConfig): string {
  const rules = generateSafetyRules(config);
  
  return `# Safety Rules — ${config.name}

*Critical guardrails for safe operation.*

## Critical Rules (Must Follow)

${rules.filter(r => r.severity === 'critical').map(r => `- **${r.id}**: ${r.rule}`).join('\n') || '- None defined'}

## High Priority Rules

${rules.filter(r => r.severity === 'high').map(r => `- **${r.id}**: ${r.rule}`).join('\n') || '- None defined'}

## Standard Rules

${rules.filter(r => r.severity === 'medium' || r.severity === 'low').map(r => `- **${r.id}**: ${r.rule}`).join('\n') || '- None defined'}

## Rule Categories

| Category | Rules |
|----------|-------|
| Safety | ${rules.filter(r => r.category === 'safety').length} |
| Compliance | ${rules.filter(r => r.category === 'compliance').length} |
| Privacy | ${rules.filter(r => r.category === 'privacy').length} |
| Ethics | ${rules.filter(r => r.category === 'ethics').length} |

---

*These rules are enforced by the persona system. Violations will trigger alerts.*
`;
}
