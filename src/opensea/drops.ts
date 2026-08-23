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
}
