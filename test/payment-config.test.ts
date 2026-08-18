import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/config/schema.js';

const base = {
  network: { name: 'robinhood', chainId: 4663, orderingModel: 'fcfs', feeModel: 'orbit' },
  rpc: { endpoints: ['https://rpc.example.com'] },
  mint: { collectionSlug: 'xcopunks', quantity: 1 },
  gas: { maxGasGwei: 10 },
};

const crossChain = {
  mode: 'cross-chain',
  chain: 'base',
  token: '0x0000000000000000000000000000000000000000',
};

const withBaseRpc = {
  endpoints: ['https://rpc.example.com'],
  paymentEndpoints: { base: ['https://mainnet.base.org'] },
};

describe('payment mode defaults', () => {
  it('defaults to native — the fast path — when payment is omitted', () => {
    const parsed = configSchema.parse(base);
    expect(parsed.mint.payment.mode).toBe('native');
  });

  it('accepts an explicit native mode', () => {
    const parsed = configSchema.parse({
      ...base,
      mint: { ...base.mint, payment: { mode: 'native' } },
    });
    expect(parsed.mint.payment.mode).toBe('native');
  });

  it('rejects leftover chain/token under native rather than ignoring them', () => {
    // A half-edited payment block must fail loudly; silently ignoring the fields would
    // let someone believe they configured cross-chain when they did not.
    const result = configSchema.safeParse({
      ...base,
      mint: { ...base.mint, payment: { mode: 'native', chain: 'base', token: '0x00' } },
    });
    expect(result.success).toBe(false);
  });
});

describe('cross-chain payment config', () => {
  it('accepts a complete cross-chain block', () => {
    const parsed = configSchema.parse({
      ...base,
      rpc: withBaseRpc,
      mint: { ...base.mint, payment: crossChain },
    });
    expect(parsed.mint.payment).toMatchObject({ mode: 'cross-chain', chain: 'base' });
  });

  it('requires chain and token', () => {
    expect(
      configSchema.safeParse({
        ...base,
        rpc: withBaseRpc,
        mint: { ...base.mint, payment: { mode: 'cross-chain' } },
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed token address', () => {
    expect(
      configSchema.safeParse({
        ...base,
        rpc: withBaseRpc,
        mint: { ...base.mint, payment: { ...crossChain, token: 'not-an-address' } },
      }).success,
    ).toBe(false);
  });

  it('does not require a paymentEndpoints entry — known chains carry a built-in RPC', () => {
    // Choosing a payment network is enough on its own; requiring a second config edit
    // to name an RPC is exactly the friction this replaced.
    const result = configSchema.safeParse({
      ...base,
      mint: { ...base.mint, payment: crossChain },
    });
    expect(result.success).toBe(true);
  });

  it('still accepts an explicit override', () => {
    const parsed = configSchema.parse({
      ...base,
      rpc: withBaseRpc,
      mint: { ...base.mint, payment: crossChain },
    });
    expect(parsed.rpc.paymentEndpoints.base).toEqual(['https://mainnet.base.org']);
  });
});

describe('cross-chain is refused where it would defeat the point', () => {
  it('rejects cross-chain payment with execution.mode: race', () => {
    const result = configSchema.safeParse({
      ...base,
      rpc: withBaseRpc,
      mint: { ...base.mint, payment: crossChain },
      execution: { mode: 'race' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/race/);
    }
  });

  it('rejects cross-chain payment with presign', () => {
    const result = configSchema.safeParse({
      ...base,
      rpc: withBaseRpc,
      mint: { ...base.mint, payment: crossChain },
      execution: { mode: 'race', presign: true },
    });
    expect(result.success).toBe(false);
  });

  it('still allows race mode under native payment', () => {
    const result = configSchema.safeParse({
      ...base,
      mint: { ...base.mint, payment: { mode: 'native' } },
      execution: { mode: 'race', presign: true },
    });
    expect(result.success).toBe(true);
  });
});
