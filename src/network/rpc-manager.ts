import { createPublicClient, http, type PublicClient, type Transport, type Chain } from 'viem';
import type { BotConfig } from '../config/schema.js';
import type { ResolvedChain } from '../chains/registry.js';
import type { Logger } from '../observability/logger.js';

export interface EndpointHealth {
  url: string;
  ok: boolean;
  latencyMs: number;
  chainId?: number;
  blockNumber?: bigint;
  error?: string;
}

export class RpcManager {
  private readonly clients = new Map<string, PublicClient<Transport, Chain>>();
  private health: EndpointHealth[] = [];

  constructor(
    private readonly config: BotConfig,
    private readonly resolved: ResolvedChain,
    private readonly logger: Logger,
  ) {
    for (const url of this.allUrls()) {
      this.clients.set(
        url,
        createPublicClient({
          chain: resolved.chain,
          transport: http(url, {
            timeout: config.rpc.timeoutMs,
            fetchOptions: { keepalive: true },
            retryCount: 0,
          }),
        }),
      );
    }
  }

  /** Read endpoints plus the submit endpoint, deduplicated. */
  private allUrls(): string[] {
    return [...new Set([...this.resolved.readUrls, this.resolved.submitUrl])];
  }

  /**
   * True when the submit endpoint is a dedicated sequencer rather than a full node.
   *
   * Arbitrum sequencer endpoints expose only eth_sendRawTransaction — every read
   * method returns -32601. Probing one with eth_blockNumber reports it as down when it
   * is in fact perfectly healthy for the one job it has.
   */
  private submitIsWriteOnly(): boolean {
    return (
      this.resolved.submitUrl !== this.resolved.readUrls[0] &&
      !this.resolved.readUrls.includes(this.resolved.submitUrl)
    );
  }

  client(url: string): PublicClient<Transport, Chain> {
    const client = this.clients.get(url);
    if (!client) throw new Error(`No RPC client for ${url}`);
    return client;
  }

  /**
   * Client for reads: the healthiest read endpoint, or the first configured one before
   * probing. Never returns the submit endpoint when that is a write-only sequencer.
   */
  primary(): PublicClient<Transport, Chain> {
    const readable = new Set(this.resolved.readUrls);
    const best = this.health.find((h) => h.ok && readable.has(h.url));
    return this.client(best?.url ?? this.resolved.readUrls[0]!);
  }

  submitClient(): PublicClient<Transport, Chain> {
    return this.client(this.resolved.submitUrl);
  }

  /**
   * Measures each endpoint and, as a side effect, opens the TLS connections that the
   * mint window would otherwise pay for. Call this before the stage opens.
   */
  async probe(): Promise<EndpointHealth[]> {
    const writeOnlySubmit = this.submitIsWriteOnly();

    const results = await Promise.all(
      this.allUrls().map(async (url): Promise<EndpointHealth> => {
        if (writeOnlySubmit && url === this.resolved.submitUrl) {
          return this.probeWriteEndpoint(url);
        }

        const started = performance.now();
        try {
          const client = this.client(url);
          const [chainId, blockNumber] = await Promise.all([
            client.getChainId(),
            client.getBlockNumber(),
          ]);
          return {
            url,
            ok: true,
            latencyMs: Math.round(performance.now() - started),
            chainId,
            blockNumber,
          };
        } catch (error) {
          return {
            url,
            ok: false,
            latencyMs: Math.round(performance.now() - started),
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    // Healthy first, then fastest.
    this.health = results.sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      return a.latencyMs - b.latencyMs;
    });

    for (const h of this.health) {
      this.logger.debug(
        { url: h.url, ok: h.ok, latencyMs: h.latencyMs, chainId: h.chainId },
        'rpc probe',
      );
    }

    return this.health;
  }

  /**
   * Liveness check for a write-only sequencer, using the method it actually serves.
   *
   * Calls eth_sendRawTransaction with no params: a live sequencer replies -32602
   * ("missing value for required argument 0"), which proves the endpoint is up and the
   * method is available without submitting anything. -32601 would mean it does not
   * serve the one method we need. This doubles as the RTT measurement that, on an fcfs
   * chain, is the number that decides whether the bot wins.
   */
  private async probeWriteEndpoint(url: string): Promise<EndpointHealth> {
    const started = performance.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_sendRawTransaction',
          params: [],
        }),
        signal: AbortSignal.timeout(this.config.rpc.timeoutMs),
        keepalive: true,
      });

      const latencyMs = Math.round(performance.now() - started);
      const body = (await response.json()) as { error?: { code?: number; message?: string } };
      const code = body.error?.code;

      if (code === -32601) {
        return {
          url,
          ok: false,
          latencyMs,
          error: 'endpoint does not serve eth_sendRawTransaction',
        };
      }

      // -32602 (bad params) or any non-error response means the method is live.
      return { url, ok: true, latencyMs };
    } catch (error) {
      return {
        url,
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  lastHealth(): EndpointHealth[] {
    return this.health;
  }

  /** Endpoints that answered on the last probe, fastest first. */
  healthyUrls(): string[] {
    return this.health.filter((h) => h.ok).map((h) => h.url);
  }
}
