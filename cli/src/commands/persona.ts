import { Command } from 'commander';
import chalk from 'chalk';
import { loadOptional } from '../utils/optional-package.js';
import { registerPersona, listPersonas } from '../utils/persona-registry.js';

export const personaCommand = new Command('persona')
  .description('Persona management commands')
  .addCommand(
    new Command('create')
      .description('Create a new persona')
      .argument('<name>', 'Persona name')
      .option('--domain <domain>', 'Domain', 'general')
      .option('--interactive', 'Interactive mode', false)
      .action(async (name, options) => {
        const { generatePersona } = await loadOptional<typeof import('zouroboros-personas')>(
          'zouroboros-personas',
          'persona create'
        );

        if (options.interactive) {
          console.log(chalk.cyan(`\n🎭 Creating persona: ${name}\n`));
          // Interactive mode would go here
        } else {
          const slug = name.toLowerCase().replace(/\s+/g, '-');
          const config = {
            name,
            slug,
            domain: options.domain,
            description: `${name} persona for ${options.domain} domain`,
            expertise: [],
            requiresApiKey: false,
            safetyRules: [],
            capabilities: [],
          };
          const genOptions = {
            outputDir: process.cwd(),
          };
          const result = await generatePersona(config, genOptions);
          const files = result.filter((r: any) => r.output).map((r: any) => r.output);

          // Record the persona so `list` can enumerate it (GitHub #382).
          const personaDir = result.find((r: any) => r.phase === 1)?.output;
          const skillDir = result.find((r: any) => r.phase === 6)?.output;
          if (personaDir) {
            registerPersona({
              name,
              slug,
              domain: options.domain,
              dir: personaDir,
              skillDir,
              createdAt: new Date().toISOString(),
            });
          }

          console.log(chalk.green(`✅ Persona '${name}' created`));
          console.log(chalk.gray(`   Phases: ${result.length} completed`));
          if (files.length > 0) {
            console.log(chalk.gray(`   Output: ${files.join(', ')}`));
          }
        }
      })
  )
  .addCommand(
    new Command('list')
      .description('List all personas')
      .action(() => {
        const personas = listPersonas();
        console.log(chalk.cyan('\nAvailable Personas:\n'));
        if (personas.length === 0) {
          console.log(chalk.gray('  (none yet)'));
          console.log(chalk.gray("  Create one with: zouroboros persona create <name>\n"));
          return;
        }
        for (const p of personas) {
          console.log(`  ${chalk.bold(p.name)} ${chalk.gray(`(${p.domain})`)}`);
          console.log(chalk.gray(`    ${p.dir}`));
        }
        console.log('');
      })
  );
