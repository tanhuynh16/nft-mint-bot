import { describe, expect, it, vi } from 'vitest';
import { openStages, selectStage, stageAfter } from '../src/schedule/stages.js';
import { resolveSchedule, formatBoth } from '../src/schedule/time.js';
import type { DropDetail } from '../src/opensea/drops.js';
import type { DropsApi } from '../src/opensea/drops.js';

/**
 * Modelled on the real `the-doll-club-nfts`: three gated presales before the public
 * sale. Following `next_stage` here aims the job at a team presale, which rejects the
 * wallet and lets the public mint pass unattended.
 */
const DOLL_CLUB = {
  collection_slug: 'the-doll-club-nfts',
  contract_address: '0xaaa',
  chain: 'robinhood',
  stages: [
    {
      label: 'PUBLIC',
      stage_type: 'public_sale',
      price: '0',
      max_per_wallet: 1,
      start_time: '2026-08-25T07:30:00Z',
      end_time: '2026-08-26T07:30:00Z',
    },
    {
      label: 'Team',
      stage_type: 'signed_presale',
      price: '0',
      max_per_wallet: 100,
      start_time: '2026-08-24T17:00:00Z',
      end_time: '2026-08-24T17:30:00Z',
    },
    {
      label: 'GTD',
      stage_type: 'signed_presale',
      price: '0',
      max_per_wallet: 1,
      start_time: '2026-08-24T17:30:00Z',
      end_time: '2026-08-25T05:30:00Z',
    },
    {
      label: 'FCFS',
      stage_type: 'signed_presale',
      price: '0',
      max_per_wallet: 1,
      start_time: '2026-08-25T05:30:00Z',
      end_time: '2026-08-25T07:30:00Z',
    },
  ],
  active_stage: null,
  next_stage: { label: 'Team', stage_type: 'signed_presale', start_time: '2026-08-24T17:00:00Z' },
} as unknown as DropDetail;

const BEFORE_ALL = Date.parse('2026-08-22T00:00:00Z');

describe('stage selection', () => {
  it('prefers the public sale over an earlier presale', () => {
    // The bug this guards: next_stage is "Team", so a job would have fired on the 24th,
    // been rejected, and missed the public mint on the 25th entirely.
    expect(selectStage(DOLL_CLUB, undefined, BEFORE_ALL)?.label).toBe('PUBLIC');
  });

  it('targets a named presale when asked', () => {
    const stage = selectStage(DOLL_CLUB, 'GTD', BEFORE_ALL);
    expect(stage?.label).toBe('GTD');
    expect(stage?.requiresEligibility).toBe(true);
  });

  it('matches a stage by type as well as label', () => {
    expect(selectStage(DOLL_CLUB, 'public_sale', BEFORE_ALL)?.label).toBe('PUBLIC');
  });

  it('marks the public sale as ungated', () => {
    expect(selectStage(DOLL_CLUB, undefined, BEFORE_ALL)?.requiresEligibility).toBe(false);
  });

  it('ignores stages that have already ended', () => {
    // After the presales close, only PUBLIC remains open.
    const afterPresales = Date.parse('2026-08-25T06:00:00Z');
    expect(openStages(DOLL_CLUB, afterPresales).map((s) => s.label)).toEqual([
      'FCFS',
      'PUBLIC',
    ]);
  });

  it('returns nothing once every stage has closed', () => {
    expect(selectStage(DOLL_CLUB, undefined, Date.parse('2027-01-01T00:00:00Z'))).toBeUndefined();
  });

  it('returns nothing for a stage name that does not exist', () => {
    expect(selectStage(DOLL_CLUB, 'NOPE', BEFORE_ALL)).toBeUndefined();
  });
});

describe('advancing past a rejected stage', () => {
  it('walks presales in time order, ending at the public sale', () => {
    expect(stageAfter(DOLL_CLUB, 'Team', BEFORE_ALL)?.label).toBe('GTD');
    expect(stageAfter(DOLL_CLUB, 'GTD', BEFORE_ALL)?.label).toBe('FCFS');
    expect(stageAfter(DOLL_CLUB, 'FCFS', BEFORE_ALL)?.label).toBe('PUBLIC');
  });

  it('stops after the last stage rather than looping', () => {
    expect(stageAfter(DOLL_CLUB, 'PUBLIC', BEFORE_ALL)).toBeUndefined();
  });
});

describe('resolveSchedule', () => {
  const drops = { getDrop: vi.fn().mockResolvedValue(DOLL_CLUB) } as unknown as DropsApi;

  it('schedules auto against the public sale', async () => {
    const r = await resolveSchedule(drops, 'the-doll-club-nfts', { kind: 'auto' }, undefined, BEFORE_ALL);
    expect(r.stage).toBe('PUBLIC');
    expect(r.fireAt).toBe('2026-08-25T07:30:00.000Z');
    expect(r.activeNow).toBe(false);
  });

  it('flags a chosen presale as gated, so the operator knows the bet', async () => {
    const r = await resolveSchedule(drops, 'the-doll-club-nfts', { kind: 'auto' }, 'GTD', BEFORE_ALL);
    expect(r.stage).toBe('GTD');
    expect(r.requiresEligibility).toBe(true);
  });

  it('names the available stages when the requested one is unknown', async () => {
    await expect(
      resolveSchedule(drops, 'the-doll-club-nfts', { kind: 'auto' }, 'NOPE', BEFORE_ALL),
    ).rejects.toThrow(/PUBLIC, Team, GTD, FCFS/);
  });

  it('still reads the price when the time is explicit', async () => {
    // Without this the authorised ceiling would cover gas only and the job would fail
    // closed the moment it fired.
    const r = await resolveSchedule(
      drops,
      'the-doll-club-nfts',
      { kind: 'at', iso: '2026-09-01T14:00:00Z' },
      undefined,
      BEFORE_ALL,
    );
    expect(r.fireAt).toBe('2026-09-01T14:00:00.000Z');
    expect(r.stage).toBe('PUBLIC');
    expect(r.pricePerToken).toBe(0n);
  });

  it('rejects an unparseable explicit time', async () => {
    await expect(
      resolveSchedule(drops, 'x', { kind: 'at', iso: 'next tuesday' }),
    ).rejects.toThrow(/not a valid date/);
  });
});

describe('dual time rendering', () => {
  it('renders midnight as 00:xx, not 24:xx', () => {
    // 17:30Z is 00:30 the next day in Saigon. "24:30" is exactly the confusion the
    // dual rendering exists to remove.
    const out = formatBoth('2026-08-24T17:30:00Z', 'Asia/Saigon');
    expect(out).toContain('00:30');
    expect(out).not.toContain('24:30');
  });

  it('shows UTC and the local zone together', () => {
    const out = formatBoth('2026-08-25T07:30:00Z', 'Asia/Saigon');
    expect(out).toContain('2026-08-25 07:30:00Z');
    expect(out).toContain('Asia/Saigon');
  });
});
