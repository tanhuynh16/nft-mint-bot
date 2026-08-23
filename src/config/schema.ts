import { z } from 'zod';

/**
 * Ordering model determines what actually wins a competitive mint on this chain.
 *
 * - priority-auction: block builders order by effective priority fee (Ethereum, Polygon).
 *   Fee escalation and wide propagation matter.
 * - fcfs: a sequencer orders strictly by arrival time (Arbitrum Orbit chains such as
 *   Robinhood Chain, and OP-stack chains such as Base). Paying more buys nothing;
 *   round-trip time to the sequencer is the only lever.
 */
export const OrderingModel = z.enum(['priority-auction', 'fcfs']);
export type OrderingModel = z.infer<typeof OrderingModel>;

/**
 * Fee model determines how gas parameters are computed.
 *
 * - eip1559: baseFee + priority fee, tuned by strategy multipliers.
 * - orbit: Arbitrum Nitro. L2 base fee is tiny and stable; eth_estimateGas already
 *   folds in the L1 data-availability component, so we buffer the estimate rather
 *   than applying Ethereum-style multipliers.
 */
export const FeeModel = z.enum(['eip1559', 'orbit']);
export type FeeModel = z.infer<typeof FeeModel>;

export const GasStrategy = z.enum(['normal', 'fast', 'aggressive', 'custom']);
export type GasStrategy = z.infer<typeof GasStrategy>;

/**
 * - dry-run:   build and simulate, never broadcast.
 * - preflight: simulate before sending. Normal production mode.
 * - race:      skip simulation, allow the pre-sign fast path. Only after a verified dry-run.
 */
export const ExecutionMode = z.enum(['dry-run', 'preflight', 'race']);
export type ExecutionMode = z.infer<typeof ExecutionMode>;

const hexAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 20-byte address');

const networkSchema = z.object({
  name: z.string().min(1),
  chainId: z.number().int().positive(),
  orderingModel: OrderingModel,
  feeModel: FeeModel,
  nativeCurrency: z
    .object({
      name: z.string().default('Ether'),
      symbol: z.string().default('ETH'),
      decimals: z.number().int().default(18),
    })
    .prefault({}),
  blockExplorerUrl: z.string().url().optional(),
});

const rpcSchema = z.object({
  endpoints: z.array(z.string().url()).min(1, 'at least one RPC endpoint is required'),
  /**
   * Where signed transactions are submitted. On an fcfs chain this should be the
   * sequencer itself — any other endpoint merely forwards there, adding a hop.
   * Falls back to endpoints[0] when unset.
   */
  submitEndpoint: z.string().url().optional(),
  /**
   * Broadcast the same raw transaction to every healthy endpoint. Meaningful only
   * on priority-auction chains; forced off for fcfs (see refinement below).
   */
  parallelBroadcast: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(10_000),
});

const mintSchema = z.object({
  collectionSlug: z.string().min(1),
  quantity: z.number().int().min(1).max(100),
  maxRetries: z.number().int().min(0).default(20),
  retryDelayMs: z.number().int().min(0).default(100),
  /** Wait for the next stage to open rather than exiting when nothing is active. */
  waitForStage: z.boolean().default(true),
  /** Give up waiting after this long. 0 disables the timeout. */
  waitTimeoutMs: z.number().int().min(0).default(0),
});

const gasSchema = z.object({
  strategy: GasStrategy.default('normal'),
  priorityMultiplier: z.number().positive().default(1.5),
  maxFeeMultiplier: z.number().positive().default(2.0),
  /** Hard ceiling on total fee per gas. Enforced under every strategy and fee model. */
  maxGasGwei: z.number().positive(),
  /** Multiplier applied to the estimated gas limit. */
  gasLimitBuffer: z.number().min(1).default(1.25),
  /** strategy: custom only. Explicit values in gwei. */
  customMaxFeeGwei: z.number().positive().optional(),
  customPriorityFeeGwei: z.number().positive().optional(),
});

const executionSchema = z.object({
  mode: ExecutionMode.default('preflight'),
  waitForConfirmation: z.boolean().default(true),
  confirmationBlocks: z.number().int().min(1).default(1),
  confirmationTimeoutMs: z.number().int().positive().default(120_000),
  /** Arm the pre-sign fast path. Requires mode: race. */
  presign: z.boolean().default(false),
  /** Re-validate and re-arm the pre-signed transaction this long before stage open. */
  presignRearmMs: z.number().int().positive().default(30_000),
});

const walletSchema = z.object({
  /** Name of the env var holding the key. Never the key itself. */
  privateKeyEnv: z.string().min(1).default('PRIVATE_KEY'),
  /** If set, startup asserts the derived address matches. Guards against loading the wrong key. */
  expectedAddress: hexAddress.optional(),
});

const openseaSchema = z.object({
  apiKeyEnv: z.string().min(1).default('OPENSEA_API_KEY'),
  bearerTokenEnv: z.string().min(1).default('OPENSEA_BEARER_TOKEN'),
  baseUrl: z.string().url().default('https://api.opensea.io'),
});

const journalSchema = z.object({
  enabled: z.boolean().default(true),
  dir: z.string().default('.journal'),
});

export const configSchema = z
  .object({
    network: networkSchema,
    rpc: rpcSchema,
    mint: mintSchema,
    gas: gasSchema,
    execution: executionSchema.prefault({}),
    wallet: walletSchema.prefault({}),
    opensea: openseaSchema.prefault({}),
    journal: journalSchema.prefault({}),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.execution.presign && cfg.execution.mode !== 'race') {
      ctx.addIssue({
        code: 'custom',
        path: ['execution', 'presign'],
        message: 'presign requires execution.mode: race',
      });
    }
    if (cfg.gas.strategy === 'custom' && cfg.gas.customMaxFeeGwei === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['gas', 'customMaxFeeGwei'],
        message: 'gas.strategy: custom requires gas.customMaxFeeGwei',
      });
    }
    if (cfg.gas.customMaxFeeGwei !== undefined && cfg.gas.customMaxFeeGwei > cfg.gas.maxGasGwei) {
      ctx.addIssue({
        code: 'custom',
        path: ['gas', 'customMaxFeeGwei'],
        message: 'gas.customMaxFeeGwei exceeds the gas.maxGasGwei ceiling',
      });
    }
  })
  .transform((cfg) => {
    // Parallel broadcast cannot help when a single sequencer decides ordering; it only
    // burns time and rate limit. Force it off rather than letting a stale config mislead.
    if (cfg.network.orderingModel === 'fcfs' && cfg.rpc.parallelBroadcast) {
      cfg.rpc.parallelBroadcast = false;
    }
    return cfg;
  });

export type BotConfig = z.infer<typeof configSchema>;
