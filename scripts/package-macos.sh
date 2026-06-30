#!/usr/bin/env bash
set -euo pipefail
export COPYFILE_DISABLE=1

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "${PROVIDER_NODE_SKIP_VERSION_BUMP:-0}" != "1" ]; then
  ROOT_DIR="${ROOT_DIR}" node "${ROOT_DIR}/scripts/bump-package-patch-version.mjs"
fi
VERSION="$(node -p "require('${ROOT_DIR}/package.json').version")"
IDENTIFIER="ai.wokey.provider-node"
BUILD_DIR="${ROOT_DIR}/.tmp/macos-pkg"
ROOTFS="${BUILD_DIR}/root"
PKG_SCRIPTS="${BUILD_DIR}/scripts"
COMPONENT_EXPANDED="${BUILD_DIR}/component-expanded"
PKG_DIR="${ROOT_DIR}/release/macos"
COMPONENT_PKG="${BUILD_DIR}/WokeyProviderNode-component.pkg"
SANITIZED_COMPONENT_PKG="${BUILD_DIR}/WokeyProviderNode-component-sanitized.pkg"
PRODUCT_DISTRIBUTION="${BUILD_DIR}/Distribution.xml"
FINAL_PKG="${PKG_DIR}/WokeyProviderNode-${VERSION}.pkg"
DMG_STAGING="${BUILD_DIR}/dmg"
FINAL_DMG="${PKG_DIR}/WokeyProviderNode-${VERSION}.dmg"

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required tool: $1" >&2
    exit 1
  fi
}

require_tool node
require_tool npm
require_tool ditto
require_tool cpio
require_tool gzip
require_tool lsbom
require_tool mkbom
require_tool pkgbuild
require_tool pkgutil
require_tool productbuild
require_tool hdiutil

copy_tree() {
  ditto --norsrc "$1" "$2"
}

clean_macos_metadata() {
  if command -v dot_clean >/dev/null 2>&1; then
    dot_clean -m "${ROOTFS}" "${PKG_SCRIPTS}" || true
  fi

  find "${ROOTFS}" "${PKG_SCRIPTS}" -name '._*' -delete

  if [ -x /usr/bin/xattr ]; then
    find "${ROOTFS}" "${PKG_SCRIPTS}" -exec /usr/bin/xattr -c {} + 2>/dev/null || true
  elif command -v xattr >/dev/null 2>&1; then
    find "${ROOTFS}" "${PKG_SCRIPTS}" -exec xattr -c {} + 2>/dev/null || true
  fi
}

sanitize_component_package() {
  rm -rf "${COMPONENT_EXPANDED}" "${SANITIZED_COMPONENT_PKG}"
  pkgutil --expand "${COMPONENT_PKG}" "${COMPONENT_EXPANDED}"

  (
    cd "${ROOTFS}"
    find . | sort | cpio -o --format odc -R 0:0 2>/dev/null | gzip -c > "${COMPONENT_EXPANDED}/Payload"
  )

  lsbom "${COMPONENT_EXPANDED}/Bom" | awk '!/(^|\/)\._/' > "${BUILD_DIR}/bom.list"
  mkbom -i "${BUILD_DIR}/bom.list" "${COMPONENT_EXPANDED}/Bom"

  payload_files="$(find "${ROOTFS}" | wc -l | tr -d '[:space:]')"
  install_kbytes="$(du -sk "${ROOTFS}" | awk '{print $1}')"
  PAYLOAD_FILES="${payload_files}" INSTALL_KBYTES="${install_kbytes}" perl -0pi -e \
    's/<payload numberOfFiles="\d+" installKBytes="\d+"\/>/<payload numberOfFiles="$ENV{PAYLOAD_FILES}" installKBytes="$ENV{INSTALL_KBYTES}"\/>/' \
    "${COMPONENT_EXPANDED}/PackageInfo"

  find "${COMPONENT_EXPANDED}" -name '._*' -delete
  pkgutil --flatten "${COMPONENT_EXPANDED}" "${SANITIZED_COMPONENT_PKG}"
}

cd "${ROOT_DIR}"
npm run build

rm -rf "${BUILD_DIR}"
mkdir -p \
  "${ROOTFS}/usr/local/wokey-provider-node/app" \
  "${ROOTFS}/usr/local/wokey-provider-node/bin" \
  "${ROOTFS}/usr/local/bin" \
  "${ROOTFS}/Library/LaunchAgents" \
  "${PKG_SCRIPTS}" \
  "${PKG_DIR}"

