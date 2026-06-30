#!/usr/bin/env bash
set -euo pipefail

VERSION="${WOKEY_PROVIDER_NODE_VERSION:-0.1.34}"
PACKAGE_REVISION="${WOKEY_PROVIDER_NODE_PACKAGE_REVISION:-${VERSION}}"
DEFAULT_BASE_URL="https://github.com/focuxdot/wokey-provider-node/releases/download/v${VERSION}"
BASE_URL="${WOKEY_PROVIDER_NODE_BASE_URL:-${DEFAULT_BASE_URL}}"
BASE_URL="${BASE_URL%/}"
INSTALLER_TMPDIR=""
CHECKSUMS_FILE=""

# Identity the release `checksums.txt` signature must chain to. Releases are
# signed keyless by the GitHub Actions release workflow (cosign + Fulcio), so
# the signer identity is the workflow ref, not a long-lived key.
COSIGN_IDENTITY_REGEXP="${WOKEY_PROVIDER_NODE_COSIGN_IDENTITY:-^https://github.com/focuxdot/wokey-provider-node/\.github/workflows/release\.yml@refs/(tags/v.*|heads/main)$}"
COSIGN_OIDC_ISSUER="${WOKEY_PROVIDER_NODE_COSIGN_ISSUER:-https://token.actions.githubusercontent.com}"
# By default, install remains convenient for provider-owned machines that do not
# have cosign preinstalled. SHA-256 artifact verification is always required.
# Set WOKEY_PROVIDER_NODE_REQUIRE_SIGNATURE=1 to require cosign provenance.
REQUIRE_SIGNATURE="${WOKEY_PROVIDER_NODE_REQUIRE_SIGNATURE:-0}"

cleanup_tmpdir() {
  if [ -n "${INSTALLER_TMPDIR}" ]; then
    rm -rf "${INSTALLER_TMPDIR}"
  fi
}

trap cleanup_tmpdir EXIT

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'wokey provider node installer: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

signature_required() {
  case "${REQUIRE_SIGNATURE}" in
    1|true|TRUE|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

node_major() {
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  [ "$(node_major)" -ge 20 ]
}

# Newest Node.js LTS version string (e.g. v22.11.0) from nodejs.org. The dist
# index is ordered newest-first; LTS releases carry a codename string in "lts",
# non-LTS releases carry false — so the first line with a string "lts" wins.
latest_lts_version() {
  curl -fsSL --retry 3 --connect-timeout 10 --max-time 60 "https://nodejs.org/dist/index.json" \
    | tr '{' '\n' \
    | grep '"lts":"' \
    | head -n 1 \
    | sed -E 's/.*"version":"(v[0-9]+\.[0-9]+\.[0-9]+)".*/\1/'
}

# Universal Linux fallback: official prebuilt Node.js binaries unpacked into
# /usr/local. Works on any glibc distro and across CPU architectures, regardless
# of how old the distro's packaged Node.js is.
install_node_official_tarball() {
  need_cmd tar
  local ver arch tmp url
  ver="$(latest_lts_version || true)"
  [ -n "${ver}" ] || fail "could not resolve the latest Node.js LTS version from nodejs.org. Install Node.js 20+ from https://nodejs.org and rerun."
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l|armv6l) arch=armv7l ;;
    ppc64le) arch=ppc64le ;;
    s390x) arch=s390x ;;
    *) fail "automatic Node.js install does not support CPU architecture $(uname -m). Install Node.js 20+ from https://nodejs.org and rerun." ;;
  esac
  url="https://nodejs.org/dist/${ver}/node-${ver}-linux-${arch}.tar.gz"
  # Not every architecture ships a prebuilt binary for every release; probe first
  # so a missing build yields a clear message instead of a raw curl error abort.
  curl -fsIL --connect-timeout 10 --max-time 30 "${url}" >/dev/null 2>&1 \
    || fail "no official Node.js ${ver} build for ${arch}. Install Node.js 20+ from https://nodejs.org and rerun."
  tmp="${INSTALLER_TMPDIR:-$(mktemp -d)}/node-${ver}-linux-${arch}.tar.gz"
  log "Installing Node.js ${ver} (${arch}) to /usr/local"
  download "${url}" "${tmp}"
  sudo tar -C /usr/local --strip-components=1 -xzf "${tmp}"
  # The tarball lands in /usr/local/bin; ensure the rest of this script sees it.
  export PATH="/usr/local/bin:${PATH}"
}

