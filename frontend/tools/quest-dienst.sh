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
#   frontend/tools/quest-dienst.sh wlan       Einstellung fürs eigene WLAN öffnen (feste Adresse 192.168.2.1)
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
    FEST_IP="${ILEEN_QUEST_FEST_IP:-192.168.2.1}"
    HOTSPOT_IP="${ILEEN_QUEST_HOTSPOT_IP:-172.20.10.14}"
    if ifconfig | grep -q "inet $HOTSPOT_IP "; then
      echo "Feste Adresse: an (iPhone-WLAN) — https://$HOTSPOT_IP:5443"
    elif ifconfig | awk -v ip="$FEST_IP" '/^[a-z0-9]+:/ { s = $1 } /inet / && $2 == ip && s ~ /^bridge/ { f = 1 } END { exit !f }'; then
      echo "Feste Adresse: an (WLAN des Macs) — https://$FEST_IP:5443"
    else
      echo "Feste Adresse: aus — iPhone-Hotspot an, Mac und Brille in sein WLAN → https://$HOTSPOT_IP:5443"
      [ -f /Library/LaunchDaemons/de.ileen.quest-festip.plist ] || echo "  (einmal einrichten: $(dirname "$0")/quest-festip.sh install)"
    fi
    for ip in $(ifconfig | awk '/inet / && $2 !~ /^127\./ && $2 !~ /^169\.254\./ { print $2 }'); do echo "  https://$ip:5443"; done
    [ -f "$HOME/.ileen/quest-tls/stand.json" ] && echo "Stand: $(cat "$HOME/.ileen/quest-tls/stand.json")"
    ;;
  wlan)
    # Die Internetfreigabe braucht Administratorrechte und lässt sich nur dort einschalten
    open "x-apple.systempreferences:com.apple.Sharing-Settings.extension"
    cat <<'TXT'
Eigenes WLAN des Macs (feste Adresse 192.168.2.1):
  1. Den Mac per Kabel (USB-Ethernet) oder iPhone (USB) ans Internet — das WLAN-Modul wird zum Sender.
  2. Freigaben → Internetfreigabe → ⓘ:
       Verbindung teilen über: das Kabel (z. B. „USB 10/100/1000 LAN") bzw. „iPhone USB"
       An Geräte über: WLAN  → WLAN-Optionen: Name „iLEEN", Sicherheit WPA2/WPA3, Passwort
  3. Internetfreigabe einschalten.
  4. Brille ins WLAN „iLEEN", dann https://192.168.2.1:5443 (Vision Pro: einmal http://192.168.2.1:5443/einrichten).
TXT
    ;;
  log)
    tail -f "$LOG"
    ;;
  *)
    echo "Aufruf: $0 install | remove | status | log | wlan"
    exit 2
    ;;
esac
