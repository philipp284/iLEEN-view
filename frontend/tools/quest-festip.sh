#!/usr/bin/env bash
# © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
#
# Feste Adresse des Macs im iPhone-WLAN (Persönlicher Hotspot): 172.20.10.14.
#
#   frontend/tools/quest-festip.sh install   einrichten (macOS fragt einmal nach dem Passwort)
#   frontend/tools/quest-festip.sh status    läuft er, hat der Mac die Adresse
#   frontend/tools/quest-festip.sh remove    entfernen (fragt wieder nach dem Passwort)
#
# Warum: Die Brille braucht eine Adresse, die man nicht jedes Mal nachsehen
# muss. Im Hochschul-WLAN wechselt die des Macs mehrmals am Tag, und eduroam
# trennt Geräte oft voneinander. Ein eigenes WLAN des Macs (Internetfreigabe)
# geht nicht, wenn sein WLAN zugleich der Internetzugang ist. Also das iPhone:
# Mac und Brille treten seinem WLAN bei. Das iPhone hat dort immer 172.20.10.1
# und verteilt 172.20.10.2 … .14 — welche der Mac bekommt, bestimmt es selbst.
#
# Wie: Ein LaunchDaemon sieht alle 5 s nach. Ist das WLAN im Netz eines iPhones
# (Router 172.20.10.1, eigene Adresse 172.20.10.x), hängt er 172.20.10.14 als
# zweite Adresse an — die oberste, die das iPhone als letzte vergibt. Antwortet
# dort schon ein anderes Gerät, lässt er es. Verlässt der Mac das iPhone-WLAN,
# nimmt er sie wieder ab. Eine zusätzliche Adresse setzen darf nur root.
#
# Sicherheit: Der Dienst läuft als root. Deshalb führt er nicht dieses Skript im
# Projekt aus (das jeder Prozess des Benutzers ändern könnte), sondern eine
# root-eigene Kopie unter /Library/Application Support/iLEEN/.

set -uo pipefail

NAME="de.ileen.quest-festip"
ZIEL_DIR="/Library/Application Support/iLEEN"
ZIEL="$ZIEL_DIR/quest-festip.sh"
PLIST="/Library/LaunchDaemons/$NAME.plist"
LOG="/Library/Logs/ileen-quest-festip.log"
FEST="172.20.10.14"         # dieselbe Zahl wie HOTSPOT_IP in quest-wlan.sh
NETZ="172.20.10"            # iOS-Hotspot: immer 172.20.10.0/28, das iPhone ist .1
MASKE="255.255.255.240"

wlan_schnittstelle() {
  networksetup -listallhardwareports 2>/dev/null | awk '/^Hardware Port: (Wi-Fi|WLAN|AirPort)$/ { getline; print $2; exit }'
}

# Eine Runde: anhängen oder abnehmen. Gibt aus, was sie getan hat (sonst nichts).
runde() {
  local s="$1" ip router hat=0
  ip="$(ipconfig getifaddr "$s" 2>/dev/null)"
  router="$(ipconfig getoption "$s" router 2>/dev/null)"
  ifconfig "$s" 2>/dev/null | grep -q "inet $FEST " && hat=1
  if [ "$router" = "$NETZ.1" ] && [ "${ip%.*}" = "$NETZ" ]; then
    [ "$ip" = "$FEST" ] && return 0      # das iPhone hat sie dem Mac selbst gegeben
    [ "$hat" = 1 ] && return 0
    if ping -c 1 -t 1 "$FEST" >/dev/null 2>&1; then
      echo "$FEST ist im iPhone-Netz schon vergeben — nicht angehängt"
      return 0
    fi
    ifconfig "$s" alias "$FEST" netmask "$MASKE" && echo "im iPhone-WLAN: $FEST angehängt (vom iPhone: $ip)"
  elif [ "$hat" = 1 ] && [ "$ip" != "$FEST" ]; then
    ifconfig "$s" -alias "$FEST" && echo "iPhone-WLAN verlassen: $FEST abgenommen"
  fi
}

