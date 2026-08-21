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
      stages: [],
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

  it('caps a single sleep at the re-resolve interval, so moved stages are noticed', async () => {
    store.add({ ...JOB, resolvedAt: iso(30 * 24 * 3_600_000) });
    const { runner, sleep } = makeRunner({ reresolveIntervalMs: 900_000 });

    await runner.tick();

    expect(sleep.mock.calls[0]![0]).toBeLessThanOrEqual(900_000);
  });

  it('fires once the job is inside the lead time', async () => {
    store.add({ ...JOB, resolvedAt: iso(60_000) });
    const { runner, mint } = makeRunner();

    const result = await runner.tick();

    expect(result.action).toBe('fired');
    expect(mint).toHaveBeenCalledWith('config/robinhood.yaml', {
      collectionSlug: 'testnftprofile',
      quantity: 1,
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
