#!/usr/bin/env bun
/**
 * CLI for Zouroboros Personas
 * 
 * Usage: zouroboros-personas <command> [options]
 */

import { parseArgs } from 'util';
import { generatePersona } from '../generators/persona.js';
import type { PersonaConfig } from '../types.js';

function printHelp() {
  console.log(`
zouroboros-personas — Persona creation and management

USAGE:
  zouroboros-personas create [options]
  zouroboros-personas template <type>
  zouroboros-personas validate <config.json>

COMMANDS:
  create      Interactive persona creation
  template    Generate a template file
  validate    Validate a persona config

OPTIONS:
  --name, -n          Persona name
  --domain, -d        Domain (financial, healthcare, legal, etc.)
  --output, -o        Output directory (default: ./personas)
  --skip-soul         Skip SOUL.md generation
  --skip-skill        Skip skill directory creation
  --help, -h          Show this help

EXAMPLES:
  zouroboros-personas create --name "Health Coach" --domain healthcare
  zouroboros-personas create --name "Financial Advisor" --domain financial --output ./my-personas
  zouroboros-personas template config
`);
}

async function interactiveCreate(): Promise<void> {
  console.log('\n🎭 Interactive Persona Creation\n');
  
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(`${prompt}: `, (answer) => resolve(answer.trim()));
    });
  };

  try {
    const name = await question('Persona name (e.g., "Health Coach")');
    if (!name) {
      console.error('❌ Persona name is required');
      process.exit(1);
    }

    const domain = await question('Domain (e.g., healthcare, financial, legal)') || 'general';
    const description = await question('Description') || `${name} - ${domain} assistant`;
    
    console.log('\nEnter areas of expertise (press Enter to finish):');
    const expertise: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const exp = await question(`  Expertise ${i}`);
      if (!exp) break;
      expertise.push(exp);
    }

    console.log('\nEnter capabilities (press Enter to finish):');
    const capabilities: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const cap = await question(`  Capability ${i}`);
      if (!cap) break;
      capabilities.push(cap);
    }

    const needsApiKey = (await question('Does this persona need an API key? (y/n)')).toLowerCase() === 'y';
    
    let apiKeyName = '';
    if (needsApiKey) {
      apiKeyName = await question(`API key name (e.g., ${domain.toUpperCase()}_API_KEY)`) || 
        `${domain.toUpperCase()}_API_KEY`;
    }

    const safetyRules = [
      'Always verify information before providing recommendations',
      'Include disclaimers for all advice',
      'Respect user privacy and data security',
    ];

    const config: PersonaConfig = {
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      domain,
      description,
      expertise,
      requiresApiKey: needsApiKey,
      apiKeyName: apiKeyName || undefined,
      safetyRules,
      capabilities: capabilities.length ? capabilities : [`${domain} analysis`, 'Recommendations', 'Data access'],
    };

    console.log('\n⚙️  Generating persona files...\n');
    
    const results = await generatePersona(config, {
      outputDir: './personas',
      skipSOUL: false,
      skipSkill: false,
    });

    console.log('\n✅ Persona created successfully!\n');
    
    for (const result of results) {
      const icon = result.status === 'complete' ? '✅' : result.status === 'skipped' ? '⏭️' : '⏳';
      console.log(`${icon} Phase ${result.phase}: ${result.name}`);
      if (result.output) {
        console.log(`   Output: ${result.output}`);
      }
    }

    console.log(`\n📁 Persona directory: ./personas/${config.slug}/`);
    console.log('\nNext steps:');
    console.log('  1. Review SOUL.md for constitution alignment');
    console.log('  2. Customize IDENTITY.md for presentation layer');
    console.log('  3. Update PROMPT.md with specific instructions');
    console.log('  4. Import persona into your Zo Computer');

  } finally {
    rl.close();
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      name: { type: 'string', short: 'n' },
      domain: { type: 'string', short: 'd' },
      output: { type: 'string', short: 'o', default: './personas' },
      'skip-soul': { type: 'boolean', default: false },
      'skip-skill': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    printHelp();
    process.exit(0);
  }

  const command = positionals[0];

  switch (command) {
    case 'create':
      if (values.name && values.domain) {
        // Non-interactive mode
        const config: PersonaConfig = {
          name: values.name,
          slug: values.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          domain: values.domain,
          description: `${values.name} - ${values.domain} assistant`,
          expertise: ['Analysis', 'Recommendations', 'Domain expertise'],
          requiresApiKey: false,
          safetyRules: [
            'Always verify information before providing recommendations',
            'Include disclaimers for all advice',
            'Respect user privacy and data security',
          ],
          capabilities: ['Data analysis', 'Recommendations', 'Research'],
        };

        console.log(`\n⚙️  Creating persona: ${values.name}\n`);
        
        const results = await generatePersona(config, {
          outputDir: values.output,
          skipSOUL: values['skip-soul'],
          skipSkill: values['skip-skill'],
        });

        for (const result of results) {
          const icon = result.status === 'complete' ? '✅' : '⏭️';
          console.log(`${icon} Phase ${result.phase}: ${result.name}`);
        }

        console.log(`\n✅ Persona created at: ${values.output}/${config.slug}/`);
      } else {
        // Interactive mode
        await interactiveCreate();
      }
      break;

    case 'template':
      console.log(`
{
  "name": "Example Persona",
  "domain": "financial",
  "description": "Financial advisor specializing in portfolio management",
  "expertise": ["Portfolio management", "Risk analysis", "Tax optimization"],
  "requiresApiKey": true,
  "apiKeyName": "FINANCIAL_API_KEY",
  "safetyRules": [
    "Always verify information before providing recommendations",
    "Include disclaimers for all advice"
  ],
  "capabilities": [
    "Portfolio analysis",
    "Investment recommendations",
    "Risk assessment"
  ]
}
`);
      break;

    case 'validate':
      console.log('Validation not yet implemented');
      break;

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
