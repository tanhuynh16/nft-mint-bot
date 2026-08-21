import { OpenSeaError } from '../opensea/client.js';
import type { MintErrorClass } from '../providers/mint-provider.js';

export interface Classification {
  class: MintErrorClass;
  /** Whether the orchestrator should attempt this operation again. */
  retry: boolean;
  /** Suggested wait before retrying, in ms. */
  delayMs?: number;
  reason: string;
}

/** Substrings that identify a deterministic on-chain or RPC rejection. */
const DETERMINISTIC_PATTERNS: Array<[RegExp, string]> = [
  [/insufficient funds/i, 'wallet cannot cover value + gas'],
  [/intrinsic gas too low/i, 'gas limit below intrinsic cost'],
  [/exceeds block gas limit/i, 'gas limit above block limit'],
  [/invalid sender|invalid signature/i, 'signature rejected'],
  [/execution reverted/i, 'contract reverted'],
  [/mintquantityexceedsmaxminted/i, 'per-wallet mint limit reached'],
  [/incorrectpayment/i, 'value does not match mint price'],
  [/feerecipientnotallowed/i, 'fee recipient not approved by the drop'],
  [/invalidproof/i, 'wallet not on the allowlist'],
];

const SUPPLY_PATTERNS: Array<[RegExp, string]> = [
  [/mintquantityexceedsmaxsupply/i, 'requested quantity exceeds remaining supply'],
  [/exceedsmaxtokensupplyforstage/i, 'stage supply exhausted'],
  [/sold ?out/i, 'sold out'],
];

const REPLACEABLE_PATTERNS: Array<[RegExp, string]> = [
  [/replacement transaction underpriced/i, 'replacement fee too low'],
  [/transaction underpriced/i, 'fee below the node minimum'],
  [/fee cap less than block base fee/i, 'maxFeePerGas below base fee'],
];

const RETRYABLE_PATTERNS: Array<[RegExp, string]> = [
  [/timeout|timed out|etimedout/i, 'request timed out'],
  [/econnreset|econnrefused|socket hang up|network error|fetch failed/i, 'connection failure'],
  [/502|503|504|bad gateway|service unavailable/i, 'upstream unavailable'],
  [/header not found|block not found/i, 'transient node state'],
];

function match(
  message: string,
  patterns: Array<[RegExp, string]>,
): string | undefined {
  for (const [pattern, reason] of patterns) {
    if (pattern.test(message)) return reason;
  }
  return undefined;
}

/**
 * Maps an arbitrary failure onto a retry decision.
 *
 * Ordering is deliberate: deterministic and supply checks run before the retryable
 * ones, because several node implementations wrap a hard revert in a message that also
 * contains generic transport words. Guessing "retryable" on a revert would spin the
 * retry loop through the entire mint window for nothing.
 */
export function classifyError(error: unknown, retryDelayMs = 100): Classification {
  if (error instanceof OpenSeaError) {
    switch (error.kind) {
      case 'not-active':
        return { class: 'not-active', retry: true, delayMs: 250, reason: 'stage is not open yet' };
      case 'precondition':
        return {
          class: 'deterministic',
          retry: false,
          reason: 'OpenSea rejected a precondition (eligibility, limit, supply, or balance)',
        };
      case 'rate-limited':
        return {
          class: 'rate-limited',
          retry: true,
          delayMs: error.retryAfterMs ?? 1_000,
          reason: 'rate limited by OpenSea',
        };
      case 'server':
        return { class: 'retryable', retry: true, delayMs: retryDelayMs, reason: 'OpenSea 5xx' };
      case 'network':
        return {
          class: 'retryable',
          retry: true,
          delayMs: retryDelayMs,
          reason: 'network failure reaching OpenSea',
        };
      case 'auth':
        return { class: 'config', retry: false, reason: 'OpenSea API key rejected' };
      case 'not-found':
        return {
          class: 'config',
          retry: false,
          reason: 'no such drop on the OpenSea Drops API',
        };
      case 'client':
        return { class: 'config', retry: false, reason: `OpenSea ${error.status}` };
    }
  }

  const message = error instanceof Error ? error.message : String(error);

  // Nonce errors are recoverable, but only by reconciling — never by resending as-is.
  if (/nonce too low|nonce is too low/i.test(message)) {
    return {
      class: 'deterministic',
      retry: false,
      reason: 'nonce too low; reconcile against the chain before retrying',
    };
  }
  if (/already known|known transaction/i.test(message)) {
    return {
      class: 'deterministic',
      retry: false,
      reason: 'transaction already in the mempool',
    };
  }
  if (/nonce too high/i.test(message)) {
    return { class: 'deterministic', retry: false, reason: 'nonce gap; reconcile required' };
  }

  // JSON-RPC -32601. The endpoint does not implement the method and never will, so a
  // retry cannot change the outcome. This is how a wallet client pointed at a write-only
  // sequencer presents: every signature fails on eth_chainId, and without this case the
  // bot loops SIGNING -> BUILDING_TX until maxRetries, burning the mint window.
  if (/does not exist ?\/ ?is not available|method not found|-32601/i.test(message)) {
    return {
      class: 'config',
      retry: false,
      reason:
        'the RPC endpoint does not implement a method the bot needs ' +
        '(JSON-RPC -32601). A dedicated sequencer serves only eth_sendRawTransaction — ' +
        'reads and signing must use a full node.',
    };
  }

  const supply = match(message, SUPPLY_PATTERNS);
  if (supply) return { class: 'supply', retry: false, reason: supply };

  const deterministic = match(message, DETERMINISTIC_PATTERNS);
  if (deterministic) return { class: 'deterministic', retry: false, reason: deterministic };

  const replaceable = match(message, REPLACEABLE_PATTERNS);
  if (replaceable) return { class: 'replaceable', retry: true, delayMs: 0, reason: replaceable };

  if (/429|rate limit|too many requests/i.test(message)) {
    return { class: 'rate-limited', retry: true, delayMs: 1_000, reason: 'RPC rate limited' };
  }

  const retryable = match(message, RETRYABLE_PATTERNS);
  if (retryable) {
    return { class: 'retryable', retry: true, delayMs: retryDelayMs, reason: retryable };
  }

  // Unknown failures get one conservative retry path rather than an immediate stop —
  // but the caller's maxRetries still bounds it.
  return {
    class: 'retryable',
    retry: true,
    delayMs: retryDelayMs,
    reason: `unclassified: ${message.slice(0, 160)}`,
  };
}
