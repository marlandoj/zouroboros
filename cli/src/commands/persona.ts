import { Command } from 'commander';
import chalk from 'chalk';

export const personaCommand = new Command('persona')
  .description('Persona management commands')
  .addCommand(
    new Command('create')
      .description('Create a new persona')
      .argument('<name>', 'Persona name')
      .option('--domain <domain>', 'Domain', 'general')
      .option('--interactive', 'Interactive mode', false)
      .action(async (name, options) => {
        const { generatePersona } = await import('zouroboros-personas');
        
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
        console.log(chalk.cyan('\nAvailable Personas:\n'));
        console.log('Run with --interactive to create one.\n');
      })
  );