import type { Address, Hex } from 'viem';
import { getAddress } from 'viem';
import { OpenSeaError } from '../opensea/client.js';
import { DropsApi, toCount, toWei, type DropDetail, type DropStage } from '../opensea/drops.js';
import type {
  MintErrorClass,
  MintProvider,
  MintStage,
  MintStatus,
  MintTarget,
  UnsignedTx,
} from './mint-provider.js';

/** Stage types that issue a per-wallet proof or signature and so cannot be pre-encoded. */
const PROOF_STAGE_TYPES = new Set(['allowlist', 'presale', 'signed', 'allow_list']);

function toStage(stage: DropStage | null | undefined): MintStage | undefined {
  if (!stage) return undefined;
  const label = (stage.stage_type ?? stage.label ?? '').toLowerCase();
  return {
    ...(stage.uuid ? { uuid: stage.uuid } : {}),
    ...(stage.label ? { label: stage.label } : {}),
    ...(stage.start_time ? { startTime: new Date(stage.start_time) } : {}),
    ...(stage.end_time ? { endTime: new Date(stage.end_time) } : {}),
    ...(stage.price !== undefined ? { pricePerToken: toWei(stage.price) } : {}),
    ...(stage.max_per_wallet !== undefined && stage.max_per_wallet !== null
      ? { maxPerWallet: toCount(stage.max_per_wallet) }
      : {}),
    requiresProof: PROOF_STAGE_TYPES.has(label),
  } as MintStage;
}

/**
 * Mints through OpenSea's Drops API: OpenSea builds the calldata, we sign and send.
 *
 * Correct and provider-agnostic, but it puts an HTTPS round-trip to OpenSea on the
 * critical path — and that round-trip is slowest exactly when a drop opens and every
 * other bot is calling the same endpoint. Use SeaDropProvider for the race path.
 */
export class OpenSeaDropProvider implements MintProvider {
  readonly name = 'opensea-drop';
  readonly supportsLocalEncoding = false;

  private cachedDrop: DropDetail | undefined;

  constructor(
    private readonly drops: DropsApi,
    private readonly slug: string,
    private readonly minter: Address,
  ) {}

  async resolveTarget(): Promise<MintTarget> {
    const drop = await this.loadDrop();
    return {
      contractAddress: getAddress(drop.contract_address),
      chain: drop.chain,
      ...(drop.drop_type ? { dropType: drop.drop_type } : {}),
    };
  }

  async getStatus(): Promise<MintStatus> {
    const drop = await this.loadDrop(true);
    const total = toCount(drop.total_supply);
    const max = toCount(drop.max_supply);
    const active = toStage(drop.active_stage);
    const next = toStage(drop.next_stage);
    return {
      isMinting: drop.is_minting ?? Boolean(drop.active_stage),
      ...(active ? { activeStage: active } : {}),
      ...(next ? { nextStage: next } : {}),
      ...(total !== undefined ? { totalSupply: total } : {}),
      ...(max !== undefined ? { maxSupply: max } : {}),
      ...(total !== undefined && max !== undefined
        ? { remainingSupply: max > total ? max - total : 0n }
        : {}),
    };
  }

  async buildMint(quantity: bigint): Promise<UnsignedTx> {
    const tx = await this.drops.buildMintTransaction(this.slug, this.minter, Number(quantity));
    return {
      to: getAddress(tx.to),
      data: tx.data as Hex,
      value: toWei(tx.value ?? 0),
    };
  }

  classifyError(error: unknown): MintErrorClass {
    if (error instanceof OpenSeaError) {
      switch (error.kind) {
        case 'not-active':
          return 'not-active';
        case 'precondition':
          // 422 covers allowlist miss, per-wallet limit, exhausted supply, and low
          // balance. All are deterministic for the current state — the caller must
          // re-read supply before deciding to retry with a smaller quantity.
          return 'deterministic';
        case 'rate-limited':
          return 'rate-limited';
        case 'server':
        case 'network':
          return 'retryable';
        case 'auth':
        case 'not-found':
        case 'client':
          return 'config';
      }
    }
    return 'retryable';
  }

  private async loadDrop(refresh = false): Promise<DropDetail> {
    if (!refresh && this.cachedDrop) return this.cachedDrop;
    this.cachedDrop = await this.drops.getDrop(this.slug);
    return this.cachedDrop;
  }
}
