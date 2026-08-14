import { formatEther } from 'viem';
import { createContext } from './context.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Pre-flight environment audit.
 *
 * Every check here answers a question that would otherwise be discovered mid-mint,
 * when there is no time to fix it.
 */
export async function doctorCommand(configPath: string): Promise<number> {
  const ctx = createContext(configPath);
  const { config, resolved, account, rpc, openseaClient, drops, logger } = ctx;
  const checks: Check[] = [];

  checks.push({
    name: 'node version',
    ok: Number(process.versions.node.split('.')[0]) >= 20,
    detail: `v${process.versions.node} (need >=20)`,
  });

  checks.push({
    name: 'wallet loaded',
    ok: true,
    detail: `${account.address} on ${resolved.chain.name} (${config.network.chainId})`,
  });

  // RPC health, which also warms the TLS connections the mint will reuse.
  const health = await rpc.probe();
  const readUrls = new Set(resolved.readUrls);

  for (const h of health) {
    if (!readUrls.has(h.url)) continue; // The submit endpoint gets its own line below.
    checks.push({
      name: `rpc ${new URL(h.url).host}`,
      ok: h.ok && h.chainId === config.network.chainId,
      detail: h.ok
        ? `${h.latencyMs}ms, chain ${h.chainId}, block ${h.blockNumber}`
        : `unreachable: ${h.error}`,
    });
  }

  // The submit endpoint is graded on reachability alone: a dedicated sequencer serves
  // only eth_sendRawTransaction, so it has no chain id or block to report. On an fcfs
  // chain this single RTT is the number that decides whether the bot wins.
  const submitHealth = health.find((h) => h.url === resolved.submitUrl);
  checks.push({
    name: 'submit endpoint',
    ok: Boolean(submitHealth?.ok),
    detail:
      `${resolved.submitUrl} — ${submitHealth?.latencyMs ?? '?'}ms` +
      (resolved.orderingModel === 'fcfs' ? ' (fcfs: this RTT decides ordering)' : '') +
      (submitHealth?.ok === false ? ` — ${submitHealth.error}` : ''),
  });

  try {
    const balance = await rpc.primary().getBalance({ address: account.address });
    checks.push({
      name: 'wallet balance',
      ok: balance > 0n,
      detail: `${formatEther(balance)} ${config.network.nativeCurrency.symbol}`,
    });
  } catch (error) {
    checks.push({
      name: 'wallet balance',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  checks.push({
    name: 'opensea api key',
    ok: openseaClient.hasApiKey(),
    detail: openseaClient.hasApiKey()
      ? 'present'
      : `unset — set ${config.opensea.apiKeyEnv} in .env`,
  });

  checks.push({
    name: 'opensea bearer token',
    ok: true, // Optional: only the eligibility endpoint needs it.
    detail: openseaClient.hasBearerToken()
      ? 'present'
      : `unset — the eligibility endpoint will be unavailable (set ${config.opensea.bearerTokenEnv})`,
  });

  try {
    const drop = await drops.getDrop(config.mint.collectionSlug);
    checks.push({
      name: 'drop reachable',
      ok: true,
      detail: `${drop.collection_slug} on ${drop.chain}, type ${drop.drop_type ?? 'unknown'}`,
    });
  } catch (error) {
    checks.push({
      name: 'drop reachable',
      ok: false,
      detail: `${error instanceof Error ? error.message : String(error)} — the direct SeaDrop path may still work; see "inspect"`,
    });
  }

  const failures = checks.filter((c) => !c.ok);
  for (const check of checks) {
    // eslint-disable-next-line no-console
    console.log(`${check.ok ? '✓' : '✗'} ${check.name.padEnd(24)} ${check.detail}`);
  }

  logger.info({ passed: checks.length - failures.length, failed: failures.length }, 'doctor done');
  return failures.length === 0 ? 0 : 1;
}
