import { z } from 'zod';
import type { OpenSeaClient } from './client.js';

/**
 * Schemas mirror the OpenSea v2 API, which is snake_case throughout.
 *
 * Every field beyond the ones we actually depend on is optional and the objects are
 * loose: OpenSea adds fields without notice, and a strict schema would turn an additive
 * API change into a failed mint.
 */
export const dropStageSchema = z.looseObject({
  uuid: z.string().optional(),
  label: z.string().optional(),
  stage_type: z.string().optional(),
  start_time: z.string().optional(),
  end_time: z.string().nullable().optional(),
  /** Price per token, in wei, as a decimal string. */
  price: z.string().optional(),
  price_currency_address: z.string().optional(),
  max_per_wallet: z.union([z.string(), z.number()]).nullable().optional(),
});
export type DropStage = z.infer<typeof dropStageSchema>;

export const dropDetailSchema = z.looseObject({
  collection_slug: z.string(),
  collection_name: z.string().optional(),
  contract_address: z.string(),
  chain: z.string(),
  /** e.g. "seadrop_v1_erc721" — the discriminator for provider selection. */
  drop_type: z.string().optional(),
  is_minting: z.boolean().optional(),
  max_supply: z.union([z.string(), z.number()]).nullable().optional(),
  total_supply: z.union([z.string(), z.number()]).nullable().optional(),
  stages: z.array(dropStageSchema).default([]),
  active_stage: dropStageSchema.nullable().optional(),
  next_stage: dropStageSchema.nullable().optional(),
  opensea_url: z.string().optional(),
});
export type DropDetail = z.infer<typeof dropDetailSchema>;

/** Response of POST /api/v2/drops/{slug}/mint — ready-to-sign transaction data. */
export const mintTransactionSchema = z.looseObject({
  chain: z.string().optional(),
  to: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  data: z.string().regex(/^0x[a-fA-F0-9]*$/),
  /** Wei. OpenSea returns hex; decimal strings are tolerated. */
  value: z.union([z.string(), z.number()]).optional(),
});
export type MintTransaction = z.infer<typeof mintTransactionSchema>;

/**
 * One step of a cross-chain mint. Every step executes on the payment chain — the
 * relay handles delivery to the NFT's chain, which is why paying from Base mints a
 * Robinhood NFT with a single signature on Base.
 */
export const swapTransactionSchema = z.looseObject({
  chain: z.string(),
  to: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  data: z.string().regex(/^0x[a-fA-F0-9]*$/),
  /** Decimal string. `value_hex` carries the same amount as hex. */
  value: z.union([z.string(), z.number()]).nullable().optional(),
  value_hex: z.string().nullable().optional(),
});
export type SwapTransaction = z.infer<typeof swapTransactionSchema>;

