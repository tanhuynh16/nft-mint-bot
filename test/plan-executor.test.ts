import { describe, expect, it, vi } from 'vitest';
import { PlanExecutor } from '../src/tx/plan-executor.js';
import { Metrics } from '../src/observability/metrics.js';
import type { MintPlan } from '../src/providers/mint-provider.js';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const ACCOUNT = { address: '0x1111111111111111111111111111111111111111' } as never;
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const SPENDER = '0x2222222222222222222222222222222222222222';

/** approve(0x2222…, 1_000_000) */
const APPROVE_DATA = ('0x095ea7b3' +
  '0000000000000000000000002222222222222222222222222222222222222222' +
  '00000000000000000000000000000000000000000000000000000000000f4240') as `0x${string}`;

function makePlan(): MintPlan {
  return {
    transactions: [
      { to: TOKEN, data: APPROVE_DATA, value: 0n, chain: 'base', label: 'approve' },
      {
        to: '0x3333333333333333333333333333333333333333',
        data: '0xabcdef',
        value: 0n,
        chain: 'base',
        label: 'mint',
      },
    ],
  };
}

function makeDeps(allowance: bigint) {
  const readContract = vi.fn().mockResolvedValue(allowance);
  const nonceManager = {
    reserve: vi.fn().mockReturnValue(7),
    markBroadcast: vi.fn(),
    markConfirmed: vi.fn(),
    markFailed: vi.fn(),
    releaseOnPreSignFailure: vi.fn(),
  };
  const broadcaster = {
    send: vi.fn().mockResolvedValue({ txHash: '0xhash', acceptedBy: 'rpc', latencyMs: 5, errors: [] }),
  };
  const monitor = {
    waitForReceipt: vi.fn().mockResolvedValue({
      receipt: { blockNumber: 1n },
      latencyMs: 10,
      succeeded: true,
    }),
  };

  return {
    deps: {
      resolved: { chain: { id: 8453 } },
      publicClient: { readContract },
      wallet: { signTransaction: vi.fn().mockResolvedValue('0xraw') },
      account: ACCOUNT,
      nonceManager,
      gasEngine: {
        calculate: vi.fn().mockResolvedValue({
          gas: 100000n,
          maxFeePerGas: 1000n,
          maxPriorityFeePerGas: 0n,
          ceilingApplied: false,
          maxFeeCost: 100000000n,
        }),
      },
      broadcaster,
      monitor,
      metrics: new Metrics(),
      logger: silentLogger,
      confirmationBlocks: 1,
      confirmationTimeoutMs: 30_000,
    } as never,
    readContract,
    broadcaster,
    nonceManager,
  };
}

describe('approve step skipping', () => {
  it('skips the approve when the existing allowance already covers the amount', async () => {
    // Checking the chain rather than local state means this also holds after a crash or
    // a re-run: a token approved by an earlier attempt is not approved again.
    const { deps, broadcaster } = makeDeps(2_000_000n);
    const result = await new PlanExecutor(deps).execute(makePlan());

    expect(result.steps[0]?.skipped).toBe(true);
    expect(result.steps[0]?.reason).toMatch(/allowance already/);
    expect(result.steps[1]?.skipped).toBe(false);
    // Only the mint step reached the network.
    expect(broadcaster.send).toHaveBeenCalledTimes(1);
  });

  it('runs the approve when the allowance is insufficient', async () => {
    const { deps, broadcaster } = makeDeps(5n);
    const result = await new PlanExecutor(deps).execute(makePlan());

    expect(result.steps[0]?.skipped).toBe(false);
    expect(broadcaster.send).toHaveBeenCalledTimes(2);
  });

  it('runs the approve when the allowance is exactly one short', async () => {
    const { deps, broadcaster } = makeDeps(999_999n);
    await new PlanExecutor(deps).execute(makePlan());
    expect(broadcaster.send).toHaveBeenCalledTimes(2);
  });

  it('executes the approve when the allowance check fails, rather than skipping blindly', async () => {
    // Omitting a step the mint depends on is worse than a redundant approval.
    const { deps, broadcaster } = makeDeps(0n);
    deps.publicClient.readContract = vi.fn().mockRejectedValue(new Error('rpc down'));

    await new PlanExecutor(deps).execute(makePlan());
    expect(broadcaster.send).toHaveBeenCalledTimes(2);
  });
});

describe('plan execution', () => {
  it('runs steps in order and reports the final hash', async () => {
    const { deps } = makeDeps(0n);
    const result = await new PlanExecutor(deps).execute(makePlan());

    expect(result.steps.map((s) => s.step)).toEqual([1, 2]);
    expect(result.finalTxHash).toBe('0xhash');
  });

  it('waits for each receipt before signing the next step', async () => {
    const { deps } = makeDeps(0n);
    await new PlanExecutor(deps).execute(makePlan());
    // Sequential by necessity: step 2 spends what step 1 authorises.
    expect(deps.monitor.waitForReceipt).toHaveBeenCalledTimes(2);
  });

  it('stops the plan when a step reverts instead of continuing', async () => {
    const { deps } = makeDeps(0n);
    deps.monitor.waitForReceipt = vi
      .fn()
      .mockResolvedValueOnce({ receipt: { blockNumber: 1n }, latencyMs: 1, succeeded: false });

    await expect(new PlanExecutor(deps).execute(makePlan())).rejects.toThrow(
      /Step 1 of 2 \(approve\) reverted/,
    );
  });

  it('broadcasts nothing in dry-run', async () => {
    const { deps, broadcaster } = makeDeps(0n);
    const result = await new PlanExecutor(deps).execute(makePlan(), true);

    expect(broadcaster.send).not.toHaveBeenCalled();
    expect(result.steps.every((s) => s.reason === 'dry-run')).toBe(true);
  });

  it('journals the broadcast before sending, so a crash is recoverable', async () => {
    const { deps, nonceManager } = makeDeps(2_000_000n);
    await new PlanExecutor(deps).execute(makePlan());

    expect(nonceManager.markBroadcast).toHaveBeenCalled();
    const markOrder = nonceManager.markBroadcast.mock.invocationCallOrder[0]!;
    const sendOrder = deps.broadcaster.send.mock.invocationCallOrder[0]!;
    expect(markOrder).toBeLessThan(sendOrder);
  });
});
