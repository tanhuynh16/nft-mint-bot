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
import type { PlanExecutor } from './plan-executor.js';
import { StageClock } from './stage-clock.js';
import type { MintPlan } from '../providers/mint-provider.js';
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
  /**
   * Executes a multi-step plan on the payment chain. Present only under cross-chain
   * payment; native payment keeps the single-transaction path below.
   */
  planExecutor?: PlanExecutor;
  /** Read client for the payment chain, used for the balance preflight under cross-chain. */
  paymentPublicClient?: PublicClient<Transport, Chain>;
  /**
   * Waits on the contract's own stage clock instead of polling. Set when the target is a
   * SeaDrop contract; the poller remains the fallback.
   */
  stageClock?: StageClock;
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

    // Under cross-chain payment the transactions execute on the payment chain, so that
    // is where funds and gas are needed. Requiring a balance on the drop's chain would
    // reject exactly the case this feature exists to serve: holding nothing there and
    // paying from somewhere else.
    // Keyed on paymentPublicClient, not the config: when the payment chain equals the
    // drop's chain the run falls back to the native path, and the balance must then be
    // checked on the drop's chain like any native mint.
    const paymentClient = this.deps.paymentPublicClient;
    const crossChain = Boolean(paymentClient);
    const payment = config.mint.payment;
    const balanceClient = paymentClient ?? publicClient;
    const balanceChain =
      crossChain && payment.mode === 'cross-chain' ? payment.chain : resolved.chain.name;

    const balance = await balanceClient.getBalance({ address: account.address });
    logger.info(
      {
        address: account.address,
        chainId,
        chain: resolved.chain.name,
        balanceChain,
        balance: formatEther(balance),
        ...(crossChain ? { note: 'balance shown for the payment chain' } : {}),
      },
      'wallet ready',
    );

    if (balance === 0n) {
      throw new Error(
        `Wallet ${account.address} has zero native balance on ${balanceChain}` +
          (crossChain
            ? ' — gas there is required even when the mint price is paid in a token.'
            : '.'),
      );
    }
  }

  /**
   * Blocks until a stage is open, or returns immediately if one already is.
   *
   * Polls rather than sleeping straight to the advertised start time: stage times move,
   * and a bot asleep past the open is a bot that lost.
   */
  private async waitForActiveStage(): Promise<MintStatus> {
    const { provider, config, logger, metrics, stageClock } = this.deps;
    const deadline =
      config.mint.waitTimeoutMs > 0 ? Date.now() + config.mint.waitTimeoutMs : undefined;

    metrics.start('detect');

    // Prefer the contract's clock: polling is late by up to its interval, and on a chain
    // producing a block every ~100ms that hands a block to everyone else. The contract
    // also *is* the authority — it is what reverts if we are early.
    if (stageClock) {
      const window = await stageClock.readWindow();
      if (window) {
        // Read supply and stage metadata *before* the wait. Doing it afterwards would put
        // an OpenSea round-trip at T0 — the exact 211ms this path exists to remove. The
        // figures are then slightly stale, which is acceptable: the contract enforces
        // supply and the per-wallet cap itself, reverting if either is exceeded.
        const status = await provider.getStatus();
        stageClock.reportDrift(window, status.nextStage?.startTime?.toISOString());

        const open = await stageClock.waitForOpen(window);
        if (open) {
          metrics.end('detect', 'detect');
          logger.info(
            {
              source: 'contract',
              startedAt: new Date(window.startsAtMs).toISOString(),
              pricePerToken: window.pricePerToken.toString(),
              maxPerWallet: window.maxPerWallet.toString(),
            },
            'stage open per the contract clock',
          );

          // Present the contract's own limits, which are authoritative, over whatever
          // OpenSea reported before the wait.
          return {
            ...status,
            isMinting: true,
            activeStage: {
              label: status.activeStage?.label ?? status.nextStage?.label ?? 'public',
              startTime: new Date(window.startsAtMs),
              endTime: new Date(window.endsAtMs),
              pricePerToken: window.pricePerToken,
              maxPerWallet: window.maxPerWallet,
              requiresProof: false,
            },
          };
        }
      }
    }

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
      planExecutor,
    } = this.deps;

    // Race path: everything below was done before the window opened.
    if (presignedTx) {
      return this.broadcastPresigned(presignedTx);
    }

    // Cross-chain path: a sequence on the payment chain, not one call on this one.
    if (planExecutor) {
      return this.executePlan(planExecutor);
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

  /**
   * Runs a cross-chain payment plan.
   *
   * The provider returns an ordered sequence on the payment chain; the executor runs it
   * step by step. The final step only initiates the mint — the relay delivers it to the
   * drop's chain afterwards, so a confirmed receipt here means "payment accepted", not
   * "NFT in hand". The relay id is surfaced so delivery can be tracked.
   */
  private async executePlan(executor: PlanExecutor): Promise<MintOutcome> {
    const { config, provider, metrics, logger } = this.deps;

    this.transition('BUILDING_TX');

    const buildPlan = (provider as { buildMintPlan?: (q: bigint) => Promise<MintPlan> })
      .buildMintPlan;
    if (typeof buildPlan !== 'function') {
      throw new Error(`Provider "${provider.name}" cannot build a cross-chain mint plan.`);
    }

    const [plan] = await metrics.time<MintPlan>('build', () =>
      buildPlan.call(provider, BigInt(config.mint.quantity)),
    );

    const dryRun = config.execution.mode === 'dry-run';
    if (dryRun) {
      logger.info(
        {
          steps: plan.transactions.map((tx, i) => ({
            step: i + 1,
            label: tx.label,
            chain: tx.chain,
            to: tx.to,
            value: tx.value.toString(),
          })),
          relayRequestId: plan.relayRequestId,
        },
        'dry-run: cross-chain plan built, nothing will be broadcast',
      );
    }

    this.transition('BROADCASTING');
    const result = await executor.execute(plan, dryRun);

    if (dryRun) {
      this.transition('CONFIRMED');
      return { state: 'CONFIRMED', attempts: this.attempts, metrics: metrics.summary() };
    }

    this.transition('CONFIRMED');
    logger.info(
      {
        steps: result.steps,
        finalTxHash: result.finalTxHash,
        relayRequestId: result.relayRequestId,
      },
      'payment accepted — the relay now delivers the mint to the drop chain',
    );

    return {
      state: 'CONFIRMED',
      ...(result.finalTxHash ? { txHash: result.finalTxHash } : {}),
      attempts: this.attempts,
      metrics: metrics.summary(),
    };
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
