#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

fail() {
  echo "OSS boundary audit failed: $*" >&2
  exit 1
}

if [ -d src/platform ]; then
  fail "src/platform must not exist in the public Provider Node repository"
fi

if find . -path './.git' -prune -o -path './node_modules' -prune -o -path './release' -prune -o -path './.tmp' -prune -o -type f \( \
  -name '*.dmg' -o -name '*.pkg' -o -name '*.deb' -o -name '*.zip' -o -name '*.tar.gz' \
\) -print | grep -q .; then
  fail "binary release artifacts must not be committed"
fi

if [ -d dist ]; then
  while IFS= read -r built_file; do
    rel="${built_file#dist/}"
    case "${rel}" in
      console/index.html|provider-node/build-info.json)
        continue
        ;;
    esac
    src_file="src/${rel%.js}.ts"
    if [ ! -f "${src_file}" ]; then
      fail "stale dist output without source must not be published: ${built_file}"
    fi
  done < <(find dist -type f -name '*.js' | sort)
fi

if rg -n --glob '!docs/**' --glob '!README.md' --glob '!CONTRIBUTING.md' \
  --glob '!scripts/audit-oss-boundary.sh' \
  'exchangeAnthropicSessionKey|detectClaudeBrowserSession|readClaudeBrowserSession|Network/Cookies|Chrome Safe Storage|sessionKey=|browser-session/import|from-session|scopeBrowserSession|browserUserAgent|Keychain|find-generic-password|Claude Code-credentials|/usr/bin/security' \
  src tests packaging scripts web; then
  fail "browser cookie/session import code must not be present"
fi

if rg -n 'web/public/downloads/provider-node|src/platform/|deploy/scripts|prod-exec' . \
  --glob '!node_modules/**' \
  --glob '!release/**' \
  --glob '!.tmp/**' \
  --glob '!scripts/audit-oss-boundary.sh'; then
  fail "private monorepo paths must not be referenced"
fi

# Platform-internal infrastructure detail must not leak through code comments,
# docs, or tests: CDN-bypass topology, internal admin/control hostnames, internal
# demand-side jargon ("seeker"), internal milestone tags ("(M3)"), and internal
# subsystem vocabulary the node never consumes (tunnel broker, entitlement check,
# slot scheduling, official-exit governance fields, credential safety tiers).
if rg -n \
  --glob '!node_modules/**' \
  --glob '!release/**' \
  --glob '!.tmp/**' \
  --glob '!package-lock.json' \
  --glob '!scripts/audit-oss-boundary.sh' \
  -e 'grey-?cloud' \
  -e '[Cc]loudflare' \
  -e '\bseeker\b' \
  -e '\(M[0-9]+\)' \
  -e 'entitlementCheckId' \
  -e 'tunnelEndpointId|tunnelToken|tunnelNonce' \
  -e 'slotId' \
  -e '[Pp]olicyVersion' \
  -e 'SafetyTier' \
  -e 'slowMode' \
  -e 'allowedVendors' \
  .; then
  fail "platform-internal infrastructure detail must not be referenced (CDN/internal admin host/internal jargon/internal subsystem fields)"
fi

echo "OSS boundary audit passed."
