import { describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadAccountFor, walletSpecs, type WalletSpec } from '../src/wallet/signer.js';
import { configSchema } from '../src/config/schema.js';

const K1 = generatePrivateKey();
const K2 = generatePrivateKey();
const K3 = generatePrivateKey();
const A1 = privateKeyToAccount(K1).address;
const A2 = privateKeyToAccount(K2).address;

const ENV = { PRIMARY_KEY: K1, SECOND_KEY: K2, THIRD_KEY: K3 } as NodeJS.ProcessEnv;

function cfg(wallet: Record<string, unknown>) {
  return configSchema.parse({
    network: { name: 'robinhood', chainId: 4663, orderingModel: 'fcfs', feeModel: 'orbit' },
    rpc: { endpoints: ['https://rpc.example.com'] },
    mint: { collectionSlug: 'x', quantity: 1 },
    gas: { maxGasGwei: 10 },
    wallet,
  });
}

describe('wallet specs', () => {
  it('yields just the primary when none are added', () => {
    const specs = walletSpecs(cfg({ privateKeyEnv: 'PRIMARY_KEY' }));
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ privateKeyEnv: 'PRIMARY_KEY', label: 'primary' });
  });

  it('keeps the primary first, then the additional wallets in order', () => {
    const specs = walletSpecs(
      cfg({
        privateKeyEnv: 'PRIMARY_KEY',
        additional: [{ privateKeyEnv: 'SECOND_KEY' }, { privateKeyEnv: 'THIRD_KEY', label: 'burner' }],
      }),
    );
    expect(specs.map((s) => s.label)).toEqual(['primary', 'wallet-2', 'burner']);
  });

  it('leaves a single-wallet config completely unchanged', () => {
    // Multi-wallet must be purely additive; an existing deployment should not shift.
    const specs = walletSpecs(cfg({}));
    expect(specs).toHaveLength(1);
    expect(specs[0]!.privateKeyEnv).toBe('PRIVATE_KEY');
  });
});

describe('loading each wallet', () => {
  const spec = (privateKeyEnv: string, extra: Partial<WalletSpec> = {}): WalletSpec => ({
    privateKeyEnv,
    label: 'test',
    ...extra,
  });

  it('derives a distinct address per wallet', () => {
    // Distinct addresses are what give independent nonce sequences, which is the whole
    // reason these can fire concurrently.
    expect(loadAccountFor(spec('PRIMARY_KEY'), ENV).address).toBe(A1);
    expect(loadAccountFor(spec('SECOND_KEY'), ENV).address).toBe(A2);
    expect(A1).not.toBe(A2);
  });

  it('names the wallet and its env var when the key is missing', () => {
    expect(() => loadAccountFor(spec('NOPE', { label: 'burner' }), ENV)).toThrow(/NOPE.*burner|burner.*NOPE/s);
  });

  it('rejects a malformed key without echoing it', () => {
    expect(() => loadAccountFor(spec('BAD'), { BAD: 'not-a-key' } as NodeJS.ProcessEnv)).toThrow(
      /not a valid 32-byte hex private key/,
    );
  });

  it('enforces expectedAddress per wallet', () => {
    expect(() =>
      loadAccountFor(spec('SECOND_KEY', { expectedAddress: A1 }), ENV),
    ).toThrow(/Refusing to sign with the wrong wallet/);
  });

  it('accepts a matching expectedAddress', () => {
    expect(loadAccountFor(spec('SECOND_KEY', { expectedAddress: A2 }), ENV).address).toBe(A2);
  });
});

describe('journal isolation', () => {
  it('gives each wallet its own journal file name', async () => {
    // TxJournal keys on `${chainId}-${address}`, so separate wallets cannot share nonce
    // state. This is the invariant that makes concurrent firing safe.
    const { TxJournal } = await import('../src/wallet/journal.js');
    const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
    const a = new TxJournal('.schedule-test', 4663, A1, 'r', silent, false);
    const b = new TxJournal('.schedule-test', 4663, A2, 'r', silent, false);
    expect(a.path).not.toBe(b.path);
    expect(a.path.toLowerCase()).toContain(A1.toLowerCase());
  });
});
