# NFT Mint Bot

Terminal-based bot for minting limited-supply EVM NFT drops. TypeScript + viem, no
browser automation: it builds the mint transaction, signs it locally, and submits it
straight to the chain.

## What actually wins a mint

The bot models two different worlds, because the strategy that wins in one loses in
the other:

| | `priority-auction` (Ethereum, Polygon) | `fcfs` (Robinhood, Arbitrum, Base) |
|---|---|---|
| Ordering by | effective priority fee | **arrival time at the sequencer** |
| Raising gas | buys priority | **buys nothing** |
| Multi-RPC broadcast | improves propagation | adds a hop; disabled automatically |
| Pre-signing | unsafe (fee goes stale) | **the single biggest win** |
| What to optimise | fee strategy | RTT to the sequencer |

Each chain declares `orderingModel` and `feeModel` in its config, and the registry
rejects a config that contradicts a known chain — a wrong `orderingModel` would have
the bot bidding for priority on a chain that ignores it.

### Measured on this machine

Against `sequencer.testnet.chain.robinhood.com`:

- cold connection: **633 ms** (203 ms TCP + 420 ms TLS handshake)
- warm connection: **199 ms**

Warming the connection before the mint window saves ~430 ms — more than any code-level
optimisation. `doctor` warms and measures it for you.

## Setup

Requires **Node 20+** (`.nvmrc` pins it; run `nvm use`). On an older node the CLI stops
with an explicit message rather than a stray `Object.hasOwn is not a function`.

```bash
nvm use
npm install
cp .env.example .env      # then fill in .env — NOT .env.example, which is tracked
```

Fill in the **copy**. `.env.example` is committed to git, so a real value placed there
is a leak; a pre-commit hook rejects it, but the habit is what matters.

`.env` needs `PRIVATE_KEY` (a dedicated hot wallet, minimally funded),
`OPENSEA_API_KEY`, and RPC URLs. Optionally `OPENSEA_BEARER_TOKEN` (an OAuth token with
the `read:eligibility` scope) to check eligibility without spending a mint attempt.

## Commands

There is no global `mint-bot` binary — run through npm. Note the `--` separating npm's
arguments from the bot's:

```bash
nvm use                                                    # Node 20+, reads .nvmrc

npm run doctor   -- --config config/robinhood-testnet.yaml # environment + RTT audit
npm run inspect  -- --config config/robinhood-testnet.yaml # what the Drops API knows
npm run payments -- --config config/robinhood.yaml         # tokens you can pay with
npm run dry-run -- --config config/robinhood-testnet.yaml  # build + simulate, no broadcast
npm run mint    -- --config config/robinhood.yaml --quantity 2
```

Run them in that order. `inspect` is the one that settles whether the OpenSea Drops API
covers your target at all — a 404 there means the collection mints through its own
contract, and you pass `--contract 0x...` to use the direct SeaDrop path instead.

The mint command is `mint`, not `start`, so that a bare `npm start` cannot fire a
real mint by accident.

## Paying with a token on another chain

By default the bot pays natively on the chain the NFT contract is deployed to. That is
one transaction, no swap and no bridge — always the fastest route, and what any
competitive mint should use. No configuration needed.

To spend a token you already hold elsewhere instead, opt in:

```yaml
mint:
  payment:
    mode: cross-chain
    chain: base                                          # OpenSea chain slug
    token: "0x0000000000000000000000000000000000000000"  # 0x0 = native token
```

**Those lines are the whole change.** The configs ship with an RPC for every payment
network, so switching `chain:` from `base` to `optimism` switches the RPC with it —
nothing else to edit:

```yaml
rpc:
  paymentEndpoints:
    ethereum:  ["${ETHEREUM_RPC:-https://ethereum.reth.rs/rpc}"]
    base:      ["${BASE_RPC:-https://mainnet.base.org}"]
    arbitrum:  ["${ARBITRUM_RPC:-https://arb1.arbitrum.io/rpc}"]
    optimism:  ["${OPTIMISM_RPC:-https://mainnet.optimism.io}"]
    polygon:   ["${POLYGON_RPC:-https://polygon.drpc.org}"]
```

Each falls back to a public endpoint when its env var is unset. For a private RPC, set
just that one variable in `.env` —
`BASE_RPC=https://base-mainnet.g.alchemy.com/v2/KEY`. Those URLs carry API keys, which
is why they belong in `.env` and not in the committed config. A chain left out of
`paymentEndpoints` entirely still works, falling back to its built-in default.

`doctor` names the endpoint in use and whether it came from your config or the built-in
default, so a shared public RPC is never a silent surprise.

Run `npm run payments` to list your balances across chains with their token addresses,
rather than guessing.

Two things worth knowing:

- **This chooses the token for the mint price, not for gas.** Gas is still the native
  token of the payment chain — pay with USDC on Base and you still need Base ETH.
