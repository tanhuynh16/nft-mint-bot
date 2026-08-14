import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { configSchema, type BotConfig } from './schema.js';

/**
 * Substitutes ${VAR} references from the environment.
 *
 * Interpolation happens on the parsed tree rather than the raw YAML text so that a
 * secret containing YAML metacharacters can never alter document structure.
 */
function interpolate(value: unknown, env: NodeJS.ProcessEnv, path: string[] = []): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
      const resolved = env[name];
      if (resolved === undefined || resolved === '') {
        throw new Error(
          `Config references \${${name}} at "${path.join('.')}" but that env var is unset. ` +
            `Set it in .env or the environment.`,
        );
      }
      return resolved;
    });
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
