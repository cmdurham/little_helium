#!/bin/zsh
# Installs (or with --uninstall removes) Little Helium's optional native helper,
# which lets Little windows open on the display of the app a link came from.
#
#   ./install-helper.sh [--uninstall] [extension-id]
#
# The extension id defaults to the one Helium gives this folder when loaded
# unpacked. Set HELIUM_DATA_DIR to target a different Helium profile directory.
set -euo pipefail

NAME=com.cmdurham.little_helium
REPO=${0:A:h}
DATA_DIR=${HELIUM_DATA_DIR:-"$HOME/Library/Application Support/net.imput.helium"}
HOSTS_DIR="$DATA_DIR/NativeMessagingHosts"
BIN_DIR="$HOME/Library/Application Support/LittleHelium"
BIN="$BIN_DIR/little-helium-helper"

if [[ ${1:-} == --uninstall ]]; then
  rm -f "$HOSTS_DIR/$NAME.json" "$BIN"
  rmdir "$BIN_DIR" 2>/dev/null || true
  echo "Removed the Little Helium helper."
  exit 0
fi

# Unpacked extension ids are the first 128 bits of SHA-256(folder path), hex mapped to a–p.
EXT_ID=${1:-$(print -rn -- "$REPO" | shasum -a 256 | cut -c1-32 | tr '0-9a-f' 'a-p')}

mkdir -p "$BIN_DIR" "$HOSTS_DIR"
swiftc -O -o "$BIN" "$REPO/helper/little-helium-helper.swift"

cat > "$HOSTS_DIR/$NAME.json" <<JSON
{
  "name": "$NAME",
  "description": "Little Helium helper: finds the display of the app a link came from",
  "path": "$BIN",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON

echo "Installed the Little Helium helper for extension $EXT_ID."
echo "Reload Little Helium at helium://extensions to start using it."