install_node_linux() {
  # Alpine and other musl distros cannot run the glibc tarball; use apk there.
  if [ -f /etc/alpine-release ] && command -v apk >/dev/null 2>&1; then
    log "Detected Alpine Linux; installing Node.js via apk"
    sudo apk add --no-cache nodejs npm
    return 0
  fi
  # Debian/Ubuntu: install an apt-managed Node.js via NodeSource. The .deb package
  # declares `Depends: nodejs (>= 20)`, and dpkg/apt only see apt-installed
  # packages — a /usr/local tarball would leave that dependency unmet and abort
  # the .deb install. NodeSource ships a current-LTS `nodejs` apt package.
  if command -v apt-get >/dev/null 2>&1; then
    log "Installing Node.js (current LTS) via the NodeSource apt repository"
    if curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - \
       && sudo apt-get install -y nodejs; then
      return 0
    fi
    log "Warning: NodeSource install failed; falling back to the official binaries in /usr/local"
  fi
  install_node_official_tarball
}

install_node_macos() {
  if command -v brew >/dev/null 2>&1; then
    log "Installing Node.js via Homebrew"
    brew install node || brew upgrade node || true
    return 0
  fi
  # No Homebrew: the official universal .pkg works on every macOS and arch.
  local ver pkg url
  ver="$(latest_lts_version || true)"
  [ -n "${ver}" ] || fail "could not resolve the latest Node.js LTS version from nodejs.org. Install Node.js 20+ from https://nodejs.org and rerun."
  url="https://nodejs.org/dist/${ver}/node-${ver}.pkg"
  curl -fsIL --connect-timeout 10 --max-time 30 "${url}" >/dev/null 2>&1 \
    || fail "Node.js ${ver} package is not available yet. Install Node.js 20+ from https://nodejs.org and rerun."
  pkg="${INSTALLER_TMPDIR:-$(mktemp -d)}/node-${ver}.pkg"
  log "Installing Node.js ${ver} from the official package"
  download "${url}" "${pkg}"
  sudo installer -pkg "${pkg}" -target /
  # The pkg lands in /usr/local/bin (on the default macOS PATH, but be explicit).
  export PATH="/usr/local/bin:${PATH}"
}

# Ensure a Node.js 20+ runtime is present, installing one automatically if not.
ensure_node() {
  if node_ok; then
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    log "Node.js $(node --version) is too old (Node.js 20+ required); installing a newer Node.js automatically"
  else
    log "Node.js 20+ was not found; installing it automatically"
  fi
  case "$(uname -s)" in
    Darwin) install_node_macos ;;
    Linux) install_node_linux ;;
    *) fail "automatic Node.js install is not supported on $(uname -s). Install Node.js 20+ from https://nodejs.org and rerun." ;;
  esac
  # Drop any cached lookup of an old `node`; each installer above puts the new one
  # on PATH itself (tarball prepends /usr/local/bin; brew/apk/pkg use standard
  # locations already on PATH), so no blanket prepend here — that could shadow a
  # freshly installed node (e.g. Homebrew's /opt/homebrew/bin) with a stale one.
  hash -r 2>/dev/null || true
  if ! node_ok; then
    fail "automatic Node.js installation did not complete. Install Node.js 20+ from https://nodejs.org, open a new terminal, then rerun this installer."
  fi
  log "Using Node.js $(node --version)"
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail "missing shasum or sha256sum for artifact verification"
  fi
}

download() {
  local url="$1"
  local output="$2"
  log "Downloading ${url}"
  curl -fL --retry 3 --connect-timeout 10 --max-time 300 "$url" -o "$output"
}

download_checksums() {
  if [ -n "${CHECKSUMS_FILE}" ]; then
    return 0
  fi
  CHECKSUMS_FILE="${INSTALLER_TMPDIR}/checksums.txt"
  download "${BASE_URL}/checksums.txt?v=${PACKAGE_REVISION}" "${CHECKSUMS_FILE}"
  verify_checksums_signature
}

