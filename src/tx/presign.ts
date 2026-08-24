import { decodeErrorResult } from 'viem';
import type {
  Account,
  Address,
  Chain,
  Hex,
  PublicClient,
  Transport,
  WalletClient,
} from 'viem';
import { SEADROP_ADDRESS, seaDropAbi } from '../providers/seadrop-abi.js';
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

/**
 * Pulls SeaDrop's custom error name out of a viem call failure.
 *
 * Walks the cause chain for raw revert data, then decodes it against the error entries in
 * seaDropAbi. Without this the only thing available is "execution reverted", which cannot
 * distinguish a wrong fee recipient from a stage that has not opened.
 */
export function decodeSeaDropRevert(error: unknown): string | undefined {
  let cursor = error as { cause?: unknown; data?: unknown } | undefined;

  for (let depth = 0; depth < 8 && cursor; depth += 1) {
    const raw = cursor.data;
    const candidate =
      typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object' && typeof (raw as { data?: unknown }).data === 'string'
          ? (raw as { data: string }).data
          : undefined;

    if (candidate && candidate.startsWith('0x') && candidate.length >= 10) {
      try {
        return decodeErrorResult({ abi: seaDropAbi, data: candidate as Hex }).errorName;
      } catch {
        /* not one of SeaDrop's errors */
      }
    }
    cursor = cursor.cause as typeof cursor;
  }

  return undefined;
}

export type ChainVerdict =
  /** The call would succeed right now. */
  | { kind: 'ok' }
  /**
   * The calldata is structurally correct and the only objection is timing. This is the
   * expected verdict when arming ahead of a drop, and it is safe to arm on.
   */
  | { kind: 'not-yet'; detail: string }
  /** The call would never succeed as built. Refuse to arm. */
  | { kind: 'wrong'; detail: string };

/**
 * Verifies pre-signed calldata against the chain rather than against OpenSea.
 *
 * The OpenSea cross-check cannot help before a race: its mint endpoint returns 409 until
 * a stage is open, so requiring it disabled pre-signing in exactly the situation
 * pre-signing exists for. An `eth_call` works at any time and answers a sharper
 * question — SeaDrop's own reverts distinguish "wrong calldata" from "right calldata,
 * wrong moment".
 *
 * `NotActive` is therefore a pass. `FeeRecipientNotAllowed`, `IncorrectPayment` and the
 * quantity errors are hard failures: those would still be wrong when the stage opens.
 */
export async function verifyAgainstChain(
  publicClient: PublicClient<Transport, Chain>,
  tx: UnsignedTx,
  from: Address,
  logger: Logger,
): Promise<ChainVerdict> {
  try {
    await publicClient.call({ account: from, to: tx.to, data: tx.data, value: tx.value });
    logger.info('pre-flight call succeeded — calldata is valid and the stage is open');
    return { kind: 'ok' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A raw eth_call carries no ABI, so viem reports "reverted for an unknown reason"
    // and the error *name* never appears in the message. Pull the revert data out of the
    // cause chain and decode it, or every verdict collapses to "wrong".
    const decoded = decodeSeaDropRevert(error);
    const name = decoded ?? '';

    if (name === 'NotActive' || /NotActive/i.test(message)) {
      logger.info('pre-flight call reverted NotActive — calldata is valid, stage not open yet');
      return { kind: 'not-yet', detail: 'stage has not opened' };
    }

    // Everything below is still wrong once the clock moves, so arming would burn a nonce
    // on a transaction that cannot succeed.
    for (const known of [
      'FeeRecipientNotAllowed',
      'IncorrectPayment',
      'MintQuantityCannotBeZero',
      'MintQuantityExceedsMaxMintedPerWallet',
      'MintQuantityExceedsMaxSupply',
      'MintQuantityExceedsMaxTokenSupplyForStage',
    ]) {
      if (name === known || message.includes(known)) {
        logger.error({ error: known }, 'pre-flight call rejected the calldata');
        return { kind: 'wrong', detail: known };
      }
    }

    // Insufficient balance is about funding, not calldata — but it would still fail at
    // T0, so it is not something to arm through.
    if (/insufficient funds/i.test(message)) {
      return { kind: 'wrong', detail: 'insufficient funds' };
    }

    logger.warn({ error: message.slice(0, 200) }, 'pre-flight call failed for an unknown reason');
    return { kind: 'wrong', detail: message.slice(0, 120) };
  }
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

export interface ArmWhenReadyOptions {
  publicClient: PublicClient<Transport, Chain>;
  contractAddress: Address;
  logger: Logger;
  /** Give up waiting for the contract to be configured after this long. */
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Waits until the contract actually has a public stage configured.
 *
 * Observed on a real drop: OpenSea publishes the schedule days ahead, but
 * `getPublicDrop` returns all zeroes and `getAllowedFeeRecipients` is empty until the
 * creator configures the stage on-chain — often shortly before it opens. Local calldata
 * cannot be built before that, so pre-signing has a genuine window rather than being
 * armable at will.
 *
 * Polls the chain, not OpenSea: these are cheap reads against our own RPC with no rate
 * limit to exhaust.
 */
export async function waitForContractConfigured(
  options: ArmWhenReadyOptions,
): Promise<boolean> {
  const {
    publicClient,
    contractAddress,
    logger,
    timeoutMs = 10 * 60_000,
    pollMs = 2_000,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  } = options;

  const deadline = now() + timeoutMs;
  let announced = false;

  for (;;) {
    try {
      const [drop, fees] = await Promise.all([
        publicClient.readContract({
          address: SEADROP_ADDRESS as Address,
          abi: seaDropAbi,
          functionName: 'getPublicDrop',
          args: [contractAddress],
        }),
        publicClient.readContract({
          address: SEADROP_ADDRESS as Address,
          abi: seaDropAbi,
          functionName: 'getAllowedFeeRecipients',
          args: [contractAddress],
        }),
      ]);

      if (Number(drop.startTime) > 0 && fees.length > 0) {
        logger.info(
          { startTime: new Date(Number(drop.startTime) * 1000).toISOString() },
          'contract now has a public stage configured; can arm',
        );
        return true;
      }
    } catch {
      /* not configured yet */
    }

    if (now() >= deadline) {
      logger.warn(
        { contractAddress },
        'contract still has no public stage configured; pre-sign unavailable, ' +
          'falling back to building at mint time',
      );
      return false;
    }

    if (!announced) {
      logger.info('waiting for the creator to configure the public stage on-chain');
      announced = true;
    }
    await sleep(pollMs);
  }
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
