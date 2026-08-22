import { getAddress, type Account, type Chain, type PublicClient, type Transport } from 'viem';
import { randomUUID } from 'node:crypto';
import { describeEnvSearch, loadEnvFile } from '../config/env.js';
import { loadConfig } from '../config/loader.js';
import { resolveChain, type ResolvedChain } from '../chains/registry.js';
import {
  defaultRpcUrls,
  getChainProfileBySlug,
  supportedPaymentChains,
} from '../chains/profiles.js';
import { NATIVE_TOKEN_ADDRESS } from '../config/schema.js';
import { CrossChainDropProvider } from '../providers/crosschain-drop-provider.js';
import { createSigner } from '../wallet/signer.js';
import { RpcManager } from '../network/rpc-manager.js';
import { GasEngine } from '../network/gas-engine.js';
import { OpenSeaClient } from '../opensea/client.js';
import { DropsApi } from '../opensea/drops.js';
import { OpenSeaDropProvider } from '../providers/opensea-drop-provider.js';
import { SeaDropProvider } from '../providers/seadrop-provider.js';
import { TxJournal } from '../wallet/journal.js';
import { NonceManager } from '../wallet/nonce-manager.js';
import { Broadcaster } from '../tx/broadcaster.js';
import { TxMonitor } from '../tx/monitor.js';
import { Metrics } from '../observability/metrics.js';
import { createLogger, type Logger } from '../observability/logger.js';
import type { BotConfig } from '../config/schema.js';
import type { MintProvider } from '../providers/mint-provider.js';

/** Set from the global --env-file option before any command builds a context. */
let envFileOverride: string | undefined;

export function setEnvFileOverride(path: string | undefined): void {
  envFileOverride = path;
}

export interface CliOverrides {
  quantity?: number;
  gas?: string;
  mode?: string;
  /**
   * Target a different collection than the config names. This is what lets the
   * scheduler run many jobs off one base config: the config supplies network, wallet
   * and gas policy, each job supplies its own slug and quantity.
   */
  collectionSlug?: string;
}

/**
 * Everything needed to execute transactions on the payment chain.
 *
 * Present only under `payment.mode: cross-chain`, where the steps run on the payment
 * chain rather than the drop's chain. Each field mirrors its mint-chain counterpart —
 * the same classes, pointed at a different chain — so the executor needs no special
 * cases and the journal, which keys on `${chainId}-${address}`, stays correct per chain.
 */
export interface PaymentContext {
  slug: string;
  resolved: ResolvedChain;
  publicClient: PublicClient<Transport, Chain>;
  wallet: ReturnType<typeof createSigner>['wallet'];
  rpc: RpcManager;
  gasEngine: GasEngine;
  nonceManager: NonceManager;
  broadcaster: Broadcaster;
  monitor: TxMonitor;
  journal: TxJournal;
}

export interface BotContext {
  runId: string;
  config: BotConfig;
  configPath: string;
  resolved: ResolvedChain;
  /** Set only for cross-chain payment. */
  payment?: PaymentContext;
  logger: Logger;
  account: Account;
  wallet: ReturnType<typeof createSigner>['wallet'];
  rpc: RpcManager;
  publicClient: PublicClient<Transport, Chain>;
  gasEngine: GasEngine;
  openseaClient: OpenSeaClient;
  drops: DropsApi;
  journal: TxJournal;
  nonceManager: NonceManager;
  broadcaster: Broadcaster;
  monitor: TxMonitor;
  metrics: Metrics;
}

/**
 * Builds everything a command needs, in dependency order.
 *
 * Kept separate from the commands so `doctor`, `inspect`, `dry-run` and `start` all
 * exercise exactly the same wiring — a doctor that passes against different objects
 * than the mint uses would not be worth much.
 */
