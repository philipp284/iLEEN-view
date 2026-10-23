# shellcheck shell=bash
# © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
#
# Zertifikate für den Brillen-Dienst. quest-wlan.sh bindet diese Datei ein
# (`source`); allein aufgerufen stellt sie die Zertifikate nur aus:
#
#   ILEEN_QUEST_TLS=/pfad frontend/tools/quest-zertifikat.sh
#
# Zwei Zertifikate statt eines:
#
#   ca.pem           eine eigene Zertifizierungsstelle je Mac, 10 Jahre, einmal
#                    erzeugt. Apple-Geräte (Vision Pro, iPad) bekommen sie als
#                    Profil (ileen-ca.mobileconfig, über die Weiche unter
#                    http://<Mac>:5443/einrichten) und vertrauen ihr dann.
#   zertifikat.pem   das Serverzertifikat für Vite, von ihr signiert, 397 Tage,
#                    mit allen Adressen, unter denen der Mac je erreichbar war.
#                    Kommt eine neue dazu, wird es neu ausgestellt — die Geräte
#                    mit Profil merken davon nichts, die Quest warnt einmal.
#
# Warum das sein muss: Vorher war das Serverzertifikat selbst signiert, ohne
# ExtendedKeyUsage serverAuth und mit CA:TRUE. Chromium (Quest) ist das gleich;
# Apple lehnt ein solches Zertifikat für TLS ab, auch wenn man ihm vertraut
# („Extended key usage does not match certificate usage", gemessen mit
# `security verify-cert`). Safari auf der Vision Pro öffnete die Seite nie.
# Apples Regeln (support.apple.com/103769): SAN, EKU serverAuth, RSA ≥ 2048,
# SHA-2, höchstens 825 Tage.
#
# Die Zertifizierungsstelle ist per Name Constraints auf private Adressen
# (10/8, 172.16/12, 192.168/16, 127/8, 100.64/10) und auf *.local beschränkt.
# Ihr Schlüssel liegt unverschlüsselt auf dem Mac; ohne die Beschränkung wäre
# er für jedes Gerät mit dem Profil ein Generalschlüssel für jede Webseite. So
# kann er nur Adressen im lokalen Netz bestätigen. Öffentliche Adressen des
# Macs kommen deshalb nicht ins Zertifikat — dort hilft ileen.local.

: "${TLS:=${ILEEN_QUEST_TLS:-$HOME/.ileen/quest-tls}}"
: "${FEST:=${ILEEN_QUEST_NAME:-ileen}.local}"
: "${name:=$(scutil --get LocalHostName 2>/dev/null || hostname -s).local}"

CA_TAGE=3650
BLATT_TAGE=397          # unter Apples 825 und unter den 398 der Browser
BLATT_REST=2592000      # 30 Tage vor Ablauf neu ausstellen

# Liegt eine IPv4-Adresse in einem Bereich, den die Zertifizierungsstelle bestätigen darf?
ist_privat() {
  case "$1" in
    10.*|127.*|192.168.*) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
    100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) return 0 ;;
  esac
  return 1
}

# Fingerabdruck (SHA-256) der Zertifizierungsstelle, mit Doppelpunkten
ca_fingerabdruck() {
  openssl x509 -in "$TLS/ca.pem" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//'
}

# Die Zertifizierungsstelle und das Profil für Apple-Geräte. Gibt 0 zurück, wenn neu erzeugt.
ca_sicherstellen() {
  mkdir -p "$TLS"
  local neu=1
  if [ ! -f "$TLS/ca.pem" ] || [ ! -f "$TLS/ca-schluessel.pem" ]; then
    local cnf="$TLS/.ca.cnf"
    cat > "$cnf" <<CNF
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca
[dn]
CN = iLEEN VR lokale CA (${name%.local})
O = iLEEN
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;IP:10.0.0.0/255.0.0.0, permitted;IP:172.16.0.0/255.240.0.0, permitted;IP:192.168.0.0/255.255.0.0, permitted;IP:127.0.0.0/255.0.0.0, permitted;IP:100.64.0.0/255.192.0.0, permitted;DNS:local, permitted;DNS:localhost
CNF
    openssl req -x509 -new -newkey rsa:2048 -nodes -sha256 -days "$CA_TAGE" -config "$cnf" \
      -keyout "$TLS/ca-schluessel.pem" -out "$TLS/ca.pem" 2>/dev/null || { echo "Zertifizierungsstelle: openssl schlug fehl"; rm -f "$cnf"; return 2; }
    chmod 600 "$TLS/ca-schluessel.pem"
    rm -f "$cnf" "$TLS/ileen-ca.mobileconfig" "$TLS/ileen-ca.cer"
    echo "Zertifizierungsstelle neu: $(ca_fingerabdruck)"
    neu=0
  fi
  [ -f "$TLS/ileen-ca.cer" ] || openssl x509 -in "$TLS/ca.pem" -outform der -out "$TLS/ileen-ca.cer"
  [ -f "$TLS/ileen-ca.mobileconfig" ] || profil_schreiben
  return $neu
}

