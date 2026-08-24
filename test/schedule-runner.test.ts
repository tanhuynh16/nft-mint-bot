import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScheduleRunner } from '../src/schedule/runner.js';
import { ScheduleStore } from '../src/schedule/store.js';
import type { DropsApi } from '../src/opensea/drops.js';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

let dir: string;
let store: ScheduleStore;

const JOB = {
  slug: 'testnftprofile',
  configPath: 'config/robinhood.yaml',
  quantity: 1,
  when: { kind: 'auto' } as const,
  maxSpendWei: '2010000000000000',
};

function makeDrops(startTime = iso(3_600_000)) {
  return {
    getDrop: vi.fn().mockResolvedValue({
      collection_slug: 'testnftprofile',
      contract_address: '0x2db811758b6923d70fa7643ae83589974f29795d',
      chain: 'robinhood',
      stages: [
        {
          label: 'Public',
          stage_type: 'public_sale',
          start_time: startTime,
          price: '10000000000000',
        },
      ],
      active_stage: null,
      next_stage: { label: 'Public', start_time: startTime, price: '10000000000000' },
    }),
  } as unknown as DropsApi;
}

function makeRunner(overrides: Record<string, unknown> = {}) {
  const sleep = vi.fn().mockResolvedValue(undefined);
  const mint = vi.fn().mockResolvedValue({
    outcome: { state: 'CONFIRMED', txHash: '0xabc', attempts: 1, metrics: {} },
  });
  const drops = (overrides.drops as DropsApi) ?? makeDrops();

  const runner = new ScheduleRunner({
    store,
    drops,
    logger: silentLogger,
    leadTimeMs: 120_000,
    now: () => NOW,
    sleep,
    mint: mint as never,
    ...overrides,
  });

  return { runner, sleep, mint, drops };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mintbot-runner-'));
  store = new ScheduleStore(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('rate-limit guard', () => {
  it('sleeps instead of firing when a job is hours away', async () => {
    // The point of the daemon: handing a distant job to the mint flow would have its
    // stage poller hit OpenSea every 15s for hours and exhaust the rate limit.
    store.add({ ...JOB, resolvedAt: iso(6 * 3_600_000) });
    const { runner, sleep, mint } = makeRunner();

    const result = await runner.tick();

    expect(result.action).toBe('slept');
    expect(mint).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalled();
  });

  it('never sleeps longer than maxNapMs, however distant the job', async () => {
    // The regression: tick() used to sleep up to reresolveIntervalMs (15 minutes) in one
    // go, so a job added meanwhile went unseen for that long. One mint fired 6m48s late
    // and another had its stage close before the scheduler ever reached it.
    store.add({ ...JOB, resolvedAt: iso(30 * 24 * 3_600_000) });
    const { runner, sleep } = makeRunner({ reresolveIntervalMs: 900_000, maxNapMs: 60_000 });

    await runner.tick();

    expect(sleep.mock.calls[0]![0]).toBeLessThanOrEqual(60_000);
    expect(sleep.mock.calls[0]![0]).not.toBe(900_000);
  });

  it('re-reads the queue each tick, so a job added while waiting is picked up', async () => {
    store.add({ ...JOB, slug: 'distant', resolvedAt: iso(30 * 24 * 3_600_000) });
    const { runner, mint } = makeRunner({ maxNapMs: 60_000 });

    await runner.tick();                       // naps on the distant job
    store.add({ ...JOB, slug: 'urgent', resolvedAt: iso(1_000) });  // added meanwhile
    const result = await runner.tick();

    expect(result.action).toBe('fired');
    expect(mint.mock.calls[0]![1].collectionSlug).toBe('urgent');
  });

  it('still sleeps the exact remaining time inside the lead window', async () => {
    // The cap governs idle waiting only. Firing accuracy must be untouched.
    store.add({ ...JOB, resolvedAt: iso(45_000) });
    const { runner, sleep } = makeRunner({ maxNapMs: 60_000 });

    await runner.tick();

    expect(sleep).toHaveBeenCalledWith(45_000);
  });

  it('fires once the job is inside the lead time', async () => {
    store.add({ ...JOB, resolvedAt: iso(60_000) });
    const { runner, mint } = makeRunner();

    const result = await runner.tick();

    expect(result.action).toBe('fired');
    // allWallets: a per-wallet cap means one wallet can only win its own allocation, so a
    // scheduled job fires from every configured wallet.
    expect(mint).toHaveBeenCalledWith('config/robinhood.yaml', {
      collectionSlug: 'testnftprofile',
      quantity: 1,
      allWallets: true,
    });
  });

  it('does nothing when there are no pending jobs', async () => {
    const { runner, mint } = makeRunner();
    expect((await runner.tick()).action).toBe('idle');
    expect(mint).not.toHaveBeenCalled();
  });
});

describe('firing and outcomes', () => {
  it('marks a confirmed mint done and records the hash', async () => {
    const job = store.add({ ...JOB, resolvedAt: iso(0) });
    const { runner } = makeRunner();

    await runner.tick();

    const after = store.get(job.id)!;
    expect(after.status).toBe('done');
    expect(after.txHash).toBe('0xabc');
    expect(after.attempts).toBe(1);
  });

  it('marks a failed mint failed rather than retrying forever', async () => {
    const job = store.add({ ...JOB, resolvedAt: iso(0) });
    const { runner } = makeRunner({
      mint: vi.fn().mockResolvedValue({
        outcome: { state: 'FAILED', attempts: 1, error: 'sold out', metrics: {} },
      }),
    });

    await runner.tick();

    const after = store.get(job.id)!;
    expect(after.status).toBe('failed');
    expect(after.error).toBe('sold out');
    // Terminal, so it is not picked up again.
    expect(store.pending()).toHaveLength(0);
  });

  it('records a thrown error without crashing the daemon', async () => {
    const job = store.add({ ...JOB, resolvedAt: iso(0) });
    const { runner } = makeRunner({
      mint: vi.fn().mockRejectedValue(new Error('rpc exploded')),
    });

    await expect(runner.tick()).resolves.toBeDefined();
    expect(store.get(job.id)!.error).toMatch(/rpc exploded/);
  });

  it('takes the earliest job first', async () => {
    store.add({ ...JOB, slug: 'later', resolvedAt: iso(90_000) });
    store.add({ ...JOB, slug: 'sooner', resolvedAt: iso(10_000) });
    const { runner, mint } = makeRunner();

    await runner.tick();

    expect(mint.mock.calls[0]![1].collectionSlug).toBe('sooner');
  });
});

describe('restart reconciliation', () => {
  it('re-arms a job that was armed when the process died', async () => {
    const job = store.add({ ...JOB, resolvedAt: iso(60_000) });
    store.update(job.id, { status: 'armed' });

    makeRunner().runner.reconcile();

    expect(store.get(job.id)!.status).toBe('pending');
  });

  it('never silently re-fires a job that was mid-flight', async () => {
    // The transaction may already have been broadcast — the journal records the hash
    // before sending. Guessing here either double-mints or skips the drop, so it stops
    // and says so instead.
    const job = store.add({ ...JOB, resolvedAt: iso(60_000) });
    store.update(job.id, { status: 'running' });

    makeRunner().runner.reconcile();

    const after = store.get(job.id)!;
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/may have been broadcast/i);
  });

  it('leaves finished jobs untouched', () => {
    const job = store.add({ ...JOB, resolvedAt: iso(0) });
    store.update(job.id, { status: 'done', txHash: '0xdone' });

    makeRunner().runner.reconcile();

    expect(store.get(job.id)!.status).toBe('done');
  });
});

describe('closed stages', () => {
  /** A drop whose targeted stage has already ended, plus one still open. */
  function dropWithEndedStage() {
    return {
      getDrop: vi.fn().mockResolvedValue({
        collection_slug: 'meozz',
        contract_address: '0xaaa',
        chain: 'robinhood',
        stages: [
          {
            label: 'Team',
            stage_type: 'signed_presale',
            price: '0',
            start_time: iso(-6 * 3_600_000),
            end_time: iso(-60_000),
          },
          {
            label: 'WhiteList',
            stage_type: 'signed_presale',
            price: '0',
            start_time: iso(-30_000),
            end_time: iso(30 * 24 * 3_600_000),
          },
        ],
        active_stage: null,
        next_stage: null,
      }),
    } as unknown as DropsApi;
  }

  it('fails a job whose stage closed while the daemon was down', async () => {
    // The real case: the service crash-looped for hours, and by the time it recovered
    // the Team stage had ended. Building a transaction against it cannot succeed.
    const job = store.add({ ...JOB, slug: 'meozz', stageLabel: 'Team', resolvedAt: iso(-3_600_000) });
    const { runner, mint } = makeRunner({ drops: dropWithEndedStage() });

    const result = await runner.tick();

    expect(result.action).toBe('skipped');
    expect(mint).not.toHaveBeenCalled();
    const after = store.get(job.id)!;
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/closed/i);
  });

  it('still fires a job whose stage is open', async () => {
    const job = store.add({
      ...JOB,
      slug: 'meozz',
      stageLabel: 'WhiteList',
      resolvedAt: iso(-30_000),
    });
    const { runner, mint } = makeRunner({ drops: dropWithEndedStage() });

    const result = await runner.tick();

    expect(result.action).toBe('fired');
    expect(mint).toHaveBeenCalled();
    expect(store.get(job.id)!.status).toBe('done');
  });

  it('fires a job with no recorded stage rather than skipping it', async () => {
    // Jobs added before stages were tracked have no stageLabel. Skipping those would
    // silently drop a mintable job — worse than a wasted attempt.
    store.add({ ...JOB, resolvedAt: iso(0) });
    const { runner, mint } = makeRunner({ drops: dropWithEndedStage() });

    expect((await runner.tick()).action).toBe('fired');
    expect(mint).toHaveBeenCalled();
  });

  it('fires when the drop cannot be read, rather than assuming the worst', async () => {
    store.add({ ...JOB, stageLabel: 'WhiteList', resolvedAt: iso(0) });
    const { runner, mint } = makeRunner({
      drops: { getDrop: vi.fn().mockRejectedValue(new Error('429')) } as unknown as DropsApi,
    });

    expect((await runner.tick()).action).toBe('fired');
    expect(mint).toHaveBeenCalled();
  });
});

