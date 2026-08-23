import type { Address, Chain, Hex, PublicClient, Transport } from 'viem';
import type { TxJournal } from './journal.js';
import type { Logger } from '../observability/logger.js';

export interface PendingRecovery {
  nonce: number;
  txHash?: string;
  rawTx?: string;
}

export interface ReconcileResult {
  /** Chain's pending transaction count — the next free nonce. */
  chainNonce: number;
  /** Journal entries that were broadcast but have no receipt yet. */
  stillPending: PendingRecovery[];
  /** Journal entries whose transaction confirmed while the process was down. */
  confirmed: PendingRecovery[];
}

/**
 * Single authoritative nonce allocator for one wallet.
 *
 * All allocation flows through one instance so no two code paths can read-then-increment
 * concurrently and hand out the same nonce twice. Every state change is journaled before
 * it is acted on, so a crash is recoverable.
 */
export class NonceManager {
  private next: number | undefined;
  private readonly inFlight = new Set<number>();

  constructor(
    private readonly client: PublicClient<Transport, Chain>,
    private readonly address: Address,
    private readonly journal: TxJournal,
    private readonly logger: Logger,
  ) {}

  /**
   * Establishes the starting nonce and resolves anything left over from a previous run.
   *
   * The 'pending' block tag counts transactions the node has accepted but not yet mined,
   * so it already accounts for our own in-flight transactions and is the correct base.
   */
  async initialize(): Promise<ReconcileResult> {
    const chainNonce = await this.client.getTransactionCount({
      address: this.address,
      blockTag: 'pending',
    });

    const leftovers = this.journal.unresolved();
    const stillPending: PendingRecovery[] = [];
    const confirmed: PendingRecovery[] = [];

    for (const event of leftovers) {
      if (!event.txHash) {
        // Reserved but never broadcast: nothing is on the chain, the nonce is free.
        this.journal.append({
          type: 'released',
          nonce: event.nonce,
          error: 'reserved but never broadcast; released on restart',
        });
        continue;
      }

      const receipt = await this.client
        .getTransactionReceipt({ hash: event.txHash as Hex })
        .catch(() => undefined);

      if (receipt) {
        this.journal.append({ type: 'confirmed', nonce: event.nonce, txHash: event.txHash });
        confirmed.push({ nonce: event.nonce, txHash: event.txHash });
      } else if (event.nonce < chainNonce) {
        // The chain has moved past this nonce but our hash has no receipt: some other
        // transaction took the slot (a replacement, or a manual send). Ours is dead.
        this.journal.append({
          type: 'failed',
          nonce: event.nonce,
          txHash: event.txHash,
          error: 'nonce consumed by a different transaction',
        });
      } else {
        stillPending.push({
          nonce: event.nonce,
          txHash: event.txHash,
          ...(event.rawTx ? { rawTx: event.rawTx } : {}),
        });
      }
    }

    this.next = chainNonce;

    this.logger.info(
      {
        chainNonce,
        recoveredPending: stillPending.length,
        recoveredConfirmed: confirmed.length,
      },
      'nonce manager initialized',
    );

    return { chainNonce, stillPending, confirmed };
  }

  /** Allocates the next nonce and journals the reservation before returning it. */
  reserve(): number {
    if (this.next === undefined) {
      throw new Error('NonceManager.initialize() must run before reserve()');
    }
    const nonce = this.next;
    this.next += 1;
    this.inFlight.add(nonce);
    this.journal.append({ type: 'reserved', nonce });
    return nonce;
  }

  /**
   * Records a broadcast. Must be called and awaited (it fsyncs) *before* the raw
   * transaction is handed to the network.
   */
  markBroadcast(nonce: number, txHash: string, rawTx?: string): void {
    this.journal.append({
      type: 'broadcast',
      nonce,
      txHash,
      ...(rawTx ? { rawTx } : {}),
    });
  }

  markConfirmed(nonce: number, txHash: string): void {
    this.inFlight.delete(nonce);
    this.journal.append({ type: 'confirmed', nonce, txHash });
  }

  markFailed(nonce: number, error: string, txHash?: string): void {
    this.inFlight.delete(nonce);
    this.journal.append({
      type: 'failed',
      nonce,
      error,
      ...(txHash ? { txHash } : {}),
    });
  }

  /**
   * Returns a nonce that was reserved but never broadcast.
   *
   * Only safe before broadcast: once a transaction is on the wire, the nonce is spent
   * whether or not we saw the response.
   */
  releaseOnPreSignFailure(nonce: number, reason: string): void {
    if (!this.inFlight.has(nonce)) return;
    this.inFlight.delete(nonce);
    // Only the most recently issued nonce can be handed back without leaving a gap.
    if (this.next !== undefined && nonce === this.next - 1) {
      this.next = nonce;
    }
    this.journal.append({ type: 'released', nonce, error: reason });
  }

  /** Re-reads the chain after a nonce error and resets the counter to match. */
  async reconcile(): Promise<number> {
    const chainNonce = await this.client.getTransactionCount({
      address: this.address,
      blockTag: 'pending',
    });
    this.logger.warn({ from: this.next, to: chainNonce }, 'reconciling nonce against chain');
    this.next = chainNonce;
    return chainNonce;
  }

  peek(): number | undefined {
    return this.next;
  }

  pending(): number[] {
    return [...this.inFlight];
  }
}
