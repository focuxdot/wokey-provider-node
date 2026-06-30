#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR="${ROOT_DIR}/release"
CHECKSUMS="${RELEASE_DIR}/checksums.txt"

if [ ! -d "${RELEASE_DIR}" ]; then
  echo "release directory not found: ${RELEASE_DIR}" >&2
  exit 1
fi

hash_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    echo "Missing shasum or sha256sum" >&2
    exit 1
  fi
}

tmp="${CHECKSUMS}.tmp"
: > "${tmp}"

while IFS= read -r file; do
  name="$(basename "${file}")"
  hash="$(hash_file "${file}" | awk '{print $1}')"
  printf '%s  %s\n' "${hash}" "${name}" >> "${tmp}"
done < <(find "${RELEASE_DIR}" -type f \
  ! -name 'checksums.txt' \
  ! -name 'checksums.txt.tmp' \
  ! -name 'checksums.txt.sig' \
  ! -name 'checksums.txt.pem' \
  ! -name 'checksums.txt.bundle' \
  | sort)

mv "${tmp}" "${CHECKSUMS}"
echo "Wrote ${CHECKSUMS}"

if [ -n "${WOKEY_PROVIDER_NODE_GPG_KEY:-}" ] && command -v gpg >/dev/null 2>&1; then
  gpg --batch --yes --local-user "${WOKEY_PROVIDER_NODE_GPG_KEY}" --detach-sign --armor "${CHECKSUMS}"
  echo "Wrote ${CHECKSUMS}.asc"
elif { [ "${WOKEY_PROVIDER_NODE_COSIGN_KEYLESS:-}" = "1" ] || [ -n "${COSIGN_EXPERIMENTAL:-}" ]; } && command -v cosign >/dev/null 2>&1; then
  # Keyless (OIDC) signing. In CI the workflow's own OIDC identity is the
  # signer, so there is no long-lived private key. Emits a detached signature
  # plus the short-lived Fulcio certificate that installers verify against.
  cosign sign-blob --yes \
    --output-signature "${CHECKSUMS}.sig" \
    --output-certificate "${CHECKSUMS}.pem" \
    "${CHECKSUMS}"
  echo "Wrote ${CHECKSUMS}.sig and ${CHECKSUMS}.pem (cosign keyless)"
else
  echo "No signing key/tool configured; checksums were generated without a detached signature."
fi
