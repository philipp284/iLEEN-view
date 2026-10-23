#!/usr/bin/env bash
# © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
#
# iLEEN und die VR-Ansicht für die Brille übers WLAN — ohne Entwicklermodus.
#
#   frontend/tools/quest-wlan.sh         → läuft im Vordergrund bis Strg+C
#   frontend/tools/quest-dienst.sh install → läuft dauerhaft im Hintergrund
#
# Für Brillen, die man nicht in den Entwicklermodus schalten kann oder darf
# (Hochschulgeräte unter einem gemeinsamen Meta-Konto). Der Quest-Browser
# braucht für WebXR nur einen sicheren Kontext, und den gibt HTTPS.
#
# Was läuft: ein zweiter Vite (tools/vite-quest.config.js, https, nur intern auf
# 5444) mit iLEEN und der VR-Seite, davor eine Weiche (tools/quest-weiche.mjs)
# auf 5443, die auch ein getipptes `http://` auf https umleitet. Der normale
# Dev-Server auf 5181 bleibt unberührt. Dazu das Relais für „Gemeinsam"
# (tools/vr-raum.mjs, nur intern auf 5446): mehrere Brillen im selben Modell;
# Vite reicht wss://…:5443/vr-raum dorthin durch.
#
# Netzwechsel: Das Zertifikat nennt alle Adressen, unter denen der Mac je
# erreichbar war (~/.ileen/quest-tls/). Kommt eine neue dazu, wird es erweitert
# und Vite neu gestartet — in bekannten Netzen bleibt es unverändert, die Brille
# warnt dort nicht erneut. In der Quest: https://<Adresse>:5443 öffnen, die
# Warnung einmal über „Erweitert → Weiter zu …" bestätigen.
#
# Apple-Geräte (Vision Pro, iPad, iPhone): Safari nimmt keine Warnung hin, die
# Zertifizierungsstelle des Macs muss als Profil drauf (quest-zertifikat.sh).
# Einmal http://<Adresse>:5443/einrichten öffnen — die Weiche liefert die
# Anleitung und das Profil. Danach gilt jede Adresse ohne Warnung.
#
# Fest ist der Port (5443), nicht die Adresse: die vergibt jedes Netz neu. Damit
# man sie nicht im Terminal suchen muss, schreibt der Aufseher den Stand nach
# $TLS/stand.json; die Weiche gibt ihn unter http://localhost:5443/ileen-quest.json
# heraus, und die VR-Ebene in iLEEN zeigt ihn beim Klick auf 🥽 am Mac an
# (vr.js → verbindenZeigen). Dazu ein fester Name, ileen.local, per Bonjour auf
# die Hauptadresse gelegt — ob der Quest-Browser .local auflöst, ist unbelegt.
#
# Mac und Brille müssen im selben Netz sein, und das Netz muss Geräte einander
# erreichen lassen. Gast-WLANs und eduroam trennen sie oft — dann Handy-Hotspot,
# oder den Mac zusätzlich ins WLAN der Brille (die neue Adresse kommt von selbst).

set -uo pipefail

cd "$(dirname "$0")/.."
PORT="${ILEEN_QUEST_PORT:-5443}"
INNEN="${ILEEN_QUEST_INNEN:-5444}"
TLS="${ILEEN_QUEST_TLS:-$HOME/.ileen/quest-tls}"
BACKEND="${ILEEN_BACKEND:-http://localhost:8100}"
RAUM_PORT="${ILEEN_VR_RAUM_PORT:-5446}"
export ILEEN_QUEST_PORT="$PORT" ILEEN_QUEST_INNEN="$INNEN" ILEEN_QUEST_TLS="$TLS" ILEEN_BACKEND="$BACKEND" ILEEN_VR_RAUM_PORT="$RAUM_PORT"

name="$(scutil --get LocalHostName 2>/dev/null || hostname -s).local"
FEST="${ILEEN_QUEST_NAME:-ileen}.local"
mkdir -p "$TLS"

# Adressen, unter denen die Brille den Mac erreichen kann: keine Loopback-
# (auch nicht 127.x-Aliase wie 127.51.68.120) und keine Link-Local-Adressen.
adressen() { ifconfig | awk '/inet / && $2 !~ /^127\./ && $2 !~ /^169\.254\./ { print $2 }' | sort -u; }
# „Schnittstelle Adresse" je Zeile, für den Stand
adressen_mit_schnittstelle() {
  ifconfig | awk '/^[a-z0-9]+:/ { s = $1; sub(":", "", s) } /inet / && $2 !~ /^127\./ && $2 !~ /^169\.254\./ { print s, $2 }'
}
# Die Adresse der Schnittstelle mit der Standardroute — die, über die der Mac
# im aktuellen Netz hängt. Ist das ein VPN (utun), die erste en-Schnittstelle.
hauptadresse() {
  local s ip
  s="$(route -n get default 2>/dev/null | awk '/interface:/ { print $2 }')"
  case "$s" in en*|bridge*) ip="$(ipconfig getifaddr "$s" 2>/dev/null)" ;; esac
  [ -n "${ip:-}" ] || ip="$(adressen_mit_schnittstelle | awk '$1 ~ /^en/ { print $2; exit }')"
  echo "${ip:-}"
}

