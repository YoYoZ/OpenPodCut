#!/bin/bash
# OpenPodCut — macOS installer
# Copies the extension to Premiere Pro's CEP extensions folder.
# Run once after downloading the release zip.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/../cep-extension"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/podcast-cutter"

if [ ! -f "$SRC/bin/analyzer/analyzer" ]; then
    echo "ERROR: analyzer binary not found at:"
    echo "  $SRC/bin/analyzer/analyzer"
    echo ""
    echo "Make sure you downloaded the macOS release zip (not the Windows one)."
    exit 1
fi

echo "Installing OpenPodCut to:"
echo "  $DEST"
echo ""

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC/"* "$DEST/"
chmod +x "$DEST/bin/analyzer/analyzer"

echo "Done!"
echo "If the panel doesn't appear, run enable_debug_mode.sh first, then restart Premiere."
echo "In Premiere: Window > Extensions > OpenPodCut"
