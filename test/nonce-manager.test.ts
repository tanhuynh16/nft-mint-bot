import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NonceManager } from '../src/wallet/nonce-manager.js';
import { TxJournal } from '../src/wallet/journal.js';

const ADDRESS = '0x1111111111111111111111111111111111111111' as const;
const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getTransactionCount: vi.fn().mockResolvedValue(5),
    getTransactionReceipt: vi.fn().mockRejectedValue(new Error('not found')),
    ...overrides,
  } as never;
}

let dir: string;
let journal: TxJournal;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mintbot-journal-'));
  journal = new TxJournal(dir, 4663, ADDRESS, 'run-1', silentLogger, true);
});

afterEach(() => {
  journal.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('NonceManager allocation', () => {
  it('refuses to allocate before initialize', () => {
    const manager = new NonceManager(makeClient(), ADDRESS, journal, silentLogger);
    expect(() => manager.reserve()).toThrow(/initialize/);
  });

  it('hands out strictly increasing nonces from the pending count', async () => {
    const manager = new NonceManager(makeClient(), ADDRESS, journal, silentLogger);
    await manager.initialize();
    expect(manager.reserve()).toBe(5);
    expect(manager.reserve()).toBe(6);
    expect(manager.reserve()).toBe(7);
  });

  it('reuses a nonce released before broadcast', async () => {
    const manager = new NonceManager(makeClient(), ADDRESS, journal, silentLogger);
    await manager.initialize();
    const nonce = manager.reserve();
    manager.releaseOnPreSignFailure(nonce, 'signing failed');
    // Nothing was sent, so the nonce is genuinely free again.
    expect(manager.reserve()).toBe(nonce);
  });

  it('does not roll back a nonce that is not the most recent, to avoid a gap', async () => {
    const manager = new NonceManager(makeClient(), ADDRESS, journal, silentLogger);
    await manager.initialize();
    const first = manager.reserve();
    manager.reserve();
    manager.releaseOnPreSignFailure(first, 'signing failed');
    expect(manager.reserve()).toBe(7);
  });
});

describe('NonceManager restart recovery', () => {
  it('journals the broadcast before the send, so a crash leaves a recoverable record', async () => {
    const manager = new NonceManager(makeClient(), ADDRESS, journal, silentLogger);
    await manager.initialize();
    const nonce = manager.reserve();
    manager.markBroadcast(nonce, '0xdeadbeef', '0xraw');

    // Simulate a crash: a fresh journal reads what actually reached disk.
    const reopened = new TxJournal(dir, 4663, ADDRESS, 'run-2', silentLogger, true);
    const unresolved = reopened.unresolved();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.txHash).toBe('0xdeadbeef');
    expect(unresolved[0]?.rawTx).toBe('0xraw');
    reopened.close();
  });

  it('adopts a still-pending transaction rather than re-sending it', async () => {
    const manager = new NonceManager(makeClient(), ADDRESS, journal, silentLogger);
    await manager.initialize();
    const nonce = manager.reserve();
    manager.markBroadcast(nonce, '0xpending', '0xraw');
    journal.close();

    // Restart: chain is still at 5, so nonce 5 is in flight and unconfirmed.
    const reopened = new TxJournal(dir, 4663, ADDRESS, 'run-2', silentLogger, true);
    const recovered = new NonceManager(makeClient(), ADDRESS, reopened, silentLogger);
    const result = await recovered.initialize();

    expect(result.stillPending).toHaveLength(1);
    expect(result.stillPending[0]?.nonce).toBe(5);
    expect(result.confirmed).toHaveLength(0);
    reopened.close();
  });

  it('recognises a transaction that confirmed while the process was down', async () => {
    const manager = new NonceManager(makeClient(), ADDRESS, journal, silentLogger);
    await manager.initialize();
    manager.markBroadcast(manager.reserve(), '0xconfirmed', '0xraw');
    journal.close();

    const reopened = new TxJournal(dir, 4663, ADDRESS, 'run-2', silentLogger, true);
    const recovered = new NonceManager(
      makeClient({
        getTransactionCount: vi.fn().mockResolvedValue(6),
        getTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
      }),
      ADDRESS,
      reopened,
      silentLogger,
    );
    const result = await recovered.initialize();

    expect(result.confirmed).toHaveLength(1);
    expect(result.stillPending).toHaveLength(0);
    // Critically, the next nonce is 6 — not 5 again, which would double-mint.
    expect(recovered.reserve()).toBe(6);
    reopened.close();
  });

  it('marks a nonce dead when another transaction consumed it', async () => {
    const manager = new NonceManager(makeClient(), ADDRESS, journal, silentLogger);
    await manager.initialize();
    manager.markBroadcast(manager.reserve(), '0xlost', '0xraw');
    journal.close();

    const reopened = new TxJournal(dir, 4663, ADDRESS, 'run-2', silentLogger, true);
    const recovered = new NonceManager(
      // Chain moved past nonce 5, but our hash has no receipt: someone else took the slot.
      makeClient({ getTransactionCount: vi.fn().mockResolvedValue(6) }),
      ADDRESS,
      reopened,
      silentLogger,
    );
    const result = await recovered.initialize();

    expect(result.stillPending).toHaveLength(0);
    expect(result.confirmed).toHaveLength(0);
    reopened.close();
  });

  it('frees a nonce that was reserved but never broadcast', async () => {
    const manager = new NonceManager(makeClient(), ADDRESS, journal, silentLogger);
    await manager.initialize();
    manager.reserve();
    journal.close();

    const reopened = new TxJournal(dir, 4663, ADDRESS, 'run-2', silentLogger, true);
    const recovered = new NonceManager(makeClient(), ADDRESS, reopened, silentLogger);
    const result = await recovered.initialize();

    expect(result.stillPending).toHaveLength(0);
    expect(recovered.reserve()).toBe(5);
    reopened.close();
  });
});