# Zertifikat: eigene Zertifizierungsstelle + Serverzertifikat mit allen je
# gesehenen privaten Adressen (zertifikat() gibt 0 zurück, wenn neu ausgestellt).
# Warum zwei und nicht eines: siehe den Kopf von quest-zertifikat.sh.
# shellcheck source=quest-zertifikat.sh
source "$(dirname "${BASH_SOURCE[0]}")/quest-zertifikat.sh"

for p in "$PORT" "$INNEN" "$RAUM_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $p ist belegt — läuft quest-wlan.sh schon (oder der Dienst)? Sonst ILEEN_QUEST_PORT / ILEEN_QUEST_INNEN / ILEEN_VR_RAUM_PORT setzen."
    exit 1
  fi
done

zertifikat || true
VITE=""; WEICHE=""; BONJOUR=""; RAUM=""
starte_vite() {
  [ -n "$VITE" ] && kill "$VITE" 2>/dev/null && wait "$VITE" 2>/dev/null
  npx vite --config tools/vite-quest.config.js --clearScreen false &
  VITE=$!
}
# ileen.local → Hauptadresse, per Bonjour (dns-sd -P meldet Dienst und Namen
# an, solange es läuft). Bei jedem Netzwechsel neu.
fest_melden() {
  [ -n "$BONJOUR" ] && kill "$BONJOUR" 2>/dev/null
  BONJOUR=""
  local ip; ip="$(hauptadresse)"
  [ -n "$ip" ] || return 0
  dns-sd -P "iLEEN VR" _https._tcp local "$PORT" "$FEST" "$ip" "path=/" >/dev/null 2>&1 &
  BONJOUR=$!
}
# Der Stand für die VR-Ebene in iLEEN (über die Weiche: /ileen-quest.json)
stand() {
  local haupt; haupt="$(hauptadresse)"
  {
    printf '{"port":%s,"haupt":"%s","fest":"%s","name":"%s","zeit":"%s","ca":"%s","adressen":[' \
      "$PORT" "$haupt" "$FEST" "$name" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(ca_fingerabdruck)"
    adressen_mit_schnittstelle | awk 'BEGIN { n = 0 } { if (n++) printf ","; printf "{\"schnittstelle\":\"%s\",\"ip\":\"%s\"}", $1, $2 }'
    printf ']}\n'
  } > "$TLS/stand.json.neu" && mv "$TLS/stand.json.neu" "$TLS/stand.json"
}
aufraeumen() { kill $VITE $WEICHE $BONJOUR $RAUM 2>/dev/null; rm -f "$TLS/stand.json"; exit 0; }
trap aufraeumen EXIT INT TERM

starte_vite
node tools/quest-weiche.mjs &
WEICHE=$!
# Eigener Prozess, nicht in Vite: ein Neustart von Vite (neues Zertifikat)
# soll die Brillen im Raum nicht trennen und die Gruppe nicht vergessen.
node tools/vr-raum.mjs &
RAUM=$!

zeige() {
  local haupt; haupt="$(hauptadresse)"
  stand
  fest_melden
  echo
  echo "  In der Brille öffnen (iLEEN, dort der Schalter 🥽 VR):"
  [ -n "$haupt" ] && echo "      https://$haupt:$PORT      ← dieses Netz"
  for ip in $(adressen); do [ "$ip" = "$haupt" ] || echo "      https://$ip:$PORT"; done
  echo "      https://$FEST:$PORT      (fester Name, wenn die Brille .local auflöst)"
  echo "      https://$name:$PORT"
  echo "  Nur die VR-Ansicht:  …/vr.html"
  echo "  Quest: auch ohne „https://“ getippt geht es. Warnung → Erweitert → Weiter zu …"
  [ -n "$haupt" ] && echo "  Vision Pro, iPad, iPhone: einmal http://$haupt:$PORT/einrichten öffnen — Profil laden und vertrauen."
  echo
}
zeige
curl -s -m 3 -o /dev/null "$BACKEND/assets/" || echo "Achtung: das Backend unter $BACKEND antwortet nicht — die Modellliste bleibt leer."

# Aufseher: neue Adresse → Zertifikat erweitern, Vite neu starten. Einmal je
# Stunde auch ohne Netzwechsel: das Serverzertifikat läuft nach 397 Tagen ab.
bekannt="$(adressen | tr '\n' ' ')"
runden=0
while kill -0 "$VITE" 2>/dev/null && kill -0 "$WEICHE" 2>/dev/null && kill -0 "$RAUM" 2>/dev/null; do
  sleep 10
  runden=$((runden + 1))
  jetzt="$(adressen | tr '\n' ' ')"
  if [ "$jetzt" != "$bekannt" ]; then
    bekannt="$jetzt"
    if zertifikat; then starte_vite; echo "(Neues Netz — die Quest warnt für die neue Adresse einmal; Geräte mit Profil nicht.)"; fi
    zeige
  elif [ $((runden % 360)) = 0 ] && zertifikat; then
    starte_vite
  fi
done
echo "Ein Teil ist beendet — Aufseher endet."
exit 1
