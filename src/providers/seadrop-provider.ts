import {
  encodeFunctionData,
  getAddress,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
} from 'viem';
import { SEADROP_ADDRESS, erc721SupplyAbi, seaDropAbi } from './seadrop-abi.js';
import type {
  MintErrorClass,
  MintProvider,
  MintStage,
  MintStatus,
  MintTarget,
  UnsignedTx,
} from './mint-provider.js';

export interface SeaDropProviderOptions {
  contractAddress: Address;
  minter: Address;
  chain: string;
  /**
   * Fee recipient required by mintPublic. Read from the contract when omitted.
   * SeaDrop rejects an unapproved recipient when restrictFeeRecipients is set, so
   * this must match what the drop expects.
   */
  feeRecipient?: Address;
  seadropAddress?: Address;
}

/**
 * Mints by calling SeaDrop directly, encoding calldata locally.
 *
 * This is the provider that makes the race path possible: no OpenSea round-trip at
 * T0, and — because mintPublic's arguments are all known before the stage opens — the
 * transaction can be signed in advance. Correctness rests on the calldata being
 * identical to what OpenSea would have built, which presign.ts verifies byte-for-byte
 * before arming.
 */
export class SeaDropProvider implements MintProvider {
  readonly name = 'seadrop';
  readonly supportsLocalEncoding = true;

  private readonly seadrop: Address;
  private feeRecipient: Address | undefined;

  constructor(
    private readonly client: PublicClient<Transport, Chain>,
    private readonly options: SeaDropProviderOptions,
  ) {
    this.seadrop = options.seadropAddress ?? (SEADROP_ADDRESS as Address);
    this.feeRecipient = options.feeRecipient;
  }

  async resolveTarget(): Promise<MintTarget> {
    return {
      contractAddress: this.options.contractAddress,
      chain: this.options.chain,
      dropType: 'seadrop_v1',
    };
  }

  async getStatus(): Promise<MintStatus> {
    const [publicDrop, totalSupply, maxSupply] = await Promise.all([
      this.client
        .readContract({
          address: this.seadrop,
          abi: seaDropAbi,
          functionName: 'getPublicDrop',
          args: [this.options.contractAddress],
        })
        .catch(() => undefined),
      this.client
        .readContract({
          address: this.options.contractAddress,
          abi: erc721SupplyAbi,
          functionName: 'totalSupply',
        })
        .catch(() => undefined),
      this.client
        .readContract({
          address: this.options.contractAddress,
          abi: erc721SupplyAbi,
          functionName: 'maxSupply',
        })
        .catch(() => undefined),
    ]);

    let activeStage: MintStage | undefined;
    let nextStage: MintStage | undefined;
    let isMinting = false;

    if (publicDrop) {
      const start = Number(publicDrop.startTime) * 1000;
      const end = Number(publicDrop.endTime) * 1000;
      const now = Date.now();
      const stage: MintStage = {
        label: 'public',
        startTime: new Date(start),
        endTime: new Date(end),
        pricePerToken: BigInt(publicDrop.mintPrice),
        maxPerWallet: BigInt(publicDrop.maxTotalMintableByWallet),
        requiresProof: false,
      };
      isMinting = now >= start && now < end;
      if (isMinting) activeStage = stage;
      else if (now < start) nextStage = stage;
    }

    return {
      isMinting,
      ...(activeStage ? { activeStage } : {}),
      ...(nextStage ? { nextStage } : {}),
      ...(totalSupply !== undefined ? { totalSupply } : {}),
      ...(maxSupply !== undefined ? { maxSupply } : {}),
      ...(totalSupply !== undefined && maxSupply !== undefined
        ? { remainingSupply: maxSupply > totalSupply ? maxSupply - totalSupply : 0n }
        : {}),
    };
  }

  async buildMint(quantity: bigint): Promise<UnsignedTx> {
    const feeRecipient = await this.resolveFeeRecipient();
    const publicDrop = await this.client.readContract({
      address: this.seadrop,
      abi: seaDropAbi,
      functionName: 'getPublicDrop',
      args: [this.options.contractAddress],
    });

    const data = encodeFunctionData({
      abi: seaDropAbi,
      functionName: 'mintPublic',
      args: [
        this.options.contractAddress,
        feeRecipient,
        // Zero means "the payer is the minter". Set explicitly when paying for
        // another address.
        '0x0000000000000000000000000000000000000000',
        quantity,
      ],
    });

    return {
      to: this.seadrop,
      data,
      value: BigInt(publicDrop.mintPrice) * quantity,
    };
  }

  classifyError(error: unknown): MintErrorClass {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

    // SeaDrop's custom errors are deterministic — retrying cannot change the outcome.
    if (
      message.includes('mintquantityexceedsmaxminted') ||
      message.includes('mintquantityexceedsmaxsupply') ||
      message.includes('notactive') ||
      message.includes('exceedsmaxtokensupplyforstage')
    ) {
      return 'supply';
    }
    if (
      message.includes('incorrectpayment') ||
      message.includes('feerecipientnotallowed') ||
      message.includes('invalidproof') ||
      message.includes('insufficient funds')
    ) {
      return 'deterministic';
    }
    if (message.includes('nonce too low') || message.includes('already known')) {
      return 'deterministic';
    }
    if (message.includes('replacement transaction underpriced') || message.includes('underpriced')) {
      return 'replaceable';
    }
    if (message.includes('timeout') || message.includes('econnreset') || message.includes('fetch')) {
      return 'retryable';
    }
    if (message.includes('429') || message.includes('rate limit')) {
      return 'rate-limited';
    }
    return 'retryable';
  }

  /**
   * The fee recipient mintPublic requires.
   *
   * Must come from `getAllowedFeeRecipients`, not `getCreatorPayoutAddress`. Using the
   * creator payout looks plausible and reverts `FeeRecipientNotAllowed` every time — a
   * pre-signed transaction built that way would have burned its nonce on a guaranteed
   * failure. On Robinhood the allowed recipient is OpenSea's fee collector, which is
   * also what the Drops API puts in its own calldata.
   */
  private async resolveFeeRecipient(): Promise<Address> {
    if (this.feeRecipient) return this.feeRecipient;

    const allowed = await this.client.readContract({
      address: this.seadrop,
      abi: seaDropAbi,
      functionName: 'getAllowedFeeRecipients',
      args: [this.options.contractAddress],
    });

    if (allowed.length === 0) {
      throw new Error(
        `SeaDrop reports no allowed fee recipients for ${this.options.contractAddress}; ` +
          `cannot build mintPublic calldata locally.`,
      );
    }

    this.feeRecipient = getAddress(allowed[0]!);
    return this.feeRecipient;
  }
}
