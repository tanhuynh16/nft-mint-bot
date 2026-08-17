/*
 * Node version gate for npm scripts.
 *
 * `npm run <script>` executes under whatever node is currently active — npm does not
 * select a version for you. On Node 16 that means tsx fails to parse before any of our
 * own code runs, producing a wall of minified SyntaxError with no hint of the cause.
 * Wiring this as a `pre` script catches it first and says what to do instead.
 *
 * Written as ES5 CommonJS on purpose: it has to run on the old runtime it rejects.
 */
var REQUIRED_MAJOR = 20;
var major = parseInt(process.versions.node.split('.')[0], 10);

if (!isFinite(major) || major < REQUIRED_MAJOR) {
  process.stderr.write(
    '\n' +
      '  This bot requires Node ' +
      REQUIRED_MAJOR +
      '+, but npm is running on v' +
      process.versions.node +
      '.\n' +
      '\n' +
      '  A supported version is already installed. From this directory:\n' +
      '\n' +
      '      nvm use          # reads .nvmrc\n' +
      '      npm run doctor -- --config config/robinhood-testnet.yaml\n' +
      '\n',
  );
  process.exit(1);
}
