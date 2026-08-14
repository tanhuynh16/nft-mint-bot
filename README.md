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

Requires **Node 20+**.

```bash
npm install
cp .env.example .env      # then fill it in — .env is gitignored
```

`.env` needs `PRIVATE_KEY` (a dedicated hot wallet, minimally funded),
`OPENSEA_API_KEY`, and RPC URLs. Optionally `OPENSEA_BEARER_TOKEN` (an OAuth token with
the `read:eligibility` scope) to check eligibility without spending a mint attempt.

## Commands

```bash
mint-bot doctor  --config config/robinhood-testnet.yaml   # environment + RTT audit
mint-bot inspect --config config/robinhood-testnet.yaml   # what the Drops API knows
mint-bot dry-run --config config/robinhood-testnet.yaml   # build + simulate, no broadcast
mint-bot start   --config config/robinhood.yaml --quantity 2
```

Run them in that order. `inspect` is the one that settles whether the OpenSea Drops API
covers your target at all — a 404 there means the collection mints through its own
contract, and you pass `--contract 0x...` to use the direct SeaDrop path instead.

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
