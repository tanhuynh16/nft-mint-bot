import { describe, expect, it, vi } from 'vitest';
import { encodeErrorResult } from 'viem';
import { decodeSeaDropRevert, verifyAgainstChain, waitForContractConfigured } from '../src/tx/presign.js';
import { seaDropAbi } from '../src/providers/seadrop-abi.js';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const SD = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5' as const;
const NFT = '0x2db811758b6923d70fa7643ae83589974f29795d' as const;
const FROM = '0xD68E51C40E41FA52Ef0aBa8166d85f0B9C764A3d' as const;
const TX = { to: SD, data: '0x161ac21f' as `0x${string}`, value: 10_000_000_000_000n };

/** A viem-shaped failure carrying raw revert data in its cause chain. */
function revertWith(name: string, args: readonly unknown[] = []) {
  const data = encodeErrorResult({ abi: seaDropAbi, errorName: name as never, args: args as never });
  const inner: Record<string, unknown> = { data };
  const outer: Record<string, unknown> = {
    message: 'Execution reverted for an unknown reason.',
    cause: inner,
  };
  return Object.assign(new Error('Execution reverted for an unknown reason.'), outer);
}

function client(onCall: () => Promise<unknown>) {
  return { call: vi.fn().mockImplementation(onCall) } as never;
}

describe('decoding SeaDrop reverts', () => {
  it('recovers the error name from raw revert data', () => {
    expect(decodeSeaDropRevert(revertWith('FeeRecipientNotAllowed'))).toBe('FeeRecipientNotAllowed');
  });

  it('decodes an error carrying arguments', () => {
    expect(decodeSeaDropRevert(revertWith('IncorrectPayment', [0n, 10n]))).toBe('IncorrectPayment');
  });

  it('returns nothing for an unrelated failure', () => {
    expect(decodeSeaDropRevert(new Error('socket hang up'))).toBeUndefined();
  });
});

describe('verifying calldata against the chain', () => {
  it('passes when the call succeeds', async () => {
    const v = await verifyAgainstChain(client(async () => ({})), TX, FROM, silentLogger);
    expect(v.kind).toBe('ok');
  });

  it('treats NotActive as armable — the stage simply has not opened', async () => {
    // This is the verdict that makes pre-signing possible before a race. OpenSea's mint
    // endpoint answers 409 until a stage opens, so the chain is the only source that can
    // confirm calldata in advance.
    const err = revertWith('NotActive', [1n, 2n, 3n]);
    const v = await verifyAgainstChain(client(async () => { throw err; }), TX, FROM, silentLogger);
    expect(v.kind).toBe('not-yet');
  });

  it('refuses a wrong fee recipient', async () => {
    // The real defect this caught: the provider used the creator payout address, which
    // reverts every time. Arming on it would have burned a nonce for nothing.
    const err = revertWith('FeeRecipientNotAllowed');
    const v = await verifyAgainstChain(client(async () => { throw err; }), TX, FROM, silentLogger);
    expect(v).toMatchObject({ kind: 'wrong', detail: 'FeeRecipientNotAllowed' });
  });

  it.each([
    ['IncorrectPayment', [0n, 10n]],
    ['MintQuantityCannotBeZero', []],
    ['MintQuantityExceedsMaxSupply', [1n, 2n]],
  ] as const)('refuses %s', async (name, args) => {
    const err = revertWith(name, args);
    const v = await verifyAgainstChain(client(async () => { throw err; }), TX, FROM, silentLogger);
    expect(v).toMatchObject({ kind: 'wrong', detail: name });
  });

  it('refuses on insufficient funds rather than arming a doomed transaction', async () => {
    const v = await verifyAgainstChain(
      client(async () => { throw new Error('insufficient funds for gas * price + value'); }),
      TX, FROM, silentLogger,
    );
    expect(v.kind).toBe('wrong');
  });
});

describe('waiting for the contract to be configured', () => {
  const configured = { startTime: 1_800_000_000n, endTime: 1_900_000_000n, mintPrice: 10n,
    maxTotalMintableByWallet: 3n, feeBps: 500n, restrictFeeRecipients: true };
  const unconfigured = { ...configured, startTime: 0n, endTime: 0n };

  function pc(sequence: Array<{ drop: unknown; fees: unknown[] }>) {
    let i = 0;
    return {
      readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
        const step = sequence[Math.min(i, sequence.length - 1)]!;
        if (functionName === 'getAllowedFeeRecipients') { i += 1; return Promise.resolve(step.fees); }
        return Promise.resolve(step.drop);
      }),
    } as never;
  }

  it('returns immediately when already configured', async () => {
    const ok = await waitForContractConfigured({
      publicClient: pc([{ drop: configured, fees: ['0xfee'] }]),
      contractAddress: NFT, logger: silentLogger,
    });
    expect(ok).toBe(true);
  });

  it('keeps waiting while the stage is unset, then arms when it appears', async () => {
    // Observed on a live drop: OpenSea knew the schedule days ahead while the contract
    // still reported zeroes.
    const sleep = vi.fn().mockResolvedValue(undefined);
    const ok = await waitForContractConfigured({
      publicClient: pc([
        { drop: unconfigured, fees: [] },
        { drop: unconfigured, fees: [] },
        { drop: configured, fees: ['0xfee'] },
      ]),
      contractAddress: NFT, logger: silentLogger, sleep, pollMs: 10,
    });
    expect(ok).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up at the deadline so the run falls back instead of hanging', async () => {
    let clock = 0;
    const ok = await waitForContractConfigured({
      publicClient: pc([{ drop: unconfigured, fees: [] }]),
      contractAddress: NFT, logger: silentLogger,
      timeoutMs: 100, pollMs: 10,
      now: () => (clock += 60),
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    expect(ok).toBe(false);
  });

  it('does not arm on a configured stage with no allowed fee recipient', async () => {
    // Both are required: without a fee recipient the calldata cannot be built at all.
    let clock = 0;
    const ok = await waitForContractConfigured({
      publicClient: pc([{ drop: configured, fees: [] }]),
      contractAddress: NFT, logger: silentLogger,
      timeoutMs: 50, pollMs: 10,
      now: () => (clock += 30),
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    expect(ok).toBe(false);
  });
});
