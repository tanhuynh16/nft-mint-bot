# Deploying the scheduler to a VPS

The point of running this on a server is that drops open while you are asleep. The
daemon holds the job list, wakes shortly before each one, and mints unattended.

## Read this first

**A funded hot wallet key will sit on a rented machine.** Contabo staff, anyone who
compromises the host, and anyone who obtains a disk snapshot can read it. Nothing in this
guide changes that — it only narrows the blast radius.

So: use a wallet dedicated to this bot, fund it with what the schedule needs and little
more, and treat the balance as spendable. Do not reuse a wallet that holds anything you
would mind losing.

## 1. Provision

Any Contabo VPS is ample — this is network-bound, not CPU-bound. Debian 12 or Ubuntu 22.04+.

```bash
ssh root@<your-vps>

apt update && apt upgrade -y
apt install -y git curl

# Node 22 (the bot refuses to start on anything older, with an explicit message)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v
```

**Set the clock to UTC and keep it synced.** The bot works in UTC internally; a drifted
clock means firing at the wrong moment, and on a first-come-first-served chain that is
the whole game.

```bash
timedatectl set-timezone UTC
timedatectl set-ntp true
timedatectl          # confirm "System clock synchronized: yes"
```

## 2. Install

```bash
adduser --system --group --home /opt/nft-mint-bot --shell /usr/sbin/nologin mintbot

git clone https://github.com/tanhuynh16/nft-mint-bot.git /opt/nft-mint-bot
cd /opt/nft-mint-bot
npm ci
npm run build

mkdir -p .journal .schedule
chown -R mintbot:mintbot /opt/nft-mint-bot
```

`mintbot` is a system account with no login shell: if the bot is compromised, the
attacker lands as a user who cannot log in.

## 3. Secrets

```bash
mkdir -p /etc/nft-mint-bot
cat > /etc/nft-mint-bot/env <<'EOF'
PRIVATE_KEY=0x...
OPENSEA_API_KEY=...
RPC_PRIMARY=https://rpc.mainnet.chain.robinhood.com
SEQUENCER_URL=https://sequencer.mainnet.chain.robinhood.com
EOF

chown mintbot:mintbot /etc/nft-mint-bot/env
chmod 600 /etc/nft-mint-bot/env
```

Owned by the service user and `600`. systemd reads it as root while starting the unit,
and `mintbot` can read it when you run CLI commands as that user — which you need, since
`schedule add` and `doctor` do not run under systemd. Root-only ownership buys nothing
here (the process already holds the key in memory) and breaks every manual command.

Keep it out of `/opt/nft-mint-bot` so it can never be caught by a `git add`.

The bot finds this file on its own: it looks for `--env-file`, then `$MINT_BOT_ENV_FILE`,
then `./.env`, then `/etc/nft-mint-bot/env`. Nothing extra to pass.

## 4. Start

```bash
cp /opt/nft-mint-bot/deploy/nft-mint-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now nft-mint-bot
```

**Check that it actually stayed up.** A service can start, crash, and be restarted
forever without anything obvious being wrong:

```bash
systemctl status nft-mint-bot
#   want: "active (running)"
#   bad:  a "restart counter is at N" that climbs each time you look — that is a
#         crash loop, and no job will ever fire

journalctl -u nft-mint-bot -n 30
#   want: "scheduler started"
#   bad:  a V8 native stack trace — a systemd hardening directive is blocking the
#         JIT. See the MemoryDenyWriteExecute note in the unit file.
```

Wait a minute and run `systemctl status` again. If the counter has not moved, it is up.

Note for anyone tightening the unit later: **hardening must be tested against a JIT
runtime.** `MemoryDenyWriteExecute=true` looks like an obvious win and makes node abort
on startup every time.

Logs are structured JSON in the journal. The logger redacts key material by
construction, so these are safe to read and paste:

```bash
journalctl -u nft-mint-bot -f
journalctl -u nft-mint-bot --since "1 hour ago" | grep -i 'scheduled mint'
```

## 5. Managing the queue

Queue changes run as the service user so file ownership stays correct. The daemon
re-reads the file on each decision, so there is no need to restart it:

