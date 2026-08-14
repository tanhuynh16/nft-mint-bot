import { pino, type Logger } from 'pino';
import { randomUUID } from 'node:crypto';

/**
 * Paths pino strips before anything reaches a transport.
 *
 * Configured at construction rather than relied on by convention: any code path that
 * logs an object carrying one of these keys is scrubbed whether or not its author
 * remembered to. `censor: '[REDACTED]'` keeps the key visible so a leak attempt is
 * still auditable in the log.
 */
const REDACT_PATHS = [
  'privateKey',
  'private_key',
  'PRIVATE_KEY',
  'key',
  'secret',
  'mnemonic',
  'seedPhrase',
  'apiKey',
  'api_key',
  'OPENSEA_API_KEY',
  'bearerToken',
  'authorization',
  'Authorization',
  'headers.authorization',
  'headers["x-api-key"]',
  'req.headers.authorization',
  '*.privateKey',
  '*.apiKey',
  '*.secret',
];

export interface CreateLoggerOptions {
  level?: string;
  pretty?: boolean;
  runId?: string;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const { level = process.env.LOG_LEVEL ?? 'info', pretty = process.stdout.isTTY } = options;
  const runId = options.runId ?? randomUUID();

  return pino({
    level,
    base: { runId },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

/** Renders an address as 0x1234…abcd. Addresses are public, but full ones make logs noisy. */
export function maskAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export type { Logger };
