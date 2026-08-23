import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/config/schema.js';

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
