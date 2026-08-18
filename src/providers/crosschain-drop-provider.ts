import { getAddress, type Address, type Hex } from 'viem';
import { OpenSeaError } from '../opensea/client.js';
import { DropsApi, toCount, toWei, type DropDetail } from '../opensea/drops.js';
import { NATIVE_TOKEN_ADDRESS } from '../config/schema.js';
import type {
  MintErrorClass,
  MintPlan,
  MintProvider,
  MintStatus,
  MintTarget,
  PlannedTx,
  UnsignedTx,
} from './mint-provider.js';
import type { Logger } from '../observability/logger.js';

export interface CrossChainProviderOptions {
  slug: string;
  minter: Address;
  /** Wallet funding the payment. Same as minter unless paying for someone else. */
  payer: Address;
  /** OpenSea chain slug the payment token lives on. */
  paymentChain: string;
  /** Token address; the zero address selects that chain's native token. */
  paymentToken: string;
}

/** Recognises the ERC-20 approve selector so plan steps can be labelled in logs. */
const APPROVE_SELECTOR = '0x095ea7b3';

/**
 * Pays for a mint with a token held on another chain.
 *
 * Every returned transaction executes on the **payment** chain; OpenSea's relay carries
 * the mint to the drop's chain afterwards. That is why paying from Base can mint a
 * Robinhood NFT with a single signature on Base.
 *
 * The cost is latency: a swap, a bridge and a relay hop add seconds to minutes. This
 * provider is for spending funds you already hold elsewhere, not for winning a race —
 * the config schema refuses to combine it with race mode for that reason.
 */
export class CrossChainDropProvider implements MintProvider {
  readonly name = 'opensea-cross-chain';
  readonly supportsLocalEncoding = false;

  private cachedDrop: DropDetail | undefined;

  constructor(
    private readonly drops: DropsApi,
    private readonly options: CrossChainProviderOptions,
    private readonly logger: Logger,
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
    return {
      isMinting: drop.is_minting ?? Boolean(drop.active_stage),
      ...(total !== undefined ? { totalSupply: total } : {}),
      ...(max !== undefined ? { maxSupply: max } : {}),
      ...(total !== undefined && max !== undefined
        ? { remainingSupply: max > total ? max - total : 0n }
        : {}),
    };
  }

  /**
   * Not meaningful here: a cross-chain mint is a sequence, not a single call. Callers
   * must use buildMintPlan(). Throwing beats returning only the last step, which would
   * silently skip an approve and revert on chain.
   */
  async buildMint(): Promise<UnsignedTx> {
    throw new Error(
      'Cross-chain payment produces a transaction sequence — use buildMintPlan().',
    );
  }

  async buildMintPlan(quantity: bigint): Promise<MintPlan> {
    const { slug, minter, payer, paymentChain, paymentToken } = this.options;

    const response = await this.drops.buildCrossChainMint(
      slug,
      minter,
      payer,
      Number(quantity),
      { chain: paymentChain, token_address: paymentToken },
    );

    if (response.transactions.length === 0) {
      throw new Error('OpenSea returned an empty transaction list for the cross-chain mint.');
    }

    const transactions: PlannedTx[] = response.transactions.map((tx, index) => {
      // Guard the assumption this design rests on. If a route ever spans chains, refuse
      // rather than sign something on a chain the operator did not choose.
      if (tx.chain !== paymentChain) {
        throw new Error(
          `Step ${index + 1} of the mint plan is on chain "${tx.chain}" but the ` +
            `configured payment chain is "${paymentChain}". Refusing to sign.`,
        );
      }

      const data = tx.data as Hex;
      return {
        to: getAddress(tx.to),
        data,
        // Prefer value_hex when present; both carry the same amount.
        value: toWei(tx.value_hex ?? tx.value ?? 0),
        chain: tx.chain,
        label: data.startsWith(APPROVE_SELECTOR) ? 'approve' : 'mint',
      };
    });

    const relayRequestId = response.receipt_request?.relay_request_id ?? undefined;
    const requestId = response.receipt_request?.request_id ?? undefined;

    this.logger.info(
      {
        steps: transactions.length,
        labels: transactions.map((t) => t.label),
        paymentChain,
        paymentToken:
          paymentToken.toLowerCase() === NATIVE_TOKEN_ADDRESS ? 'native' : paymentToken,
        relayRequestId,
      },
      'cross-chain mint plan built',
    );

    return {
      transactions,
      ...(relayRequestId ? { relayRequestId } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }

  classifyError(error: unknown): MintErrorClass {
    if (error instanceof OpenSeaError) {
      switch (error.kind) {
        case 'not-active':
          return 'not-active';
        case 'precondition':
          return 'deterministic';
        case 'rate-limited':
          return 'rate-limited';
        case 'server':
        case 'network':
          return 'retryable';
        case 'auth':
        case 'not-found':
        case 'client':
          // 400 here means a bad payment chain, token, or quantity — a config problem
          // the operator must fix, not something a retry can resolve.
          return 'config';
      }
    }
    return 'retryable';
  }

  private async loadDrop(refresh = false): Promise<DropDetail> {
    if (!refresh && this.cachedDrop) return this.cachedDrop;
    this.cachedDrop = await this.drops.getDrop(this.options.slug);
    return this.cachedDrop;
  }
}
