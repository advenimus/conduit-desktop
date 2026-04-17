#!/bin/bash
set -e

# Generate all required icon sizes from a source image
# Requires ImageMagick (brew install imagemagick)

SOURCE="${1:-assets/icon-1024.png}"
DEST="src-tauri/icons"

if [ ! -f "$SOURCE" ]; then
    echo "Error: Source image not found: $SOURCE"
    echo "Usage: $0 [path-to-1024x1024-png]"
    exit 1
fi

mkdir -p "$DEST"

echo "Generating icons from $SOURCE..."

# PNG icons
convert "$SOURCE" -resize 32x32 "$DEST/32x32.png"
convert "$SOURCE" -resize 128x128 "$DEST/128x128.png"
convert "$SOURCE" -resize 256x256 "$DEST/128x128@2x.png"
convert "$SOURCE" -resize 256x256 "$DEST/256x256.png"

# macOS icns
ICONSET="/tmp/conduit-icon.iconset"
mkdir -p "$ICONSET"
convert "$SOURCE" -resize 16x16 "$ICONSET/icon_16x16.png"
convert "$SOURCE" -resize 32x32 "$ICONSET/icon_16x16@2x.png"
convert "$SOURCE" -resize 32x32 "$ICONSET/icon_32x32.png"
convert "$SOURCE" -resize 64x64 "$ICONSET/icon_32x32@2x.png"
convert "$SOURCE" -resize 128x128 "$ICONSET/icon_128x128.png"
convert "$SOURCE" -resize 256x256 "$ICONSET/icon_128x128@2x.png"
convert "$SOURCE" -resize 256x256 "$ICONSET/icon_256x256.png"
convert "$SOURCE" -resize 512x512 "$ICONSET/icon_256x256@2x.png"
convert "$SOURCE" -resize 512x512 "$ICONSET/icon_512x512.png"
convert "$SOURCE" -resize 1024x1024 "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$DEST/icon.icns"
rm -rf "$ICONSET"

# Windows ico
convert "$SOURCE" -resize 256x256 -define icon:auto-resize=256,128,64,48,32,16 "$DEST/icon.ico"

echo "Icons generated in $DEST:"
ls -la "$DEST"
