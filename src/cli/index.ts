#!/usr/bin/env node
// Must stay first: rejects an unsupported Node before viem is evaluated. See the module.
import './engine-check.js';
import { Command } from 'commander';
import { startCommand } from './start.js';
import { doctorCommand } from './doctor.js';
import { inspectCommand } from './inspect.js';

const program = new Command();

program
  .name('mint-bot')
  .description('Low-latency EVM NFT mint bot')
  .version('0.1.0');

program
  .command('start')
  .description('Execute the mint workflow')
  .requiredOption('-c, --config <path>', 'path to the YAML config')
  .option('-q, --quantity <n>', 'override mint.quantity', (v) => Number.parseInt(v, 10))
  .option('-g, --gas <strategy>', 'override gas.strategy (normal|fast|aggressive|custom)')
  .option('--contract <address>', 'mint contract, for the direct SeaDrop path')
  .option('--local', 'force local calldata encoding instead of the OpenSea API')
  .action(async (options) => {
    process.exitCode = await startCommand(options.config, {
      quantity: options.quantity,
      gas: options.gas,
      contract: options.contract,
      local: options.local,
    });
  });

program
  .command('dry-run')
  .description('Validate config, wallet, network, drop and transaction construction — no broadcast')
  .requiredOption('-c, --config <path>', 'path to the YAML config')
  .option('-q, --quantity <n>', 'override mint.quantity', (v) => Number.parseInt(v, 10))
  .option('--contract <address>', 'mint contract, for the direct SeaDrop path')
  .option('--local', 'force local calldata encoding instead of the OpenSea API')
  .action(async (options) => {
    process.exitCode = await startCommand(options.config, {
      quantity: options.quantity,
      contract: options.contract,
      local: options.local,
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
