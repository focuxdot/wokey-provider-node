#!/usr/bin/env bash
set -euo pipefail

VERSION="0.1.71"
REPOSITORY="focuxdot/wokey-provider-node"
RELEASE_BASE_URL="https://github.com/${REPOSITORY}/releases/download/v${VERSION}"
TEMP_DIR=""

cleanup() {
  if [ -n "${TEMP_DIR}" ]; then
    rm -rf "${TEMP_DIR}"
  fi
}
trap cleanup EXIT

fail() {
  printf 'Wokey Provider Node macOS migration: %s\n' "$*" >&2
  exit 1
}

if [ "$(uname -s)" != "Darwin" ]; then
  fail "this migration only supports macOS"
fi
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v shasum >/dev/null 2>&1 || fail "shasum is required"
command -v mktemp >/dev/null 2>&1 || fail "mktemp is required"

TEMP_DIR="$(mktemp -d)"
INSTALLER="${TEMP_DIR}/install.sh"
CHECKSUMS="${TEMP_DIR}/checksums.txt"
CACHE_BUSTER="$(date +%s)"

printf 'Downloading the Wokey Provider Node %s macOS migration installer...\n' "${VERSION}"
curl -fL --retry 3 --connect-timeout 10 --max-time 300 \
  "${RELEASE_BASE_URL}/install.sh?update=${CACHE_BUSTER}" -o "${INSTALLER}"
curl -fL --retry 3 --connect-timeout 10 --max-time 300 \
  "${RELEASE_BASE_URL}/checksums.txt?update=${CACHE_BUSTER}" -o "${CHECKSUMS}"

EXPECTED_SHA256="$(awk '$2 == "install.sh" { print $1; exit }' "${CHECKSUMS}")"
[ -n "${EXPECTED_SHA256}" ] || fail "v${VERSION} checksums.txt does not contain install.sh"
ACTUAL_SHA256="$(shasum -a 256 "${INSTALLER}" | awk '{print $1}')"
[ "${ACTUAL_SHA256}" = "${EXPECTED_SHA256}" ] || fail "install.sh SHA-256 verification failed"

chmod 700 "${INSTALLER}"
printf 'Installer verified. macOS will request administrator authorization once for the migration.\n'
WOKEY_PROVIDER_NODE_VERSION="${VERSION}" \
WOKEY_PROVIDER_NODE_BASE_URL="${RELEASE_BASE_URL}" \
  bash "${INSTALLER}"
