import {
  createContext,
  getEnvFileOverride,
  resolveProvider,
  type CliOverrides,
} from './context.js';
import { loadBotConfig } from '../config/loader.js';
import { walletSpecs } from '../wallet/signer.js';
import { MintOrchestrator, type MintOutcome } from '../tx/orchestrator.js';
import { OpenSeaDropProvider } from '../providers/opensea-drop-provider.js';
import {
  armTransaction,
  revalidateArmed,
  verifyAgainstChain,
  verifyLocalEncoding,
  waitForContractConfigured,
} from '../tx/presign.js';
import { PlanExecutor } from '../tx/plan-executor.js';
import { StageClock } from '../tx/stage-clock.js';

export interface StartOptions extends CliOverrides {
  /** Mint from every configured wallet, concurrently. */
  allWallets?: boolean;
  contract?: string;
  /** Force the direct SeaDrop path even when the Drops API knows the collection. */
  local?: boolean;
}

export interface MintRunResult {
  outcome: MintOutcome;
  /** Block explorer base URL for the chain the mint ran on, when known. */
  explorerUrl?: string;
}

/**
 * Runs one mint and returns its outcome.
 *
 * Separated from the CLI wrapper so the scheduler daemon can drive exactly the same
 * path without going through argument parsing or printing to stdout. Everything the
 * operator sees at a terminal lives in startCommand below.
 */
export async function runMint(
  configPath: string,
  options: StartOptions = {},
): Promise<MintRunResult> {
  const ctx = createContext(configPath, options);
  const {
    config,
    resolved,
    logger,
    account,
    wallet,
    rpc,
    publicClient,
    gasEngine,
    nonceManager,
    broadcaster,
    monitor,
    metrics,
    journal,
    drops,
  } = ctx;

  logger.info(
    {
      mode: config.execution.mode,
      chain: resolved.chain.name,
      chainId: config.network.chainId,
      ordering: resolved.orderingModel,
      feeModel: resolved.feeModel,
      quantity: config.mint.quantity,
      slug: config.mint.collectionSlug,
      wallet: account.address,
    },
    'starting mint bot',
  );

  // Warm the connections before anything time-sensitive, so the mint window never pays
  // for a TLS handshake.
  await rpc.probe();
  if (ctx.payment) await ctx.payment.rpc.probe();

  // Reconcile anything a previous run left pending before allocating a new nonce.
  const recovery = await nonceManager.initialize();
  // The payment chain has its own nonce sequence and its own journal file.
  if (ctx.payment) await ctx.payment.nonceManager.initialize();
  if (recovery.stillPending.length > 0) {
    logger.warn(
      { pending: recovery.stillPending },
      'transactions from a previous run are still pending — not re-sending them',
    );
  }

  const useLocal = options.local ?? config.execution.presign;
  const provider = await resolveProvider(ctx, {
    ...(useLocal !== undefined ? { preferLocal: useLocal } : {}),
    ...(options.contract ? { contractAddress: options.contract } : {}),
  });

  let presignedTx: `0x${string}` | undefined;

  if (config.execution.presign) {
    presignedTx = await armFastPath(ctx, provider);
  }

  // Under cross-chain payment the steps execute on the payment chain, so the executor
  // is built from that context rather than the mint chain's clients.
  // Gate on the resolved provider, not the config: resolveProvider falls back to the
  // native path when the payment chain turns out to equal the drop's chain, and the
  // executor must follow that decision rather than the original intent.
  const usingCrossChain = provider.name === 'opensea-cross-chain';
  const planExecutor =
    ctx.payment && usingCrossChain
    ? new PlanExecutor({
        resolved: ctx.payment.resolved,
        publicClient: ctx.payment.publicClient,
        wallet: ctx.payment.wallet,
        account,
        nonceManager: ctx.payment.nonceManager,
        gasEngine: ctx.payment.gasEngine,
        broadcaster: ctx.payment.broadcaster,
        monitor: ctx.payment.monitor,
        metrics,
        logger,
        confirmationBlocks: config.execution.confirmationBlocks,
        confirmationTimeoutMs: config.execution.confirmationTimeoutMs,
      })
    : undefined;

  // The contract's clock beats polling, but only a SeaDrop target can report it. Resolve
  // the collection address from the provider rather than the config, so it is whatever
  // this run will actually mint.
  let stageClock: StageClock | undefined;
  try {
    const target = await provider.resolveTarget();
    if ((target.dropType ?? '').startsWith('seadrop')) {
      stageClock = new StageClock({
        publicClient,
        contractAddress: target.contractAddress,
        logger,
      });
    }
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'could not resolve the target for the stage clock; polling instead',
    );
  }

  const orchestrator = new MintOrchestrator({
    config,
    resolved,
    provider,
    publicClient,
    wallet,
    account,
    nonceManager,
    gasEngine,
    broadcaster,
    monitor,
    metrics,
    logger,
    ...(presignedTx ? { presignedTx } : {}),
    ...(planExecutor ? { planExecutor } : {}),
    ...(ctx.payment && usingCrossChain
      ? { paymentPublicClient: ctx.payment.publicClient }
      : {}),
    ...(stageClock ? { stageClock } : {}),
  });

  const outcome = await orchestrator.run();
  journal.close();
  ctx.payment?.journal.close();
  const explorerUrl = resolved.chain.blockExplorers?.default.url;

  logger.info(
    {
      state: outcome.state,
      txHash: outcome.txHash,
      attempts: outcome.attempts,
      errorClass: outcome.errorClass,
      metrics: outcome.metrics,
    },
    'run finished',
  );

  return { outcome, ...(explorerUrl ? { explorerUrl } : {}) };
}

