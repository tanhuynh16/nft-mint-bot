import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/config/schema.js';
import { loadConfig } from '../src/config/loader.js';

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
