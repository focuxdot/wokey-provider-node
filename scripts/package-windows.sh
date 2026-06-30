#!/usr/bin/env bash
set -euo pipefail
export COPYFILE_DISABLE=1

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "${PROVIDER_NODE_SKIP_VERSION_BUMP:-0}" != "1" ]; then
  ROOT_DIR="${ROOT_DIR}" node "${ROOT_DIR}/scripts/bump-package-patch-version.mjs"
fi
VERSION="$(node -p "require('${ROOT_DIR}/package.json').version")"
BUILD_DIR="${ROOT_DIR}/.tmp/windows-pkg"
PAYLOAD_ROOT="${BUILD_DIR}/WokeyProviderNode-win-x64-${VERSION}"
APP_DIR="${PAYLOAD_ROOT}/app"
BIN_DIR="${PAYLOAD_ROOT}/bin"
PKG_DIR="${ROOT_DIR}/release/windows"
ZIP_NAME="WokeyProviderNode-win-x64-${VERSION}.zip"

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required tool: $1" >&2
    exit 1
  fi
}

copy_tree() {
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$1"/ "$2"/
  else
    mkdir -p "$2"
    cp -R "$1"/. "$2"/
  fi
}

require_tool node
require_tool npm

cd "${ROOT_DIR}"
npm run build

rm -rf "${BUILD_DIR}"
mkdir -p "${APP_DIR}" "${BIN_DIR}" "${PKG_DIR}"

copy_tree "${ROOT_DIR}/dist" "${APP_DIR}/dist"
install -m 644 "${ROOT_DIR}/package.json" "${APP_DIR}/package.json"
install -m 644 "${ROOT_DIR}/package-lock.json" "${APP_DIR}/package-lock.json"
install -m 644 "${ROOT_DIR}/README.md" "${APP_DIR}/README.md"
install -m 644 "${ROOT_DIR}/packaging/linux/provider-node-cli.mjs" "${BIN_DIR}/provider-node-cli.mjs"
install -m 644 "${ROOT_DIR}/packaging/windows/wokey-node.ps1" "${BIN_DIR}/wokey-node.ps1"
install -m 644 "${ROOT_DIR}/packaging/windows/wokey-node.cmd" "${BIN_DIR}/wokey-node.cmd"

cat > "${PAYLOAD_ROOT}/README.txt" <<EOF
Wokey Provider Node for Windows

Install with:
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1

Installed locations:
- %LOCALAPPDATA%\\WokeyProviderNode
- %APPDATA%\\Wokey Provider Node

Common commands:
- wokey-node
- wokey-node add
- wokey-node bind --value bind_...
- wokey-node restart
- wokey-node update
- wokey-node open
- wokey-node status

This package requires Node.js 20 or newer.
EOF

find "${PAYLOAD_ROOT}" -name '._*' -delete

rm -f "${PKG_DIR}/${ZIP_NAME}"
if command -v zip >/dev/null 2>&1; then
  (
    cd "${BUILD_DIR}"
    zip -qr "${PKG_DIR}/${ZIP_NAME}" "WokeyProviderNode-win-x64-${VERSION}"
  )
elif command -v ditto >/dev/null 2>&1; then
  ditto -c -k --keepParent "${PAYLOAD_ROOT}" "${PKG_DIR}/${ZIP_NAME}"
else
  echo "Missing required tool: ditto or zip" >&2
  exit 1
fi

echo "Built ${PKG_DIR}/${ZIP_NAME}"