export function createContext(
  configPath: string,
  overrides: CliOverrides = {},
): BotContext {
  const env = loadEnvFile(envFileOverride);

  const runId = randomUUID();
  const logger = createLogger({ runId });
  logger.debug({ envFile: env.loaded ?? null, searched: env.searched }, 'environment loaded');

  let config: BotConfig;
  let path: string;
  try {
    ({ config, path } = loadConfig(configPath));
  } catch (error) {
    // A missing variable is nearly always a missing env *file*, so say which files were
    // considered rather than leaving the operator to guess which .env was meant.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n\n  ${describeEnvSearch(env)}`);
  }

  if (overrides.collectionSlug) config.mint.collectionSlug = overrides.collectionSlug;
  if (overrides.quantity !== undefined) config.mint.quantity = overrides.quantity;
  if (overrides.gas) config.gas.strategy = overrides.gas as BotConfig['gas']['strategy'];
  if (overrides.mode) config.execution.mode = overrides.mode as BotConfig['execution']['mode'];

  const resolved = resolveChain(config);
  const { account, wallet } = createSigner(config, resolved);
  const rpc = new RpcManager(config, resolved, logger);
  const publicClient = rpc.primary();
  const gasEngine = new GasEngine(config, resolved.feeModel, logger);

  const openseaClient = new OpenSeaClient(config, logger);
  const drops = new DropsApi(openseaClient);

  const journal = new TxJournal(
    config.journal.dir,
    config.network.chainId,
    account.address,
    runId,
    logger,
    config.journal.enabled,
  );
  const nonceManager = new NonceManager(publicClient, account.address, journal, logger);
  const broadcaster = new Broadcaster(rpc, resolved, config.rpc.parallelBroadcast, logger);
  const monitor = new TxMonitor(publicClient, logger);

  const payment = buildPaymentContext(config, account, runId, logger);

  return {
    runId,
    config,
    configPath: path,
    resolved,
    ...(payment ? { payment } : {}),
    logger,
    account,
    wallet,
    rpc,
    publicClient,
    gasEngine,
    openseaClient,
    drops,
    journal,
    nonceManager,
    broadcaster,
    monitor,
    metrics: new Metrics(),
  };
}

/**
 * Builds the payment-chain execution context, or undefined under native payment.
 *
 * Native is the fast default and needs none of this: it executes on the drop's own
 * chain using the mint-chain clients already built above.
 */
function buildPaymentContext(
  config: BotConfig,
  account: Account,
  runId: string,
  logger: Logger,
): PaymentContext | undefined {
  if (config.mint.payment.mode !== 'cross-chain') return undefined;

  const { chain: slug, token } = config.mint.payment;
  const profile = getChainProfileBySlug(slug);

  if (!profile) {
    throw new Error(
      `Unknown payment chain "${slug}". Known chains: ${supportedPaymentChains().join(', ')}.`,
    );
  }

  // Config override first, then the chain's built-in public endpoint. Selecting a
  // payment network therefore switches RPCs on its own, with no second config edit.
  const configured = config.rpc.paymentEndpoints[slug];
  const endpoints =
    configured && configured.length > 0 ? configured : defaultRpcUrls(profile);
  const endpointSource = configured && configured.length > 0 ? 'config' : 'built-in default';

  if (endpoints.length === 0) {
    throw new Error(
      `No RPC endpoint for payment chain "${slug}" — it has no built-in default, so set ` +
        `rpc.paymentEndpoints.${slug} in your config.`,
    );
  }

  logger.warn(
    {
      paymentChain: slug,
      paymentToken: token.toLowerCase() === NATIVE_TOKEN_ADDRESS ? 'native' : token,
      // Named explicitly so a shared public endpoint is never a silent surprise.
      rpc: new URL(endpoints[0]!).host,
      rpcSource: endpointSource,
    },
    'cross-chain payment selected — a swap, bridge and relay add seconds to minutes; ' +
      'use payment.mode: native for a competitive mint',
  );

  // A synthetic config pointed at the payment chain, so every existing class can be
  // reused unchanged rather than growing a second multi-chain code path.
  const paymentConfig: BotConfig = {
    ...config,
    network: {
      ...config.network,
      name: slug,
      chainId: profile.chain.id,
      orderingModel: profile.orderingModel,
      feeModel: profile.feeModel,
    },
    rpc: {
      ...config.rpc,
      endpoints,
      // Explicitly set, never inherited: spreading config.rpc carries the *mint* chain's
      // submitEndpoint, which would send payment transactions to the wrong chain's
      // sequencer. undefined makes resolveChain fall back to endpoints[0].
      submitEndpoint: profile.sequencerUrl,
    },
  };

  const resolved = resolveChain(paymentConfig);
  const { wallet } = createSigner(paymentConfig, resolved);
  const rpc = new RpcManager(paymentConfig, resolved, logger);
  const publicClient = rpc.primary();

  const journal = new TxJournal(
    config.journal.dir,
    profile.chain.id,
    account.address,
    runId,
    logger,
    config.journal.enabled,
  );

  return {
    slug,
    resolved,
    publicClient,
    wallet,
    rpc,
    gasEngine: new GasEngine(paymentConfig, profile.feeModel, logger),
    nonceManager: new NonceManager(publicClient, account.address, journal, logger),
    broadcaster: new Broadcaster(rpc, resolved, paymentConfig.rpc.parallelBroadcast, logger),
    monitor: new TxMonitor(publicClient, logger),
    journal,
  };
}