# Konfigurationsprofil (com.apple.security.root) — Safari auf Vision Pro, iPad
# und iPhone bietet es nach dem Laden zur Installation an. Unsigniert, also
# „nicht überprüft"; das ist bei einem selbst erzeugten Profil richtig so.
profil_schreiben() {
  local daten fp id
  daten="$(openssl base64 -in "$TLS/ileen-ca.cer" | tr -d '\n')"
  fp="$(ca_fingerabdruck | tr -d ':' | tr 'A-F' 'a-f')"
  id="$(echo "$fp" | cut -c1-32)"
  # Feste UUIDs aus dem Fingerabdruck: ein neu geladenes Profil ersetzt das alte, statt sich daneben zu legen
  local u1 u2
  u1="$(echo "$id" | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/')"
  u2="$(echo "$fp" | cut -c33-64 | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/')"
  cat > "$TLS/ileen-ca.mobileconfig" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>ileen-ca.cer</string>
      <key>PayloadContent</key><data>$daten</data>
      <key>PayloadDescription</key><string>Zertifizierungsstelle von iLEEN VR auf ${name%.local}. Bestätigt nur Adressen im lokalen Netz und .local-Namen.</string>
      <key>PayloadDisplayName</key><string>iLEEN VR lokale CA (${name%.local})</string>
      <key>PayloadIdentifier</key><string>de.ileen.quest.ca.$id</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>$u1</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key><string>Damit Safari iLEEN auf diesem Mac (Port 5443) ohne Warnung und mit WebXR öffnet. Danach unter Allgemein → Info → Zertifikatsvertrauenseinstellungen einschalten.</string>
  <key>PayloadDisplayName</key><string>iLEEN VR (${name%.local})</string>
  <key>PayloadIdentifier</key><string>de.ileen.quest.$id</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>$u2</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
PL
}

# Das Serverzertifikat: alle je gesehenen privaten Adressen. Gibt 0 zurück, wenn neu ausgestellt.
zertifikat() {
  local neu=1 ip
  ca_sicherstellen && neu=0
  [ -f "$TLS/ca.pem" ] || return 1
  touch "$TLS/adressen.txt"
  if declare -F adressen >/dev/null; then
    for ip in $(adressen); do
      grep -qx "$ip" "$TLS/adressen.txt" || { echo "$ip" >> "$TLS/adressen.txt"; neu=0; }
    done
  fi
  local z="$TLS/zertifikat.pem"
  if [ "$neu" = 1 ]; then
    if [ ! -f "$z" ] || [ ! -f "$TLS/schluessel.pem" ]; then neu=0
    # nicht von dieser Zertifizierungsstelle (alte, selbst signierte Fassung)
    elif ! openssl verify -CAfile "$TLS/ca.pem" "$z" >/dev/null 2>&1; then neu=0
    # der feste Name fehlt, oder die Laufzeit geht zu Ende
    # (-text statt -ext: das openssl von macOS ist LibreSSL und kennt -ext nicht)
    elif ! openssl x509 -in "$z" -noout -text 2>/dev/null | grep -q "DNS:$FEST"; then neu=0
    elif ! openssl x509 -in "$z" -noout -checkend "$BLATT_REST" >/dev/null 2>&1; then neu=0
    fi
  fi
  [ "$neu" = 0 ] || return 1

  local san="DNS:localhost,DNS:$name,DNS:$FEST,IP:127.0.0.1" oeffentlich=""
  while read -r ip; do
    [ -n "$ip" ] || continue
    [ "$ip" = 127.0.0.1 ] && continue
    if ist_privat "$ip"; then san="$san,IP:$ip"; else oeffentlich="$oeffentlich $ip"; fi
  done < "$TLS/adressen.txt"

  local cnf="$TLS/.blatt.cnf"
  cat > "$cnf" <<CNF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = iLEEN VR (${name%.local})
O = iLEEN
[v3]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = $san
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid, issuer
CNF
  # Jede Ausstellung eine eigene Seriennummer (Firefox und Safari stolpern über wiederholte)
  local serie="0x1$(openssl rand -hex 15)"
  if openssl req -new -newkey rsa:2048 -nodes -sha256 -config "$cnf" \
       -keyout "$TLS/schluessel.neu" -out "$TLS/.blatt.csr" 2>/dev/null &&
     openssl x509 -req -in "$TLS/.blatt.csr" -CA "$TLS/ca.pem" -CAkey "$TLS/ca-schluessel.pem" \
       -set_serial "$serie" -days "$BLATT_TAGE" -sha256 -extfile "$cnf" -extensions v3 \
       -out "$TLS/zertifikat.neu" 2>/dev/null; then
    chmod 600 "$TLS/schluessel.neu"
    mv "$TLS/schluessel.neu" "$TLS/schluessel.pem"
    mv "$TLS/zertifikat.neu" "$TLS/zertifikat.pem"
    rm -f "$cnf" "$TLS/.blatt.csr" "$TLS/san.txt"
    echo "Zertifikat neu für: ${san//,/ }"
    [ -n "$oeffentlich" ] && echo "Nicht im Zertifikat (öffentlich, die CA darf sie nicht bestätigen):$oeffentlich — dort ileen.local nehmen."
    return 0
  fi
  rm -f "$cnf" "$TLS/.blatt.csr" "$TLS/schluessel.neu" "$TLS/zertifikat.neu"
  echo "Zertifikat: openssl schlug fehl — das bisherige bleibt."
  return 1
}

# Allein aufgerufen: nur ausstellen
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -uo pipefail
  adressen() { ifconfig | awk '/inet / && $2 !~ /^127\./ && $2 !~ /^169\.254\./ { print $2 }' | sort -u; }
  zertifikat || echo "Zertifikat unverändert: $TLS/zertifikat.pem"
  echo "Zertifizierungsstelle: $(ca_fingerabdruck)"
fi
