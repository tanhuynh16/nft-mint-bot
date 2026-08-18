import { defineChain, type Chain } from 'viem';
import { mainnet, base, arbitrum, polygon, optimism } from 'viem/chains';
import type { FeeModel, OrderingModel } from '../config/schema.js';

/**
 * Robinhood Chain — Arbitrum Orbit (Nitro) L2, ETH gas, launched July 2026.
 * Defined locally rather than imported so the bot does not depend on viem shipping it.
 */
export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' },
  },
  testnet: true,
});

export interface ChainProfile {
  chain: Chain;
  orderingModel: OrderingModel;
  feeModel: FeeModel;
  /**
   * Canonical sequencer submission endpoint for fcfs chains. Submitting here avoids the
   * forwarding hop that a general-purpose RPC adds before the sequencer sees the tx.
   */
  sequencerUrl?: string;
  /** OpenSea's `chain` identifier, for cross-checking API responses against config. */
  openseaChain?: string;
}

/**
 * Known chains and how they actually order transactions.
 *
 * The orderingModel is the important column: it decides whether the gas engine is
 * bidding in an auction or merely paying a toll, and whether the pre-sign fast path
 * is available.
 */
export const CHAIN_PROFILES: Record<number, ChainProfile> = {
  [mainnet.id]: {
    chain: mainnet,
    orderingModel: 'priority-auction',
    feeModel: 'eip1559',
    openseaChain: 'ethereum',
  },
  [polygon.id]: {
    chain: polygon,
    orderingModel: 'priority-auction',
    feeModel: 'eip1559',
    openseaChain: 'matic',
  },
  [base.id]: {
    // OP-stack: a single sequencer orders by arrival, so priority fees do not reorder.
    chain: base,
    orderingModel: 'fcfs',
    feeModel: 'eip1559',
    openseaChain: 'base',
  },
  [arbitrum.id]: {
    chain: arbitrum,
    orderingModel: 'fcfs',
    feeModel: 'orbit',
    openseaChain: 'arbitrum',
  },
  [optimism.id]: {
    // OP-stack, like Base: single sequencer ordering by arrival.
    chain: optimism,
    orderingModel: 'fcfs',
    feeModel: 'eip1559',
    openseaChain: 'optimism',
  },
  [robinhood.id]: {
    chain: robinhood,
    orderingModel: 'fcfs',
    feeModel: 'orbit',
    sequencerUrl: 'https://sequencer.mainnet.chain.robinhood.com',
    openseaChain: 'robinhood',
  },
  [robinhoodTestnet.id]: {
    chain: robinhoodTestnet,
    orderingModel: 'fcfs',
    feeModel: 'orbit',
    sequencerUrl: 'https://sequencer.testnet.chain.robinhood.com',
    openseaChain: 'robinhood_testnet',
  },
};

export function getChainProfile(chainId: number): ChainProfile | undefined {
  return CHAIN_PROFILES[chainId];
}

/**
 * Looks a chain up by its OpenSea slug ("base", "ethereum", …).
 *
 * The payment side of a cross-chain mint is identified by slug, not chain id, because
 * that is what the OpenSea API speaks.
 */
export function getChainProfileBySlug(slug: string): ChainProfile | undefined {
  const wanted = slug.toLowerCase();
  return Object.values(CHAIN_PROFILES).find((p) => p.openseaChain === wanted);
}

/** OpenSea slugs the bot can execute payment transactions on. */
export function supportedPaymentChains(): string[] {
  return Object.values(CHAIN_PROFILES)
    .map((p) => p.openseaChain)
    .filter((slug): slug is string => Boolean(slug))
    .sort();
}

export function knownChainIds(): number[] {
  return Object.keys(CHAIN_PROFILES).map(Number);
}
