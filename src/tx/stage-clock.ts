import type { Address, Chain, PublicClient, Transport } from 'viem';
import { SEADROP_ADDRESS, seaDropAbi } from '../providers/seadrop-abi.js';
import type { Logger } from '../observability/logger.js';

export interface OnChainWindow {
  /** Unix ms when the public stage opens, read from the contract. */
  startsAtMs: number;
  endsAtMs: number;
  pricePerToken: bigint;
  maxPerWallet: bigint;
}

export interface StageClockOptions {
  publicClient: PublicClient<Transport, Chain>;
  /** The NFT collection, not SeaDrop. */
  contractAddress: Address;
  logger: Logger;
  seadropAddress?: Address;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Waits for a public stage to open using the contract's own clock.
 *
 * The alternative — polling until the drop reports itself active — is late by up to its
 * poll interval, and on a chain producing a block every ~100ms that is a block or more
 * handed to everyone else. `getPublicDrop()` states exactly when the window opens, so the
 * wait can end on that instant instead of on a poll tick.
 *
 * The contract is also the *right* source: OpenSea's metadata can disagree with what the
 * contract will actually accept, and it is the contract that reverts.
 */
export class StageClock {
  private readonly publicClient: PublicClient<Transport, Chain>;
  private readonly contractAddress: Address;
  private readonly logger: Logger;
  private readonly seadrop: Address;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: StageClockOptions) {
    this.publicClient = options.publicClient;
    this.contractAddress = options.contractAddress;
    this.logger = options.logger;
    this.seadrop = options.seadropAddress ?? (SEADROP_ADDRESS as Address);
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Reads the public stage window, or undefined when the contract cannot answer.
   *
   * Undefined is a normal outcome, not a failure: allowlist stages, ERC-1155 drops and
   * non-SeaDrop contracts all land here, and the caller falls back to polling.
   */
  async readWindow(): Promise<OnChainWindow | undefined> {
    try {
      const drop = await this.publicClient.readContract({
        address: this.seadrop,
        abi: seaDropAbi,
        functionName: 'getPublicDrop',
        args: [this.contractAddress],
      });

      const startsAtMs = Number(drop.startTime) * 1000;
      const endsAtMs = Number(drop.endTime) * 1000;

      // A contract with no public stage configured reports zeroes rather than failing.
      if (startsAtMs === 0 || endsAtMs === 0) return undefined;

      return {
        startsAtMs,
        endsAtMs,
        pricePerToken: BigInt(drop.mintPrice),
        maxPerWallet: BigInt(drop.maxTotalMintableByWallet),
      };
    } catch (error) {
      this.logger.debug(
        { error: error instanceof Error ? error.message : String(error) },
        'contract did not report a public stage; falling back to polling',
      );
      return undefined;
    }
  }

  /**
   * Sleeps until the window opens. Returns false when the contract has no usable window.
   *
   * Never returns before `startsAtMs`. A pre-signed transaction that arrives early
   * reverts `NotActive`, and because its nonce is fixed that transaction is then dead —
   * so being early costs far more than the latency it would save. Sending *at* the start
   * means arrival is `start + RTT`, which is inherently inside the window.
   */
  async waitForOpen(window?: OnChainWindow): Promise<boolean> {
    const w = window ?? (await this.readWindow());
    if (!w) return false;

    const remaining = w.startsAtMs - this.now();

    if (remaining > 0) {
      this.logger.info(
        {
          startsAt: new Date(w.startsAtMs).toISOString(),
          inMs: remaining,
          source: 'contract',
        },
        'waiting on the contract stage clock',
      );
      await this.sleep(remaining);
    } else if (this.now() > w.endsAtMs) {
      this.logger.warn(
        { endedAt: new Date(w.endsAtMs).toISOString() },
        'contract reports the public stage has already closed',
      );
      return false;
    }

    return true;
  }

  /**
   * Flags a disagreement between the contract and OpenSea's metadata.
   *
   * The contract wins — it is what reverts — but a gap large enough to matter is worth
   * saying out loud, because it usually means the drop was reconfigured after the job
   * was scheduled.
   */
  reportDrift(window: OnChainWindow, apiStartIso: string | undefined, toleranceMs = 1000): void {
    if (!apiStartIso) return;
    const apiMs = new Date(apiStartIso).getTime();
    if (Number.isNaN(apiMs)) return;

    const driftMs = window.startsAtMs - apiMs;
    if (Math.abs(driftMs) > toleranceMs) {
      this.logger.warn(
        {
          contract: new Date(window.startsAtMs).toISOString(),
          opensea: apiStartIso,
          driftMs,
        },
        'contract and OpenSea disagree on the stage start; using the contract',
      );
    }
  }
}
