import { formatEther } from 'viem';
import { createContext } from './context.js';
import { toCount, toWei } from '../opensea/drops.js';
import { OpenSeaError } from '../opensea/client.js';

const log = (line = '') => {
  // eslint-disable-next-line no-console
  console.log(line);
};

/**
 * Reports what the Drops API actually knows about the target.
 *
 * This is the command that settles whether the OpenSea Drops path is available for a
 * given collection at all. A 404 here is informative, not a failure: it means the
 * collection mints through its own contract and the SeaDrop/custom provider is the
 * route, which is precisely why the provider abstraction exists.
 */
export async function inspectCommand(
  configPath: string,
  overrides: { collection?: string } = {},
): Promise<number> {
  const ctx = createContext(configPath);
  const { config, drops, openseaClient, resolved, account } = ctx;
  const slug = overrides.collection ?? config.mint.collectionSlug;

  log(`Collection : ${slug}`);
  log(`Network    : ${resolved.chain.name} (${config.network.chainId})`);
  log(`Ordering   : ${resolved.orderingModel}   Fee model: ${resolved.feeModel}`);
  log(`Submit to  : ${resolved.submitUrl}`);
  log();

  if (resolved.orderingModel === 'fcfs') {
    log('Note: this chain sequences first-come-first-served. Gas does not buy priority;');
    log('      round-trip time to the submit endpoint does.');
    log();
  }

  try {
    const drop = await drops.getDrop(slug);

    log(`Contract   : ${drop.contract_address}`);
    log(`Chain      : ${drop.chain}`);
    log(`Drop type  : ${drop.drop_type ?? 'unknown'}`);
    log(`Minting    : ${drop.is_minting ?? 'unknown'}`);

    const total = toCount(drop.total_supply);
    const max = toCount(drop.max_supply);
    if (total !== undefined && max !== undefined) {
      log(`Supply     : ${total} / ${max} (${max - total} remaining)`);
    }
    log();

    if (drop.stages.length > 0) {
      log('Stages:');
      for (const stage of drop.stages) {
        const price = stage.price ? formatEther(toWei(stage.price)) : '?';
        log(
          `  - ${stage.label ?? stage.stage_type ?? 'stage'}: ${price} ETH, ` +
            `max/wallet ${stage.max_per_wallet ?? '∞'}, ` +
            `${stage.start_time ?? '?'} → ${stage.end_time ?? '?'}`,
        );
      }
      log();
    }

    if (drop.active_stage) {
      log(`Active stage: ${drop.active_stage.label ?? drop.active_stage.stage_type ?? 'yes'}`);
    } else if (drop.next_stage) {
      log(`Next stage : ${drop.next_stage.label ?? '?'} at ${drop.next_stage.start_time ?? '?'}`);
    } else {
      log('No active or upcoming stage reported.');
    }

    // Eligibility needs the OAuth token, so it is best-effort.
    if (openseaClient.hasBearerToken()) {
      try {
        const eligibility = await drops.getEligibility(slug);
        log();
        log(`Eligibility for ${account.address}:`);
        for (const stage of eligibility.stages) {
          log(
            `  - ${stage.stage_uuid}: ${stage.is_eligible ? 'ELIGIBLE' : 'not eligible'}` +
              (stage.max_total_mintable_by_wallet
                ? `, max ${stage.max_total_mintable_by_wallet}`
                : ''),
          );
        }
      } catch (error) {
        log();
        log(
          `Eligibility unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      log();
      log(
        `Eligibility skipped — set ${config.opensea.bearerTokenEnv} (OAuth token with ` +
          `read:eligibility) to check without spending a mint attempt.`,
      );
    }

    return 0;
  } catch (error) {
    if (error instanceof OpenSeaError && error.kind === 'not-found') {
      log(`The OpenSea Drops API has no drop for "${slug}".`);
      log();
      log('That does not mean it is unmintable — it means the Drops API is not the route.');
      log('Find the mint contract (collection page → contract, or the project site) and');
      log('use the direct path:');
      log();
      log(`  mint-bot dry-run --config ${configPath} --contract 0x...`);
      return 1;
    }
    log(`Failed to read the drop: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
