import { describe, expect, it } from 'vitest';
import { resolveChain } from '../src/chains/registry.js';
import {
  CHAIN_PROFILES,
  defaultRpcUrls,
  getChainProfileBySlug,
  supportedPaymentChains,
} from '../src/chains/profiles.js';
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

describe('payment chain slugs', () => {
  /**
   * The exact `chain` identifiers OpenSea's GET /api/v2/chains returns for the networks
   * the bot can execute on. A stale slug here is invisible until a mint is attempted and
   * the API rejects it — "matic" was wrong for Polygon and only surfaced when a run
   * against that network failed.
   */
  const OPENSEA_SLUGS = ['ethereum', 'optimism', 'polygon', 'base', 'arbitrum', 'robinhood'];

  it.each(OPENSEA_SLUGS)('resolves the OpenSea slug "%s" to a profile', (slug) => {
    expect(getChainProfileBySlug(slug)).toBeDefined();
  });

  it('does not resolve the retired "matic" slug', () => {
    expect(getChainProfileBySlug('matic')).toBeUndefined();
  });

  it('is case-insensitive, since slugs arrive from config and the API alike', () => {
    expect(getChainProfileBySlug('BASE')?.chain.id).toBe(8453);
  });

  it('returns undefined for an unknown chain rather than guessing', () => {
    expect(getChainProfileBySlug('notachain')).toBeUndefined();
  });

  it('lists every supported chain', () => {
    expect(supportedPaymentChains()).toEqual(expect.arrayContaining(OPENSEA_SLUGS));
  });
});

describe('built-in RPC defaults', () => {
  it('gives every profile at least one usable https endpoint', () => {
    // This is what lets choosing a payment network switch RPCs with no config edit.
    for (const profile of Object.values(CHAIN_PROFILES)) {
      const urls = defaultRpcUrls(profile);
      expect(urls.length).toBeGreaterThan(0);
      expect(urls[0]).toMatch(/^https:\/\//);
    }
  });

  it('returns a copy, so a caller cannot mutate the shared chain definition', () => {
    const profile = getChainProfileBySlug('base')!;
    defaultRpcUrls(profile).push('https://injected.example.com');
    expect(defaultRpcUrls(profile)).not.toContain('https://injected.example.com');
  });

  it('points each chain at its own network, not a shared one', () => {
    // Guards the class of bug where one chain's endpoint leaks into another's config.
    const hosts = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'].map(
      (s) => new URL(defaultRpcUrls(getChainProfileBySlug(s)!)[0]!).host,
    );
    expect(new Set(hosts).size).toBe(hosts.length);
  });
});
