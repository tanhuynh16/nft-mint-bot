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
  /**
   * RPC endpoints for chains other than the mint chain, keyed by OpenSea chain slug.
   * Required only for cross-chain payment, where the transactions execute on the
   * payment chain rather than the drop's chain.
   *
   *   paymentEndpoints:
   *     base: ["https://mainnet.base.org"]
   */
  paymentEndpoints: z.record(z.string(), z.array(z.string().url()).min(1)).default({}),
});

/** Zero address means "the chain's native token" in OpenSea's payment schema. */
export const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * How the mint price is paid.
 *
 * `native` is the default and the fast path: one transaction on the chain the NFT
 * contract is deployed to, no swap and no bridge. Any competitive mint wants this.
 *
 * `cross-chain` spends a token held on another chain, routed through OpenSea's relay.
 * That adds a swap, a bridge and a relay hop — seconds to minutes — so it exists for
 * convenience, never for winning a contested drop.
 *
 * A discriminated union rather than optional fields: it makes the choice visible in the
 * config file, and stops a half-edited `payment` block from quietly doing the wrong
 * thing (leftover chain/token under `native` is an error, not silently ignored).
 */
const paymentSchema = z.discriminatedUnion('mode', [
  // strict: a leftover `chain`/`token` under native must fail loudly. Zod strips unknown
  // keys by default, which would let a half-reverted config look like cross-chain while
  // silently paying natively.
  z.strictObject({
    mode: z.literal('native'),
  }),
  z.strictObject({
    mode: z.literal('cross-chain'),
    /** OpenSea chain slug the payment token lives on, e.g. "base", "ethereum". */
    chain: z.string().min(1),
    /** Token contract address; the zero address selects the native token. */
    token: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 20-byte token address'),
  }),
]);

export type PaymentConfig = z.infer<typeof paymentSchema>;

const mintSchema = z.object({
  collectionSlug: z.string().min(1),
  quantity: z.number().int().min(1).max(100),
  maxRetries: z.number().int().min(0).default(20),
  retryDelayMs: z.number().int().min(0).default(100),
  /** Wait for the next stage to open rather than exiting when nothing is active. */
  waitForStage: z.boolean().default(true),
  /** Give up waiting after this long. 0 disables the timeout. */
  waitTimeoutMs: z.number().int().min(0).default(0),
  payment: paymentSchema.prefault({ mode: 'native' }),
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

const scheduleSchema = z.object({
  /** Where the scheduled-job list lives. Must be writable by the service user. */
  dir: z.string().default('.schedule'),
  /** How long before a job's fire time the daemon wakes and hands off to the poller. */
  leadTimeMs: z.number().int().positive().default(120_000),
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
    schedule: scheduleSchema.prefault({}),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.mint.payment.mode === 'cross-chain') {
      // These express opposite intents. race/presign exist to shave milliseconds off a
      // contested mint; a relayed swap costs seconds to minutes and cannot be signed in
      // advance because the returned steps depend on a live quote. Better to reject the
      // combination than let one silently defeat the other.
      if (cfg.execution.mode === 'race') {
        ctx.addIssue({
          code: 'custom',
          path: ['mint', 'payment', 'mode'],
          message:
            'cross-chain payment cannot be used with execution.mode: race — a relayed ' +
            'swap adds seconds and cannot win a contested mint. Use payment.mode: native.',
        });
      }
      if (cfg.execution.presign) {
        ctx.addIssue({
          code: 'custom',
          path: ['mint', 'payment', 'mode'],
          message:
            'cross-chain payment cannot be pre-signed — the transaction sequence depends ' +
            'on a live swap quote. Set execution.presign: false.',
        });
      }
      // No paymentEndpoints entry is required any more: every known chain carries a
      // built-in public RPC, so choosing a network is enough on its own. Whether the
      // chain is one the bot can execute on is checked at context build, where the
      // profile table lives.
    }

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
