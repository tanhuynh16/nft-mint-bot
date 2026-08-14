import { defineChain, type Chain } from 'viem';
import type { BotConfig } from '../config/schema.js';
import { getChainProfile, type ChainProfile } from './profiles.js';

export interface ResolvedChain extends ChainProfile {
  /** Endpoint signed transactions are submitted to. */
  submitUrl: string;
  /** Endpoints used for reads, in preference order. */
  readUrls: string[];
}

/**
 * Reconciles the configured network against the built-in profile table.
 *
 * A config for an unknown chain id is allowed — it just has to declare its own
 * orderingModel and feeModel, which the schema already requires. A config that
 * contradicts a known profile is rejected: silently minting on a chain whose
 * ordering model differs from what the operator believes is exactly the failure
 * this table exists to prevent.
 */
export function resolveChain(config: BotConfig): ResolvedChain {
  const { network, rpc } = config;
  const known = getChainProfile(network.chainId);

  if (known) {
    if (known.orderingModel !== network.orderingModel) {
      throw new Error(
        `Config declares network.orderingModel "${network.orderingModel}" for chain ` +
          `${network.chainId} (${known.chain.name}), but that chain is "${known.orderingModel}". ` +
          `Fix the config — this setting decides whether gas bidding does anything.`,
      );
    }
    if (known.feeModel !== network.feeModel) {
      throw new Error(
        `Config declares network.feeModel "${network.feeModel}" for chain ${network.chainId} ` +
          `(${known.chain.name}), but that chain is "${known.feeModel}".`,
      );
    }
  }

  const chain: Chain =
    known?.chain ??
    defineChain({
      id: network.chainId,
      name: network.name,
      nativeCurrency: network.nativeCurrency,
      rpcUrls: { default: { http: [rpc.endpoints[0]!] } },
      ...(network.blockExplorerUrl
        ? {
            blockExplorers: {
              default: { name: 'Explorer', url: network.blockExplorerUrl },
            },
          }
        : {}),
    });

  // Prefer an explicit submitEndpoint, then the profile's sequencer, then the first RPC.
  const submitUrl = rpc.submitEndpoint ?? known?.sequencerUrl ?? rpc.endpoints[0]!;

  return {
    chain,
    orderingModel: network.orderingModel,
    feeModel: network.feeModel,
    ...(known?.sequencerUrl ? { sequencerUrl: known.sequencerUrl } : {}),
    ...(known?.openseaChain ? { openseaChain: known.openseaChain } : {}),
    submitUrl,
    readUrls: rpc.endpoints,
  };
}
