import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Logger } from '../observability/logger.js';

export type JournalEventType = 'reserved' | 'broadcast' | 'confirmed' | 'failed' | 'released';

export interface JournalEvent {
  ts: string;
  runId: string;
  type: JournalEventType;
  chainId: number;
  address: string;
  nonce: number;
  txHash?: string;
  /**
   * The signed transaction. Retained so a restart can re-broadcast the exact same
   * transaction rather than building a new one — rebuilding risks a second, different
   * transaction competing at the same nonce.
   */
  rawTx?: string;
  error?: string;
  /** 1-based step index within a multi-transaction plan, for audit of partial runs. */
  step?: number;
  /** Step label, e.g. "approve" or "mint". */
  label?: string;
}

/**
 * Append-only, fsync'd write-ahead log of nonce lifecycle events.
 *
 * The ordering guarantee is the whole point: the "broadcast" record hits disk *before*
 * the transaction goes to the network. A crash in the microseconds between the two
 * therefore leaves a record of a transaction that may or may not have landed, which
 * reconciliation can resolve by asking the chain. The reverse order would lose the
 * nonce entirely and risk a duplicate mint on restart.
 */
export class TxJournal {
  private readonly filePath: string;
  private fd: number | undefined;

  constructor(
    dir: string,
    private readonly chainId: number,
    private readonly address: string,
    private readonly runId: string,
    private readonly logger: Logger,
    private readonly enabled = true,
  ) {
    const resolved = resolve(dir);
    this.filePath = join(resolved, `${chainId}-${address.toLowerCase()}.jsonl`);
    if (enabled) {
      mkdirSync(resolved, { recursive: true });
    }
  }

  get path(): string {
    return this.filePath;
  }

  /** Writes and fsyncs. Synchronous by design — callers must not proceed until it is durable. */
  append(event: Omit<JournalEvent, 'ts' | 'runId' | 'chainId' | 'address'>): void {
    if (!this.enabled) return;

    const record: JournalEvent = {
      ts: new Date().toISOString(),
      runId: this.runId,
      chainId: this.chainId,
      address: this.address,
      ...event,
    };

    this.fd ??= openSync(this.filePath, 'a');
    writeSync(this.fd, `${JSON.stringify(record)}\n`);
    // Without fsync the record sits in the page cache and a hard crash loses it —
    // which is exactly the scenario this journal exists for.
    fsyncSync(this.fd);
  }

  /** All events for this chain+wallet, oldest first. Malformed lines are skipped, not fatal. */
  read(): JournalEvent[] {
    if (!this.enabled || !existsSync(this.filePath)) return [];
    const contents = readFileSync(this.filePath, 'utf8');
    const events: JournalEvent[] = [];
    for (const line of contents.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as JournalEvent);
      } catch {
        this.logger.warn({ line: line.slice(0, 120) }, 'skipping malformed journal line');
      }
    }
    return events;
  }

  /**
   * Nonces that were broadcast but never reached a terminal state — the set that needs
   * reconciling against the chain on startup.
   */
  unresolved(): JournalEvent[] {
    const latest = new Map<number, JournalEvent>();
    for (const event of this.read()) {
      const existing = latest.get(event.nonce);
      // 'reserved' must not overwrite a later 'broadcast' from an earlier run.
      if (!existing || event.ts >= existing.ts) latest.set(event.nonce, event);
    }
    return [...latest.values()].filter(
      (e) => e.type === 'reserved' || e.type === 'broadcast',
    );
  }

  close(): void {
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
  }
}
