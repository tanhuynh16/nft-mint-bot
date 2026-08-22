import { runMint } from '../cli/start.js';
import { resolveSchedule } from './time.js';
import { openStages, stageAfter } from './stages.js';
import { isTerminal, type ScheduledJob, type ScheduleStore } from './store.js';
import type { DropsApi } from '../opensea/drops.js';
import type { Logger } from '../observability/logger.js';

export interface RunnerOptions {
  store: ScheduleStore;
  drops: DropsApi;
  logger: Logger;
  /**
   * How long before the fire time the daemon wakes and hands the job to the mint flow,
   * whose own stage poller tightens to 200ms near the open.
   */
  leadTimeMs?: number;
  /** Re-check `auto` times no more often than this while a job is distant. */
  reresolveIntervalMs?: number;
  /** Injected for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  mint?: typeof runMint;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface TickResult {
  action: 'idle' | 'slept' | 'fired' | 'reresolved' | 'skipped';
  jobId?: string;
  detail?: string;
}

/**
 * Fires scheduled mints.
 *
 * The central design point is that the daemon **sleeps** while a job is distant rather
 * than polling. Handing a job to the mint flow hours early would have its stage poller
 * issue an OpenSea request every 15 seconds for hours, which burns the API rate limit
 * for no benefit. The daemon therefore waits until `leadTimeMs` before the target, then
 * hands off — the poller's job is the last two minutes, not the last two days.
 */
export class ScheduleRunner {
  private readonly store: ScheduleStore;
  private readonly drops: DropsApi;
  private readonly logger: Logger;
  private readonly leadTimeMs: number;
  private readonly reresolveIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly mint: typeof runMint;

  private stopping = false;

  constructor(options: RunnerOptions) {
    this.store = options.store;
    this.drops = options.drops;
    this.logger = options.logger;
    this.leadTimeMs = options.leadTimeMs ?? 120_000;
    this.reresolveIntervalMs = options.reresolveIntervalMs ?? 15 * 60_000;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.mint = options.mint ?? runMint;
  }

  stop(): void {
    this.stopping = true;
  }

  /**
   * Resolves jobs left mid-flight by a crash or a reboot.
   *
   * A job in `armed` never reached the network, so it is safe to return to `pending`.
   * A job in `running` may have broadcast: the TxJournal records the transaction hash
   * *before* it is sent, so the evidence exists on disk and on chain. Rather than guess,
   * mark it `failed` with an explicit note so the operator decides — a wrong guess here
   * either double-mints or silently skips a drop.
   */
  reconcile(): ScheduledJob[] {
    const touched: ScheduledJob[] = [];

    for (const job of this.store.all()) {
      if (job.status === 'armed') {
        touched.push(this.store.update(job.id, { status: 'pending' }));
        this.logger.warn({ jobId: job.id }, 're-arming job left armed by a restart');
      } else if (job.status === 'running') {
        touched.push(
          this.store.update(job.id, {
            status: 'failed',
            error:
              'process stopped while this job was mid-flight; a transaction may have ' +
              'been broadcast. Check .journal/ and the chain before rescheduling.',
          }),
        );
        this.logger.error(
          { jobId: job.id },
          'job was running at shutdown — not re-fired automatically',
        );
      }
    }

    return touched;
  }

  /** One scheduling decision. Returns what it did, so tests can assert without timers. */
  async tick(): Promise<TickResult> {
    const pending = this.store.pending();
    if (pending.length === 0) return { action: 'idle' };

    const job = pending[0]!;
    const fireAt = job.resolvedAt ? new Date(job.resolvedAt).getTime() : undefined;

    if (fireAt === undefined) {
      await this.reresolve(job);
      return { action: 'reresolved', jobId: job.id };
    }

    const untilFire = fireAt - this.now();

    if (untilFire > this.leadTimeMs) {
      // Distant: sleep, do not poll. Wake early enough to re-resolve a moved stage.
      const nap = Math.min(untilFire - this.leadTimeMs, this.reresolveIntervalMs);
      await this.sleep(nap);
      if (!this.stopping && untilFire - nap > this.leadTimeMs) {
        await this.reresolve(job);
      }
      return { action: 'slept', jobId: job.id, detail: `${Math.round(nap / 1000)}s` };
    }

    if (untilFire > 0) await this.sleep(untilFire);

    // A stage can close while the daemon is down, or while a distant job waits. Building
    // a transaction against a closed stage cannot succeed, so fail cleanly rather than
    // spend gas proving it.
    const closed = await this.stageClosed(job);
    if (closed) {
      this.store.update(job.id, { status: 'failed', error: closed });
      this.logger.warn({ jobId: job.id, reason: closed }, 'stage closed; not firing');
      return { action: 'skipped', jobId: job.id, detail: closed };
    }

    await this.fire(job);
    return { action: 'fired', jobId: job.id };
  }

  /** Runs until stopped. */
  async run(): Promise<void> {
    this.reconcile();
    while (!this.stopping) {
      const result = await this.tick();
      if (result.action === 'idle') await this.sleep(30_000);
    }
    this.logger.info('scheduler stopped');
  }

