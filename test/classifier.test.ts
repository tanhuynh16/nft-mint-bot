import { describe, expect, it } from 'vitest';
import { classifyError } from '../src/retry/classifier.js';
import { OpenSeaError } from '../src/opensea/client.js';

describe('classifyError — OpenSea statuses', () => {
  it('treats 409 as a stage that has not opened, and keeps retrying', () => {
    const result = classifyError(new OpenSeaError('not-active', 409, 'not active'));
    expect(result.class).toBe('not-active');
    expect(result.retry).toBe(true);
  });

  it('stops on 422 rather than burning the window on a precondition that cannot change', () => {
    const result = classifyError(new OpenSeaError('precondition', 422, 'not eligible'));
    expect(result.class).toBe('deterministic');
    expect(result.retry).toBe(false);
  });

  it('honours Retry-After on 429', () => {
    const result = classifyError(
      new OpenSeaError('rate-limited', 429, 'slow down', undefined, 5_000),
    );
    expect(result.class).toBe('rate-limited');
    expect(result.retry).toBe(true);
    expect(result.delayMs).toBe(5_000);
  });

  it('retries 5xx', () => {
    expect(classifyError(new OpenSeaError('server', 503, 'unavailable')).retry).toBe(true);
  });

  it('stops on a rejected API key instead of hammering it', () => {
    const result = classifyError(new OpenSeaError('auth', 401, 'unauthorized'));
    expect(result.class).toBe('config');
    expect(result.retry).toBe(false);
  });
});

describe('classifyError — nonce handling', () => {
  it('does not blindly retry "nonce too low"; it demands reconciliation', () => {
    const result = classifyError(new Error('nonce too low'));
    expect(result.retry).toBe(false);
    expect(result.reason).toMatch(/reconcile/i);
  });

  it('treats an already-known transaction as terminal, not a retry', () => {
    expect(classifyError(new Error('already known')).retry).toBe(false);
  });
});

describe('classifyError — chain errors', () => {
  it('classifies supply exhaustion separately from other deterministic failures', () => {
    const result = classifyError(new Error('MintQuantityExceedsMaxSupply()'));
    expect(result.class).toBe('supply');
    expect(result.retry).toBe(false);
  });

  it('marks an underpriced replacement as replaceable so the fee can be raised', () => {
    const result = classifyError(new Error('replacement transaction underpriced'));
    expect(result.class).toBe('replaceable');
    expect(result.retry).toBe(true);
  });

  it('stops on insufficient funds', () => {
    const result = classifyError(new Error('insufficient funds for gas * price + value'));
    expect(result.class).toBe('deterministic');
    expect(result.retry).toBe(false);
  });

  it('retries transport failures', () => {
    expect(classifyError(new Error('socket hang up')).class).toBe('retryable');
    expect(classifyError(new Error('request timed out')).class).toBe('retryable');
  });

  it('prefers the deterministic reading when a revert message also mentions the network', () => {
    // Node clients often wrap a hard revert in transport-flavoured wording. Reading that
    // as retryable would spin the retry loop through the whole mint window for nothing.
    const result = classifyError(
      new Error('execution reverted: fetch failed to complete call'),
    );
    expect(result.class).toBe('deterministic');
    expect(result.retry).toBe(false);
  });

  it('retries an unrecognised error, but bounded by the caller', () => {
    const result = classifyError(new Error('something nobody predicted'));
    expect(result.class).toBe('retryable');
    expect(result.reason).toMatch(/unclassified/);
  });
});
