import { createContext, resolveProvider, type CliOverrides } from './context.js';
import { MintOrchestrator } from '../tx/orchestrator.js';
import { OpenSeaDropProvider } from '../providers/opensea-drop-provider.js';
import { armTransaction, revalidateArmed, verifyLocalEncoding } from '../tx/presign.js';

export interface StartOptions extends CliOverrides {
  contract?: string;
  /** Force the direct SeaDrop path even when the Drops API knows the collection. */
  local?: boolean;
}

export async function startCommand(
  configPath: string,
  options: StartOptions = {},
): Promise<number> {
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

  // Reconcile anything a previous run left pending before allocating a new nonce.
  const recovery = await nonceManager.initialize();
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
  });

  const outcome = await orchestrator.run();
  journal.close();

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

  if (outcome.txHash) {
    const explorer = resolved.chain.blockExplorers?.default.url;
    // eslint-disable-next-line no-console
    console.log(
      `\n${outcome.state}: ${outcome.txHash}` +
        (explorer ? `\n${explorer}/tx/${outcome.txHash}` : ''),
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

  const reference = new OpenSeaDropProvider(drops, config.mint.collectionSlug, account.address);

  try {
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
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'could not cross-check calldata against the OpenSea API — pre-sign disabled',
    );
    return undefined;
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