/** Response of POST /api/v2/drops/{slug}/cross_chain_mint. */
export const crossChainMintSchema = z.looseObject({
  transactions: z.array(swapTransactionSchema),
  receipt_request: z
    .looseObject({
      relay_request_id: z.string().nullable().optional(),
      request_id: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type CrossChainMint = z.infer<typeof crossChainMintSchema>;

/** Response of GET /api/v2/chain/{chain}/payment_token/{address}. */
export const paymentTokenSchema = z.looseObject({
  address: z.string(),
  chain: z.string(),
  symbol: z.string().optional(),
  name: z.string().optional(),
  decimals: z.number().optional(),
  usd_price: z.union([z.string(), z.number()]).nullable().optional(),
});
export type PaymentToken = z.infer<typeof paymentTokenSchema>;

/** One row of GET /api/v2/account/{address}/tokens. */
export const tokenBalanceSchema = z.looseObject({
  address: z.string().optional(),
  chain: z.string().optional(),
  symbol: z.string().optional(),
  name: z.string().optional(),
  decimals: z.number().optional(),
  /** Display units, already divided by 10^decimals — not raw/wei. */
  quantity: z.union([z.string(), z.number()]).nullable().optional(),
  usd_price: z.union([z.string(), z.number()]).nullable().optional(),
  /** quantity * usd_price. */
  usd_value: z.union([z.string(), z.number()]).nullable().optional(),
  image_url: z.string().nullable().optional(),
  opensea_url: z.string().nullable().optional(),
});
export type TokenBalance = z.infer<typeof tokenBalanceSchema>;

export const tokenBalancesSchema = z.looseObject({
  token_balances: z.array(tokenBalanceSchema).default([]),
  next: z.string().nullable().optional(),
});

export const eligibilityStageSchema = z.looseObject({
  stage_uuid: z.string(),
  is_eligible: z.boolean(),
  price: z.string().optional(),
  max_total_mintable_by_wallet: z.string().optional(),
  max_total_mintable_by_wallet_per_token: z.string().optional(),
});

export const eligibilitySchema = z.looseObject({
  stages: z.array(eligibilityStageSchema),
});
export type DropEligibility = z.infer<typeof eligibilitySchema>;

/** Parses a wei amount that may arrive as hex ("0x..."), a decimal string, or a number. */
export function toWei(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'number') return BigInt(value);
  const trimmed = value.trim();
  if (trimmed === '') return 0n;
  // BigInt() parses both "0x..." and decimal strings.
  return BigInt(trimmed);
}

export function toCount(value: string | number | null | undefined): bigint | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === 'number' ? BigInt(value) : BigInt(value.trim());
}

export class DropsApi {
  constructor(private readonly client: OpenSeaClient) {}

  /** GET /api/v2/drops/{slug} */
  async getDrop(slug: string): Promise<DropDetail> {
    const raw = await this.client.request<unknown>(`/api/v2/drops/${encodeURIComponent(slug)}`);
    return dropDetailSchema.parse(raw);
  }

  /**
   * GET /api/v2/drops/{slug}/eligibility
   *
   * Requires an OAuth bearer token with the read:eligibility scope. Worth calling
   * before a mint: it answers "am I allowed" without consuming a mint attempt, so an
   * allowlist miss surfaces as a clean stop instead of a 422 mid-race.
   */
  async getEligibility(slug: string): Promise<DropEligibility> {
    const raw = await this.client.request<unknown>(
      `/api/v2/drops/${encodeURIComponent(slug)}/eligibility`,
      { useBearer: true },
    );
    return eligibilitySchema.parse(raw);
  }

  /** POST /api/v2/drops/{slug}/mint */
  async buildMintTransaction(
    slug: string,
    minter: string,
    quantity: number,
  ): Promise<MintTransaction> {
    const raw = await this.client.request<unknown>(
      `/api/v2/drops/${encodeURIComponent(slug)}/mint`,
      { method: 'POST', body: { minter, quantity } },
    );
    return mintTransactionSchema.parse(raw);
  }

  /**
   * POST /api/v2/drops/{slug}/cross_chain_mint
   *
   * Returns an ordered sequence to run on the payment chain — typically one
   * transaction for a native token, or an `approve` followed by the bridge call for an
   * ERC-20. Delivery to the drop's chain is handled by the relay afterwards.
   */
  async buildCrossChainMint(
    slug: string,
    minter: string,
    payer: string,
    quantity: number,
    payment: { chain: string; token_address: string },
  ): Promise<CrossChainMint> {
    const raw = await this.client.request<unknown>(
      `/api/v2/drops/${encodeURIComponent(slug)}/cross_chain_mint`,
      { method: 'POST', body: { minter, payer, quantity, payment } },
    );
    return crossChainMintSchema.parse(raw);
  }

  /**
   * GET /api/v2/chain/{chain}/payment_token/{address}
   *
   * Used to validate a configured payment token before a run spends anything — a typo
   * in a token address should fail in `doctor`, not mid-mint.
   */
  async getPaymentToken(chain: string, address: string): Promise<PaymentToken> {
    const raw = await this.client.request<unknown>(
      `/api/v2/chain/${encodeURIComponent(chain)}/payment_token/${encodeURIComponent(address)}`,
    );
    return paymentTokenSchema.parse(raw);
  }

  /**
   * GET /api/v2/account/{address}/tokens
   *
   * The wallet's holdings across chains — the same data behind OpenSea's payment-method
   * picker, so the operator can choose a chain/token pair from real balances.
   */
  async getAccountTokens(address: string, chains?: string[]): Promise<TokenBalance[]> {
    const query = chains?.length ? `?chains=${encodeURIComponent(chains.join(','))}` : '';
    const raw = await this.client.request<unknown>(
      `/api/v2/account/${encodeURIComponent(address)}/tokens${query}`,
    );
    return tokenBalancesSchema.parse(raw).token_balances;
  }
}
