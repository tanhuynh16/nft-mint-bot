import { describe, expect, it, vi } from 'vitest';
import { parseGwei } from 'viem';
import { GasEngine } from '../src/network/gas-engine.js';
import { configSchema, type BotConfig } from '../src/config/schema.js';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const FROM = '0x1111111111111111111111111111111111111111' as const;
const TX = {
  to: '0x2222222222222222222222222222222222222222' as const,
  data: '0x' as const,
  value: 0n,
};

function makeConfig(overrides: Record<string, unknown> = {}): BotConfig {
  return configSchema.parse({
    network: { name: 'test', chainId: 1, orderingModel: 'priority-auction', feeModel: 'eip1559' },
    rpc: { endpoints: ['https://rpc.example.com'] },
    mint: { collectionSlug: 'x', quantity: 1 },
    gas: { maxGasGwei: 200, ...(overrides.gas ?? {}) },
    ...overrides,
  });
}

function makeClient(baseFeeGwei: string, priorityGwei = '1') {
  return {
    estimateGas: vi.fn().mockResolvedValue(100_000n),
    getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: parseGwei(baseFeeGwei) }),
    estimateFeesPerGas: vi.fn().mockResolvedValue({
      maxPriorityFeePerGas: parseGwei(priorityGwei),
    }),
  } as never;
}

describe('gas limit', () => {
  it('buffers the estimate', async () => {
    const config = makeConfig({ gas: { maxGasGwei: 200, gasLimitBuffer: 1.25 } });
    const engine = new GasEngine(config, 'eip1559', silentLogger);
    const result = await engine.calculate(makeClient('10'), TX, FROM);
    expect(result.gas).toBe(125_000n);
  });
});

describe('eip1559 fee model', () => {
  it('scales the priority fee up with an aggressive strategy', async () => {
    const normal = new GasEngine(
      makeConfig({ gas: { maxGasGwei: 200, strategy: 'normal', priorityMultiplier: 1 } }),
      'eip1559',
      silentLogger,
    );
    const aggressive = new GasEngine(
      makeConfig({ gas: { maxGasGwei: 200, strategy: 'aggressive', priorityMultiplier: 1 } }),
      'eip1559',
      silentLogger,
    );

    const a = await normal.calculate(makeClient('10'), TX, FROM);
    const b = await aggressive.calculate(makeClient('10'), TX, FROM);
    expect(b.maxPriorityFeePerGas).toBeGreaterThan(a.maxPriorityFeePerGas);
  });

  it('clamps to the ceiling and reports that it did', async () => {
    const config = makeConfig({
      gas: { maxGasGwei: 20, strategy: 'aggressive', maxFeeMultiplier: 2 },
    });
    const engine = new GasEngine(config, 'eip1559', silentLogger);
    const result = await engine.calculate(makeClient('500'), TX, FROM);

    expect(result.ceilingApplied).toBe(true);
    expect(result.maxFeePerGas).toBe(parseGwei('20'));
  });

  it('never lets the priority fee exceed the max fee', async () => {
    const config = makeConfig({
      gas: { maxGasGwei: 5, strategy: 'aggressive', priorityMultiplier: 100 },
    });
    const engine = new GasEngine(config, 'eip1559', silentLogger);
    const result = await engine.calculate(makeClient('1', '50'), TX, FROM);
    expect(result.maxPriorityFeePerGas).toBeLessThanOrEqual(result.maxFeePerGas);
  });
});

describe('orbit fee model', () => {
  it('sets no priority fee, because the sequencer ignores it for ordering', async () => {
    const config = makeConfig({
      network: { name: 'robinhood', chainId: 4663, orderingModel: 'fcfs', feeModel: 'orbit' },
      gas: { maxGasGwei: 10 },
    });
    const engine = new GasEngine(config, 'orbit', silentLogger);
    const result = await engine.calculate(makeClient('0.01'), TX, FROM);
    expect(result.maxPriorityFeePerGas).toBe(0n);
  });

  it('keeps headroom above the base fee without approaching an Ethereum-scale ceiling', async () => {
    const config = makeConfig({
      network: { name: 'robinhood', chainId: 4663, orderingModel: 'fcfs', feeModel: 'orbit' },
      gas: { maxGasGwei: 10 },
    });
    const engine = new GasEngine(config, 'orbit', silentLogger);
    const result = await engine.calculate(makeClient('0.01'), TX, FROM);

    expect(result.maxFeePerGas).toBeGreaterThan(parseGwei('0.01'));
    expect(result.maxFeePerGas).toBeLessThan(parseGwei('1'));
    expect(result.ceilingApplied).toBe(false);
  });

  it('still enforces the ceiling if the base fee spikes', async () => {
    const config = makeConfig({
      network: { name: 'robinhood', chainId: 4663, orderingModel: 'fcfs', feeModel: 'orbit' },
      gas: { maxGasGwei: 1 },
    });
    const engine = new GasEngine(config, 'orbit', silentLogger);
    const result = await engine.calculate(makeClient('5'), TX, FROM);
    expect(result.ceilingApplied).toBe(true);
    expect(result.maxFeePerGas).toBe(parseGwei('1'));
  });
});

describe('custom strategy', () => {
  it('uses the operator values, still bounded by the ceiling', async () => {
    const config = makeConfig({
      gas: {
        maxGasGwei: 200,
        strategy: 'custom',
        customMaxFeeGwei: 50,
        customPriorityFeeGwei: 3,
      },
    });
    const engine = new GasEngine(config, 'eip1559', silentLogger);
    const result = await engine.calculate(makeClient('10'), TX, FROM);
    expect(result.maxFeePerGas).toBe(parseGwei('50'));
    expect(result.maxPriorityFeePerGas).toBe(parseGwei('3'));
  });
});
