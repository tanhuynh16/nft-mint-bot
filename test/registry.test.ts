import { describe, expect, it } from 'vitest';
import { resolveChain } from '../src/chains/registry.js';
import { configSchema } from '../src/config/schema.js';

function parse(overrides: Record<string, unknown>) {
  return configSchema.parse({
    network: { name: 'robinhood', chainId: 4663, orderingModel: 'fcfs', feeModel: 'orbit' },
    rpc: { endpoints: ['https://rpc.example.com'] },
    mint: { collectionSlug: 'xcopunks', quantity: 1 },
    gas: { maxGasGwei: 10 },
    ...overrides,
  });
}

describe('resolveChain', () => {
  it('recognises Robinhood Chain as fcfs/orbit and routes writes to the sequencer', () => {
    const resolved = resolveChain(parse({}));
    expect(resolved.chain.id).toBe(4663);
    expect(resolved.orderingModel).toBe('fcfs');
    expect(resolved.feeModel).toBe('orbit');
    expect(resolved.submitUrl).toBe('https://sequencer.mainnet.chain.robinhood.com');
  });

  it('rejects a config that misdescribes a known chain as an auction', () => {
    // The whole gas strategy hinges on this field; a wrong value would have the bot
    // bidding for priority on a chain that ignores priority.
    expect(() =>
      resolveChain(
        parse({
          network: {
            name: 'robinhood',
            chainId: 4663,
            orderingModel: 'priority-auction',
            feeModel: 'orbit',
          },
        }),
      ),
    ).toThrow(/orderingModel/);
  });

  it('rejects a mismatched fee model', () => {
    expect(() =>
      resolveChain(
        parse({
          network: {
            name: 'robinhood',
            chainId: 4663,
            orderingModel: 'fcfs',
            feeModel: 'eip1559',
          },
        }),
      ),
    ).toThrow(/feeModel/);
  });

  it('lets an explicit submitEndpoint win over the built-in sequencer', () => {
    const resolved = resolveChain(
      parse({
        rpc: {
          endpoints: ['https://rpc.example.com'],
          submitEndpoint: 'https://my-node.example.com',
        },
      }),
    );
    expect(resolved.submitUrl).toBe('https://my-node.example.com');
  });

  it('accepts an unknown chain that declares its own models', () => {
    const resolved = resolveChain(
      parse({
        network: {
          name: 'somechain',
          chainId: 999_999,
          orderingModel: 'fcfs',
          feeModel: 'eip1559',
        },
      }),
    );
    expect(resolved.chain.id).toBe(999_999);
    expect(resolved.submitUrl).toBe('https://rpc.example.com');
  });

  it('identifies Ethereum as a priority auction', () => {
    const resolved = resolveChain(
      parse({
        network: {
          name: 'ethereum',
          chainId: 1,
          orderingModel: 'priority-auction',
          feeModel: 'eip1559',
        },
      }),
    );
    expect(resolved.orderingModel).toBe('priority-auction');
  });
});
