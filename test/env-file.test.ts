import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describeEnvSearch, loadEnvFile } from '../src/config/env.js';

let dir: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mintbot-env-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ['MINT_BOT_ENV_FILE', 'TEST_ONLY_VAR']) delete process.env[k];
  Object.assign(process.env, saved);
});

function writeEnv(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

describe('env file resolution', () => {
  it('loads an explicitly named file', () => {
    // The VPS case: secrets live outside the working directory.
    const path = writeEnv('etc-env', 'TEST_ONLY_VAR=from-explicit\n');
    const result = loadEnvFile(path);
    expect(result.loaded).toBe(path);
    expect(process.env.TEST_ONLY_VAR).toBe('from-explicit');
  });

  it('falls back to MINT_BOT_ENV_FILE', () => {
    const path = writeEnv('via-var', 'TEST_ONLY_VAR=from-var\n');
    process.env.MINT_BOT_ENV_FILE = path;
    expect(loadEnvFile().loaded).toBe(path);
    expect(process.env.TEST_ONLY_VAR).toBe('from-var');
  });

  it('prefers the explicit path over the env var', () => {
    const explicit = writeEnv('explicit', 'TEST_ONLY_VAR=explicit-wins\n');
    process.env.MINT_BOT_ENV_FILE = writeEnv('other', 'TEST_ONLY_VAR=var-loses\n');
    expect(loadEnvFile(explicit).loaded).toBe(explicit);
    expect(process.env.TEST_ONLY_VAR).toBe('explicit-wins');
  });

  it('never overwrites a variable already in the environment', () => {
    // systemd injects the daemon's environment; a file on disk must not clobber it.
    process.env.TEST_ONLY_VAR = 'from-systemd';
    loadEnvFile(writeEnv('conflict', 'TEST_ONLY_VAR=from-file\n'));
    expect(process.env.TEST_ONLY_VAR).toBe('from-systemd');
  });

  it('reports the paths it searched when nothing is found', () => {
    // Run from a directory with no .env, so the chain reaches the deployed location
    // instead of short-circuiting on the repo's own file.
    const cwd = process.cwd();
    process.chdir(dir);
    const result = loadEnvFile(join(dir, 'does-not-exist'));
    process.chdir(cwd);
    expect(result.loaded).toBeUndefined();
    // The original error said "set it in .env" without saying which .env, which is why
    // this took a live VPS session to diagnose.
    const described = describeEnvSearch(result);
    expect(described).toMatch(/does-not-exist/);
    expect(described).toMatch(/\/etc\/nft-mint-bot\/env/);
  });

  it('names the file it loaded', () => {
    const path = writeEnv('named', 'TEST_ONLY_VAR=x\n');
    expect(describeEnvSearch(loadEnvFile(path))).toContain(path);
  });

  it('reaches the deployed location when nothing earlier exists', () => {
    const cwd = process.cwd();
    process.chdir(dir);
    const searched = loadEnvFile(join(dir, 'nope')).searched;
    process.chdir(cwd);
    expect(searched).toContain('/etc/nft-mint-bot/env');
  });

  it('stops at the first file that exists', () => {
    // Short-circuiting is the intended behaviour: a local .env wins over the system one.
    const local = writeEnv('.env', 'TEST_ONLY_VAR=local\n');
    const cwd = process.cwd();
    process.chdir(dir);
    const result = loadEnvFile();
    process.chdir(cwd);
    // realpath, not resolve: on macOS /var is a symlink to /private/var, and cwd
    // reports the real path after chdir.
    expect(result.loaded).toBe(realpathSync(local));
    expect(result.searched).not.toContain('/etc/nft-mint-bot/env');
  });
});
