import { createInterface } from 'node:readline/promises';
import { formatEther } from 'viem';
import { createContext } from './context.js';
import { ScheduleStore, isTerminal, type ScheduledJob } from '../schedule/store.js';
import { ScheduleRunner } from '../schedule/runner.js';
import { walletSpecs } from '../wallet/signer.js';
import { describeGap, formatBoth, resolveSchedule } from '../schedule/time.js';
import type { JobWhen } from '../schedule/store.js';

const log = (line = '') => {
  // eslint-disable-next-line no-console
  console.log(line);
};

/** Gas headroom folded into the authorised ceiling, so a modest spike does not fail a job. */
const GAS_MARGIN_WEI = 2_000_000_000_000_000n; // 0.002 ETH

export interface AddOptions {
  config: string;
  quantity?: number;
  at?: string;
  yes?: boolean;
  /** Target a named stage instead of the public sale. */
  stage?: string;
}

/**
 * Adds a job — and this is the point at which spending is authorised.
 *
 * A scheduler fires unattended by definition, so consent has to move forward in time to
 * the moment the job is created. That is why this prints the concrete cost and target
 * and waits for a yes: everything the daemon later does was agreed to here.
 */
export async function scheduleAddCommand(
  slug: string,
  options: AddOptions,
): Promise<number> {
  const ctx = createContext(options.config, { collectionSlug: slug });
  const store = new ScheduleStore(ctx.config.schedule.dir);

  const when: JobWhen = options.at ? { kind: 'at', iso: options.at } : { kind: 'auto' };
  const quantity = options.quantity ?? ctx.config.mint.quantity;

  let resolved;
  try {
    resolved = await resolveSchedule(ctx.drops, slug, when, options.stage);
  } catch (error) {
    log(`Cannot schedule: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (resolved.maxPerWallet !== undefined && BigInt(quantity) > resolved.maxPerWallet) {
    log(
      `Quantity ${quantity} exceeds the stage's per-wallet cap of ${resolved.maxPerWallet}.`,
    );
    return 1;
  }

  const wallets = walletSpecs(ctx.config).length;
  const price = resolved.pricePerToken ?? 0n;
  // Per wallet, because every wallet fires this job.
  const mintCost = price * BigInt(quantity);
  const ceiling = mintCost + GAS_MARGIN_WEI;
  const totalCost = mintCost * BigInt(wallets);

  log(`Schedule a mint`);
  log(`  collection : ${slug}`);
  log(`  network    : ${ctx.resolved.chain.name} (${ctx.config.network.chainId})`);
  log(`  wallet     : ${ctx.account.address}`);
  log(`  quantity   : ${quantity}`);
  log(`  price each : ${formatEther(price)} ETH`);
  log(`  mint cost  : ${formatEther(mintCost)} ETH per wallet  (+ gas, capped at ${formatEther(ceiling)})`);
  if (wallets > 1) {
    log(`  wallets    : ${wallets}  ->  total up to ${formatEther(totalCost + GAS_MARGIN_WEI * BigInt(wallets))} ETH`);
  }
  log(`  stage      : ${resolved.stage ?? 'unknown'}${resolved.stageType ? ` (${resolved.stageType})` : ''}`);
  log(`  fires at   : ${formatBoth(resolved.fireAt)}  ${describeGap(resolved.fireAt)}`);
  if (resolved.activeNow) log(`               (stage is already open — this fires immediately)`);
  if (resolved.requiresEligibility) {
    log();
    log(`  NOTE: "${resolved.stage}" is an allowlist/signed stage. It will reject this`);
    log(`        wallet unless it is on the list. If it does, the job advances to the`);
    log(`        next stage rather than giving up on the drop.`);
  }
  log();

  if (!options.yes) {
    const answer = await prompt('Add this job? It will spend real funds when it fires. [y/N] ');
    if (!/^y(es)?$/i.test(answer.trim())) {
      log('Not scheduled.');
      return 1;
    }
  }

  const job = store.add({
    slug,
    configPath: options.config,
    quantity,
    when,
    resolvedAt: resolved.fireAt,
    maxSpendWei: ceiling.toString(),
    ...(resolved.stage ? { stageLabel: resolved.stage } : {}),
    ...(resolved.stageType ? { stageType: resolved.stageType } : {}),
  });

  log(`Scheduled as ${job.id}.`);
  return 0;
}

