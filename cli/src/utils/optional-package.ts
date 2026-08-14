import chalk from 'chalk';

/**
 * Loads a package that ships only with the full workspace, not the MVP bundle.
 * On a bundle where the package is absent, prints a clean hint and exits 1
 * instead of surfacing a raw module-resolution stack trace.
 */
export async function loadOptional<T>(pkg: string, command: string): Promise<T> {
  try {
    return (await import(pkg)) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const notFound =
      (err as { code?: string })?.code === 'ERR_MODULE_NOT_FOUND' ||
      /cannot find (module|package)/i.test(message);
    if (notFound) {
      console.log(
        chalk.yellow(`\n'${command}' is not part of the Zouroboros MVP bundle.`)
      );
      console.log(
        chalk.gray(
          `It needs the optional '${pkg}' package. Install the full workspace to enable it.`
        )
      );
      process.exit(1);
    }
    throw err;
  }
}
