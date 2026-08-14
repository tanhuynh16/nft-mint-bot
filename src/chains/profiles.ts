import { defineChain, type Chain } from 'viem';
import { mainnet, base, arbitrum, polygon } from 'viem/chains';
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

export function knownChainIds(): number[] {
  return Object.keys(CHAIN_PROFILES).map(Number);
}
