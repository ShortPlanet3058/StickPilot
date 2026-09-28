#!/bin/bash
# Builds helper/dist/stickpilot-keys, the macOS Right Shift shortcut helper, as a
# universal (Intel + Apple Silicon) binary. The result is committed; needs Xcode's swiftc.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
for arch in x86_64 arm64; do
  swiftc -O -target "$arch-apple-macos11" -o "$tmp/keys-$arch" helper/macos/StickPilotKeys.swift
done
mkdir -p helper/dist
lipo -create -output helper/dist/stickpilot-keys "$tmp/keys-x86_64" "$tmp/keys-arm64"
rm -rf "$tmp"
codesign --force --sign - helper/dist/stickpilot-keys
echo "Built helper/dist/stickpilot-keys"
