import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from 'viem';
import { formatEther, keccak256 } from 'viem';
import type { BotConfig } from '../config/schema.js';
import type { ResolvedChain } from '../chains/registry.js';
import type { MintProvider, MintStatus, UnsignedTx } from '../providers/mint-provider.js';
import type { NonceManager } from '../wallet/nonce-manager.js';
import type { GasEngine } from '../network/gas-engine.js';
import type { Broadcaster } from './broadcaster.js';
import type { TxMonitor } from './monitor.js';
import { simulate } from './simulator.js';
import { classifyError } from '../retry/classifier.js';
import type { Metrics } from '../observability/metrics.js';
import type { Logger } from '../observability/logger.js';

export type MintState =
  | 'WAITING'
  | 'PREPARE'
  | 'ACTIVE'
  | 'BUILDING_TX'
  | 'SIMULATING'
  | 'SIGNING'
  | 'BROADCASTING'
  | 'PENDING'
  | 'CONFIRMED'
  | 'FAILED';

export interface MintOutcome {
  state: MintState;
  txHash?: Hex;
  blockNumber?: bigint;
  attempts: number;
  errorClass?: string;
  error?: string;
  metrics: Record<string, unknown>;
}

export interface OrchestratorDeps {
  config: BotConfig;
  resolved: ResolvedChain;
  provider: MintProvider;
  publicClient: PublicClient<Transport, Chain>;
  wallet: WalletClient<Transport, Chain, Account>;
  account: Account;
  nonceManager: NonceManager;
  gasEngine: GasEngine;
  broadcaster: Broadcaster;
  monitor: TxMonitor;
  metrics: Metrics;
  logger: Logger;
  /** Pre-signed raw transaction, when the race path is armed. */
  presignedTx?: Hex;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MintOrchestrator {
  private state: MintState = 'WAITING';
  private attempts = 0;

  constructor(private readonly deps: OrchestratorDeps) {}

  private transition(next: MintState): void {
    this.deps.logger.info({ from: this.state, to: next }, 'state');
    this.state = next;
  }

  async run(): Promise<MintOutcome> {
    const { config, provider, logger, metrics } = this.deps;

    try {
      this.transition('PREPARE');
      await this.preflightChecks();

      const status = await this.waitForActiveStage();
      this.transition('ACTIVE');

      this.guardSupplyAndLimits(status);

      const outcome = await this.attemptMintLoop();
      return outcome;
    } catch (error) {
      const classification = classifyError(error, config.mint.retryDelayMs);
      this.transition('FAILED');
      logger.error(
        { errorClass: classification.class, reason: classification.reason },
        'mint failed',
      );
      return {
        state: 'FAILED',
        attempts: this.attempts,
        errorClass: classification.class,
        error: error instanceof Error ? error.message : String(error),
        metrics: metrics.summary(),
      };
    } finally {
      logger.debug({ provider: provider.name }, 'run complete');
    }
  }

  /** Chain id, balance, and quantity checks. Everything that should stop us before signing. */
  private async preflightChecks(): Promise<void> {
    const { publicClient, config, account, resolved, logger } = this.deps;

    const chainId = await publicClient.getChainId();
    if (chainId !== config.network.chainId) {
      throw new Error(
        `RPC reports chain ${chainId}, config expects ${config.network.chainId}. Refusing to sign.`,
      );
    }

    const balance = await publicClient.getBalance({ address: account.address });
    logger.info(
      {
        address: account.address,
        chainId,
        chain: resolved.chain.name,
        balance: formatEther(balance),
      },
      'wallet ready',
    );

    if (balance === 0n) {
      throw new Error(`Wallet ${account.address} has zero balance on ${resolved.chain.name}.`);
    }
  }

  /**
   * Blocks until a stage is open, or returns immediately if one already is.
   *
   * Polls rather than sleeping straight to the advertised start time: stage times move,
   * and a bot asleep past the open is a bot that lost.
   */
  private async waitForActiveStage(): Promise<MintStatus> {
    const { provider, config, logger, metrics } = this.deps;
    const deadline =
      config.mint.waitTimeoutMs > 0 ? Date.now() + config.mint.waitTimeoutMs : undefined;

    metrics.start('detect');

    for (;;) {
      const status = await provider.getStatus();

      if (status.isMinting && status.activeStage) {
        metrics.end('detect', 'detect');
        logger.info(
          { stage: status.activeStage.label, remaining: status.remainingSupply?.toString() },
          'stage is active',
        );
        return status;
      }

      if (!config.mint.waitForStage) {
        throw new Error('No active mint stage and mint.waitForStage is false.');
      }

      if (deadline && Date.now() > deadline) {
        throw new Error('Timed out waiting for a mint stage to open.');
      }

      const startsAt = status.nextStage?.startTime;
      const msUntil = startsAt ? startsAt.getTime() - Date.now() : undefined;

      // Poll lazily while the open is far away, then tighten to catch it promptly.
      const pollMs =
        msUntil === undefined ? 5_000 : msUntil > 60_000 ? 15_000 : msUntil > 5_000 ? 1_000 : 200;

      logger.info(
        { nextStage: status.nextStage?.label, startsInMs: msUntil, pollMs },
        'waiting for stage',
      );
      await sleep(pollMs);
    }
  }

  private guardSupplyAndLimits(status: MintStatus): void {
    const { config, logger } = this.deps;
    const requested = BigInt(config.mint.quantity);

    if (status.remainingSupply !== undefined && status.remainingSupply < requested) {
      throw new Error(
        `Requested ${requested} but only ${status.remainingSupply} remain. ` +
          `Lower mint.quantity or accept the smaller amount explicitly.`,
      );
    }

    const maxPerWallet = status.activeStage?.maxPerWallet;
    if (maxPerWallet !== undefined && requested > maxPerWallet) {
      throw new Error(
        `Requested ${requested} but the stage allows ${maxPerWallet} per wallet.`,
      );
    }

    logger.debug(
      {
        requested: requested.toString(),
        remaining: status.remainingSupply?.toString(),
        maxPerWallet: maxPerWallet?.toString(),
      },
      'supply and limit guards passed',
    );
  }

  private async attemptMintLoop(): Promise<MintOutcome> {
    const { config, logger, metrics, nonceManager } = this.deps;
    let lastError: unknown;

    while (this.attempts <= config.mint.maxRetries) {
      this.attempts += 1;

      try {
        return await this.attemptMint();
      } catch (error) {
        lastError = error;
        const classification = classifyError(error, config.mint.retryDelayMs);

        logger.warn(
          {
            attempt: this.attempts,
            errorClass: classification.class,
            reason: classification.reason,
          },
          'mint attempt failed',
        );

        if (classification.class === 'deterministic' && /nonce/i.test(classification.reason)) {
          // Recoverable, but only after resyncing with the chain.
          await nonceManager.reconcile();
        } else if (!classification.retry) {
          this.transition('FAILED');
          return {
            state: 'FAILED',
            attempts: this.attempts,
            errorClass: classification.class,
            error: classification.reason,
            metrics: metrics.summary(),
          };
        }

        if (classification.delayMs) await sleep(classification.delayMs);
      }
    }

    this.transition('FAILED');
    return {
      state: 'FAILED',
      attempts: this.attempts,
      errorClass: 'retryable',
      error: `exhausted ${config.mint.maxRetries} retries: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      metrics: metrics.summary(),
    };
  }

  private async attemptMint(): Promise<MintOutcome> {
    const {
      config,
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
      presignedTx,
    } = this.deps;

    // Race path: everything below was done before the window opened.
    if (presignedTx) {
      return this.broadcastPresigned(presignedTx);
    }

    this.transition('BUILDING_TX');
    const [tx] = await metrics.time<UnsignedTx>('build', () =>
      provider.buildMint(BigInt(config.mint.quantity)),
    );
    logger.debug({ to: tx.to, value: tx.value.toString() }, 'mint transaction built');

    if (config.execution.mode !== 'race') {
      this.transition('SIMULATING');
      const result = await simulate(publicClient, tx, account.address, logger);
      metrics.record('simulate', result.latencyMs);
      if (!result.ok) {
        throw new Error(`simulation failed: ${result.error ?? 'unknown'}`);
      }
      if (config.execution.mode === 'dry-run') {
        logger.info('dry-run complete — not broadcasting');
        return {
          state: 'CONFIRMED',
          attempts: this.attempts,
          metrics: metrics.summary(),
        };
      }
    }

    const [gasParams] = await metrics.time('gas', () =>
      gasEngine.calculate(publicClient, tx, account.address),
    );
    await this.assertAffordable(tx, gasParams.maxFeeCost);

    const nonce = nonceManager.reserve();

    this.transition('SIGNING');
    let rawTx: Hex;
    try {
      const [signed] = await metrics.time('sign', () =>
        wallet.signTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value,
          nonce,
          gas: gasParams.gas,
          maxFeePerGas: gasParams.maxFeePerGas,
          maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
          chain: this.deps.resolved.chain,
        }),
      );
      rawTx = signed;
    } catch (error) {
      // Nothing was sent, so the nonce is still free.
      nonceManager.releaseOnPreSignFailure(nonce, 'signing failed');
      throw error;
    }

    return this.broadcastAndConfirm(rawTx, nonce);
  }

  private async broadcastPresigned(rawTx: Hex): Promise<MintOutcome> {
    const { nonceManager, logger } = this.deps;
    const nonce = nonceManager.peek();
    logger.info({ nonce }, 'broadcasting pre-signed transaction');
    // The nonce was already reserved and journaled when the transaction was armed.
    return this.broadcastAndConfirm(rawTx, nonce ?? 0, true);
  }

  private async broadcastAndConfirm(
    rawTx: Hex,
    nonce: number,
    presigned = false,
  ): Promise<MintOutcome> {
    const { config, nonceManager, broadcaster, monitor, metrics, logger } = this.deps;

    this.transition('BROADCASTING');

    // Journaled before the send, so a crash mid-flight leaves a recoverable record
    // rather than an orphaned nonce. The hash is derived locally from the signed bytes,
    // so we know it without waiting for the node's reply.
    const predictedHash = keccak256(rawTx);
    nonceManager.markBroadcast(nonce, predictedHash, presigned ? rawTx : undefined);

    let result;
    try {
      result = await broadcaster.send(rawTx);
    } catch (error) {
      nonceManager.markFailed(
        nonce,
        error instanceof Error ? error.message : String(error),
        predictedHash,
      );
      throw error;
    }

    metrics.record('broadcast', result.latencyMs);
    logger.info(
      { txHash: result.txHash, acceptedBy: result.acceptedBy, latencyMs: result.latencyMs },
      'broadcast accepted',
    );

    this.transition('PENDING');

    if (!config.execution.waitForConfirmation) {
      return {
        state: 'PENDING',
        txHash: result.txHash,
        attempts: this.attempts,
        metrics: metrics.summary(),
      };
    }

    const confirmation = await monitor.waitForReceipt(result.txHash, {
      confirmations: config.execution.confirmationBlocks,
      timeoutMs: config.execution.confirmationTimeoutMs,
    });
    metrics.record('confirm', confirmation.latencyMs);

    if (!confirmation.succeeded) {
      nonceManager.markFailed(nonce, 'reverted on chain', result.txHash);
      // Mined but reverted: the nonce is spent and the gas is gone. Retrying the same
      // call would revert identically, so this is terminal.
      this.transition('FAILED');
      return {
        state: 'FAILED',
        txHash: result.txHash,
        blockNumber: confirmation.receipt.blockNumber,
        attempts: this.attempts,
        errorClass: 'deterministic',
        error: 'transaction reverted on chain',
        metrics: metrics.summary(),
      };
    }

    nonceManager.markConfirmed(nonce, result.txHash);
    this.transition('CONFIRMED');

    return {
      state: 'CONFIRMED',
      txHash: result.txHash,
      blockNumber: confirmation.receipt.blockNumber,
      attempts: this.attempts,
      metrics: metrics.summary(),
    };
  }

  /** Refuses to sign a transaction the wallet demonstrably cannot cover. */
  private async assertAffordable(tx: UnsignedTx, maxFeeCost: bigint): Promise<void> {
    const { publicClient, account } = this.deps;
    const balance = await publicClient.getBalance({ address: account.address });
    const required = tx.value + maxFeeCost;

    if (balance < required) {
      throw new Error(
        `insufficient funds: need ${formatEther(required)} ` +
          `(${formatEther(tx.value)} mint + ${formatEther(maxFeeCost)} max gas) ` +
          `but wallet holds ${formatEther(balance)}`,
      );
    }
  }
}
