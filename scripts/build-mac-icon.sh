#!/usr/bin/env bash
# Compiles the Icon Composer file (resources/icons/icon-macos.icon) into the files the macOS app uses:
#   build/icons/Assets.car               Liquid Glass icon: light, dark, clear and tinted looks (macOS 26+)
#   build/icons/icon.icns                flat icon for macOS 15 and older, the DMG and Finder previews
#   build/icons/Assets.car.source-sha256 which source they came from (a packaged build checks it)
# The outputs are committed, so release builds do not need Xcode 26. Run `npm run icons:mac` after
# editing the icon. Needs Xcode 26 or newer (actool 26+ and Icon Composer).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/resources/icons/icon-macos.icon"
OUT_DIR="$ROOT/build/icons"

version="$(actool --version | plutil -extract com\\.apple\\.actool\\.version.short-bundle-version raw -o - -)"
if [ "${version%%.*}" -lt 26 ]; then
  echo "actool $version is too old. Install Xcode 26 or newer." >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# actool names the app icon after the .icon file; the bundle's CFBundleIconName is "Icon".
cp -R "$SRC" "$tmp/Icon.icon"
mkdir "$tmp/out"

actool "$tmp/Icon.icon" \
  --compile "$tmp/out" \
  --output-format human-readable-text \
  --notices --warnings \
  --output-partial-info-plist "$tmp/out/assetcatalog_generated_info.plist" \
  --app-icon Icon \
  --include-all-app-icons \
  --enable-on-demand-resources NO \
  --development-region en \
  --target-device mac \
  --minimum-deployment-target 12.0 \
  --platform macosx

cp "$tmp/out/Assets.car" "$OUT_DIR/Assets.car"

# actool's own Icon.icns stops at 256 px, so render the full 16-1024 px set with Icon Composer instead.
ictool=""
for app in "/Applications/Icon Composer.app" "$(xcode-select -p)/../Applications/Icon Composer.app"; do
  if [ -x "$app/Contents/Executables/ictool" ]; then ictool="$app/Contents/Executables/ictool"; break; fi
done
if [ -z "$ictool" ]; then
  echo "Icon Composer (ictool) not found. It ships with Xcode 26 or newer." >&2
  exit 1
fi
iconset="$tmp/icon.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
  for scale in 1 2; do
    suffix=""
    [ "$scale" = 2 ] && suffix="@2x"
    "$ictool" "$SRC" --export-image --output-file "$iconset/icon_${size}x${size}${suffix}.png" \
      --platform macOS --rendition Default --width "$size" --height "$size" --scale "$scale"
  done
done
iconutil -c icns -o "$OUT_DIR/icon.icns" "$iconset"
node "$ROOT/scripts/mac-icon.cjs" stamp
echo "Wrote $OUT_DIR/Assets.car and $OUT_DIR/icon.icns (actool $version)"
