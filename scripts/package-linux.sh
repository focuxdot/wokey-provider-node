#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "${PROVIDER_NODE_SKIP_VERSION_BUMP:-0}" != "1" ]; then
  ROOT_DIR="${ROOT_DIR}" node "${ROOT_DIR}/scripts/bump-package-patch-version.mjs"
fi
VERSION="$(node -p "require('${ROOT_DIR}/package.json').version")"
BUILD_DIR="${ROOT_DIR}/.tmp/linux-pkg"
ROOTFS="${BUILD_DIR}/rootfs"
DEB_ROOT="${BUILD_DIR}/deb"
PKG_DIR="${ROOT_DIR}/release/linux"
ARCH_UNAME="${WOKEY_TARGET_ARCH:-$(uname -m)}"

case "${ARCH_UNAME}" in
  x86_64|amd64)
    DEB_ARCH="amd64"
    ARTIFACT_ARCH="x64"
    ;;
  aarch64|arm64)
    DEB_ARCH="arm64"
    ARTIFACT_ARCH="arm64"
    ;;
  *)
    DEB_ARCH="all"
    ARTIFACT_ARCH="${ARCH_UNAME}"
    ;;
esac

TAR_NAME="WokeyProviderNode-linux-${ARTIFACT_ARCH}-${VERSION}.tar.gz"
DEB_NAME="wokey-provider-node_${VERSION}_${DEB_ARCH}.deb"

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
require_tool tar

cd "${ROOT_DIR}"
npm run build

rm -rf "${BUILD_DIR}"
mkdir -p \
  "${ROOTFS}/opt/wokey-provider-node/app" \
  "${ROOTFS}/opt/wokey-provider-node/bin" \
  "${ROOTFS}/usr/local/bin" \
  "${ROOTFS}/usr/share/doc/wokey-provider-node" \
  "${ROOTFS}/usr/share/wokey-provider-node/systemd" \
  "${PKG_DIR}"

copy_tree "${ROOT_DIR}/dist" "${ROOTFS}/opt/wokey-provider-node/app/dist"
install -m 644 "${ROOT_DIR}/package.json" "${ROOTFS}/opt/wokey-provider-node/app/package.json"
install -m 644 "${ROOT_DIR}/package-lock.json" "${ROOTFS}/opt/wokey-provider-node/app/package-lock.json"
install -m 644 "${ROOT_DIR}/README.md" "${ROOTFS}/opt/wokey-provider-node/app/README.md"
install -m 644 "${ROOT_DIR}/docs/PROVIDER_NODE.md" "${ROOTFS}/usr/share/doc/wokey-provider-node/PROVIDER_NODE.md"
install -m 644 "${ROOT_DIR}/docs/LINUX_INSTALLER.md" "${ROOTFS}/usr/share/doc/wokey-provider-node/LINUX_INSTALLER.md"
install -m 755 "${ROOT_DIR}/packaging/linux/provider-node" "${ROOTFS}/opt/wokey-provider-node/bin/provider-node"
install -m 755 "${ROOT_DIR}/packaging/linux/provider-node-cli.mjs" "${ROOTFS}/opt/wokey-provider-node/bin/provider-node-cli.mjs"
install -m 644 "${ROOT_DIR}/packaging/linux/wokey-provider-node.service" "${ROOTFS}/usr/share/wokey-provider-node/systemd/wokey-provider-node.service"
ln -sf /opt/wokey-provider-node/bin/provider-node "${ROOTFS}/usr/local/bin/wokey-node"

(
  cd "${ROOTFS}/opt/wokey-provider-node/app"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
)

tar -C "${ROOTFS}" -czf "${PKG_DIR}/${TAR_NAME}" .
echo "Built ${PKG_DIR}/${TAR_NAME}"

if command -v dpkg-deb >/dev/null 2>&1; then
  rm -rf "${DEB_ROOT}"
  copy_tree "${ROOTFS}" "${DEB_ROOT}"
  mkdir -p "${DEB_ROOT}/DEBIAN"
  install -m 755 "${ROOT_DIR}/packaging/linux/scripts/postinst" "${DEB_ROOT}/DEBIAN/postinst"
  install -m 755 "${ROOT_DIR}/packaging/linux/scripts/prerm" "${DEB_ROOT}/DEBIAN/prerm"
  cat > "${DEB_ROOT}/DEBIAN/control" <<EOF
Package: wokey-provider-node
Version: ${VERSION}
Section: net
Priority: optional
Architecture: ${DEB_ARCH}
Depends: nodejs (>= 20)
Maintainer: Wokey <support@wokey.ai>
Description: Wokey Provider Node
 Provider-side daemon and local console for binding supply capacity to Wokey.
EOF
  fakeroot dpkg-deb --build "${DEB_ROOT}" "${PKG_DIR}/${DEB_NAME}" >/dev/null 2>&1 || \
    dpkg-deb --build --root-owner-group "${DEB_ROOT}" "${PKG_DIR}/${DEB_NAME}" >/dev/null
  echo "Built ${PKG_DIR}/${DEB_NAME}"
else
  echo "Skipping .deb build because dpkg-deb is not available."
fi
