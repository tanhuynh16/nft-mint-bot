#!/usr/bin/env node
// Must stay first: rejects an unsupported Node before viem is evaluated. See the module.
import './engine-check.js';
import { Command } from 'commander';
import { startCommand } from './start.js';
import { setEnvFileOverride } from './context.js';
import { doctorCommand } from './doctor.js';
import { inspectCommand } from './inspect.js';
import { paymentsCommand } from './payments.js';
import {
  scheduleAddCommand,
  scheduleEditCommand,
  scheduleListCommand,
  scheduleRemoveCommand,
  scheduleRunCommand,
} from './schedule.js';

const program = new Command();

program
  .name('mint-bot')
  .description('Low-latency EVM NFT mint bot')
  .version('0.1.0')
  .option(
    '--env-file <path>',
    'env file to load (default: $MINT_BOT_ENV_FILE, ./.env, then /etc/nft-mint-bot/env)',
  )
  .hook('preSubcommand', (thisCommand) => {
    setEnvFileOverride(thisCommand.opts().envFile as string | undefined);
  });

program
  .command('start')
  .description('Execute the mint workflow')
  .requiredOption('-c, --config <path>', 'path to the YAML config')
  .option('-q, --quantity <n>', 'override mint.quantity', (v) => Number.parseInt(v, 10))
  .option('-g, --gas <strategy>', 'override gas.strategy (normal|fast|aggressive|custom)')
  .option('--contract <address>', 'mint contract, for the direct SeaDrop path')
  .option('--local', 'force local calldata encoding instead of the OpenSea API')
  .option('--all-wallets', 'mint concurrently from every configured wallet')
  .action(async (options) => {
    process.exitCode = await startCommand(options.config, {
      quantity: options.quantity,
      gas: options.gas,
      contract: options.contract,
      local: options.local,
      allWallets: options.allWallets,
    });
  });

program
  .command('dry-run')
  .description('Validate config, wallet, network, drop and transaction construction — no broadcast')
  .requiredOption('-c, --config <path>', 'path to the YAML config')
  .option('-q, --quantity <n>', 'override mint.quantity', (v) => Number.parseInt(v, 10))
  .option('--contract <address>', 'mint contract, for the direct SeaDrop path')
  .option('--local', 'force local calldata encoding instead of the OpenSea API')
  .option('--all-wallets', 'rehearse from every configured wallet, without broadcasting')
  .action(async (options) => {
    process.exitCode = await startCommand(options.config, {
      quantity: options.quantity,
      contract: options.contract,
      local: options.local,
      allWallets: options.allWallets,
      mode: 'dry-run',
    });
  });

program
  .command('inspect')
  .description('Show drop, stage, supply and provider information')
  .requiredOption('-c, --config <path>', 'path to the YAML config')
  .option('--collection <slug>', 'override mint.collectionSlug')
  .action(async (options) => {
    process.exitCode = await inspectCommand(options.config, {
      collection: options.collection,
    });
  });

program
  .command('payments')
  .description('List wallet token balances across chains, for choosing a payment method')
  .requiredOption('-c, --config <path>', 'path to the YAML config')
  .option('--chains <slugs>', 'comma-separated chain slugs to filter by')
  .action(async (options) => {
    process.exitCode = await paymentsCommand(
      options.config,
      options.chains ? { chains: String(options.chains).split(',') } : {},
    );
  });

const schedule = program
  .command('schedule')
  .description('Manage the list of NFTs queued to mint at a future time');

schedule
  .command('add <slug>')
  .description('Queue a collection to mint when its stage opens')
  .requiredOption('-c, --config <path>', 'path to the YAML config')
  .option('-q, --quantity <n>', 'how many to mint', (v) => Number.parseInt(v, 10))
  .option('--at <iso>', 'explicit UTC time, e.g. 2026-09-01T14:00:00Z (default: the drop\'s stage)')
  .option('--stage <label>', 'target a named stage (default: the public sale)')
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(async (slug, options) => {
    process.exitCode = await scheduleAddCommand(slug, {
      config: options.config,
      ...(options.quantity !== undefined ? { quantity: options.quantity } : {}),
      ...(options.at ? { at: options.at } : {}),
      ...(options.stage ? { stage: options.stage } : {}),
      ...(options.yes ? { yes: true } : {}),
    });
  });

schedule
  .command('list')
  .description('Show queued mints, with times in UTC and your local zone')
  .requiredOption('-c, --config <path>', 'path to the YAML config')
  .option('--all', 'include finished, failed and cancelled jobs')
  .action((options) => {
    process.exitCode = scheduleListCommand(options.config, Boolean(options.all));
  });

schedule
  .command('edit <id>')
  .description('Change a queued mint')
  .requiredOption('-c, --config <path>', 'path to the YAML config')
  .option('-q, --quantity <n>', 'new quantity', (v) => Number.parseInt(v, 10))
  .option('--at <iso>', 'new explicit UTC time')
  .option('--slug <slug>', 'target a different collection')
  .option('--stage <label>', 'target a named stage')
  .action(async (id, options) => {
    process.exitCode = await scheduleEditCommand(id, {
      config: options.config,
      ...(options.quantity !== undefined ? { quantity: options.quantity } : {}),
      ...(options.at ? { at: options.at } : {}),
      ...(options.slug ? { slug: options.slug } : {}),
      ...(options.stage ? { stage: options.stage } : {}),
    });
  });

schedule
  .command('remove <id>')
  .description('Drop a queued mint')
  .requiredOption('-c, --config <path>', 'path to the YAML config')
  .action((id, options) => {
    process.exitCode = scheduleRemoveCommand(id, options.config);
  });

schedule
  .command('run')
  .description('Run the scheduler daemon (this is what systemd starts on the VPS)')
  .requiredOption('-c, --config <path>', 'path to the YAML config')
  .option('--once', 'make a single scheduling decision and exit')
  .action(async (options) => {
    process.exitCode = await scheduleRunCommand(options.config, Boolean(options.once));
  });

program
  .command('doctor')
  .description('Check RPC health, wallet balance, chain id, API key and environment')
  .requiredOption('-c, --config <path>', 'path to the YAML config')
  .action(async (options) => {
    process.exitCode = await doctorCommand(options.config);
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    // Errors reaching here are configuration or environment failures, which happen
    // before the logger may exist. Print the message only — never the stack, which can
    // carry argument values.
    // eslint-disable-next-line no-console
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

void main();