laufen() {
  local s letzte="" m
  echo "$(date '+%F %T') läuft (feste Adresse $FEST im iPhone-WLAN)"
  while true; do
    s="$(wlan_schnittstelle)"
    [ -n "$s" ] || s=en0
    m="$(runde "$s")"
    # Dasselbe nur einmal ins Protokoll (eine belegte Adresse käme sonst alle 5 s)
    [ -n "$m" ] && [ "$m" != "$letzte" ] && echo "$(date '+%F %T') $m"
    letzte="$m"
    sleep 5
  done
}

als_admin() {  # $1 = Skriptdatei, als root ausführen — macOS fragt nach dem Passwort
  osascript -e "do shell script \"/bin/bash '$1'\" with administrator privileges"
}

einrichten() {
  local quelle tmp plist
  quelle="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  tmp="$(mktemp -d)"
  plist="$tmp/$NAME.plist"
  cat > "$plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$NAME</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$ZIEL</string><string>laufen</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PL
  cat > "$tmp/einrichten.sh" <<SH
set -e
mkdir -p "$ZIEL_DIR"
install -o root -g wheel -m 755 "$quelle" "$ZIEL"
install -o root -g wheel -m 644 "$plist" "$PLIST"
launchctl bootout system/$NAME 2>/dev/null || true
launchctl bootstrap system "$PLIST"
SH
  chmod 700 "$tmp"
  echo "macOS fragt jetzt nach deinem Passwort (feste Adresse $FEST im iPhone-WLAN einrichten) …"
  if als_admin "$tmp/einrichten.sh"; then
    echo "Eingerichtet: $PLIST → $ZIEL"
  else
    echo "Nicht eingerichtet (abgebrochen?)."
  fi
  rm -rf "$tmp"
}

entfernen() {
  local tmp s
  tmp="$(mktemp -d)"
  s="$(wlan_schnittstelle)"
  cat > "$tmp/entfernen.sh" <<SH
launchctl bootout system/$NAME 2>/dev/null || true
rm -f "$PLIST" "$ZIEL"
rmdir "$ZIEL_DIR" 2>/dev/null || true
ifconfig "${s:-en0}" 2>/dev/null | grep -q "inet $FEST " && ifconfig "${s:-en0}" -alias "$FEST" || true
SH
  chmod 700 "$tmp"
  echo "macOS fragt jetzt nach deinem Passwort (feste Adresse entfernen) …"
  als_admin "$tmp/entfernen.sh" && echo "Entfernt." || echo "Nicht entfernt (abgebrochen?)."
  rm -rf "$tmp"
}

zustand() {
  local s ip router
  s="$(wlan_schnittstelle)"
  [ -f "$PLIST" ] && echo "Dienst: eingerichtet ($PLIST)" || echo "Dienst: nicht eingerichtet — $0 install"
  ip="$(ipconfig getifaddr "${s:-en0}" 2>/dev/null)"
  router="$(ipconfig getoption "${s:-en0}" router 2>/dev/null)"
  if [ "$router" = "$NETZ.1" ]; then echo "WLAN: im iPhone-Netz (vom iPhone: $ip)"; else echo "WLAN: nicht im iPhone-Netz (${ip:-keine Adresse})"; fi
  if ifconfig "${s:-en0}" 2>/dev/null | grep -q "inet $FEST "; then
    echo "Feste Adresse: da — Brille ins iPhone-WLAN, dann https://$FEST:5443"
  else
    echo "Feste Adresse: nicht angehängt"
  fi
  if [ -r "$LOG" ]; then tail -3 "$LOG"; fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    install) einrichten ;;
    remove)  entfernen ;;
    status)  zustand ;;
    laufen)  laufen ;;
    *) echo "Aufruf: $0 install | status | remove"; exit 2 ;;
  esac
fi
