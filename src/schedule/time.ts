import type { DropsApi } from '../opensea/drops.js';
import { toWei } from '../opensea/drops.js';
import type { JobWhen } from './store.js';

export interface ResolvedSchedule {
  /** When the job should fire, UTC ISO 8601. */
  fireAt: string;
  /** True when the stage is already open, so the job should fire immediately. */
  activeNow: boolean;
  /** Stage label, for display. */
  stage?: string;
  /** Price per token in wei, if the stage advertises one. */
  pricePerToken?: bigint;
  /** Per-wallet cap the stage enforces, if any. */
  maxPerWallet?: bigint;
}

/**
 * Works out when a job should fire.
 *
 * The whole point of `auto` is that the operator never converts a timezone. OpenSea
 * publishes stage times as ISO 8601 UTC (`2026-07-25T09:00:06Z`), so the bot reads the
 * instant directly from the drop rather than asking a human to compute one. Everything
 * here is UTC; local time exists only in CLI output.
 */
export async function resolveSchedule(
  drops: DropsApi,
  slug: string,
  when: JobWhen,
): Promise<ResolvedSchedule> {
  if (when.kind === 'at') {
    const parsed = new Date(when.iso);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(
        `"${when.iso}" is not a valid date. Use ISO 8601 with a timezone, ` +
          `e.g. 2026-09-01T14:00:00Z.`,
      );
    }

    // The time is explicit, but the *price* still has to come from the drop: without it
    // the authorised spend ceiling would cover gas only, and the job would fail closed
    // the moment it fired. Best-effort — a drop OpenSea has not listed yet simply has
    // no price to read, which is the one case an explicit time is for.
    const pricing = await readStagePricing(drops, slug);

    return {
      fireAt: parsed.toISOString(),
      activeNow: parsed.getTime() <= Date.now(),
      ...pricing,
    };
  }

  const drop = await drops.getDrop(slug);
  const active = drop.active_stage ?? undefined;
  const next = drop.next_stage ?? undefined;

  // An open stage means there is nothing to wait for.
  if (active) {
    return {
      fireAt: new Date().toISOString(),
      activeNow: true,
      ...(active.label ? { stage: active.label } : {}),
      ...(active.price !== undefined ? { pricePerToken: toWei(active.price) } : {}),
      ...(active.max_per_wallet !== undefined && active.max_per_wallet !== null
        ? { maxPerWallet: BigInt(active.max_per_wallet) }
        : {}),
    };
  }

  if (next?.start_time) {
    const start = new Date(next.start_time);
    if (Number.isNaN(start.getTime())) {
      throw new Error(`OpenSea returned an unparseable stage time: "${next.start_time}"`);
    }
    return {
      fireAt: start.toISOString(),
      activeNow: false,
      ...(next.label ? { stage: next.label } : {}),
      ...(next.price !== undefined ? { pricePerToken: toWei(next.price) } : {}),
      ...(next.max_per_wallet !== undefined && next.max_per_wallet !== null
        ? { maxPerWallet: BigInt(next.max_per_wallet) }
        : {}),
    };
  }

  throw new Error(
    `Drop "${slug}" has no active or upcoming stage, so there is nothing to schedule ` +
      `automatically. Pass --at <ISO time> to schedule it explicitly.`,
  );
}

/**
 * Price and per-wallet cap from whichever stage is most relevant, best-effort.
 *
 * Used when the fire time is explicit but the cost still needs to be known. Returns
 * nothing rather than throwing when the drop is unknown: an explicit time is precisely
 * how an unlisted drop gets scheduled.
 */
async function readStagePricing(
  drops: DropsApi,
  slug: string,
): Promise<Pick<ResolvedSchedule, 'stage' | 'pricePerToken' | 'maxPerWallet'>> {
  try {
    const drop = await drops.getDrop(slug);
    const stage = drop.active_stage ?? drop.next_stage ?? drop.stages[0];
    if (!stage) return {};
    return {
      ...(stage.label ? { stage: stage.label } : {}),
      ...(stage.price !== undefined ? { pricePerToken: toWei(stage.price) } : {}),
      ...(stage.max_per_wallet !== undefined && stage.max_per_wallet !== null
        ? { maxPerWallet: BigInt(stage.max_per_wallet) }
        : {}),
    };
  } catch {
    return {};
  }
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
    hour12: false,
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

  const parts = d > 0 ? [`${d}d`, `${h}h`] : h > 0 ? [`${h}h`, `${m}m`] : m > 0 ? [`${m}m`] : [`${s}s`];
  return overdue ? `overdue by ${parts.join(' ')}` : `in ${parts.join(' ')}`;
}
