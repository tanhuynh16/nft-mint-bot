/**
 * Node version gate.
 *
 * Must be the FIRST import in the CLI entry point. ES modules evaluate in the order
 * their import declarations appear, so this runs before viem is loaded — which matters
 * because viem calls Object.hasOwn during module evaluation and dies on Node 16 with
 * "Object.hasOwn is not a function", an error that tells the operator nothing about
 * what is actually wrong or how to fix it.
 *
 * Deliberately uses no modern syntax or dependency of its own, so it can run on the old
 * runtime it exists to reject.
 */
const REQUIRED_MAJOR = 20;

const major = Number(process.versions.node.split('.')[0]);

if (!Number.isFinite(major) || major < REQUIRED_MAJOR) {
  process.stderr.write(
    '\n' +
      `  This bot requires Node ${REQUIRED_MAJOR}+, but is running on v${process.versions.node}.\n` +
      '\n' +
      '  A newer version is already installed via nvm. From this directory:\n' +
      '\n' +
      '      nvm use\n' +
      '\n' +
      '  Or invoke through npm, which selects the right runtime for you:\n' +
      '\n' +
      '      npm run doctor -- --config config/robinhood-testnet.yaml\n' +
      '\n',
  );
  process.exit(1);
}

export {};