export interface WalletRunResult extends MintRunResult {
  label: string;
}

/**
 * Runs the mint from every configured wallet, concurrently.
 *
 * Concurrency is safe here and only here: each wallet has its own nonce sequence, so
 * they cannot collide the way two runs from one wallet would. Firing them in parallel is
 * the whole point — sequential wallets would put every wallet after the first several
 * blocks late, which on a chain producing a block every ~100ms forfeits the race.
 *
 * `allSettled`, not `all`: one wallet running out of funds must not cancel the others.
 */
export async function runMintAllWallets(
  configPath: string,
  options: StartOptions = {},
): Promise<WalletRunResult[]> {
  const { config } = loadBotConfig(configPath, getEnvFileOverride());
  const specs = walletSpecs(config);

  const settled = await Promise.allSettled(
    specs.map((spec) => runMint(configPath, { ...options, walletEnv: spec.privateKeyEnv })),
  );

  return settled.map((result, i) => {
    const label = specs[i]!.label;
    if (result.status === 'fulfilled') return { label, ...result.value };
    return {
      label,
      outcome: {
        state: 'FAILED' as const,
        attempts: 0,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        metrics: {},
      },
    };
  });
}

/**
 * Entry point for the scheduler: fans out across wallets, reports one result.
 *
 * The daemon tracks a job as a single unit, so the many-wallet outcome is collapsed into
 * one: success if any wallet minted, and the first winning hash recorded. Per-wallet
 * detail goes to the log, where it can be read after the fact.
 */
export async function runMintForSchedule(
  configPath: string,
  options: StartOptions = {},
): Promise<MintRunResult> {
  const { config } = loadBotConfig(configPath, getEnvFileOverride());
  if (walletSpecs(config).length <= 1) return runMint(configPath, options);

  const results = await runMintAllWallets(configPath, options);
  const won = results.find(
    (r) => r.outcome.state === 'CONFIRMED' || r.outcome.state === 'PENDING',
  );

  const summary = results.map((r) => `${r.label}:${r.outcome.state}`).join(' ');

  if (won) {
    return {
      outcome: { ...won.outcome, error: summary },
      ...(won.explorerUrl ? { explorerUrl: won.explorerUrl } : {}),
    };
  }

  return {
    outcome: {
      state: 'FAILED',
      attempts: 1,
      error: `no wallet minted — ${summary}`,
      metrics: {},
    },
  };
}

