#!/bin/bash
# Build du .crx signé + update.xml pour l'auto-update via GitHub.
# Usage : ./build-crx.sh
#
# Prérequis : Google Chrome installé, clé privée à ../voice-input-key.pem

set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
KEY="$(cd "$REPO_DIR/.." && pwd)/voice-input-key.pem"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
STAGING="$(mktemp -d)"
DIST="$REPO_DIR/dist"

# URL où le crx sera hébergé (raw GitHub)
CRX_URL="https://raw.githubusercontent.com/thoy-le-duc/voice-input-extension/main/dist/voice-input.crx"

# Fichiers de l'extension (pas de .git, dist, scripts…)
FILES="manifest.json background.js content.js popup.html popup.js styles.css"

VERSION=$(grep '"version"' "$REPO_DIR/manifest.json" | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/')
echo "▶ Build version $VERSION"

# 1. Staging propre
for f in $FILES; do cp "$REPO_DIR/$f" "$STAGING/"; done

# 2. Pack avec Chrome (instance isolée pour ne pas déléguer à Chrome déjà ouvert)
rm -f "$STAGING.crx"
PROFILE="$(mktemp -d)"
"$CHROME" --user-data-dir="$PROFILE" --no-first-run --headless=new \
  --pack-extension="$STAGING" --pack-extension-key="$KEY" --no-message-box >/dev/null 2>&1 || true

# Attente écriture du fichier (max 10s)
for i in $(seq 1 20); do
  [ -f "$STAGING.crx" ] && break
  sleep 0.5
done
rm -rf "$PROFILE"

if [ ! -f "$STAGING.crx" ]; then
  echo "✗ Échec du packaging crx"; rm -rf "$STAGING"; exit 1
fi

# 3. Calcul de l'extension ID depuis la clé publique
EXT_ID=$(openssl rsa -in "$KEY" -pubout -outform DER 2>/dev/null | \
  openssl dgst -sha256 -binary | head -c16 | \
  od -An -tx1 | tr -d ' \n' | \
  tr '0123456789abcdef' 'abcdefghijklmnop')

# 4. Copie le crx dans dist/
mkdir -p "$DIST"
cp "$STAGING.crx" "$DIST/voice-input.crx"

# 5. Génère update.xml
cat > "$DIST/update.xml" <<EOF
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='$EXT_ID'>
    <updatecheck codebase='$CRX_URL' version='$VERSION' />
  </app>
</gupdate>
EOF

rm -rf "$STAGING" "$STAGING.crx"

echo "✓ dist/voice-input.crx   (version $VERSION)"
echo "✓ dist/update.xml        (appid $EXT_ID)"
echo ""
echo "→ git add dist && git commit -m \"build crx v$VERSION\" && git push"
