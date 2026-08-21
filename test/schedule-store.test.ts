import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScheduleStore, isTerminal } from '../src/schedule/store.js';

let dir: string;
let store: ScheduleStore;

const JOB = {
  slug: 'testnftprofile',
  configPath: 'config/robinhood.yaml',
  quantity: 1,
  when: { kind: 'auto' } as const,
  maxSpendWei: '2010000000000000',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mintbot-sched-'));
  store = new ScheduleStore(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('CRUD', () => {
  it('starts empty', () => {
    expect(store.all()).toEqual([]);
  });

  it('adds a job with an id and timestamps', () => {
    const job = store.add(JOB);
    expect(job.id).toMatch(/^[0-9a-f]{6}$/);
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(store.all()).toHaveLength(1);
  });

  it('gives every job a distinct id', () => {
    const ids = new Set(Array.from({ length: 25 }, () => store.add(JOB).id));
    expect(ids.size).toBe(25);
  });

  it('round-trips through the file, not just memory', () => {
    const job = store.add({ ...JOB, quantity: 7 });
    // A second instance reads what actually reached disk.
    expect(new ScheduleStore(dir).get(job.id)?.quantity).toBe(7);
  });

  it('updates a job and bumps updatedAt', async () => {
    const job = store.add(JOB);
    await new Promise((r) => setTimeout(r, 2));
    const updated = store.update(job.id, { quantity: 3 });
    expect(updated.quantity).toBe(3);
    expect(updated.updatedAt > job.updatedAt).toBe(true);
    expect(updated.createdAt).toBe(job.createdAt);
  });

  it('removes a job', () => {
    const job = store.add(JOB);
    store.remove(job.id);
    expect(store.get(job.id)).toBeUndefined();
  });

  it('names the id when it does not exist', () => {
    expect(() => store.update('nope00', { quantity: 1 })).toThrow(/nope00/);
    expect(() => store.remove('nope00')).toThrow(/nope00/);
  });
});

describe('durability', () => {
  it('never leaves a temp file behind', () => {
    store.add(JOB);
    const leftovers = readFileSync(join(dir, 'jobs.json'), 'utf8');
    expect(leftovers).toContain('testnftprofile');
    expect(() => readFileSync(join(dir, 'jobs.json.tmp'))).toThrow();
  });

  it('rejects a corrupted schedule loudly rather than silently losing jobs', () => {
    // A schedule that decides whether money moves must not degrade to "no jobs" when
    // the file is damaged — that would skip a drop with no visible error.
    store.add(JOB);
    writeFileSync(join(dir, 'jobs.json'), '{"version":1,"jobs":[{"bad":true}]}');
    expect(() => store.all()).toThrow(/not valid/);
  });

  it('treats an empty file as an empty schedule', () => {
    writeFileSync(join(dir, 'jobs.json'), '');
    expect(store.all()).toEqual([]);
  });

  it('does not lose a job when two writers interleave', () => {
    // Each mutation re-reads the file, so a second writer's job survives.
    const a = new ScheduleStore(dir);
    const b = new ScheduleStore(dir);
    a.add({ ...JOB, slug: 'first' });
    b.add({ ...JOB, slug: 'second' });
    expect(a.all().map((j) => j.slug).sort()).toEqual(['first', 'second']);
  });
});

describe('pending selection', () => {
  it('orders by fire time, earliest first', () => {
    store.add({ ...JOB, slug: 'later', resolvedAt: '2026-12-01T00:00:00.000Z' });
    store.add({ ...JOB, slug: 'sooner', resolvedAt: '2026-09-01T00:00:00.000Z' });
    expect(store.pending().map((j) => j.slug)).toEqual(['sooner', 'later']);
  });

  it('excludes terminal jobs, so a finished mint is never re-fired', () => {
    const done = store.add(JOB);
    store.update(done.id, { status: 'done' });
    const failed = store.add(JOB);
    store.update(failed.id, { status: 'failed' });
    store.add({ ...JOB, slug: 'still-pending' });

    expect(store.pending().map((j) => j.slug)).toEqual(['still-pending']);
  });

  it('classifies terminal states', () => {
    expect(isTerminal('done')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('armed')).toBe(false);
    expect(isTerminal('running')).toBe(false);
  });
});
