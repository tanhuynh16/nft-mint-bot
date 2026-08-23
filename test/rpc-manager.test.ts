import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcManager } from '../src/network/rpc-manager.js';
import { resolveChain } from '../src/chains/registry.js';
import { configSchema } from '../src/config/schema.js';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function setup(submitEndpoint?: string) {
  const config = configSchema.parse({
    network: { name: 'robinhood', chainId: 4663, orderingModel: 'fcfs', feeModel: 'orbit' },
    rpc: {
      endpoints: ['https://read.example.com'],
      ...(submitEndpoint ? { submitEndpoint } : {}),
    },
    mint: { collectionSlug: 'x', quantity: 1 },
    gas: { maxGasGwei: 10 },
  });
  const resolved = resolveChain(config);
  return new RpcManager(config, resolved, silentLogger);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('write-only sequencer probing', () => {
  it('treats -32602 from eth_sendRawTransaction as healthy', async () => {
    // A live Arbitrum sequencer answers "missing value for required argument 0" —
    // proof the method exists without submitting anything.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: async () => ({ error: { code: -32602, message: 'missing value' } }),
      }),
    );

    const manager = setup('https://sequencer.example.com');
    const health = await manager.probe();
    const submit = health.find((h) => h.url === 'https://sequencer.example.com');

    expect(submit?.ok).toBe(true);
  });

  it('marks the endpoint unhealthy when it does not serve eth_sendRawTransaction', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: async () => ({ error: { code: -32601, message: 'method not found' } }),
      }),
    );

    const manager = setup('https://sequencer.example.com');
    const health = await manager.probe();
    const submit = health.find((h) => h.url === 'https://sequencer.example.com');

    expect(submit?.ok).toBe(false);
    expect(submit?.error).toMatch(/does not serve/);
  });

  it('never selects a write-only sequencer for reads', async () => {
    // Reads must go to the full node: the sequencer would reject getBalance,
    // estimateGas, and getTransactionCount outright.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: async () => ({ error: { code: -32602, message: 'missing value' } }),
      }),
    );

    const manager = setup('https://sequencer.example.com');
    await manager.probe();

    expect(manager.primary().transport.url).toBe('https://read.example.com');
  });
});
