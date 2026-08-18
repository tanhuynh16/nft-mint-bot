import type { Address, Hex } from 'viem';

/** An unsigned mint call, independent of how it was produced. */
export interface UnsignedTx {
  to: Address;
  data: Hex;
  value: bigint;
}

/** One step of a multi-transaction plan, tagged with the chain it must run on. */
export interface PlannedTx extends UnsignedTx {
  /** OpenSea chain slug. Asserted against the configured payment chain before signing. */
  chain: string;
  /** Human label for logs, e.g. "approve" or "mint". */
  label?: string;
}

/**
 * An ordered sequence of transactions that together complete a mint.
 *
 * The native path produces exactly one step. A cross-chain payment produces one step
 * for a native token, or an `approve` plus the bridge call for an ERC-20 — all on the
 * payment chain, with the relay delivering to the drop's chain afterwards.
 */
export interface MintPlan {
  transactions: PlannedTx[];
  /** Relay identifiers, reported for manual tracking; OpenSea documents no status API. */
  relayRequestId?: string;
  requestId?: string;
}

export interface MintStage {
  uuid?: string;
  label?: string;
  startTime?: Date;
  endTime?: Date;
  pricePerToken?: bigint;
  maxPerWallet?: bigint;
  /** True when this stage requires a Merkle proof or server signature. */
  requiresProof: boolean;
}

export interface MintStatus {
  isMinting: boolean;
  activeStage?: MintStage;
  nextStage?: MintStage;
  totalSupply?: bigint;
  maxSupply?: bigint;
  /** maxSupply - totalSupply when both are known. */
  remainingSupply?: bigint;
}

export interface MintTarget {
  /** The NFT collection contract. */
  contractAddress: Address;
  chain: string;
  /** e.g. "seadrop_v1_erc721". */
  dropType?: string;
}

/**
 * How the orchestrator should react to a failure.
 *
 * The split that matters is retryable vs deterministic: a bot that retries an
 * ineligible wallet 20 times accomplishes nothing except burning the mint window.
 */
export type MintErrorClass =
  | 'retryable' // transport hiccup, 5xx — retry, possibly on another endpoint
  | 'rate-limited' // 429 — back off first
  | 'not-active' // stage closed — wait, do not error out
  | 'replaceable' // stuck or underpriced — reprice within the ceiling
  | 'supply' // supply exhausted — stop, or re-check before reducing quantity
  | 'deterministic' // ineligible, over limit, insufficient funds — stop
  | 'config'; // wrong chain, bad address — stop immediately

export interface MintProvider {
  readonly name: string;
  resolveTarget(): Promise<MintTarget>;
  getStatus(): Promise<MintStatus>;
  buildMint(quantity: bigint): Promise<UnsignedTx>;
  classifyError(error: unknown): MintErrorClass;
  /** True when this provider can produce calldata without a network call. */
  readonly supportsLocalEncoding: boolean;
}
