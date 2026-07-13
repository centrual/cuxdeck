#!/usr/bin/env bash
# Builds cuxdeck.app — a double-clickable, menu-bar-only macOS app.
# Output: dist/cuxdeck.app. Drag it to /Applications and it behaves
# like any other menu-bar app: click to launch, no Dock icon
# (LSUIElement), and "Start at login" from its own menu.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:-0.1.0-dev}"
APP="dist/cuxdeck.app"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "building universal binary…"
GOOS=darwin GOARCH=arm64 /opt/homebrew/bin/go build -ldflags "-X main.version=$VERSION" -o /tmp/cuxdeck-arm64 ./cmd/cuxdeck
if GOOS=darwin GOARCH=amd64 /opt/homebrew/bin/go build -ldflags "-X main.version=$VERSION" -o /tmp/cuxdeck-amd64 ./cmd/cuxdeck 2>/dev/null; then
  lipo -create -output "$APP/Contents/MacOS/cuxdeck" /tmp/cuxdeck-arm64 /tmp/cuxdeck-amd64
  echo "  universal (arm64 + amd64)"
else
  cp /tmp/cuxdeck-arm64 "$APP/Contents/MacOS/cuxdeck"   # CGO cross-compile unavailable → native only
  echo "  native arch only (amd64 cross-build needs a C toolchain)"
fi
chmod +x "$APP/Contents/MacOS/cuxdeck"

echo "rendering app icon…"
if command -v rsvg-convert >/dev/null 2>&1 || command -v sips >/dev/null 2>&1; then
  /opt/homebrew/bin/go run ./packaging/render-icns.go assets/onion.svg "$APP/Contents/Resources/cuxdeck.icns" 2>/dev/null \
    && echo "  icon set" || echo "  icon skipped (renderer unavailable)"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>cuxdeck</string>
  <key>CFBundleDisplayName</key><string>cuxdeck</string>
  <key>CFBundleIdentifier</key><string>com.centrual.cuxdeck</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>cuxdeck</string>
  <key>CFBundleIconFile</key><string>cuxdeck</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST

echo "done → $APP"
echo "install: mv $APP /Applications/ && open /Applications/cuxdeck.app"
