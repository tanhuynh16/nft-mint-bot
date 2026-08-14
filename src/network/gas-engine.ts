import { parseGwei, type Chain, type PublicClient, type Transport } from 'viem';
import type { BotConfig, FeeModel, GasStrategy } from '../config/schema.js';
import type { UnsignedTx } from '../providers/mint-provider.js';
import type { Logger } from '../observability/logger.js';

export interface GasParameters {
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** True when the ceiling clamped the computed fee. */
  ceilingApplied: boolean;
  /** Worst-case fee cost: gas * maxFeePerGas. Excludes the mint value. */
  maxFeeCost: bigint;
}

/** Priority-fee multipliers per strategy. Only meaningful on a priority-auction chain. */
const STRATEGY_PRIORITY_MULTIPLIER: Record<Exclude<GasStrategy, 'custom'>, number> = {
  normal: 1.0,
  fast: 1.5,
  aggressive: 2.5,
};

function scale(value: bigint, multiplier: number): bigint {
  // bigint has no float math; go through a 10_000-denominated integer to keep precision
  // without ever converting a wei value to Number.
  const scaled = BigInt(Math.round(multiplier * 10_000));
  return (value * scaled) / 10_000n;
}

export class GasEngine {
  constructor(
    private readonly config: BotConfig,
    private readonly feeModel: FeeModel,
    private readonly logger: Logger,
  ) {}

  async calculate(
    client: PublicClient<Transport, Chain>,
    tx: UnsignedTx,
    from: `0x${string}`,
  ): Promise<GasParameters> {
    const gas = await this.estimateGasLimit(client, tx, from);
    const fees =
      this.feeModel === 'orbit'
        ? await this.orbitFees(client)
        : await this.eip1559Fees(client);

    const ceiling = parseGwei(String(this.config.gas.maxGasGwei));
    let { maxFeePerGas, maxPriorityFeePerGas } = fees;
    let ceilingApplied = false;

    if (maxFeePerGas > ceiling) {
      maxFeePerGas = ceiling;
      ceilingApplied = true;
    }
    // The priority fee is part of the max fee, so it can never exceed it.
    if (maxPriorityFeePerGas > maxFeePerGas) {
      maxPriorityFeePerGas = maxFeePerGas;
    }

    const params: GasParameters = {
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      ceilingApplied,
      maxFeeCost: gas * maxFeePerGas,
    };

    this.logger.debug(
      {
        feeModel: this.feeModel,
        strategy: this.config.gas.strategy,
        gas: gas.toString(),
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
        ceilingApplied,
      },
      'gas calculated',
    );

    return params;
  }

  private async estimateGasLimit(
    client: PublicClient<Transport, Chain>,
    tx: UnsignedTx,
    from: `0x${string}`,
  ): Promise<bigint> {
    const estimate = await client.estimateGas({
      account: from,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
    return scale(estimate, this.config.gas.gasLimitBuffer);
  }

  /**
   * Arbitrum Nitro. The L2 base fee is small and nearly constant, and eth_estimateGas
   * already folds the L1 data-posting cost into the returned limit — so the fee here
   * only has to clear the base fee, not outbid anyone. Ordering is by arrival time.
   */
  private async orbitFees(
    client: PublicClient<Transport, Chain>,
  ): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    if (this.config.gas.strategy === 'custom') return this.customFees();

    const block = await client.getBlock({ blockTag: 'latest' });
    const baseFee = block.baseFeePerGas ?? parseGwei('0.01');

    return {
      // Generous headroom against a base-fee spike between estimation and inclusion.
      // Costs nothing extra: the chain refunds the difference above the actual base fee.
      maxFeePerGas: scale(baseFee, 3) + parseGwei('0.01'),
      // Nitro's sequencer ignores priority fee for ordering. Zero is correct, not stingy.
      maxPriorityFeePerGas: 0n,
    };
  }

  /** Ethereum-style fee auction: the priority fee genuinely competes for inclusion order. */
  private async eip1559Fees(
    client: PublicClient<Transport, Chain>,
  ): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    if (this.config.gas.strategy === 'custom') return this.customFees();

    const [block, estimate] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      client.estimateFeesPerGas().catch(() => undefined),
    ]);

    const baseFee = block.baseFeePerGas ?? 0n;
    const networkPriority = estimate?.maxPriorityFeePerGas ?? parseGwei('1');

    const strategyMultiplier = STRATEGY_PRIORITY_MULTIPLIER[this.config.gas.strategy];
    const priority = scale(
      networkPriority,
      strategyMultiplier * this.config.gas.priorityMultiplier,
    );

    // Base fee can rise 12.5% per block; the maxFee multiplier buys room across several
    // blocks so the transaction stays valid instead of going stale mid-window.
    const maxFee = scale(baseFee, this.config.gas.maxFeeMultiplier) + priority;

    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
  }

  private customFees(): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
    const { customMaxFeeGwei, customPriorityFeeGwei } = this.config.gas;
    if (customMaxFeeGwei === undefined) {
      throw new Error('gas.strategy is custom but gas.customMaxFeeGwei is unset');
    }
    return {
      maxFeePerGas: parseGwei(String(customMaxFeeGwei)),
      maxPriorityFeePerGas: parseGwei(String(customPriorityFeeGwei ?? 0)),
    };
  }
}
