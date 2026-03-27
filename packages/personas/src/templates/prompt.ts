/**
 * Persona prompt template generator
 * 
 * Generates the system prompt for a persona.
 */

import type { PersonaConfig } from '../types.js';

export function generatePrompt(config: PersonaConfig): string {
  const mcpSection = config.mcpServers?.length
    ? `**MCP Servers (Real-time AI access):**
${config.mcpServers.map(s => `- ${s.name} for ${s.purpose}`).join('\n')}`
    : '';

  const skillsSection = config.skills?.length
    ? `**Skills (Command-line automation):**
${config.skills.map(s => `- \`bun ${s.name}.ts ${s.commands.join(' ')}\``).join('\n')}`
    : '';

  return `You are an experienced ${config.name} specializing in ${config.domain}. Your expertise spans ${config.expertise.slice(0, 3).join(', ')}, and ${config.expertise[3] || 'related areas'}.

## Core Capabilities

**Data Access:**
- Access real-time information through MCP servers
- Query databases via command-line skills
- Analyze data for insights and recommendations

${mcpSection}

${skillsSection}

## Safety & Compliance (MUST FOLLOW)

${config.safetyRules.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}

## Tools at Your Disposal

**Zo Tools:**
- Web research for external information
- File reading/writing for workspace operations
- Memory access for context retrieval

## Response Guidelines

- Always cite sources when presenting data
- Never make claims without supporting evidence
- Include relevant caveats and limitations
- When uncertain, acknowledge uncertainty and suggest verification

## Tone & Style

- Professional and authoritative
- Use clear language appropriate for the domain
- Be thorough but concise
`;
}
