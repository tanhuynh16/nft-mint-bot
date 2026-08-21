import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSigner, loadAccount } from '../src/wallet/signer.js';
import { resolveChain } from '../src/chains/registry.js';
import { configSchema } from '../src/config/schema.js';

// Generated per run rather than hardcoded. A literal key in a source file is
// indistinguishable from a real one to any scanner — including this repo's own
// pre-commit hook, which is right to reject it rather than learn exceptions.
const KEY = generatePrivateKey();
const ADDRESS = privateKeyToAccount(KEY).address;
const ENV = { PRIVATE_KEY: KEY } as NodeJS.ProcessEnv;

function setup(overrides: Record<string, unknown> = {}) {
  const config = configSchema.parse({
    network: { name: 'robinhood', chainId: 4663, orderingModel: 'fcfs', feeModel: 'orbit' },
    rpc: {
      endpoints: ['https://read.example.com'],
      submitEndpoint: 'https://sequencer.example.com',
    },
    mint: { collectionSlug: 'x', quantity: 1 },
    gas: { maxGasGwei: 10 },
    ...overrides,
  });
  return { config, chain: resolveChain(config) };
}

describe('signing transport', () => {
  it('never points the wallet client at the submit endpoint', () => {
    // The bug this guards: viem's signTransaction calls eth_chainId before signing, and
    // a dedicated sequencer answers -32601 to every method except eth_sendRawTransaction.
    // Pointing the signer there makes every signature fail — invisible until a real mint.
    const { config, chain } = setup();
    const { wallet } = createSigner(config, chain, ENV);

    expect(wallet.transport.url).toBe('https://read.example.com');
    expect(wallet.transport.url).not.toBe(chain.submitUrl);
  });

  it('still carries the chain, so viem asserts the signed network', () => {
    const { config, chain } = setup();
    expect(createSigner(config, chain, ENV).wallet.chain?.id).toBe(4663);
  });

  it('falls back to the submit endpoint only when no read endpoint exists', () => {
    const { config, chain } = setup();
    const { wallet } = createSigner(config, { ...chain, readUrls: [] }, ENV);
    expect(wallet.transport.url).toBe(chain.submitUrl);
  });
});

describe('key loading', () => {
  it('derives a stable address from the configured key', () => {
    const { config, chain } = setup();
    expect(createSigner(config, chain, ENV).account.address).toBe(ADDRESS);
  });

  it('refuses to sign when the derived address is not the expected one', () => {
    // Guards against loading a stray key from the environment.
    const { config } = setup({
      wallet: { expectedAddress: '0x1111111111111111111111111111111111111111' },
    });
    expect(() => loadAccount(config, ENV)).toThrow(/expectedAddress|Refusing/i);
  });

  it('rejects a malformed key without echoing it', () => {
    const { config } = setup();
    expect(() => loadAccount(config, { PRIVATE_KEY: 'not-a-key' } as NodeJS.ProcessEnv)).toThrow(
      /not a valid 32-byte hex private key/,
    );
  });

  it('reports which env var is missing when no key is set', () => {
    const { config } = setup();
    expect(() => loadAccount(config, {} as NodeJS.ProcessEnv)).toThrow(/PRIVATE_KEY/);
  });
});