/** CLI wrapper: runs the mint, prints the result, maps it to an exit code. */
export async function startCommand(
  configPath: string,
  options: StartOptions = {},
): Promise<number> {
  const { config } = loadBotConfig(configPath, getEnvFileOverride());
  const multi = options.allWallets && walletSpecs(config).length > 1;

  if (multi) {
    const results = await runMintAllWallets(configPath, options);
    let ok = 0;
    for (const r of results) {
      const good = r.outcome.state === 'CONFIRMED' || r.outcome.state === 'PENDING';
      if (good) ok += 1;
      // eslint-disable-next-line no-console
      console.log(
        `\n${r.label.padEnd(12)} ${r.outcome.state}` +
          (r.outcome.txHash ? `  ${r.outcome.txHash}` : '') +
          (r.outcome.error ? `\n  ${r.outcome.error}` : ''),
      );
    }
    // eslint-disable-next-line no-console
    console.log(`\n${ok}/${results.length} wallets minted.`);
    return ok > 0 ? 0 : 1;
  }

  const { outcome, explorerUrl } = await runMint(configPath, options);

  if (outcome.txHash) {
    // eslint-disable-next-line no-console
    console.log(
      `\n${outcome.state}: ${outcome.txHash}` +
        (explorerUrl ? `\n${explorerUrl}/tx/${outcome.txHash}` : ''),
    );
  }

  return outcome.state === 'CONFIRMED' || outcome.state === 'PENDING' ? 0 : 1;
}

/**
 * Arms the race path, refusing rather than guessing if verification fails.
 *
 * The local encoding is only trusted after OpenSea produces identical bytes for the
 * same mint. If the API cannot be reached to cross-check — which is likely, since the
 * mint endpoint returns 409 until the stage opens — the fast path stays disarmed and
 * the run proceeds on the normal path. Silently trusting unverified calldata would
 * risk a reverted transaction at the one moment it cannot be retried.
 */
async function armFastPath(
  ctx: ReturnType<typeof createContext>,
  provider: Awaited<ReturnType<typeof resolveProvider>>,
): Promise<`0x${string}` | undefined> {
  const { config, resolved, logger, account, wallet, publicClient, gasEngine, nonceManager, drops } =
    ctx;

  if (!provider.supportsLocalEncoding) {
    logger.warn('provider cannot encode locally — pre-sign disabled for this run');
    return undefined;
  }

  // Local encoding needs the contract's stage and fee recipient, which creators often
  // set only shortly before the stage opens. Wait for that rather than failing outright.
  try {
    const target = await provider.resolveTarget();
    const ready = await waitForContractConfigured({
      publicClient,
      contractAddress: target.contractAddress,
      logger,
    });
    if (!ready) return undefined;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'could not confirm the contract is configured — pre-sign disabled',
    );
    return undefined;
  }

  // Build once, then verify it two ways. The chain is the authority and works at any
  // time; OpenSea is a useful second opinion but only answers once a stage is open, so
  // it can strengthen the check and must never be able to block it.
  const candidate = await provider.buildMint(BigInt(config.mint.quantity));

  const verdict = await verifyAgainstChain(publicClient, candidate, account.address, logger);
  if (verdict.kind === 'wrong') {
    logger.error(
      { reason: verdict.detail },
      'refusing to arm: the chain would reject this calldata',
    );
    return undefined;
  }

  try {
    const reference = new OpenSeaDropProvider(drops, config.mint.collectionSlug, account.address);
    const verification = await verifyLocalEncoding(
      provider,
      reference,
      BigInt(config.mint.quantity),
      logger,
    );
    if (!verification.matches) {
      logger.error(
        { differences: verification.differences },
        'refusing to arm: local calldata differs from the OpenSea API',
      );
      return undefined;
    }
  } catch {
    // Expected before a drop opens: the mint endpoint returns 409 until then. The chain
    // has already vouched for the calldata, so this is not a reason to disarm — the old
    // behaviour disabled pre-signing precisely when it was needed most.
    logger.info(
      { verdict: verdict.kind },
      'OpenSea has no reference calldata yet; proceeding on the on-chain check alone',
    );
  }

  const armed = await armTransaction({
    config,
    resolved,
    provider,
    publicClient,
    wallet,
    account,
    nonceManager,
    gasEngine,
    logger,
  });

  const check = await revalidateArmed(armed, publicClient, account, logger);
  if (!check.valid) {
    logger.warn({ reason: check.reason }, 'armed transaction went stale — falling back');
    return undefined;
  }

  return armed.rawTx;
}