/**
 * Picks the mint provider.
 *
 * `drop_type` from the API is the discriminator when it is available. When the Drops
 * API does not know the collection — which is the open question for Robinhood Chain —
 * we fall back to talking to SeaDrop directly, provided the caller supplied a contract
 * address to talk to.
 */
export async function resolveProvider(
  ctx: BotContext,
  options: { preferLocal?: boolean; contractAddress?: string } = {},
): Promise<MintProvider> {
  const { config, drops, publicClient, account, logger, resolved } = ctx;
  const slug = config.mint.collectionSlug;

  // Cross-chain payment routes through OpenSea's relay endpoint regardless of the
  // drop's underlying contract type, so it short-circuits provider selection.
  if (config.mint.payment.mode === 'cross-chain') {
    const paymentChain = config.mint.payment.chain;

    // The relay endpoint rejects a payment chain equal to the drop's chain
    // ("Payment chain must differ from the drop chain for a cross-chain mint"), and it
    // is right to: paying on the drop's own chain *is* native payment. Fall back rather
    // than let the run die on an API error at the moment of the mint — the native path
    // reaches the same result with one transaction and no relay.
    const dropChain = await drops
      .getDrop(slug)
      .then((d) => d.chain)
      .catch(() => undefined);

    if (dropChain && dropChain.toLowerCase() === paymentChain.toLowerCase()) {
      logger.warn(
        { paymentChain, dropChain },
        'payment chain equals the drop chain — using the direct native path instead, ' +
          'which is what cross-chain payment on the same chain amounts to (and is faster)',
      );
    } else {
      return new CrossChainDropProvider(
        drops,
        {
          slug,
          minter: account.address,
          payer: account.address,
          paymentChain,
          paymentToken: config.mint.payment.token,
        },
        logger,
      );
    }
  }

  let contractAddress = options.contractAddress;
  let dropType: string | undefined;

  try {
    const drop = await drops.getDrop(slug);
    contractAddress = drop.contract_address;
    dropType = drop.drop_type;

    // Under native payment the mint executes on the drop's own chain, so a mismatch
    // means the config points somewhere the contract is not deployed. Stop rather than
    // warn: continuing would build a transaction against the wrong chain.
    if (resolved.openseaChain && drop.chain !== resolved.openseaChain) {
      throw new Error(
        `Drop "${slug}" is deployed on "${drop.chain}" but the config network is ` +
          `"${resolved.openseaChain}" (chain ${config.network.chainId}). ` +
          `Point network at the drop's chain, or use payment.mode: cross-chain to pay ` +
          `from another chain.`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Drop "')) throw error;
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'could not read the drop from the OpenSea Drops API',
    );
    if (!contractAddress) {
      throw new Error(
        `The OpenSea Drops API does not have "${slug}", and no --contract was given. ` +
          `Run "mint-bot inspect" to see what it returns, then pass --contract to use ` +
          `the direct SeaDrop path.`,
      );
    }
  }

  const isSeaDrop = dropType?.startsWith('seadrop') ?? true;

  if (options.preferLocal && isSeaDrop && contractAddress) {
    logger.info({ dropType, contractAddress }, 'using the direct SeaDrop provider');
    return new SeaDropProvider(publicClient, {
      contractAddress: getAddress(contractAddress),
      minter: account.address,
      chain: resolved.openseaChain ?? config.network.name,
    });
  }

  logger.info({ dropType }, 'using the OpenSea Drops API provider');
  return new OpenSeaDropProvider(drops, slug, account.address);
}