describe('re-resolve cadence', () => {
  it('does not re-check a stage more often than the interval, despite frequent naps', async () => {
    // Waking 15x more often must not multiply API calls: re-resolution runs on its own
    // clock rather than being tied to how long the daemon slept.
    store.add({ ...JOB, resolvedAt: iso(30 * 24 * 3_600_000) });
    const drops = makeDrops();
    const { runner } = makeRunner({ drops, maxNapMs: 60_000, reresolveIntervalMs: 900_000 });

    for (let i = 0; i < 5; i += 1) await runner.tick();

    expect((drops.getDrop as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('re-checks once the interval has elapsed', async () => {
    store.add({ ...JOB, resolvedAt: iso(30 * 24 * 3_600_000) });
    const drops = makeDrops();
    let clock = NOW;
    const { runner } = makeRunner({
      drops,
      maxNapMs: 60_000,
      reresolveIntervalMs: 900_000,
      now: () => clock,
    });

    await runner.tick();
    clock += 900_001;
    await runner.tick();

    expect((drops.getDrop as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
});

describe('moved stage times', () => {
  it('picks up a stage that moved later', async () => {
    const job = store.add({ ...JOB, resolvedAt: iso(6 * 3_600_000) });
    const moved = iso(8 * 3_600_000);
    const { runner } = makeRunner({ drops: makeDrops(moved), reresolveIntervalMs: 1 });

    await runner.tick();

    expect(store.get(job.id)!.resolvedAt).toBe(moved);
  });

  it('keeps the previous time when the API cannot be reached', async () => {
    const original = iso(6 * 3_600_000);
    const job = store.add({ ...JOB, resolvedAt: original });
    const { runner } = makeRunner({
      drops: { getDrop: vi.fn().mockRejectedValue(new Error('429')) } as unknown as DropsApi,
      reresolveIntervalMs: 1,
    });

    await runner.tick();

    expect(store.get(job.id)!.resolvedAt).toBe(original);
  });
});
