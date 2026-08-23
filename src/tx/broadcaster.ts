import type { Chain, Hex, PublicClient, Transport } from 'viem';
import type { RpcManager } from '../network/rpc-manager.js';
import type { ResolvedChain } from '../chains/registry.js';
import type { Logger } from '../observability/logger.js';

export interface BroadcastResult {
  txHash: Hex;
  /** Endpoint that accepted the transaction first. */
  acceptedBy: string;
  /** Time from send to first acceptance. */
  latencyMs: number;
  /** Endpoints that rejected it, for diagnostics. */
  errors: Array<{ url: string; error: string }>;
}

export class Broadcaster {
  constructor(
    private readonly rpc: RpcManager,
    private readonly resolved: ResolvedChain,
    private readonly parallel: boolean,
    private readonly logger: Logger,
  ) {}

  /**
   * Submits a signed transaction and returns as soon as one endpoint accepts it.
   *
   * On an fcfs chain this sends to the sequencer alone: it is the only node whose
   * arrival time decides ordering, and any other endpoint just relays to it, adding a
   * hop. On a priority-auction chain, fanning out to every healthy endpoint genuinely
   * improves the odds of reaching a builder quickly, so `parallel` enables that.
   */
  async send(rawTx: Hex): Promise<BroadcastResult> {
    const targets =
      this.parallel && this.resolved.orderingModel === 'priority-auction'
        ? this.fanoutTargets()
        : [this.resolved.submitUrl];

    const started = performance.now();
    const errors: Array<{ url: string; error: string }> = [];

    if (targets.length === 1) {
      const url = targets[0]!;
      const txHash = await this.sendTo(this.rpc.client(url), rawTx);
      return {
        txHash,
        acceptedBy: url,
        latencyMs: Math.round(performance.now() - started),
        errors,
      };
    }

    // First acceptance wins; the rest are duplicates the network will dedupe by hash.
    const attempts = targets.map(async (url) => {
      try {
        const txHash = await this.sendTo(this.rpc.client(url), rawTx);
        return { url, txHash };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ url, error: message });
        throw error;
      }
    });

    const winner = await Promise.any(attempts).catch((aggregate: unknown) => {
      // Every endpoint rejected it. Surface the first real error, not the AggregateError,
      // so the classifier sees a message it can act on.
      const first = errors[0]?.error ?? String(aggregate);
      throw new Error(`all ${targets.length} endpoints rejected the transaction: ${first}`);
    });

    return {
      txHash: winner.txHash,
      acceptedBy: winner.url,
      latencyMs: Math.round(performance.now() - started),
      errors,
    };
  }

  private async sendTo(
    client: PublicClient<Transport, Chain>,
    rawTx: Hex,
  ): Promise<Hex> {
    return client.sendRawTransaction({ serializedTransaction: rawTx });
  }

  private fanoutTargets(): string[] {
    const healthy = this.rpc.healthyUrls();
    const targets = healthy.length > 0 ? healthy : this.resolved.readUrls;
    return [...new Set([this.resolved.submitUrl, ...targets])];
  }
}
