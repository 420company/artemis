#!/usr/bin/env bash
# Phosphene — Dream Daemon Installer
#
# Sets up the dream daemon to run automatically:
#   macOS: every hour via launchd (more reliable than cron)
#   Linux: every hour via crontab
#
# Usage:
#   chmod +x scripts/install-cron.sh
#   ./scripts/install-cron.sh
#
# Uninstall:
#   macOS: launchctl unload ~/Library/LaunchAgents/ai.phosphene.dream.plist
#   Linux: crontab -e  → remove the phosphene line

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON="$SCRIPT_DIR/dream-daemon.js"
NODE_BIN="$(which node 2>/dev/null || echo '')"

if [[ -z "$NODE_BIN" ]]; then
  echo "✗ Node.js not found. Install Node 18+ first."
  exit 1
fi

NODE_VERSION=$("$NODE_BIN" --version | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 18 ]]; then
  echo "✗ Node.js 18+ required (found v$NODE_VERSION). Upgrade Node first."
  exit 1
fi

if [[ ! -f "$DAEMON" ]]; then
  echo "✗ dream-daemon.js not found at $DAEMON"
  exit 1
fi

chmod +x "$DAEMON"

echo "Phosphene Dream Daemon — Install"
echo "  Node:   $NODE_BIN (v$NODE_VERSION)"
echo "  Daemon: $DAEMON"
echo ""

# ── macOS: launchd ──────────────────────────────────────────────────────────
if [[ "$(uname)" == "Darwin" ]]; then
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST_FILE="$PLIST_DIR/ai.phosphene.dream.plist"
  LOG_DIR="$HOME/.phosphene/logs"

  mkdir -p "$PLIST_DIR" "$LOG_DIR"

  cat > "$PLIST_FILE" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.phosphene.dream</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DAEMON</string>
  </array>

  <!-- Run every hour (3600 seconds) -->
  <key>StartInterval</key>
  <integer>3600</integer>

  <!-- Also run at login -->
  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/dream-daemon.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/dream-daemon.err</string>

  <!-- Retry if it fails -->
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
PLIST

  # Unload existing if running
  launchctl unload "$PLIST_FILE" 2>/dev/null || true
  launchctl load   "$PLIST_FILE"

  echo "✓ launchd job installed: ai.phosphene.dream"
  echo "  Runs every hour (also on login)"
  echo "  Logs: $LOG_DIR/dream-daemon.log"
  echo ""
  echo "  To check status:  launchctl list | grep phosphene"
  echo "  To force a dream: node $DAEMON --force"
  echo "  To uninstall:     launchctl unload $PLIST_FILE && rm $PLIST_FILE"

# ── Linux: crontab ──────────────────────────────────────────────────────────
else
  LOG_DIR="$HOME/.phosphene/logs"
  mkdir -p "$LOG_DIR"

  CRON_LINE="0 * * * * $NODE_BIN $DAEMON >> $LOG_DIR/dream-daemon.log 2>&1"

  # Check if already installed
  if crontab -l 2>/dev/null | grep -q "phosphene/scripts/dream-daemon"; then
    echo "  (removing existing phosphene cron entry)"
    crontab -l 2>/dev/null | grep -v "phosphene/scripts/dream-daemon" | crontab -
  fi

  # Add new entry
  (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -

  echo "✓ crontab entry installed (every hour)"
  echo "  Logs: $LOG_DIR/dream-daemon.log"
  echo ""
  echo "  To check: crontab -l | grep phosphene"
  echo "  To force: node $DAEMON --force"
  echo "  To remove: crontab -e  →  delete the phosphene line"
fi

echo ""
echo "Run now to test (dry run — checks conditions without forcing):"
echo "  node $DAEMON --status"
echo ""
echo "Force a dream immediately:"
echo "  node $DAEMON --force"