export function scheduleListCommand(configPath: string, all = false): number {
  const ctx = createContext(configPath);
  const store = new ScheduleStore(ctx.config.schedule.dir);

  const jobs = all ? store.all() : store.all().filter((j) => !isTerminal(j.status));
  if (jobs.length === 0) {
    log(all ? 'No scheduled jobs.' : 'No pending jobs. Use --all to include finished ones.');
    return 0;
  }

  log(`${'ID'.padEnd(8)}${'COLLECTION'.padEnd(22)}${'QTY'.padStart(4)}  ${'STATUS'.padEnd(10)}FIRES AT`);
  log('─'.repeat(104));

  for (const job of [...jobs].sort((a, b) => (a.resolvedAt ?? '').localeCompare(b.resolvedAt ?? ''))) {
    const when = job.resolvedAt
      ? `${formatBoth(job.resolvedAt)}  ${describeGap(job.resolvedAt)}`
      : 'unresolved';
    log(
      `${job.id.padEnd(8)}${job.slug.slice(0, 21).padEnd(22)}${String(job.quantity).padStart(4)}  ` +
        `${job.status.padEnd(10)}${when}`,
    );
    if (job.stageLabel) log(`${' '.repeat(8)}stage ${job.stageLabel}${job.stageType ? ` (${job.stageType})` : ''}`);
    if (job.txHash) log(`${' '.repeat(8)}tx ${job.txHash}`);
    if (job.error) log(`${' '.repeat(8)}! ${job.error.slice(0, 90)}`);
  }

  log();
  log('Times are shown as UTC first, then your local zone.');
  return 0;
}

export interface EditOptions {
  config: string;
  quantity?: number;
  at?: string;
  slug?: string;
  stage?: string;
}

export async function scheduleEditCommand(id: string, options: EditOptions): Promise<number> {
  const ctx = createContext(options.config);
  const store = new ScheduleStore(ctx.config.schedule.dir);

  const job = store.get(id);
  if (!job) {
    log(`No scheduled job with id "${id}".`);
    return 1;
  }
  if (isTerminal(job.status)) {
    log(`Job ${id} is ${job.status} and cannot be edited. Add a new job instead.`);
    return 1;
  }

  const patch: Partial<ScheduledJob> = {};
  if (options.quantity !== undefined) patch.quantity = options.quantity;
  if (options.slug) patch.slug = options.slug;
  if (options.at) patch.when = { kind: 'at', iso: options.at };

  if (Object.keys(patch).length === 0) {
    log('Nothing to change. Pass --quantity, --slug or --at.');
    return 1;
  }

  // Re-resolve so the stored time matches whatever the edit implies, and so a changed
  // quantity or collection is re-costed rather than inheriting a stale ceiling.
  const slug = patch.slug ?? job.slug;
  const when = patch.when ?? job.when;
  try {
    const resolved = await resolveSchedule(ctx.drops, slug, when, options.stage ?? job.stageLabel);
    patch.resolvedAt = resolved.fireAt;
    if (resolved.stage) patch.stageLabel = resolved.stage;
    if (resolved.stageType) patch.stageType = resolved.stageType;
    const price = resolved.pricePerToken ?? 0n;
    patch.maxSpendWei = (price * BigInt(patch.quantity ?? job.quantity) + GAS_MARGIN_WEI).toString();
  } catch (error) {
    log(`Cannot re-resolve: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const updated = store.update(id, patch);
  log(`Updated ${id}:`);
  log(`  ${updated.slug}  qty ${updated.quantity}`);
  log(`  fires at ${formatBoth(updated.resolvedAt!)}  ${describeGap(updated.resolvedAt!)}`);
  log(`  spend ceiling ${formatEther(BigInt(updated.maxSpendWei))} ETH`);
  return 0;
}

export function scheduleRemoveCommand(id: string, configPath: string): number {
  const ctx = createContext(configPath);
  const store = new ScheduleStore(ctx.config.schedule.dir);

  try {
    const job = store.remove(id);
    log(`Removed ${job.id} (${job.slug}, qty ${job.quantity}).`);
    return 0;
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** Starts the daemon. Runs until SIGINT/SIGTERM, or one decision with --once. */
export async function scheduleRunCommand(configPath: string, once = false): Promise<number> {
  const ctx = createContext(configPath);
  const store = new ScheduleStore(ctx.config.schedule.dir);

  const runner = new ScheduleRunner({
    store,
    drops: ctx.drops,
    logger: ctx.logger,
    leadTimeMs: ctx.config.schedule.leadTimeMs,
    maxNapMs: ctx.config.schedule.maxNapMs,
  });

  // systemd sends SIGTERM on stop and restart; finish cleanly rather than dying
  // mid-transaction, which would leave a job in `running` for reconciliation.
  const shutdown = (signal: string) => {
    ctx.logger.info({ signal }, 'shutting down after the current step');
    runner.stop();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  ctx.logger.info(
    { store: store.path, pending: store.pending().length },
    'scheduler started',
  );

  if (once) {
    runner.reconcile();
    const result = await runner.tick();
    ctx.logger.info({ ...result }, 'single tick complete');
    return 0;
  }

  await runner.run();
  return 0;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
