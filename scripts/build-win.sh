#!/usr/bin/env bash
# Cross-build the Windows NSIS installer from Linux (no wine required).
# Uses a workspace-local npm/electron cache and npmmirror mirrors so it works
# in restricted networks and when ~/.npm / ~/.cache are not writable.
set -euo pipefail
cd "$(dirname "$0")/.."

export npm_config_cache="${npm_config_cache:-$PWD/../.npm-cache}"
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://cdn.npmmirror.com/binaries/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
export electron_config_cache="${electron_config_cache:-$PWD/../.cache/electron}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$PWD/../.cache}"
mkdir -p "$npm_config_cache" "$electron_config_cache"

if [ ! -f build/icon.ico ] || [ ! -f build/icon.png ]; then
  python3 scripts/make-icon.py
fi

# ssh2's optional native addons (cpu-features/nan) are excluded and npmRebuild
# is disabled in package.json, so no cross-compilation is needed.
#
# We build the ZIP (portable) target here because the NSIS installer's final
# step needs wine, which is usually absent on Linux. The zip is a complete,
# runnable Windows app. For a proper NSIS installer, run `npm run dist:win`
# on Windows itself (no wine needed there).
exec ./node_modules/.bin/electron-builder --win zip --x64
