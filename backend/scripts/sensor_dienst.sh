#!/usr/bin/env bash
# © 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
#
# Den Strom künstlicher Sensordaten dauerhaft laufen lassen — als launchd-Agent.
# Er schickt alle fünf Minuten die Werte aller Raumsensoren (und, mit
# `--auch-geschosse`, der Geschoss- und Anlagensensoren) an das Backend,
# so wie eine echte GLT es täte.
#
#   backend/scripts/sensor_dienst.sh install    einrichten und starten
#   backend/scripts/sensor_dienst.sh status     läuft er, was ist zuletzt angekommen
#   backend/scripts/sensor_dienst.sh log        das Protokoll mitlesen
#   backend/scripts/sensor_dienst.sh remove     entfernen
#   backend/scripts/sensor_dienst.sh luecke     die Lücke seit dem letzten Wert nachfüllen (nach einem Ausfall)
#
# Echtzeit (`--raffer 1`) — 60 für „ein Tag in 24 Minuten" nur von Hand, mit
# `python3 scripts/sensor_demo.py --live --raffer 60 --post`: der Raffer
# schriebe sonst Werte aus der Zukunft in die Zeitreihe.

set -euo pipefail

NAME="com.philippschafer.ileen-sensoren"
PLIST="$HOME/Library/LaunchAgents/$NAME.plist"
LOG="$HOME/Library/Logs/ileen-sensoren.log"
BACKEND="$(cd "$(dirname "$0")/.." && pwd)"
ZIEL="gui/$(id -u)/$NAME"
URL="${ILEEN_BACKEND_URL:-http://localhost:8100}"
ARGS="--nur-raeume"
[ "${2:-}" = "--auch-geschosse" ] && ARGS="--raeume"

case "${1:-}" in
  install)
    PY="$(command -v python3)"
    mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$NAME</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string><string>$BACKEND/scripts/sensor_demo.py</string>
    <string>$ARGS</string><string>--live</string><string>--post</string><string>$URL</string>
  </array>
  <key>WorkingDirectory</key><string>$BACKEND</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PL
    launchctl bootout "$ZIEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Eingerichtet: $NAME ($ARGS → $URL). Protokoll: $LOG"
    ;;
  status)
    if launchctl print "$ZIEL" >/dev/null 2>&1; then echo "Dienst: läuft ($NAME)"; else echo "Dienst: nicht eingerichtet"; fi
    curl -s -m 5 "$URL/sensoren/zahlen" && echo || echo "Backend nicht erreichbar ($URL)"
    ;;
  log)
    tail -f "$LOG"
    ;;
  remove)
    launchctl bootout "$ZIEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Entfernt."
    ;;
  luecke)
    # Den letzten Tag (oder die Spanne aus dem dritten Argument) bis jetzt nachfüllen — idempotent.
    BIS="$(python3 -c "from datetime import datetime,timezone;n=datetime.now(timezone.utc);print(n.replace(minute=n.minute//5*5,second=0,microsecond=0).strftime('%Y-%m-%dT%H:%M:%SZ'))")"
    python3 "$BACKEND/scripts/sensor_demo.py" $ARGS --verlauf "${3:-1d}" --ende "$BIS" --post "$URL"
    ;;
  *)
    sed -n 4,16p "$0"
    ;;
esac
