// Verifies the release manifest's Sigstore bundle exactly as v0.1.101 and older
// macOS runtime updaters do, so those nodes can still upgrade to this release.
// Usage: tsx scripts/verify-release-signature.ts <checksums.txt> <checksums.txt.sigstore.json> <workflow ref>
import { readFileSync } from 'node:fs';
import { type Bundle, verify } from 'sigstore';

const [manifestPath, bundlePath, workflowRef] = process.argv.slice(2);
if (!manifestPath || !bundlePath || !workflowRef) {
  process.stderr.write('usage: verify-release-signature.ts <checksums.txt> <checksums.txt.sigstore.json> <workflow ref>\n');
  process.exit(2);
}
const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as Bundle;
await verify(bundle, readFileSync(manifestPath), {
  certificateIssuer: 'https://token.actions.githubusercontent.com',
  certificateIdentityURI: `https://github.com/focuxdot/wokey-provider-node/.github/workflows/release.yml@${workflowRef}`,
  ctLogThreshold: 1,
  tlogThreshold: 1,
});
process.stdout.write(`Verified ${manifestPath} against release.yml@${workflowRef}\n`);