copy_tree "${ROOT_DIR}/dist" "${ROOTFS}/usr/local/wokey-provider-node/app/dist"
install -m 644 "${ROOT_DIR}/package.json" "${ROOTFS}/usr/local/wokey-provider-node/app/package.json"
install -m 644 "${ROOT_DIR}/package-lock.json" "${ROOTFS}/usr/local/wokey-provider-node/app/package-lock.json"
install -m 644 "${ROOT_DIR}/README.md" "${ROOTFS}/usr/local/wokey-provider-node/app/README.md"
install -m 755 "${ROOT_DIR}/packaging/macos/provider-node" "${ROOTFS}/usr/local/wokey-provider-node/bin/provider-node"
install -m 755 "${ROOT_DIR}/packaging/linux/provider-node-cli.mjs" "${ROOTFS}/usr/local/wokey-provider-node/bin/provider-node-cli.mjs"
install -m 644 "${ROOT_DIR}/packaging/macos/ai.wokey.provider-node.plist" "${ROOTFS}/Library/LaunchAgents/ai.wokey.provider-node.plist"
ln -sf /usr/local/wokey-provider-node/bin/provider-node "${ROOTFS}/usr/local/bin/wokey-node"
install -m 755 "${ROOT_DIR}/packaging/macos/scripts/preinstall" "${PKG_SCRIPTS}/preinstall"
install -m 755 "${ROOT_DIR}/packaging/macos/scripts/postinstall" "${PKG_SCRIPTS}/postinstall"

chmod 755 "${ROOTFS}/usr/local/wokey-provider-node/bin/provider-node"
chmod 644 "${ROOTFS}/Library/LaunchAgents/ai.wokey.provider-node.plist"
chmod 755 "${PKG_SCRIPTS}/preinstall" "${PKG_SCRIPTS}/postinstall"

(
  cd "${ROOTFS}/usr/local/wokey-provider-node/app"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
)

clean_macos_metadata

COPYFILE_DISABLE=1 pkgbuild \
  --root "${ROOTFS}" \
  --scripts "${PKG_SCRIPTS}" \
  --identifier "${IDENTIFIER}" \
  --version "${VERSION}" \
  --install-location "/" \
  "${COMPONENT_PKG}"

sanitize_component_package

COPYFILE_DISABLE=1 productbuild \
  --synthesize \
  --package "${SANITIZED_COMPONENT_PKG}" \
  "${PRODUCT_DISTRIBUTION}"

perl -0pi -e 's#(<installer-gui-script[^>]*>\n)#$1    <title>Wokey Provider Node</title>\n#' "${PRODUCT_DISTRIBUTION}"

COPYFILE_DISABLE=1 productbuild \
  --distribution "${PRODUCT_DISTRIBUTION}" \
  --package-path "${BUILD_DIR}" \
  "${FINAL_PKG}"

echo "Built ${FINAL_PKG}"

rm -rf "${DMG_STAGING}" "${FINAL_DMG}"
mkdir -p "${DMG_STAGING}"
install -m 644 "${FINAL_PKG}" "${DMG_STAGING}/WokeyProviderNode-${VERSION}.pkg"

cat > "${DMG_STAGING}/README.txt" <<EOF
Wokey Provider Node

Install:
1. Open WokeyProviderNode-${VERSION}.pkg.
2. Follow the macOS Installer prompts.
3. macOS may ask for an administrator password because Wokey installs a background LaunchAgent and files under /usr/local.
4. After installation, the local console opens at http://127.0.0.1:16888/.

Installed locations:
- /usr/local/wokey-provider-node
- /usr/local/bin/wokey-node
- /Library/LaunchAgents/ai.wokey.provider-node.plist
- ~/Library/Application Support/Wokey Provider Node

Common commands:
- wokey-node
- wokey-node add
- wokey-node bind --value bind_...
- wokey-node restart
- wokey-node update
- wokey-node open
- wokey-node status

This DMG does not install an app into /Applications.
EOF

cat > "${DMG_STAGING}/Uninstall.command" <<'EOF'
#!/bin/sh
set -eu

LABEL="ai.wokey.provider-node"
PLIST="/Library/LaunchAgents/${LABEL}.plist"
INSTALL_DIR="/usr/local/wokey-provider-node"
SHORT_CMD="/usr/local/bin/wokey-node"
CONSOLE_USER="$(/usr/bin/stat -f '%Su' /dev/console 2>/dev/null || true)"

if [ -n "${CONSOLE_USER}" ] && [ "${CONSOLE_USER}" != "root" ]; then
  CONSOLE_UID="$(/usr/bin/id -u "${CONSOLE_USER}" 2>/dev/null || true)"
  if [ -n "${CONSOLE_UID}" ]; then
    /bin/launchctl bootout "gui/${CONSOLE_UID}/${LABEL}" >/dev/null 2>&1 || true
    /bin/launchctl bootout "gui/${CONSOLE_UID}" "${PLIST}" >/dev/null 2>&1 || true
  fi
fi

if [ "$(id -u)" -ne 0 ]; then
  /usr/bin/sudo /bin/rm -rf "${INSTALL_DIR}" "${PLIST}" "${SHORT_CMD}"
else
  /bin/rm -rf "${INSTALL_DIR}" "${PLIST}" "${SHORT_CMD}"
fi

echo "Wokey Provider Node has been removed."
echo "User data was kept at: ~/Library/Application Support/Wokey Provider Node"
EOF
chmod 755 "${DMG_STAGING}/Uninstall.command"

if command -v dot_clean >/dev/null 2>&1; then
  dot_clean -m "${DMG_STAGING}" || true
fi
find "${DMG_STAGING}" -name '._*' -delete

hdiutil create \
  -volname "Wokey Provider Node" \
  -srcfolder "${DMG_STAGING}" \
  -ov \
  -format UDZO \
  "${FINAL_DMG}" >/dev/null

echo "Built ${FINAL_DMG}"
