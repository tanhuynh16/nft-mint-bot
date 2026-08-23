import { getAddress, type Account, type Chain, type PublicClient, type Transport } from 'viem';
import { randomUUID } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { loadConfig } from '../config/loader.js';
import { resolveChain, type ResolvedChain } from '../chains/registry.js';
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

export interface CliOverrides {
  quantity?: number;
  gas?: string;
  mode?: string;
}

export interface BotContext {
  runId: string;
  config: BotConfig;
  configPath: string;
  resolved: ResolvedChain;
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
  loadDotenv({ quiet: true });

  const runId = randomUUID();
  const logger = createLogger({ runId });

  const { config, path } = loadConfig(configPath);

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

  return {
    runId,
    config,
    configPath: path,
    resolved,
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

  let contractAddress = options.contractAddress;
  let dropType: string | undefined;

  try {
    const drop = await drops.getDrop(slug);
    contractAddress = drop.contract_address;
    dropType = drop.drop_type;

    if (resolved.openseaChain && drop.chain !== resolved.openseaChain) {
      logger.warn(
        { apiChain: drop.chain, configChain: resolved.openseaChain },
        'drop chain does not match the configured network',
      );
    }
  } catch (error) {
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
