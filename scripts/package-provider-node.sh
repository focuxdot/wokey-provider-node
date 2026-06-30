#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ROOT_DIR="${ROOT_DIR}" node "${ROOT_DIR}/scripts/bump-package-patch-version.mjs"

export PROVIDER_NODE_SKIP_VERSION_BUMP=1
export PROVIDER_NODE_BUILD_AT="${PROVIDER_NODE_BUILD_AT:-$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')}"

bash "${ROOT_DIR}/scripts/package-macos.sh"
bash "${ROOT_DIR}/scripts/package-linux.sh"
bash "${ROOT_DIR}/scripts/package-windows.sh"
mkdir -p "${ROOT_DIR}/release/installers"
install -m 755 "${ROOT_DIR}/packaging/install.sh" "${ROOT_DIR}/release/installers/install.sh"
install -m 644 "${ROOT_DIR}/packaging/install.ps1" "${ROOT_DIR}/release/installers/install.ps1"
bash "${ROOT_DIR}/scripts/generate-release-checksums.sh"
