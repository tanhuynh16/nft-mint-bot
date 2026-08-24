import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { configSchema, type BotConfig } from './schema.js';
import { describeEnvSearch, loadEnvFile } from './env.js';

/**
 * Substitutes ${VAR} and ${VAR:-default} references from the environment.
 *
 * The two forms mean different things on purpose:
 *
 * - `${VAR}` is required. An unset value throws, which is what protects the secrets and
 *   endpoints a run cannot work without (PRIVATE_KEY, SEQUENCER_URL).
 * - `${VAR:-default}` is an optional override. This lets a config list every payment
 *   network at once, each falling back to a working public endpoint, without forcing an
 *   env var to be defined for every network the operator does not care about.
 *
 * An env var set to the empty string counts as unset, so `BASE_RPC=` in a .env behaves
 * the same as omitting the line rather than producing an empty URL.
 *
 * Interpolation happens on the parsed tree rather than the raw YAML text so that a
 * secret containing YAML metacharacters can never alter document structure.
 */
function interpolate(value: unknown, env: NodeJS.ProcessEnv, path: string[] = []): unknown {
  if (typeof value === 'string') {
    // The default may contain anything except a closing brace, which ends the reference.
    return value.replace(
      /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g,
      (_match, name: string, fallback: string | undefined) => {
        const resolved = env[name];
        if (resolved !== undefined && resolved !== '') return resolved;

        if (fallback !== undefined) return fallback;

        throw new Error(
          `Config references \${${name}} at "${path.join('.')}" but that env var is unset. ` +
            `Set it in .env or the environment, or give it a default with ` +
            `\${${name}:-some-value}.`,
        );
      },
    );
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => interpolate(item, env, [...path, String(i)]));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolate(v, env, [...path, k])]),
    );
  }
  return value;
}

export interface LoadedConfig {
  config: BotConfig;
  path: string;
}

/**
 * Loads the env file, then the config. The only entry point callers should use.
 *
 * Config interpolation reads `${VAR}` from the environment, so the env file has to be
 * loaded first. Leaving that ordering to each caller is how `mint`, `dry-run` and every
 * scheduled run broke: a new call site read the config before any env file existed and
 * every `${RPC_PRIMARY}` was unset.
 *
 * Fixing the call sites would have left the next one free to repeat it. Folding the
 * ordering in here makes the mistake unrepresentable, and puts the "which files did we
 * look in" report on every failure rather than only the one caller that remembered it.
 *
 * `loadEnvFile` is idempotent — dotenv never overwrites an existing variable — so calling
 * this from several entry points in one process is safe.
 */
export function loadBotConfig(configPath: string, envFileOverride?: string): LoadedConfig {
  const env = loadEnvFile(envFileOverride);

  try {
    return loadConfig(configPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n\n  ${describeEnvSearch(env)}`);
  }
}

export function loadConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): LoadedConfig {
  const absolute = resolve(configPath);

  let raw: string;
  try {
    raw = readFileSync(absolute, 'utf8');
  } catch (cause) {
    throw new Error(`Cannot read config at ${absolute}`, { cause });
  }

  const parsed: unknown = parseYaml(raw);
  const interpolated = interpolate(parsed, env);
  const result = configSchema.safeParse(interpolated);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid config at ${absolute}:\n${issues}`);
  }

  return { config: result.data, path: absolute };
}
