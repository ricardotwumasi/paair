#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="PAAIRMenuBar"
APP_DIR=".build/${APP_NAME}.app"
CONTENTS="${APP_DIR}/Contents"
MACOS="${CONTENTS}/MacOS"

echo "Building ${APP_NAME}..."
swift build -c release 2>&1

echo "Creating app bundle..."
rm -rf "${APP_DIR}"
mkdir -p "${MACOS}"

# Copy binary
cp ".build/release/${APP_NAME}" "${MACOS}/${APP_NAME}"

# Create Info.plist (LSUIElement hides from Dock)
cat > "${CONTENTS}/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>PAAIRMenuBar</string>
    <key>CFBundleIdentifier</key>
    <string>com.paair.menubar</string>
    <key>CFBundleName</key>
    <string>PAAIR Menu Bar</string>
    <key>CFBundleVersion</key>
    <string>1.0.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
</dict>
</plist>
PLIST

echo ""
echo "Build successful."
echo "App bundle at: ${APP_DIR}"
echo ""
echo "To run:        open ${APP_DIR}"
echo "To install:    cp -r ${APP_DIR} /Applications/"
echo ""

# Offer to install LaunchAgent for auto-start
AGENT_DIR="$HOME/Library/LaunchAgents"
AGENT_PLIST="${AGENT_DIR}/com.paair.menubar.plist"

if [ "${1:-}" = "--install" ]; then
    cp -r "${APP_DIR}" /Applications/
    mkdir -p "${AGENT_DIR}"
    cat > "${AGENT_PLIST}" << LAUNCH
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.paair.menubar</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Applications/PAAIRMenuBar.app/Contents/MacOS/PAAIRMenuBar</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>
LAUNCH
    echo "Installed to /Applications/PAAIRMenuBar.app"
    echo "LaunchAgent created at ${AGENT_PLIST} (auto-starts on login)"
fi
