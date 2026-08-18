import { describe, expect, it, vi } from 'vitest';
import { CrossChainDropProvider } from '../src/providers/crosschain-drop-provider.js';
import { OpenSeaError } from '../src/opensea/client.js';
import type { DropsApi } from '../src/opensea/drops.js';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const MINTER = '0x1111111111111111111111111111111111111111' as const;
const NATIVE = '0x0000000000000000000000000000000000000000';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// approve(spender, amount) selector + padded args
const APPROVE_DATA =
  '0x095ea7b3' +
  '0000000000000000000000002222222222222222222222222222222222222222' +
  '00000000000000000000000000000000000000000000000000000000000f4240';

function makeProvider(response: unknown, paymentToken = NATIVE) {
  const drops = {
    buildCrossChainMint: vi.fn().mockResolvedValue(response),
    getDrop: vi.fn(),
  } as unknown as DropsApi;

  const provider = new CrossChainDropProvider(
    drops,
    {
      slug: 'xcopunks',
      minter: MINTER,
      payer: MINTER,
      paymentChain: 'base',
      paymentToken,
    },
    silentLogger,
  );
  return { provider, drops };
}

describe('cross-chain plan parsing', () => {
  it('produces a single step for a native-token payment', async () => {
    const { provider } = makeProvider({
      transactions: [
        { chain: 'base', to: '0x3333333333333333333333333333333333333333', data: '0xabcd', value: '1000' },
      ],
      receipt_request: { relay_request_id: 'relay-1', request_id: 'req-1' },
    });

    const plan = await provider.buildMintPlan(1n);

    expect(plan.transactions).toHaveLength(1);
    expect(plan.transactions[0]?.label).toBe('mint');
    expect(plan.transactions[0]?.value).toBe(1000n);
    expect(plan.relayRequestId).toBe('relay-1');
  });

  it('labels an ERC-20 approve step so it can be skipped when already allowed', async () => {
    const { provider } = makeProvider(
      {
        transactions: [
          { chain: 'base', to: USDC_BASE, data: APPROVE_DATA, value: '0' },
          { chain: 'base', to: '0x3333333333333333333333333333333333333333', data: '0xabcd', value: '0' },
        ],
      },
      USDC_BASE,
    );

    const plan = await provider.buildMintPlan(1n);

    expect(plan.transactions.map((t) => t.label)).toEqual(['approve', 'mint']);
  });

  it('prefers value_hex over the decimal value', async () => {
    const { provider } = makeProvider({
      transactions: [
        {
          chain: 'base',
          to: '0x3333333333333333333333333333333333333333',
          data: '0x',
          value: '999',
          value_hex: '0x3e8',
        },
      ],
    });

    const plan = await provider.buildMintPlan(1n);
    expect(plan.transactions[0]?.value).toBe(1000n);
  });

  it('passes the payment chain and token through to the API', async () => {
    const { provider, drops } = makeProvider({ transactions: [
      { chain: 'base', to: '0x3333333333333333333333333333333333333333', data: '0x', value: '0' },
    ] }, USDC_BASE);

    await provider.buildMintPlan(3n);

    expect(drops.buildCrossChainMint).toHaveBeenCalledWith('xcopunks', MINTER, MINTER, 3, {
      chain: 'base',
      token_address: USDC_BASE,
    });
  });
});

describe('cross-chain safety guards', () => {
  it('refuses a step on a chain other than the configured payment chain', async () => {
    // The whole design rests on every step running on the payment chain. If a route
    // ever spans chains, stopping beats signing somewhere the operator did not choose.
    const { provider } = makeProvider({
      transactions: [
        { chain: 'base', to: '0x3333333333333333333333333333333333333333', data: '0x', value: '0' },
        { chain: 'ethereum', to: '0x4444444444444444444444444444444444444444', data: '0x', value: '0' },
      ],
    });

    await expect(provider.buildMintPlan(1n)).rejects.toThrow(
      /chain "ethereum".*payment chain is "base"/s,
    );
  });

  it('rejects an empty transaction list', async () => {
    const { provider } = makeProvider({ transactions: [] });
    await expect(provider.buildMintPlan(1n)).rejects.toThrow(/empty transaction list/);
  });

  it('refuses buildMint(), which would silently drop the approve step', async () => {
    const { provider } = makeProvider({ transactions: [] });
    await expect(provider.buildMint()).rejects.toThrow(/buildMintPlan/);
  });

  it('treats a 400 as config, not something to retry', async () => {
    const { provider } = makeProvider({ transactions: [] });
    expect(provider.classifyError(new OpenSeaError('client', 400, 'bad payment token'))).toBe(
      'config',
    );
  });

  it('still treats 409 as a stage that has not opened', async () => {
    const { provider } = makeProvider({ transactions: [] });
    expect(provider.classifyError(new OpenSeaError('not-active', 409, 'x'))).toBe('not-active');
  });
});