  /**
   * Returns a reason when the job's stage has already closed, otherwise undefined.
   *
   * Only skips on positive evidence: a job with no recorded stage, or a drop the API
   * cannot be read for, still fires. Being wrong in that direction merely wastes an
   * attempt; being wrong the other way silently skips a drop that was mintable.
   */
  private async stageClosed(job: ScheduledJob): Promise<string | undefined> {
    if (!job.stageLabel) return undefined;

    try {
      const drop = await this.drops.getDrop(job.slug);
      const open = openStages(drop, this.now());
      if (open.some((s) => s.label.toLowerCase() === job.stageLabel!.toLowerCase())) {
        return undefined;
      }

      const ended = drop.stages.find(
        (s) => (s.label ?? '').toLowerCase() === job.stageLabel!.toLowerCase(),
      );
      return (
        `stage "${job.stageLabel}" closed` +
        (ended?.end_time ? ` at ${ended.end_time}` : '') +
        ` — it was no longer open when the scheduler reached this job`
      );
    } catch {
      return undefined;
    }
  }

  /** Recognises "this wallet is not on the list" as distinct from a hard failure. */
  private looksIneligible(error?: string): boolean {
    if (!error) return false;
    return /not eligible|eligibility|allowlist|allow list|invalidproof|precondition|422/i.test(
      error,
    );
  }

  /**
   * Re-arms a rejected job against the next stage that has not closed.
   *
   * Bounded on both sides: it stops at the last stage, and it refuses to advance into a
   * stage that costs more than the ceiling authorised at `schedule add` time. Falling
   * forward into a pricier stage would spend money the operator never agreed to.
   */
  private async advanceStage(job: ScheduledJob, previousError?: string): Promise<boolean> {
    try {
      const drop = await this.drops.getDrop(job.slug);
      const next = stageAfter(drop, job.stageLabel ?? '', this.now());

      if (!next) {
        this.logger.info(
          { jobId: job.id, stage: job.stageLabel },
          'wallet not eligible and no later stage remains',
        );
        return false;
      }

      const cost = (next.pricePerToken ?? 0n) * BigInt(job.quantity);
      if (cost > BigInt(job.maxSpendWei)) {
        this.store.update(job.id, {
          status: 'failed',
          error:
            `not eligible for "${job.stageLabel}", and the next stage "${next.label}" ` +
            `costs ${cost} wei which exceeds the authorised ${job.maxSpendWei}. ` +
            `Re-add the job to authorise the higher amount.`,
        });
        this.logger.warn(
          { jobId: job.id, nextStage: next.label, cost: cost.toString() },
          'next stage exceeds the authorised spend; failing closed',
        );
        return true;
      }

      const fireAt = (next.startTime ?? new Date(this.now())).toISOString();
      this.store.update(job.id, {
        status: 'pending',
        stageLabel: next.label,
        stageType: next.type,
        resolvedAt: fireAt,
        error: `not eligible for "${job.stageLabel}"; advanced to "${next.label}"`,
      });

      this.logger.info(
        { jobId: job.id, from: job.stageLabel, to: next.label, fireAt, previousError },
        'wallet not eligible; job advanced to the next stage',
      );
      return true;
    } catch (error) {
      this.logger.warn(
        { jobId: job.id, error: error instanceof Error ? error.message : String(error) },
        'could not advance to the next stage',
      );
      return false;
    }
  }

  private async reresolve(job: ScheduledJob): Promise<void> {
    try {
      const resolved = await resolveSchedule(
        this.drops,
        job.slug,
        job.when,
        job.stageLabel,
        this.now(),
      );
      if (resolved.fireAt !== job.resolvedAt) {
        this.logger.info(
          { jobId: job.id, from: job.resolvedAt, to: resolved.fireAt },
          'stage time moved; job re-scheduled',
        );
      }
      this.store.update(job.id, { resolvedAt: resolved.fireAt });
    } catch (error) {
      this.logger.warn(
        { jobId: job.id, error: error instanceof Error ? error.message : String(error) },
        'could not re-resolve schedule; keeping the previous time',
      );
    }
  }

  private async fire(job: ScheduledJob): Promise<void> {
    this.logger.info(
      { jobId: job.id, slug: job.slug, quantity: job.quantity },
      'firing scheduled mint',
    );

    this.store.update(job.id, { status: 'running', attempts: job.attempts + 1 });

    try {
      const { outcome } = await this.mint(job.configPath, {
        collectionSlug: job.slug,
        quantity: job.quantity,
      });

      const succeeded = outcome.state === 'CONFIRMED' || outcome.state === 'PENDING';

      if (!succeeded && this.looksIneligible(outcome.error)) {
        // A gated stage rejecting this wallet is not the end of the drop — the public
        // sale is usually hours later. Advance rather than marking the job failed, which
        // would leave the drop unminted for exactly the reason the scheduler exists.
        if (await this.advanceStage(job, outcome.error)) return;
      }

      this.store.update(job.id, {
        status: succeeded ? 'done' : 'failed',
        ...(outcome.txHash ? { txHash: outcome.txHash } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      });

      this.logger.info(
        { jobId: job.id, state: outcome.state, txHash: outcome.txHash },
        succeeded ? 'scheduled mint succeeded' : 'scheduled mint failed',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.update(job.id, { status: 'failed', error: message });
      this.logger.error({ jobId: job.id, error: message }, 'scheduled mint threw');
    }
  }
}

export { isTerminal };
