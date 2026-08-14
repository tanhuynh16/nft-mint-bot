import type { BotConfig } from '../config/schema.js';
import type { Logger } from '../observability/logger.js';

/**
 * How an OpenSea HTTP status should steer the mint loop.
 *
 * The distinction that matters: `not-active` is worth waiting on, `precondition` is
 * not. Retrying a 422 in a loop burns rate limit and will never succeed.
 */
export type OpenSeaErrorKind =
  | 'not-active' // 409 — stage closed; wait for it to open
  | 'precondition' // 422 — allowlist / limit / supply / balance; stop
  | 'not-found' // 404 — no such drop on this API
  | 'auth' // 401/403 — bad or missing key
  | 'rate-limited' // 429 — back off
  | 'server' // 5xx — retryable
  | 'client' // other 4xx — stop
  | 'network'; // transport failure — retryable

export class OpenSeaError extends Error {
  constructor(
    readonly kind: OpenSeaErrorKind,
    readonly status: number | undefined,
    message: string,
    readonly body?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'OpenSeaError';
  }

  get retryable(): boolean {
    return this.kind === 'server' || this.kind === 'network' || this.kind === 'rate-limited';
  }
}

function classify(status: number): OpenSeaErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not-found';
  if (status === 409) return 'not-active';
  if (status === 422) return 'precondition';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server';
  return 'client';
}

export interface OpenSeaRequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Send the OAuth bearer token instead of / in addition to the api key. */
  useBearer?: boolean;
  timeoutMs?: number;
}

/**
 * Thin fetch wrapper over the OpenSea v2 REST API.
 *
 * Deliberately not opensea-js: the Drops endpoints are three plain REST calls, and the
 * SDK would pull in a second web3 stack alongside viem for no benefit on the mint path.
 */
export class OpenSeaClient {
  private readonly apiKey: string | undefined;
  private readonly bearerToken: string | undefined;
  private readonly baseUrl: string;

  constructor(
    config: BotConfig,
    private readonly logger: Logger,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.apiKey = env[config.opensea.apiKeyEnv];
    this.bearerToken = env[config.opensea.bearerTokenEnv];
    this.baseUrl = config.opensea.baseUrl.replace(/\/$/, '');
  }

  hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  hasBearerToken(): boolean {
    return Boolean(this.bearerToken);
  }

  async request<T>(path: string, options: OpenSeaRequestOptions = {}): Promise<T> {
    const { method = 'GET', body, useBearer = false, timeoutMs = 10_000 } = options;
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    if (useBearer && this.bearerToken) headers['authorization'] = `Bearer ${this.bearerToken}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        signal: controller.signal,
        keepalive: true,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OpenSeaError('network', undefined, `${method} ${path} failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Math.round(performance.now() - started);
    // Logs the path and status only — never the headers, which carry the key.
    this.logger.debug({ method, path, status: response.status, latencyMs }, 'opensea request');

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const kind = classify(response.status);
      const retryAfter = Number(response.headers.get('retry-after'));
      const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
      throw new OpenSeaError(
        kind,
        response.status,
        `${method} ${path} → ${response.status} (${kind})`,
        text.slice(0, 500),
        retryAfterMs,
      );
    }

    return (await response.json()) as T;
  }
}
