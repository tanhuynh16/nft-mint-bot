import { describe, expect, it, vi } from 'vitest';
import { verifyLocalEncoding } from '../src/tx/presign.js';
import type { MintProvider, UnsignedTx } from '../src/providers/mint-provider.js';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function fakeProvider(tx: UnsignedTx, supportsLocalEncoding = true): MintProvider {
  return {
    name: 'fake',
    supportsLocalEncoding,
    resolveTarget: vi.fn(),
    getStatus: vi.fn(),
    buildMint: vi.fn().mockResolvedValue(tx),
    classifyError: vi.fn(),
  } as unknown as MintProvider;
}

const CANONICAL: UnsignedTx = {
  to: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  data: '0x161ac21f0000000000000000000000000000000000000000000000000000000000000001',
  value: 1_000_000_000_000_000n,
};

describe('verifyLocalEncoding', () => {
  it('accepts calldata identical to the API output', async () => {
    const result = await verifyLocalEncoding(
      fakeProvider(CANONICAL),
      fakeProvider(CANONICAL),
      1n,
      silentLogger,
    );
    expect(result.matches).toBe(true);
    expect(result.differences).toHaveLength(0);
  });

  it('ignores address casing, which is not a real difference', async () => {
    const result = await verifyLocalEncoding(
      fakeProvider(CANONICAL),
      fakeProvider({ ...CANONICAL, to: CANONICAL.to.toLowerCase() as `0x${string}` }),
      1n,
      silentLogger,
    );
    expect(result.matches).toBe(true);
  });

  it('rejects a mismatched target contract', async () => {
    const result = await verifyLocalEncoding(
      fakeProvider(CANONICAL),
      fakeProvider({
        ...CANONICAL,
        to: '0x1111111111111111111111111111111111111111',
      }),
      1n,
      silentLogger,
    );
    expect(result.matches).toBe(false);
    expect(result.differences[0]).toMatch(/^to:/);
  });

  it('rejects mismatched calldata — the case that would revert at T0', async () => {
    // A wrong fee recipient baked into the calldata looks fine until the mint reverts,
    // by which point the window is gone. This check is what prevents that.
    const result = await verifyLocalEncoding(
      fakeProvider(CANONICAL),
      fakeProvider({ ...CANONICAL, data: '0xdeadbeef' }),
      1n,
      silentLogger,
    );
    expect(result.matches).toBe(false);
    expect(result.differences[0]).toMatch(/^data:/);
  });

  it('rejects a mismatched value', async () => {
    const result = await verifyLocalEncoding(
      fakeProvider(CANONICAL),
      fakeProvider({ ...CANONICAL, value: 999n }),
      1n,
      silentLogger,
    );
    expect(result.matches).toBe(false);
    expect(result.differences[0]).toMatch(/^value:/);
  });

  it('reports every difference at once, not just the first', async () => {
    const result = await verifyLocalEncoding(
      fakeProvider(CANONICAL),
      fakeProvider({
        to: '0x1111111111111111111111111111111111111111',
        data: '0xdeadbeef',
        value: 999n,
      }),
      1n,
      silentLogger,
    );
    expect(result.differences).toHaveLength(3);
  });
});
