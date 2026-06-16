#!/bin/sh
# ------------------------------------------------------------
# Szybki deploy na mikr.us (Alpine / Frog).
# Użycie:
#   sh deploy.sh
# a potem uruchom aplikację na swoim przydzielonym porcie, np.:
#   PORT=20454 node server.js
# ------------------------------------------------------------
set -e

echo "→ Instaluję Node.js, npm, git i screen (wymaga sudo)..."
sudo apk add --update nodejs npm git screen

echo "→ Instaluję zależności projektu..."
npm install

echo ""
echo "✅ Gotowe."
echo "   Uruchom w tle:"
echo "     screen -S leadscrape"
echo "     PORT=20454 node server.js     # podmień 20454 na swój port (20000 + ID serwera)"
echo "     (wyjście bez ubijania: Ctrl+A, potem D)"
echo ""
echo "   Adres: http://frog01.mikr.us:20454"
