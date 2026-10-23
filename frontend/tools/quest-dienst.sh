#!/usr/bin/env bash
# © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
#
# Den HTTPS-Server für die Brille dauerhaft laufen lassen — als launchd-Agent,
# startet beim Anmelden am Mac von selbst und wieder, wenn er beendet wird.
#
#   frontend/tools/quest-dienst.sh install    einrichten und starten
#   frontend/tools/quest-dienst.sh status     läuft er, unter welchen Adressen
#   frontend/tools/quest-dienst.sh log        das Protokoll mitlesen
#   frontend/tools/quest-dienst.sh remove     entfernen
#
# Er tut dasselbe wie quest-wlan.sh (dort steht, was) und passt sich Netzwechseln
# an. Solange er läuft, ist iLEEN samt VR-Ansicht für jeden im selben Netz unter
# https://<Mac>:5443 erreichbar — wer das nicht will, `remove` oder in fremden
# Netzen abschalten.

set -euo pipefail

NAME="com.philippschafer.ileen-quest"
PLIST="$HOME/Library/LaunchAgents/$NAME.plist"
LOG="$HOME/Library/Logs/ileen-quest.log"
FRONT="$(cd "$(dirname "$0")/.." && pwd)"
ZIEL="gui/$(id -u)/$NAME"

case "${1:-}" in
  install)
    NODE_BIN="$(dirname "$(command -v node)")"
    mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$NAME</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$FRONT/tools/quest-wlan.sh</string></array>
  <key>WorkingDirectory</key><string>$FRONT</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PL
    launchctl bootout "$ZIEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Eingerichtet: $PLIST"
    sleep 6
    tail -12 "$LOG" 2>/dev/null || true
    ;;
  remove)
    launchctl bootout "$ZIEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Entfernt. (Zertifikate liegen weiter in ~/.ileen/quest-tls/)"
    ;;
  status)
    if launchctl print "$ZIEL" >/dev/null 2>&1; then echo "Dienst: eingerichtet"; else echo "Dienst: nicht eingerichtet"; fi
    for p in 5443 5444; do
      if lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $p: läuft"; else echo "Port $p: aus"; fi
    done
    for ip in $(ifconfig | awk '/inet / && $2 !~ /^127\./ && $2 !~ /^169\.254\./ { print $2 }'); do echo "  https://$ip:5443"; done
    [ -f "$HOME/.ileen/quest-tls/stand.json" ] && echo "Stand: $(cat "$HOME/.ileen/quest-tls/stand.json")"
    ;;
  log)
    tail -f "$LOG"
    ;;
  *)
    echo "Aufruf: $0 install | remove | status | log"
    exit 2
    ;;
esac
