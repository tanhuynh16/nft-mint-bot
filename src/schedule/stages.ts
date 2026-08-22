import type { DropDetail, DropStage } from '../opensea/drops.js';
import { toWei } from '../opensea/drops.js';

export interface StageInfo {
  label: string;
  /** OpenSea's stage_type, e.g. "public_sale", "signed_presale". */
  type: string;
  startTime?: Date;
  endTime?: Date;
  pricePerToken?: bigint;
  maxPerWallet?: bigint;
  /** True when this stage rejects wallets that are not on its list. */
  requiresEligibility: boolean;
}

/**
 * Stage types that gate on an allowlist or a server signature.
 *
 * Scheduling one of these is a bet that the wallet is on the list — worth saying out
 * loud, because the failure mode is a rejection at the moment the stage opens.
 */
const GATED_TYPES = new Set(['signed_presale', 'allowlist', 'presale', 'allow_list']);

function toStageInfo(stage: DropStage): StageInfo {
  const type = (stage.stage_type ?? '').toLowerCase();
  return {
    label: stage.label ?? stage.stage_type ?? 'stage',
    type,
    ...(stage.start_time ? { startTime: new Date(stage.start_time) } : {}),
    ...(stage.end_time ? { endTime: new Date(stage.end_time) } : {}),
    ...(stage.price !== undefined ? { pricePerToken: toWei(stage.price) } : {}),
    ...(stage.max_per_wallet !== undefined && stage.max_per_wallet !== null
      ? { maxPerWallet: BigInt(stage.max_per_wallet) }
      : {}),
    requiresEligibility: GATED_TYPES.has(type),
  };
}

/**
 * Every stage on the drop, earliest first.
 *
 * Falls back to `active_stage`/`next_stage` when the `stages` array is empty: not every
 * response populates the full list, and a drop that only advertises its current and
 * upcoming stage must still be schedulable.
 */
export function listStages(drop: DropDetail): StageInfo[] {
  const source =
    drop.stages.length > 0
      ? drop.stages
      : [drop.active_stage, drop.next_stage].filter(
          (s): s is NonNullable<typeof s> => Boolean(s),
        );

  return source
    .map(toStageInfo)
    .sort((a, b) => (a.startTime?.getTime() ?? 0) - (b.startTime?.getTime() ?? 0));
}

/** Stages that have not already closed. */
export function openStages(drop: DropDetail, now = Date.now()): StageInfo[] {
  return listStages(drop).filter((s) => !s.endTime || s.endTime.getTime() > now);
}

/**
 * Chooses which stage a scheduled job should target.
 *
 * Following the drop's `next_stage` is wrong on a multi-stage drop: the earliest stage
 * is usually a team or allowlist presale, so a job aimed there is rejected at open and
 * the public mint hours later is missed — the exact outcome the scheduler exists to
 * prevent. Preferring the public sale targets the stage any wallet can actually use,
 * and `preferredLabel` exists for deliberately aiming at a presale you are on.
 */
export function selectStage(
  drop: DropDetail,
  preferredLabel?: string,
  now = Date.now(),
): StageInfo | undefined {
  const open = openStages(drop, now);
  if (open.length === 0) return undefined;

  if (preferredLabel) {
    const wanted = preferredLabel.toLowerCase();
    return open.find(
      (s) => s.label.toLowerCase() === wanted || s.type.toLowerCase() === wanted,
    );
  }

  return open.find((s) => s.type === 'public_sale') ?? open[0];
}

/**
 * The next stage to try after one rejects the wallet.
 *
 * Ordered by start time, so a job that misses GTD advances to FCFS and then to the
 * public sale rather than giving up on the drop.
 */
export function stageAfter(
  drop: DropDetail,
  currentLabel: string,
  now = Date.now(),
): StageInfo | undefined {
  const open = openStages(drop, now);
  const index = open.findIndex((s) => s.label.toLowerCase() === currentLabel.toLowerCase());
  if (index === -1) return open[0];
  return open[index + 1];
}
