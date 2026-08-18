#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

fail() {
  echo "OSS boundary audit failed: $*" >&2
  exit 1
}

grep_scan() {
  grep "$@"
  local status=$?
  if [ "${status}" -gt 1 ]; then
    fail "grep failed while scanning the repository"
  fi
  return "${status}"
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

if grep_scan -EnR --binary-files=without-match \
  --exclude='audit-oss-boundary.sh' \
  --exclude='jimeng-credential-store.ts' \
  --exclude='jimeng_auth.test.ts' \
  'exchangeAnthropicSessionKey|detectClaudeBrowserSession|readClaudeBrowserSession|Network/Cookies|Chrome Safe Storage|sessionKey=|browser-session/import|from-session|scopeBrowserSession|browserUserAgent|Keychain|find-generic-password|Claude Code-credentials|/usr/bin/security' \
  src tests packaging scripts web; then
  fail "browser cookie/session import code must not be present"
fi

# The Jimeng CLI stores its own credential in the native macOS Keychain. Keep
# that narrowly scoped exception auditable: the implementation and its tests
# may use /usr/bin/security, but must never grow browser/Claude import behavior,
# and the production target must remain the fixed Jimeng service and account.
if grep_scan -En \
  'exchangeAnthropicSessionKey|detectClaudeBrowserSession|readClaudeBrowserSession|Network/Cookies|Chrome Safe Storage|sessionKey=|browser-session/import|from-session|scopeBrowserSession|browserUserAgent|Claude Code-credentials' \
  src/provider-node/jimeng-credential-store.ts tests/jimeng_auth.test.ts; then
  fail "Jimeng keychain support must not import browser or Claude secrets"
fi
if ! grep_scan -Fq "const KEYRING_SERVICE = 'dreamina';" src/provider-node/jimeng-credential-store.ts \
  || ! grep_scan -Fq "const KEYRING_ACCOUNT = 'byted_cli_user_token';" src/provider-node/jimeng-credential-store.ts; then
  fail "Jimeng keychain support must use the fixed dreamina credential target"
fi

if grep_scan -EnR --binary-files=without-match \
  --exclude-dir='.git' \
  --exclude-dir='node_modules' \
  --exclude-dir='release' \
  --exclude-dir='.tmp' \
  --exclude='audit-oss-boundary.sh' \
  'web/public/downloads/provider-node|src/platform/|deploy/scripts|prod-exec' .; then
  fail "private monorepo paths must not be referenced"
fi

# Platform-internal infrastructure detail must not leak through code comments,
# docs, or tests: CDN-bypass topology, internal admin/control hostnames, internal
# demand-side jargon ("seeker"), internal milestone tags ("(M3)"), and internal
# subsystem vocabulary the node never consumes (tunnel broker, entitlement check,
# slot scheduling, official-exit governance fields, credential safety tiers).
if grep_scan -EnR --binary-files=without-match \
  --exclude-dir='.git' \
  --exclude-dir='node_modules' \
  --exclude-dir='release' \
  --exclude-dir='.tmp' \
  --exclude='package-lock.json' \
  --exclude='audit-oss-boundary.sh' \
  -e 'grey-?cloud' \
  -e '[Cc]loudflare' \
  -e '(^|[^[:alnum:]_])seeker([^[:alnum:]_]|$)' \
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
