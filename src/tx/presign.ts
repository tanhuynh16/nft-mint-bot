import type { Account, Chain, Hex, PublicClient, Transport, WalletClient } from 'viem';
import type { BotConfig } from '../config/schema.js';
import type { ResolvedChain } from '../chains/registry.js';
import type { MintProvider, UnsignedTx } from '../providers/mint-provider.js';
import type { GasEngine } from '../network/gas-engine.js';
import type { NonceManager } from '../wallet/nonce-manager.js';
import type { Logger } from '../observability/logger.js';

export interface VerificationResult {
  matches: boolean;
  local: UnsignedTx;
  reference: UnsignedTx;
  differences: string[];
}

export interface ArmedTransaction {
  rawTx: Hex;
  nonce: number;
  tx: UnsignedTx;
  armedAt: Date;
}

/**
 * Compares locally-encoded calldata against what OpenSea's API produces.
 *
 * This is the guardrail that makes local encoding safe to trust. A silently wrong
 * `to`, a wrong fee recipient baked into `data`, or a wrong `value` would all produce a
 * transaction that reverts — burning the mint window and the gas. Rather than assume
 * the SeaDrop encoding is right, we make OpenSea produce the same call and require an
 * exact match.
 */
export async function verifyLocalEncoding(
  localProvider: MintProvider,
  referenceProvider: MintProvider,
  quantity: bigint,
  logger: Logger,
): Promise<VerificationResult> {
  const [local, reference] = await Promise.all([
    localProvider.buildMint(quantity),
    referenceProvider.buildMint(quantity),
  ]);

  const differences: string[] = [];
  if (local.to.toLowerCase() !== reference.to.toLowerCase()) {
    differences.push(`to: local ${local.to} vs api ${reference.to}`);
  }
  if (local.data.toLowerCase() !== reference.data.toLowerCase()) {
    differences.push(`data: local ${local.data} vs api ${reference.data}`);
  }
  if (local.value !== reference.value) {
    differences.push(`value: local ${local.value} vs api ${reference.value}`);
  }

  const matches = differences.length === 0;
  if (matches) {
    logger.info('local calldata matches the OpenSea API byte-for-byte');
  } else {
    logger.error({ differences }, 'local calldata does NOT match the OpenSea API');
  }

  return { matches, local, reference, differences };
}

export interface ArmOptions {
  config: BotConfig;
  resolved: ResolvedChain;
  provider: MintProvider;
  publicClient: PublicClient<Transport, Chain>;
  wallet: WalletClient<Transport, Chain, Account>;
  account: Account;
  nonceManager: NonceManager;
  gasEngine: GasEngine;
  logger: Logger;
}

/**
 * Builds, prices, and signs the mint transaction ahead of the stage opening.
 *
 * Only valid where ordering is first-come-first-served. On a priority-auction chain
 * the fee must be chosen against the base fee at send time, so a transaction signed
 * minutes early would be stale and likely underpriced — hence the hard refusal below.
 *
 * The cost of arming early is that nonce, gas, and quantity are frozen into the
 * signature. Anything that invalidates them requires discarding and re-arming, which
 * is why the caller re-arms shortly before the open.
 */
export async function armTransaction(options: ArmOptions): Promise<ArmedTransaction> {
  const {
    config,
    resolved,
    provider,
    publicClient,
    wallet,
    account,
    nonceManager,
    gasEngine,
    logger,
  } = options;

  if (resolved.orderingModel !== 'fcfs') {
    throw new Error(
      `Pre-signing is only sound on an fcfs chain. ${resolved.chain.name} orders by ` +
        `priority fee, which must be set against the base fee at send time.`,
    );
  }

  const quantity = BigInt(config.mint.quantity);
  const tx = await provider.buildMint(quantity);
  const gasParams = await gasEngine.calculate(publicClient, tx, account.address);
  const nonce = nonceManager.reserve();

  let rawTx: Hex;
  try {
    rawTx = await wallet.signTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value,
      nonce,
      gas: gasParams.gas,
      maxFeePerGas: gasParams.maxFeePerGas,
      maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
      chain: resolved.chain,
    });
  } catch (error) {
    nonceManager.releaseOnPreSignFailure(nonce, 'pre-sign failed');
    throw error;
  }

  logger.info(
    {
      nonce,
      to: tx.to,
      value: tx.value.toString(),
      gas: gasParams.gas.toString(),
      maxFeePerGas: gasParams.maxFeePerGas.toString(),
      bytes: (rawTx.length - 2) / 2,
    },
    'transaction armed — T0 is now a single sendRawTransaction',
  );

  return { rawTx, nonce, tx, armedAt: new Date() };
}

/**
 * Confirms an armed transaction is still valid against fresh chain state.
 *
 * Re-checks the two things that silently invalidate a pre-signed transaction: the
 * nonce being consumed by something else, and the wallet no longer covering the cost.
 */
export async function revalidateArmed(
  armed: ArmedTransaction,
  publicClient: PublicClient<Transport, Chain>,
  account: Account,
  logger: Logger,
): Promise<{ valid: boolean; reason?: string }> {
  const [chainNonce, balance] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    publicClient.getBalance({ address: account.address }),
  ]);

  if (chainNonce > armed.nonce) {
    const reason = `nonce ${armed.nonce} was consumed (chain is at ${chainNonce})`;
    logger.warn({ reason }, 'armed transaction is stale');
    return { valid: false, reason };
  }

  if (balance < armed.tx.value) {
    const reason = `balance ${balance} no longer covers mint value ${armed.tx.value}`;
    logger.warn({ reason }, 'armed transaction is stale');
    return { valid: false, reason };
  }

  return { valid: true };
}
