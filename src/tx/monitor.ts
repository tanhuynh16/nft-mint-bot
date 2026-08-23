import type { Chain, Hex, PublicClient, TransactionReceipt, Transport } from 'viem';
import type { Logger } from '../observability/logger.js';

export interface ConfirmationOptions {
  confirmations: number;
  timeoutMs: number;
}

export interface ConfirmationResult {
  receipt: TransactionReceipt;
  /** Broadcast → receipt. */
  latencyMs: number;
  /**
   * A receipt with status 'reverted' still confirms — the transaction was mined and the
   * fee was spent, it simply failed. Callers must check this rather than assuming a
   * receipt means success.
   */
  succeeded: boolean;
}

export class TxMonitor {
  constructor(
    private readonly client: PublicClient<Transport, Chain>,
    private readonly logger: Logger,
  ) {}

  async waitForReceipt(
    txHash: Hex,
    options: ConfirmationOptions,
  ): Promise<ConfirmationResult> {
    const started = performance.now();

    const receipt = await this.client.waitForTransactionReceipt({
      hash: txHash,
      confirmations: options.confirmations,
      timeout: options.timeoutMs,
      // L2 blocks are sub-second; polling slower would add latency to the reported result.
      pollingInterval: 250,
    });

    const latencyMs = Math.round(performance.now() - started);
    const succeeded = receipt.status === 'success';

    this.logger.info(
      {
        txHash,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        status: receipt.status,
        latencyMs,
      },
      succeeded ? 'transaction confirmed' : 'transaction reverted on chain',
    );

    return { receipt, latencyMs, succeeded };
  }

  /** Non-blocking check, for reconciling a transaction recovered from the journal. */
  async tryGetReceipt(txHash: Hex): Promise<TransactionReceipt | undefined> {
    return this.client.getTransactionReceipt({ hash: txHash }).catch(() => undefined);
  }
}
