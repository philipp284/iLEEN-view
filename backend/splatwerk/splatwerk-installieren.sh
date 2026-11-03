#!/bin/bash
# Richtet den Splatwerk-Worker als launchd-Agent ein (startet beim Anmelden, wird neu gestartet,
# wenn er abstürzt) — oder entfernt ihn wieder.
#
#   splatwerk/splatwerk-installieren.sh            einrichten und starten
#   splatwerk/splatwerk-installieren.sh entfernen  stoppen und Agent löschen
#   splatwerk/splatwerk-installieren.sh status     läuft er?
#
# Der Agent liegt in ~/Library/LaunchAgents/com.philippschafer.splatwerk.plist, das Protokoll in
# backend/data/training/worker.log. Neu starten nach einer Änderung am Worker:
#   launchctl kickstart -k gui/$(id -u)/com.philippschafer.splatwerk
set -euo pipefail

LABEL="com.philippschafer.splatwerk"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(dirname "$HIER")"
LOG="$BACKEND/data/training/worker.log"
PYTHON="$(command -v python3)"
DOMAIN="gui/$(id -u)"

case "${1:-einrichten}" in
  entfernen)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Agent entfernt."
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state|pid|last exit" || echo "Agent nicht geladen."
    ;;
  einrichten)
    mkdir -p "$BACKEND/data/training/eingang" "$(dirname "$PLIST")"
    # Die Python-Pakete (numpy, Pillow, pillow-heif, plyfile) kommen aus der Python, die jetzt
    # `python3` ist; launchd kennt deinen Shell-PATH nicht, deshalb steht der Pfad fest im Agenten.
    "$PYTHON" - <<'PY' || { echo "Es fehlen Python-Pakete (siehe splatwerk/requirements-worker.txt)." >&2; exit 1; }
import numpy, PIL, pillow_heif  # noqa
PY
    cat > "$PLIST" <<PLISTEND
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON</string>
        <string>-u</string>
        <string>$HIER/worker.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$BACKEND</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>ILEEN_TRAINING_DIR</key>
        <string>$BACKEND/data/training</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>15</integer>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
</dict>
</plist>
PLISTEND
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Agent eingerichtet und gestartet."
    echo "  Eingangsordner : $BACKEND/data/training/eingang   (Fotos, Videos oder ZIP hineinlegen)"
    echo "  Protokoll      : $LOG"
    ;;
  *)
    echo "Aufruf: $0 [einrichten|entfernen|status]" >&2
    exit 2
    ;;
esac
