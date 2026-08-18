import {
  decodeFunctionData,
  keccak256,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import type { MintPlan, PlannedTx } from '../providers/mint-provider.js';
import type { GasEngine } from '../network/gas-engine.js';
import type { NonceManager } from '../wallet/nonce-manager.js';
import type { Broadcaster } from './broadcaster.js';
import type { TxMonitor } from './monitor.js';
import type { Metrics } from '../observability/metrics.js';
import type { Logger } from '../observability/logger.js';
import type { ResolvedChain } from '../chains/registry.js';

const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export interface StepResult {
  step: number;
  label: string;
  txHash?: Hex;
  skipped: boolean;
  reason?: string;
}

export interface PlanResult {
  steps: StepResult[];
  /** Hash of the final step — the one that actually initiates the mint. */
  finalTxHash?: Hex;
  relayRequestId?: string;
}

export interface PlanExecutorDeps {
  resolved: ResolvedChain;
  publicClient: PublicClient<Transport, Chain>;
  wallet: WalletClient<Transport, Chain, Account>;
  account: Account;
  nonceManager: NonceManager;
  gasEngine: GasEngine;
  broadcaster: Broadcaster;
  monitor: TxMonitor;
  metrics: Metrics;
  logger: Logger;
  confirmationBlocks: number;
  confirmationTimeoutMs: number;
}

/**
 * Runs an ordered transaction plan on a single chain, one step at a time.
 *
 * Steps are strictly sequential: an `approve` must be mined before the call that spends
 * the allowance, so each step waits for its receipt before the next is signed. That is
 * slower than firing them together and is not negotiable — sending both at once means
 * the second reverts whenever the first has not landed.
 */
export class PlanExecutor {
  constructor(private readonly deps: PlanExecutorDeps) {}

  async execute(plan: MintPlan, dryRun = false): Promise<PlanResult> {
    const { logger } = this.deps;
    const steps: StepResult[] = [];
    let finalTxHash: Hex | undefined;

    for (const [index, tx] of plan.transactions.entries()) {
      const step = index + 1;
      const label = tx.label ?? 'step';

      const skip = await this.shouldSkip(tx);
      if (skip) {
        logger.info({ step, label, reason: skip }, 'skipping step');
        steps.push({ step, label, skipped: true, reason: skip });
        continue;
      }

      if (dryRun) {
        logger.info(
          { step, label, to: tx.to, value: tx.value.toString(), chain: tx.chain },
          'dry-run: step would be sent',
        );
        steps.push({ step, label, skipped: false, reason: 'dry-run' });
        continue;
      }

      const txHash = await this.runStep(tx, step, label, plan.transactions.length);
      steps.push({ step, label, txHash, skipped: false });
      finalTxHash = txHash;
    }

    return {
      steps,
      ...(finalTxHash ? { finalTxHash } : {}),
      ...(plan.relayRequestId ? { relayRequestId: plan.relayRequestId } : {}),
    };
  }

  /**
   * Returns a reason to skip, or undefined to run the step.
   *
   * Only approvals are skippable, and only when the on-chain allowance already covers
   * the amount. Checking the chain rather than a local record means this also holds
   * after a crash or a re-run: a token approved by a previous attempt is not approved
   * twice, which would waste gas and pointlessly re-arm an allowance.
   */
  private async shouldSkip(tx: PlannedTx): Promise<string | undefined> {
    if (tx.label !== 'approve') return undefined;

    try {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      if (decoded.functionName !== 'approve') return undefined;

      const [spender, amount] = decoded.args;
      const current = await this.deps.publicClient.readContract({
        address: tx.to,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [this.deps.account.address, spender],
      });

      if (current >= amount) {
        return `allowance already ${current} >= ${amount}`;
      }
    } catch (error) {
      // An undecodable or unreadable approval is not a reason to skip — fall through and
      // let it execute rather than silently omitting a step the mint depends on.
      this.deps.logger.debug(
        { error: error instanceof Error ? error.message : String(error) },
        'allowance pre-check failed; executing the approve',
      );
    }

    return undefined;
  }

  private async runStep(
    tx: PlannedTx,
    step: number,
    label: string,
    total: number,
  ): Promise<Hex> {
    const {
      publicClient,
      wallet,
      account,
      nonceManager,
      gasEngine,
      broadcaster,
      monitor,
      metrics,
      logger,
      resolved,
      confirmationBlocks,
      confirmationTimeoutMs,
    } = this.deps;

    logger.info({ step, total, label, to: tx.to, value: tx.value.toString() }, 'executing step');

    const gasParams = await gasEngine.calculate(publicClient, tx, account.address);
    const nonce = nonceManager.reserve();

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
          chain: resolved.chain,
        }),
      );
      rawTx = signed;
    } catch (error) {
      nonceManager.releaseOnPreSignFailure(nonce, `signing step ${step} failed`);
      throw error;
    }

    const predictedHash = keccak256(rawTx);
    nonceManager.markBroadcast(nonce, predictedHash);

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

    // Sequential by necessity: the next step spends what this one authorises.
    const confirmation = await monitor.waitForReceipt(result.txHash, {
      confirmations: confirmationBlocks,
      timeoutMs: confirmationTimeoutMs,
    });
    metrics.record('confirm', confirmation.latencyMs);

    if (!confirmation.succeeded) {
      nonceManager.markFailed(nonce, `step ${step} (${label}) reverted`, result.txHash);
      throw new Error(
        `Step ${step} of ${total} (${label}) reverted on chain: ${result.txHash}`,
      );
    }

    nonceManager.markConfirmed(nonce, result.txHash);
    logger.info({ step, total, label, txHash: result.txHash }, 'step confirmed');

    return result.txHash;
  }
}