- **It is slower.** OpenSea routes cross-chain mints through Relay: a swap, a bridge and
  a relay hop, adding seconds to minutes. The config refuses to combine it with
  `execution.mode: race` or `presign`, because those exist to save milliseconds and the
  two intentions contradict each other.

An ERC-20 payment yields two steps — `approve` then the bridge call — executed in order,
each awaiting its receipt. The `approve` is skipped when the on-chain allowance already
covers the amount, so a re-run after a failure does not pay for it twice.

Setting `chain` to the drop's own chain is the same thing as native payment; the bot
detects this and takes the direct path rather than failing against the relay endpoint,
which rejects it.

A confirmed receipt means the **payment** was accepted. The relay then delivers the mint
to the drop's chain, so the NFT arrives shortly after. The relay request id is logged for
tracking.

## Scheduling mints for later

Drops open at whatever hour suits their creator, not you. `schedule` keeps a list of
collections to mint at a future time and a daemon fires them unattended.

```bash
npm run schedule -- add <slug> --config config/robinhood.yaml --quantity 1
npm run schedule -- list   --config config/robinhood.yaml
npm run schedule -- edit   <id> --config config/robinhood.yaml --quantity 2
npm run schedule -- remove <id> --config config/robinhood.yaml
npm run schedule -- run    --config config/robinhood.yaml     # the daemon
```

**You never convert a timezone.** `add` reads the stage's start time from OpenSea, which
publishes it as UTC, and `list` shows every time in UTC *and* your local zone so a
misread is visible rather than latent:

```
ID      COLLECTION             QTY  STATUS    FIRES AT
5ed7a7  hood-penguins            2  pending   2026-12-01 09:00:00Z  (2026-12-01, 16:00 Asia/Saigon)  in 101d
```

Use `--at 2026-09-01T14:00:00Z` only for a drop with no published stage yet.

**`add` is where you authorise the spend.** It prints the price, quantity, total and
target, then asks for confirmation before writing the job — because the daemon that
fires it later will not ask. Each job stores a ceiling from that quote, so a repriced
stage or a gas spike fails the job closed instead of spending more than you agreed to.

The daemon **sleeps** while a job is distant and only wakes about two minutes before,
handing off to the stage poller that tightens to 200ms near the open. That split is
deliberate: polling OpenSea every 15 seconds for hours would exhaust the rate limit and
buy nothing.

For unattended operation on a server, see [deploy/README.md](deploy/README.md) — systemd
unit, hardening, and the plain risks of putting a funded key on a rented box.

## Execution modes

- `dry-run` — build and simulate, never broadcast.
- `preflight` — simulate before sending. The normal production mode.
- `race` — skip simulation, allow pre-signing. Only after a verified dry run.

## The pre-sign fast path

On an FCFS chain the fee needs no auction, so the whole transaction can be signed
before the stage opens. T0 then costs one `eth_sendRawTransaction`.

Enable with `execution.mode: race` and `execution.presign: true`. Before arming, the
bot encodes the SeaDrop `mintPublic` call locally **and requires OpenSea's API to
produce identical bytes** — `to`, `data`, and `value` must match exactly. If they
differ, or the API cannot be reached to cross-check, the fast path stays disarmed and
the run falls back to the normal path. Unverified calldata is never signed.

Armed transactions freeze nonce, gas, and quantity into the signature, so the bot
re-validates against fresh chain state before the window and discards anything stale.

## Restart safety

Every nonce lifecycle event is written to an fsync'd append-only journal
(`.journal/<chainId>-<address>.jsonl`) **before** the corresponding action. The
broadcast record hits disk before the transaction goes to the network, so a crash in
between leaves a recoverable record instead of an orphaned nonce.

On startup the bot replays the journal, queries each recorded hash for a receipt, and
reconciles against the chain's pending nonce — adopting a still-pending transaction
rather than re-sending it, and never reusing a nonce that already confirmed.

## Development

```bash
npm test          # 53 unit tests
npm run typecheck
npm run build
```

In a fresh clone, enable the secret-blocking pre-commit hook — it lives in
`.githooks/`, and git does not activate tracked hooks on its own:

```bash
git config core.hooksPath .githooks
```

## Security

- Dedicated hot wallet, funded with only what the mint needs.
- The key is read from an env var only — never a CLI argument (shell history), never a
  config file, never a log line. `pino` redaction is configured at construction.
- Chain ID is verified against the config before anything is signed; mismatch aborts.
- `gas.maxGasGwei` is a hard ceiling enforced under every strategy and fee model.
- The bot refuses to sign when the wallet cannot cover `value + max gas`.
- `.gitignore` excludes `.env` and key files; the `.githooks/pre-commit` hook is the
  backstop, rejecting a staged `.env`, a `*.key`/`*.pem`/`*.p12`, or any added line
  containing a 64-hex private key — including via `git add -f`, which `.gitignore`
  cannot catch.
