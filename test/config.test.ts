import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/config/schema.js';
import { loadBotConfig, loadConfig } from '../src/config/loader.js';

const base = {
  network: { name: 'robinhood', chainId: 4663, orderingModel: 'fcfs', feeModel: 'orbit' },
  rpc: { endpoints: ['https://rpc.example.com'] },
  mint: { collectionSlug: 'xcopunks', quantity: 2 },
  gas: { maxGasGwei: 10 },
};

describe('config schema', () => {
  it('applies defaults for omitted sections', () => {
    const parsed = configSchema.parse(base);
    expect(parsed.execution.mode).toBe('preflight');
    expect(parsed.wallet.privateKeyEnv).toBe('PRIVATE_KEY');
    expect(parsed.mint.maxRetries).toBe(20);
  });

  it('forces parallel broadcast off on an fcfs chain', () => {
    // Fanning out cannot change ordering when one sequencer decides it; leaving the
    // flag on would just mislead the operator about what the bot is doing.
    const parsed = configSchema.parse({
      ...base,
      rpc: { endpoints: ['https://rpc.example.com'], parallelBroadcast: true },
    });
    expect(parsed.rpc.parallelBroadcast).toBe(false);
  });

  it('keeps parallel broadcast on a priority-auction chain', () => {
    const parsed = configSchema.parse({
      ...base,
      network: { name: 'ethereum', chainId: 1, orderingModel: 'priority-auction', feeModel: 'eip1559' },
      rpc: { endpoints: ['https://rpc.example.com'], parallelBroadcast: true },
    });
    expect(parsed.rpc.parallelBroadcast).toBe(true);
  });

  it('rejects presign outside race mode', () => {
    const result = configSchema.safeParse({
      ...base,
      execution: { mode: 'preflight', presign: true },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a custom fee above the ceiling', () => {
    const result = configSchema.safeParse({
      ...base,
      gas: { strategy: 'custom', maxGasGwei: 10, customMaxFeeGwei: 50 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects custom strategy without an explicit fee', () => {
    const result = configSchema.safeParse({
      ...base,
      gas: { strategy: 'custom', maxGasGwei: 10 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a quantity above the API maximum', () => {
    const result = configSchema.safeParse({ ...base, mint: { ...base.mint, quantity: 101 } });
    expect(result.success).toBe(false);
  });

  it('requires at least one RPC endpoint', () => {
    const result = configSchema.safeParse({ ...base, rpc: { endpoints: [] } });
    expect(result.success).toBe(false);
  });
});

describe('env interpolation', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** Writes a config whose single RPC endpoint is the reference under test. */
  function load(reference: string, env: NodeJS.ProcessEnv) {
    dir = mkdtempSync(join(tmpdir(), 'mintbot-cfg-'));
    const file = join(dir, 'c.yaml');
    writeFileSync(
      file,
      [
        'network:',
        '  name: robinhood',
        '  chainId: 4663',
        '  orderingModel: fcfs',
        '  feeModel: orbit',
        'rpc:',
        `  endpoints: ["${reference}"]`,
        'mint:',
        '  collectionSlug: xcopunks',
        '  quantity: 1',
        'gas:',
        '  maxGasGwei: 10',
      ].join('\n'),
    );
    return loadConfig(file, env);
  }

  it('substitutes a set variable', () => {
    const { config } = load('${BASE_RPC}', { BASE_RPC: 'https://set.example.com' });
    expect(config.rpc.endpoints[0]).toBe('https://set.example.com');
  });

  it('throws on an unset variable that has no default', () => {
    // This is what protects the values a run cannot work without.
    expect(() => load('${BASE_RPC}', {})).toThrow(/BASE_RPC/);
  });

  it('falls back to the inline default when the variable is unset', () => {
    const { config } = load('${BASE_RPC:-https://fallback.example.com}', {});
    expect(config.rpc.endpoints[0]).toBe('https://fallback.example.com');
  });

  it('prefers the variable over its default when both exist', () => {
    const { config } = load('${BASE_RPC:-https://fallback.example.com}', {
      BASE_RPC: 'https://override.example.com',
    });
    expect(config.rpc.endpoints[0]).toBe('https://override.example.com');
  });

  it('treats an empty variable as unset, so BASE_RPC= behaves like an omitted line', () => {
    const { config } = load('${BASE_RPC:-https://fallback.example.com}', { BASE_RPC: '' });
    expect(config.rpc.endpoints[0]).toBe('https://fallback.example.com');
  });

  it('keeps a URL containing a path and query intact in the default', () => {
    const { config } = load('${X:-https://rpc.example.com/v2/abc?k=1}', {});
    expect(config.rpc.endpoints[0]).toBe('https://rpc.example.com/v2/abc?k=1');
  });
});

describe('env is loaded before config is parsed', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    delete process.env.LOADER_TEST_RPC;
  });

  it('resolves a config whose values exist only in an env file', () => {
    // The regression this guards: three entry points read the config before any env file
    // was loaded, so every ${VAR} was unset and `mint`, `dry-run` and every scheduled
    // run failed. The process environment is deliberately clean here.
    dir = mkdtempSync(join(tmpdir(), 'mintbot-order-'));
    writeFileSync(join(dir, '.env'), 'LOADER_TEST_RPC=https://from-file.example.com\n');
    writeFileSync(
      join(dir, 'c.yaml'),
      [
        'network:',
        '  name: robinhood',
        '  chainId: 4663',
        '  orderingModel: fcfs',
        '  feeModel: orbit',
        'rpc:',
        '  endpoints: ["${LOADER_TEST_RPC}"]',
        'mint:',
        '  collectionSlug: x',
        '  quantity: 1',
        'gas:',
        '  maxGasGwei: 10',
      ].join('\n'),
    );

    expect(process.env.LOADER_TEST_RPC).toBeUndefined();

    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const { config } = loadBotConfig('c.yaml');
      expect(config.rpc.endpoints[0]).toBe('https://from-file.example.com');
    } finally {
      process.chdir(cwd);
    }
  });

  it('names the files it searched when a variable is genuinely missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'mintbot-order-'));
    writeFileSync(
      join(dir, 'c.yaml'),
      [
        'network:',
        '  name: robinhood',
        '  chainId: 4663',
        '  orderingModel: fcfs',
        '  feeModel: orbit',
        'rpc:',
        '  endpoints: ["${LOADER_TEST_RPC}"]',
        'mint:',
        '  collectionSlug: x',
        '  quantity: 1',
        'gas:',
        '  maxGasGwei: 10',
      ].join('\n'),
    );

    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(() => loadBotConfig('c.yaml')).toThrow(/Looked in/);
    } finally {
      process.chdir(cwd);
    }
  });

  it('is the only way source code reads a config', () => {
    // Structural, on purpose. The defect was a call site in the wrong place, so fixing
    // the three sites would leave the next one free to repeat it. Asserting that nothing
    // outside the loader calls loadConfig directly is what actually prevents recurrence.
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          if (full.endsWith(join('config', 'loader.ts'))) continue;
          if (/\bloadConfig\s*\(/.test(readFileSync(full, 'utf8'))) offenders.push(full);
        }
      }
    };
    walk('src');

    expect(offenders).toEqual([]);
  });
});
