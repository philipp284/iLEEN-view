#!/usr/bin/env bash
# © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
#
# Meta Quest per USB an iLEEN hängen und die VR-Seite in der Brille öffnen.
#
#   frontend/tools/quest.sh              → Modellliste in der Brille
#   frontend/tools/quest.sh <job-id>     → gleich dieses Modell
#
# Was es tut: `adb reverse` für den Dev-Server (5181) und das Backend (8100).
# Danach ist `localhost` in der Brille der Mac. Das ist mehr als Bequemlichkeit:
# WebXR läuft nur in einem sicheren Kontext, und `http://localhost` ist einer,
# `http://192.168.…` nicht. Ohne Kabel bräuchte es dafür HTTPS mit Zertifikat.
#
# Einmalig vorher: Entwicklermodus in der Meta-Horizon-App (Headset →
# Headset-Einstellungen → Entwicklermodus), `brew install android-platform-tools`,
# Kabel stecken, in der Brille „USB-Debugging zulassen" bestätigen.
#
# Ports anders? ILEEN_PORT=5190 frontend/tools/quest.sh   (iLEEN-view)
#
# Ohne Entwicklermodus (Hochschulbrillen): tools/quest-wlan.sh — übers WLAN mit HTTPS.

set -euo pipefail

FRONT="${ILEEN_PORT:-5181}"
BACK="${ILEEN_BACKEND_PORT:-8100}"
JOB="${1:-}"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb fehlt:  brew install android-platform-tools"
  exit 1
fi

liste="$(adb devices | awk 'NR > 1 && NF >= 2')"
geraete="$(printf '%s\n' "$liste" | awk '$2 == "device" { print $1 }')"
if [ -z "$geraete" ]; then
  if printf '%s\n' "$liste" | grep -q unauthorized; then
    echo "Quest gefunden, aber USB-Debugging nicht bestätigt — in der Brille „Zulassen“ drücken und erneut starten."
  else
    echo "Keine Quest am Kabel. Entwicklermodus an? (Meta-Horizon-App → Headset-Einstellungen → Entwicklermodus)"
  fi
  exit 1
fi
if [ "$(printf '%s\n' "$geraete" | wc -l | tr -d ' ')" -gt 1 ]; then
  export ANDROID_SERIAL="$(printf '%s\n' "$geraete" | head -1)"
  echo "Mehrere Geräte — nehme $ANDROID_SERIAL (anderes: ANDROID_SERIAL=… setzen)"
fi

adb reverse "tcp:$FRONT" "tcp:$FRONT" >/dev/null
adb reverse "tcp:$BACK" "tcp:$BACK" >/dev/null
echo "Weitergeleitet: Brille localhost:$FRONT → Mac :$FRONT, localhost:$BACK → Mac :$BACK"

# Antwortet auf dem Port wirklich iLEEN? Mit strictPort startet ein zweiter
# Vite gar nicht erst, und ein fremdes Projekt gäbe trotzdem HTTP 200.
if ! curl -s -m 3 "http://localhost:$FRONT/vr.html" | grep -q '<title>iLEEN VR</title>'; then
  echo "Achtung: auf Port $FRONT antwortet keine iLEEN-VR-Seite — Dev-Server starten:  cd frontend && npx vite"
fi
if ! curl -s -m 3 -o /dev/null "http://localhost:$BACK/assets/"; then
  echo "Achtung: das Backend auf Port $BACK antwortet nicht."
fi

url="http://localhost:$FRONT/vr.html"
[ -n "$JOB" ] && url="$url?job=$JOB"
# Die Adresse für die Shell der Brille in Hochkommata, sonst trennt sie am '?'
if adb shell am start -a android.intent.action.VIEW -d "'$url'" com.oculus.browser >/dev/null 2>&1; then
  echo "In der Brille geöffnet: $url"
else
  echo "Bitte in der Brille im Browser öffnen: $url"
fi
