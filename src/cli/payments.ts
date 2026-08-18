import { createContext } from './context.js';
import { supportedPaymentChains } from '../chains/profiles.js';
import { NATIVE_TOKEN_ADDRESS } from '../config/schema.js';
import type { TokenBalance } from '../opensea/drops.js';

const log = (line = '') => {
  // eslint-disable-next-line no-console
  console.log(line);
};

function num(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value);
}

/**
 * Lists the wallet's holdings across chains — the same data behind OpenSea's
 * payment-method picker.
 *
 * Exists so a chain/token pair can be copied from real balances rather than guessed:
 * a mistyped token address would otherwise surface as an opaque 400 from the
 * cross_chain_mint endpoint at the moment of the mint.
 */
export async function paymentsCommand(
  configPath: string,
  overrides: { chains?: string[] } = {},
): Promise<number> {
  const ctx = createContext(configPath);
  const { drops, account, openseaClient, config } = ctx;

  if (!openseaClient.hasApiKey()) {
    log(`No OpenSea API key. Set ${config.opensea.apiKeyEnv} in .env.`);
    return 1;
  }

  log(`Payment options for ${account.address}`);
  log();

  let balances: TokenBalance[];
  try {
    balances = await drops.getAccountTokens(account.address, overrides.chains);
  } catch (error) {
    log(`Could not read balances: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (balances.length === 0) {
    log('No token balances returned.');
    return 0;
  }

  const executable = new Set(supportedPaymentChains());

  // Highest USD value first — the practical order for choosing what to spend.
  const rows = [...balances].sort((a, b) => num(b.usd_value) - num(a.usd_value));

  log(
    `${'TOKEN'.padEnd(10)}${'CHAIN'.padEnd(20)}${'BALANCE'.padStart(18)}` +
      `${'USD'.padStart(14)}  TOKEN ADDRESS`,
  );
  log('─'.repeat(110));

  for (const row of rows) {
    const chain = row.chain ?? '?';
    const address = row.address ?? NATIVE_TOKEN_ADDRESS;
    const isNative = address.toLowerCase() === NATIVE_TOKEN_ADDRESS;
    // A chain the bot has no profile for cannot be executed on, even if OpenSea
    // reports a balance there. Flag it rather than let it be configured and fail later.
    const usable = executable.has(chain.toLowerCase());

    log(
      `${(row.symbol ?? '?').padEnd(10)}` +
        `${chain.padEnd(20)}` +
        `${num(row.quantity).toFixed(4).padStart(18)}` +
        `${`$${num(row.usd_value).toFixed(2)}`.padStart(14)}  ` +
        `${isNative ? `${NATIVE_TOKEN_ADDRESS} (native)` : address}` +
        `${usable ? '' : '   [chain not supported by this bot]'}`,
    );
  }

  log();
  log('To pay with one of these, set in your config:');
  log();
  log('  mint:');
  log('    payment:');
  log('      mode: cross-chain');
  log('      chain: <CHAIN>');
  log('      token: "<TOKEN ADDRESS>"');
  log();
  log('  rpc:');
  log('    paymentEndpoints:');
  log('      <CHAIN>: ["https://..."]');
  log();
  log('Native payment on the drop\'s own chain stays faster — cross-chain adds a swap,');
  log('a bridge and a relay hop. Use it for convenience, not for a competitive mint.');

  return 0;
}
