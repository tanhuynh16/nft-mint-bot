import type { DropsApi } from '../opensea/drops.js';
import { selectStage, type StageInfo } from './stages.js';
import type { JobWhen } from './store.js';

export interface ResolvedSchedule {
  /** When the job should fire, UTC ISO 8601. */
  fireAt: string;
  /** True when the stage is already open, so the job should fire immediately. */
  activeNow: boolean;
  stage?: string;
  stageType?: string;
  /** True when the chosen stage gates on an allowlist or server signature. */
  requiresEligibility?: boolean;
  pricePerToken?: bigint;
  maxPerWallet?: bigint;
}

function fromStage(stage: StageInfo, now: number): ResolvedSchedule {
  const starts = stage.startTime?.getTime() ?? now;
  const activeNow = starts <= now;
  return {
    fireAt: new Date(activeNow ? now : starts).toISOString(),
    activeNow,
    stage: stage.label,
    stageType: stage.type,
    requiresEligibility: stage.requiresEligibility,
    ...(stage.pricePerToken !== undefined ? { pricePerToken: stage.pricePerToken } : {}),
    ...(stage.maxPerWallet !== undefined ? { maxPerWallet: stage.maxPerWallet } : {}),
  };
}

/**
 * Works out when a job should fire, and against which stage.
 *
 * The point of `auto` is that the operator never converts a timezone: OpenSea publishes
 * stage times as ISO 8601 UTC, so the instant is read from the drop. Stage *choice* is
 * equally load-bearing — see selectStage, which prefers the public sale over whichever
 * presale happens to come first.
 */
export async function resolveSchedule(
  drops: DropsApi,
  slug: string,
  when: JobWhen,
  preferredStage?: string,
  now = Date.now(),
): Promise<ResolvedSchedule> {
  if (when.kind === 'at') {
    const parsed = new Date(when.iso);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(
        `"${when.iso}" is not a valid date. Use ISO 8601 with a timezone, ` +
          `e.g. 2026-09-01T14:00:00Z.`,
      );
    }

    // The time is explicit, but the price still has to come from the drop: without it
    // the authorised spend ceiling would cover gas only, and the job would fail closed
    // the moment it fired. Best-effort — an unlisted drop is exactly what --at is for.
    let pricing: Partial<ResolvedSchedule> = {};
    try {
      const drop = await drops.getDrop(slug);
      const stage = selectStage(drop, preferredStage, now);
      if (stage) {
        const { fireAt: _ignored, activeNow: _also, ...rest } = fromStage(stage, now);
        pricing = rest;
      }
    } catch {
      /* drop not listed yet; schedule on the explicit time alone */
    }

    return {
      fireAt: parsed.toISOString(),
      activeNow: parsed.getTime() <= now,
      ...pricing,
    };
  }

  const drop = await drops.getDrop(slug);
  const stage = selectStage(drop, preferredStage, now);

  if (!stage) {
    const available = drop.stages
      .map((s) => s.label ?? s.stage_type)
      .filter(Boolean)
      .join(', ');
    throw new Error(
      preferredStage
        ? `Drop "${slug}" has no open stage named "${preferredStage}". Stages: ${available || 'none'}.`
        : `Drop "${slug}" has no active or upcoming stage, so there is nothing to ` +
          `schedule automatically. Pass --at <ISO time> to schedule it explicitly.`,
    );
  }

  return fromStage(stage, now);
}

/**
 * Renders an instant in both UTC and the host's local zone.
 *
 * Both, always: the operator's problem is that drops open in another timezone, and a
 * single rendering is exactly how an off-by-hours mistake stays invisible.
 */
export function formatBoth(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;

  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    // hourCycle h23, not hour12:false — the latter renders midnight as "24:00" on the
    // previous notation, which is exactly the confusion this dual rendering exists to
    // remove.
    hourCycle: 'h23',
  }).format(d);

  return `${d.toISOString().replace('.000', '').replace('T', ' ')}  (${local} ${zone})`;
}

/** Human-readable gap, e.g. "in 2h 14m" or "overdue by 3m". */
export function describeGap(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  const overdue = ms < 0;
  const abs = Math.abs(ms);

  const d = Math.floor(abs / 86_400_000);
  const h = Math.floor((abs % 86_400_000) / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const s = Math.floor((abs % 60_000) / 1000);

  const parts =
    d > 0 ? [`${d}d`, `${h}h`] : h > 0 ? [`${h}h`, `${m}m`] : m > 0 ? [`${m}m`] : [`${s}s`];
  return overdue ? `overdue by ${parts.join(' ')}` : `in ${parts.join(' ')}`;
}
