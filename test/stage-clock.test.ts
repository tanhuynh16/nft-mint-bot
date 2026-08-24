import { describe, expect, it, vi } from 'vitest';
import { StageClock } from '../src/tx/stage-clock.js';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const CONTRACT = '0x2db811758b6923d70fa7643ae83589974f29795d' as const;

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);
const secs = (ms: number) => BigInt(Math.floor(ms / 1000));

/** Shape matching SeaDrop's getPublicDrop tuple. */
function publicDrop(startMs: number, endMs: number, price = 10_000_000_000_000n, max = 100n) {
  return {
    mintPrice: price,
    startTime: secs(startMs),
    endTime: secs(endMs),
    maxTotalMintableByWallet: max,
    feeBps: 500n,
    restrictFeeRecipients: true,
  };
}

function makeClock(readResult: unknown, opts: Record<string, unknown> = {}) {
  const sleep = vi.fn().mockResolvedValue(undefined);
  const readContract =
    readResult instanceof Error
      ? vi.fn().mockRejectedValue(readResult)
      : vi.fn().mockResolvedValue(readResult);

  const clock = new StageClock({
    publicClient: { readContract } as never,
    contractAddress: CONTRACT,
    logger: silentLogger,
    now: () => NOW,
    sleep,
    ...opts,
  });

  return { clock, sleep, readContract };
}

describe('reading the window', () => {
  it('reads start, end, price and cap from the contract', async () => {
    const { clock } = makeClock(publicDrop(NOW + 60_000, NOW + 3_600_000));
    const w = await clock.readWindow();

    expect(w?.startsAtMs).toBe(NOW + 60_000);
    expect(w?.pricePerToken).toBe(10_000_000_000_000n);
    expect(w?.maxPerWallet).toBe(100n);
  });

  it('treats an all-zero drop as no window', async () => {
    // A deconfigured or finished drop reports zeroes rather than reverting — observed on
    // a real sold-out collection. Reading that as "opens in 1970" would fire instantly.
    const { clock } = makeClock(publicDrop(0, 0, 0n, 0n));
    expect(await clock.readWindow()).toBeUndefined();
  });

  it('returns nothing when the contract cannot answer', async () => {
    // Allowlist stages, ERC-1155 drops and non-SeaDrop contracts all land here. This is
    // a normal outcome, not a failure — the caller falls back to polling.
    const { clock } = makeClock(new Error('execution reverted'));
    expect(await clock.readWindow()).toBeUndefined();
  });
});

describe('waiting for the open', () => {
  it('sleeps exactly until the start instant', async () => {
    const { clock, sleep } = makeClock(publicDrop(NOW + 45_000, NOW + 3_600_000));

    expect(await clock.waitForOpen()).toBe(true);
    expect(sleep).toHaveBeenCalledWith(45_000);
  });

  it('never sleeps a negative duration once the stage is open', async () => {
    // Firing early on a pre-signed transaction reverts NotActive, and its fixed nonce
    // means that transaction is then dead. Being early costs more than being slow.
    const { clock, sleep } = makeClock(publicDrop(NOW - 10_000, NOW + 3_600_000));

    expect(await clock.waitForOpen()).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('refuses a window that has already closed', async () => {
    const { clock, sleep } = makeClock(publicDrop(NOW - 7_200_000, NOW - 3_600_000));

    expect(await clock.waitForOpen()).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('reports no window rather than waiting forever when unreadable', async () => {
    const { clock, sleep } = makeClock(new Error('no such function'));

    expect(await clock.waitForOpen()).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('accepts a window already read, without a second call', async () => {
    const { clock, readContract } = makeClock(publicDrop(NOW + 1_000, NOW + 3_600_000));
    const w = await clock.readWindow();
    readContract.mockClear();

    await clock.waitForOpen(w);

    expect(readContract).not.toHaveBeenCalled();
  });
});

describe('drift against OpenSea metadata', () => {
  it('warns when the contract and the API disagree materially', async () => {
    const warn = vi.fn();
    const { clock } = makeClock(publicDrop(NOW + 60_000, NOW + 3_600_000), {
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    });
    const w = (await clock.readWindow())!;

    // API says a minute later than the contract.
    clock.reportDrift(w, new Date(NOW + 120_000).toISOString());

    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0]![0]).toMatchObject({ driftMs: -60_000 });
  });

  it('stays quiet when they agree within tolerance', async () => {
    const warn = vi.fn();
    const { clock } = makeClock(publicDrop(NOW + 60_000, NOW + 3_600_000), {
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    });
    const w = (await clock.readWindow())!;

    clock.reportDrift(w, new Date(NOW + 60_500).toISOString());

    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores a missing or unparseable API time', async () => {
    const warn = vi.fn();
    const { clock } = makeClock(publicDrop(NOW + 60_000, NOW + 3_600_000), {
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    });
    const w = (await clock.readWindow())!;

    clock.reportDrift(w, undefined);
    clock.reportDrift(w, 'next tuesday');

    expect(warn).not.toHaveBeenCalled();
  });
});
