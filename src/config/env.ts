import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

/** Where a deployed install keeps its secrets, outside the repo so git can never see them. */
export const SYSTEM_ENV_PATH = '/etc/nft-mint-bot/env';

export interface EnvLoadResult {
  /** The file that was loaded, if any. */
  loaded?: string;
  /** Every path considered, in order — reported when a variable turns up missing. */
  searched: string[];
}

/**
 * Loads secrets from the first env file that exists.
 *
 * Plain `dotenv` looks only in the current working directory, which quietly breaks a
 * deployed install: systemd injects `EnvironmentFile=` into the daemon, but a manual
 * `sudo -u mintbot node dist/cli/index.js …` inherits nothing and fails with an unset
 * variable. Searching a chain means the same command works from a laptop and from a
 * server without remembering a flag.
 *
 * Variables already present in the environment always win — dotenv does not overwrite —
 * so the systemd-injected daemon environment is never disturbed by a file on disk.
 */
export function loadEnvFile(explicitPath?: string): EnvLoadResult {
  const candidates = [
    explicitPath,
    process.env.MINT_BOT_ENV_FILE,
    '.env',
    SYSTEM_ENV_PATH,
  ].filter((p): p is string => Boolean(p));

  const searched: string[] = [];

  for (const candidate of candidates) {
    const path = resolve(candidate);
    searched.push(path);
    if (!existsSync(path)) continue;

    const result = loadDotenv({ path, quiet: true });
    if (result.error) {
      throw new Error(`Could not read env file ${path}: ${result.error.message}`);
    }
    return { loaded: path, searched };
  }

  // Not an error on its own: the daemon gets everything from systemd and needs no file.
  return { searched };
}

/**
 * Explains where secrets were looked for.
 *
 * Appended to a missing-variable error because "set it in .env" does not say *which*
 * .env — the ambiguity that turned this into a debugging session on a live VPS.
 */
export function describeEnvSearch(result: EnvLoadResult): string {
  if (result.loaded) return `Loaded env from ${result.loaded}.`;
  return `No env file found. Looked in: ${result.searched.join(', ')}.`;
}