# Verify the cosign signature over checksums.txt. The per-artifact SHA-256 check
# proves integrity; this proves authenticity — that the checksums were produced
# by the official release workflow, not an attacker who swapped both files.
verify_checksums_signature() {
  local sig="${INSTALLER_TMPDIR}/checksums.txt.sig"
  local cert="${INSTALLER_TMPDIR}/checksums.txt.pem"

  if ! curl -fsL --retry 3 --connect-timeout 10 --max-time 60 \
        "${BASE_URL}/checksums.txt.sig?v=${PACKAGE_REVISION}" -o "${sig}" 2>/dev/null \
     || ! curl -fsL --retry 3 --connect-timeout 10 --max-time 60 \
        "${BASE_URL}/checksums.txt.pem?v=${PACKAGE_REVISION}" -o "${cert}" 2>/dev/null; then
    if signature_required; then
      fail "release signature (checksums.txt.sig/.pem) not found"
    fi
    log "Warning: release signature not found; continuing with SHA-256 checksum verification only."
    return 0
  fi

  if ! command -v cosign >/dev/null 2>&1; then
    if signature_required; then
      fail "cosign is required for release signature verification but was not found"
    fi
    log "Warning: cosign not installed; skipped optional release provenance verification."
    log "The artifact SHA-256 will still be verified against checksums.txt."
    log "For strict provenance verification, install cosign and rerun with WOKEY_PROVIDER_NODE_REQUIRE_SIGNATURE=1."
    log "Manual verification command:"
    log "  cosign verify-blob --certificate checksums.txt.pem --signature checksums.txt.sig \\"
    log "    --certificate-identity-regexp '${COSIGN_IDENTITY_REGEXP}' \\"
    log "    --certificate-oidc-issuer '${COSIGN_OIDC_ISSUER}' checksums.txt"
    return 0
  fi

  if cosign verify-blob \
      --certificate "${cert}" \
      --signature "${sig}" \
      --certificate-identity-regexp "${COSIGN_IDENTITY_REGEXP}" \
      --certificate-oidc-issuer "${COSIGN_OIDC_ISSUER}" \
      "${CHECKSUMS_FILE}" >/dev/null 2>"${INSTALLER_TMPDIR}/cosign.err"; then
    log "Verified checksums.txt signature (cosign keyless)."
  else
    cat "${INSTALLER_TMPDIR}/cosign.err" >&2 || true
    fail "checksums.txt signature verification failed"
  fi
}

verify_artifact() {
  local path="$1"
  local name
  name="$(basename "$path")"
  download_checksums
  local expected
  expected="$(awk -v n="${name}" '$2 == n { print $1 }' "${CHECKSUMS_FILE}" | head -n 1)"
  if [ -z "${expected}" ]; then
    fail "checksums.txt does not contain ${name}"
  fi
  local actual
  actual="$(sha256_file "$path")"
  if [ "${actual}" != "${expected}" ]; then
    fail "checksum mismatch for ${name}"
  fi
  log "Verified ${name}"
}

prepare_tmpdir() {
  need_cmd curl
  need_cmd mktemp
  INSTALLER_TMPDIR="$(mktemp -d)"
}

install_macos() {
  prepare_tmpdir
  ensure_node

  local pkg="${INSTALLER_TMPDIR}/WokeyProviderNode-${VERSION}.pkg"
  download "${BASE_URL}/WokeyProviderNode-${VERSION}.pkg?v=${PACKAGE_REVISION}" "$pkg"
  verify_artifact "$pkg"

  log "Installing Wokey Provider Node ${VERSION} for macOS"
  sudo installer -pkg "$pkg" -target /

  if command -v wokey-node >/dev/null 2>&1; then
    wokey-node restart || true
    wokey-node status || true
  fi
}

install_linux_deb() {
  prepare_tmpdir
  ensure_node

  local deb="${INSTALLER_TMPDIR}/wokey-provider-node_${VERSION}_amd64.deb"
  download "${BASE_URL}/wokey-provider-node_${VERSION}_amd64.deb?v=${PACKAGE_REVISION}" "$deb"
  verify_artifact "$deb"

  log "Installing Wokey Provider Node ${VERSION} deb package"
  if command -v apt >/dev/null 2>&1; then
    sudo apt install -y "$deb"
  else
    sudo dpkg -i "$deb"
  fi

  wokey-node install-service
  wokey-node restart || true
  wokey-node status
}

install_linux_tarball() {
  local artifact_arch="${1:-x64}"
  prepare_tmpdir
  need_cmd tar
  ensure_node

  local tarball="${INSTALLER_TMPDIR}/WokeyProviderNode-linux-${artifact_arch}-${VERSION}.tar.gz"
  download "${BASE_URL}/WokeyProviderNode-linux-${artifact_arch}-${VERSION}.tar.gz?v=${PACKAGE_REVISION}" "$tarball"
  verify_artifact "$tarball"

  log "Installing Wokey Provider Node ${VERSION} ${artifact_arch} tarball"
  sudo tar -C / -xzf "$tarball"
  wokey-node install-service
  wokey-node restart || true
  wokey-node status
}

main() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "${os}" in
    Darwin)
      install_macos
      ;;
    Linux)
      case "${arch}" in
        x86_64|amd64)
          if command -v dpkg >/dev/null 2>&1; then
            install_linux_deb
          else
            install_linux_tarball x64
          fi
          ;;
        aarch64|arm64)
          install_linux_tarball arm64
          ;;
        *)
          fail "Linux ${arch} is not supported by this installer yet. Use the manual package downloads."
          ;;
      esac
      ;;
    *)
      fail "${os} is not supported by this installer yet."
      ;;
  esac
}

main "$@"