```bash
cd /opt/nft-mint-bot

sudo -u mintbot node dist/cli/index.js schedule add <slug> \
  --config config/robinhood.yaml --quantity 1

sudo -u mintbot node dist/cli/index.js schedule list   --config config/robinhood.yaml
sudo -u mintbot node dist/cli/index.js schedule edit   <id> --config config/robinhood.yaml --quantity 2
sudo -u mintbot node dist/cli/index.js schedule remove <id> --config config/robinhood.yaml
```

`add` prints the cost and the fire time in UTC **and** your local zone, then asks for
confirmation. That prompt is the authorisation for everything the daemon later does
unattended — read the numbers before answering. `--yes` skips it for scripting.

You do not convert timezones: `add` reads the stage time from OpenSea. Use
`--at 2026-09-01T14:00:00Z` only for a drop OpenSea has not listed a stage for yet.

### Which stage a job targets

Most drops have several stages — a team presale, one or two allowlist rounds, then the
public sale. `add` targets the **public sale** by default, because that is the one any
wallet can use. Following the earliest stage instead would aim the job at a presale,
have it rejected, and let the public mint pass while you slept.

```bash
# default: the public sale
schedule add the-doll-club-nfts --config config/robinhood.yaml --quantity 1

# deliberately aim at a presale you are allowlisted for
schedule add the-doll-club-nfts --config config/robinhood.yaml --stage GTD
```

`add` warns when the chosen stage gates on an allowlist. If such a stage does reject the
wallet at fire time, the job advances to the next stage rather than failing — so one job
can try GTD, then FCFS, then PUBLIC. It will not advance into a stage that costs more
than the ceiling you authorised.

## 6. Verify before trusting it

```bash
sudo -u mintbot node dist/cli/index.js doctor --config config/robinhood.yaml
```

Then rehearse the full path with a cheap collection — schedule one a few minutes out,
watch it fire, and confirm the token arrived **on-chain** rather than believing the log:

```bash
journalctl -u nft-mint-bot -f
# after it fires, check balanceOf for the collection contract
```

Restart safety is worth testing once, deliberately: `systemctl stop` while a job is
waiting, then `start`. The job should come back as `pending`, not vanish and not
double-fire.

## Upgrading

```bash
cd /opt/nft-mint-bot
sudo ./deploy/upgrade.sh
```

The script pulls, installs, builds, restarts, and then **verifies the service is still
running twenty seconds later** — printing the last journal lines and exiting non-zero if
not. That last step is why it exists: a restart looks successful even when the service is
crash-looping behind it, which is exactly how a fatal misconfiguration once ran unnoticed
for nine hours and cost a scheduled drop.

Every step that writes into the install runs as `mintbot`. Running them as root does not
work and should not be forced to: the repo is owned by the service user, so git refuses
with *"detected dubious ownership"*, and an npm build as root would leave root-owned
`node_modules/` and `dist/` inside a tree `mintbot` owns — which breaks later rather than
immediately.

Adding `safe.directory` to silence that git error is the wrong fix for the same reason.

If you prefer to do it by hand, the equivalent is:

```bash
sudo -u mintbot -H git pull --ff-only
sudo -u mintbot -H npm ci
sudo -u mintbot -H npm run build
sudo systemctl reset-failed nft-mint-bot
sudo systemctl restart nft-mint-bot
systemctl status nft-mint-bot        # then check it again a minute later
```

If an earlier root-run build already left root-owned files, repair once with:

```bash
sudo chown -R mintbot:mintbot /opt/nft-mint-bot
```

## Operating notes

- **Funding.** The bot stops at its affordability guard rather than sending a doomed
  transaction, so an underfunded wallet means a silently missed drop. Check the balance
  against what `schedule list` says is queued.
- **Upgrades.** `sudo ./deploy/upgrade.sh`. The schedule and journal survive; they live
  outside the build. See below for why it is a script.
- **A job left `running`** after a crash is marked failed and *not* re-fired. That is
  deliberate: the transaction may already have been broadcast. Check `.journal/` and the
  chain, then reschedule if it genuinely never landed.
- **Backups.** `.schedule/jobs.json` is the queue. `.journal/` is how an interrupted
  broadcast gets reconciled. Neither contains secrets; both are worth keeping.
