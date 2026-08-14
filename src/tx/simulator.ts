import type { Address, Chain, PublicClient, Transport } from 'viem';
import type { UnsignedTx } from '../providers/mint-provider.js';
import type { Logger } from '../observability/logger.js';

export interface SimulationResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * Dry-runs the mint call against current state via eth_call.
 *
 * Worth one round-trip in preflight mode: it catches wrong calldata, a bad fee
 * recipient, or an inactive stage before spending gas on a revert. In race mode it is
 * skipped — the round-trip costs more than a reverted transaction does, and by then the
 * call has already been validated in a dry run.
 */
export async function simulate(
  client: PublicClient<Transport, Chain>,
  tx: UnsignedTx,
  from: Address,
  logger: Logger,
): Promise<SimulationResult> {
  const started = performance.now();
  try {
    await client.call({
      account: from,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
    const latencyMs = Math.round(performance.now() - started);
    logger.debug({ latencyMs }, 'simulation passed');
    return { ok: true, latencyMs };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ latencyMs, error: message.slice(0, 300) }, 'simulation failed');
    return { ok: false, latencyMs, error: message };
  }
}
