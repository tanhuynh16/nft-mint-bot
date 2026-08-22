#!/usr/bin/env bash
#
# Upgrade a deployed nft-mint-bot and prove it came back up.
#
# Run as root:  sudo ./deploy/upgrade.sh
#
# Everything that writes into the install runs as the service user. The repo is owned by
# mintbot, so git refuses to operate on it as root ("dubious ownership"), and an npm
# build as root would leave root-owned node_modules/ and dist/ inside a tree the service
# user owns — which fails later rather than now, the worst kind of failure.
#
# The health check at the end is the point: a restart looks successful even when the
# service crash-loops behind it, which is exactly how a fatal misconfiguration once ran
# unnoticed for nine hours and cost a scheduled drop.

set -euo pipefail

SERVICE="${SERVICE:-nft-mint-bot}"
INSTALL_DIR="${INSTALL_DIR:-/opt/nft-mint-bot}"
RUN_USER="${RUN_USER:-mintbot}"

die() { printf '\n  %s\n\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

# --- Preconditions: fail before touching anything, not halfway through -------------

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo $0"

id -u "$RUN_USER" >/dev/null 2>&1 || die "No such user: $RUN_USER"
[ -d "$INSTALL_DIR/.git" ] || die "Not a git checkout: $INSTALL_DIR"
command -v systemctl >/dev/null 2>&1 || die "systemctl not found; this script targets systemd"

systemctl list-unit-files "$SERVICE.service" >/dev/null 2>&1 \
  || die "Unit $SERVICE.service is not installed"

cd "$INSTALL_DIR"

# Refuse to clobber uncommitted edits made on the server.
if ! sudo -u "$RUN_USER" -H git diff --quiet || ! sudo -u "$RUN_USER" -H git diff --cached --quiet; then
  die "Uncommitted changes in $INSTALL_DIR. Commit, stash or discard them first."
fi

# --- Upgrade, entirely as the owner -------------------------------------------------

step "Pulling as $RUN_USER"
sudo -u "$RUN_USER" -H git pull --ff-only

step "Installing dependencies"
sudo -u "$RUN_USER" -H npm ci

step "Building"
sudo -u "$RUN_USER" -H npm run build

[ -f "$INSTALL_DIR/dist/cli/index.js" ] || die "Build produced no dist/cli/index.js"

# --- Restart -------------------------------------------------------------------------

step "Restarting $SERVICE"
# Clears any accumulated failures so StartLimitBurst does not block the start.
systemctl reset-failed "$SERVICE" 2>/dev/null || true
systemctl restart "$SERVICE"

# --- Prove it stayed up --------------------------------------------------------------
#
# A crash loop restarts fast enough to look healthy for an instant. Sample twice, far
# enough apart to catch a service that is dying and being restarted.

step "Verifying"
sleep 5
before=$(systemctl show -p NRestarts --value "$SERVICE" 2>/dev/null || echo 0)
sleep 10
after=$(systemctl show -p NRestarts --value "$SERVICE" 2>/dev/null || echo 0)

if ! systemctl is-active --quiet "$SERVICE"; then
  printf '\n  %s is not running. Last log lines:\n\n' "$SERVICE" >&2
  journalctl -u "$SERVICE" -n 30 --no-pager >&2
  die "Upgrade failed: service is not active."
fi

if [ "$after" -gt "$before" ]; then
  printf '\n  %s is crash-looping (restarts %s -> %s). Last log lines:\n\n' \
    "$SERVICE" "$before" "$after" >&2
  journalctl -u "$SERVICE" -n 30 --no-pager >&2
  die "Upgrade failed: service restarted during the check. A V8 stack trace above means a systemd hardening directive is blocking the JIT."
fi

printf '\n  %s is active and stable (restarts: %s).\n' "$SERVICE" "$after"
printf '  Queue:\n\n'
sudo -u "$RUN_USER" -H node dist/cli/index.js schedule list \
  --config config/robinhood.yaml 2>/dev/null || true
printf '\n'
