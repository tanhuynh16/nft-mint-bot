import { createWalletClient, http, type Account, type WalletClient, type Transport } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { BotConfig } from '../config/schema.js';
import type { ResolvedChain } from '../chains/registry.js';

export interface SignerContext {
  account: Account;
  wallet: WalletClient<Transport, ResolvedChain['chain'], Account>;
}

/**
 * Loads the signing key from the environment only.
 *
 * Deliberately not accepted from a CLI flag (shell history), a config file (commits),
 * or a prompt argument. The key is read once, handed to viem, and never stored on any
 * object this module returns.
 */
export function loadAccount(config: BotConfig, env: NodeJS.ProcessEnv = process.env): Account {
  const varName = config.wallet.privateKeyEnv;
  const raw = env[varName];

  if (!raw || raw === '0x') {
    throw new Error(
      `Private key env var ${varName} is unset. Set it in .env (which is gitignored) ` +
        `or export it. Never pass a key as a CLI argument.`,
    );
  }

  const normalized = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    // Deliberately does not echo the value.
    throw new Error(`${varName} is not a valid 32-byte hex private key.`);
  }

  const account = privateKeyToAccount(normalized as `0x${string}`);

  if (config.wallet.expectedAddress) {
    const expected = config.wallet.expectedAddress.toLowerCase();
    if (account.address.toLowerCase() !== expected) {
      throw new Error(
        `Loaded key derives ${account.address}, but wallet.expectedAddress is ` +
          `${config.wallet.expectedAddress}. Refusing to sign with the wrong wallet.`,
      );
    }
  }

  return account;
}

export function createSigner(
  config: BotConfig,
  resolved: ResolvedChain,
  env: NodeJS.ProcessEnv = process.env,
): SignerContext {
  const account = loadAccount(config, env);

  const wallet = createWalletClient({
    account,
    chain: resolved.chain,
    transport: http(resolved.submitUrl, {
      timeout: config.rpc.timeoutMs,
      // Keep the connection warm so the mint window does not pay for a TLS handshake.
      fetchOptions: { keepalive: true },
      retryCount: 0, // Retries are the retry engine's job, not the transport's.
    }),
  });

  return { account, wallet };
}

/**
 * Fail-closed check that the endpoint we are about to sign against is the chain the
 * operator configured. Runs before any transaction is built.
 */
export async function assertChainId(
  actualChainId: number,
  expectedChainId: number,
): Promise<void> {
  if (actualChainId !== expectedChainId) {
    throw new Error(
      `RPC reports chain ${actualChainId} but config expects ${expectedChainId}. ` +
        `Refusing to proceed — signing against the wrong chain risks funds.`,
    );
  }
}
