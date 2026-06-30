// Builds the local console into a single self-contained HTML asset that the
// server serves. Bundles + minifies web/console/app.js (which also validates its
// syntax), inlines the CSS and JS, and keeps a __WOKEY_CSRF_JSON__ placeholder
// that the server fills in per process at first render.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'web/console');
const outDir = join(root, 'dist/console');

const html = readFileSync(join(srcDir, 'index.html'), 'utf8');
let css = readFileSync(join(srcDir, 'styles.css'), 'utf8');

// Inline the vendored woff2 fonts as base64 data URIs so the served console is
// a single self-contained asset with no external/static requests. The relative
// ./fonts/*.woff2 URLs still resolve for local dev (file://).
css = css.replace(/url\((['"]?)\.\/fonts\/([\w.-]+\.woff2)\1\)/g, (_match, _q, file) => {
  const data = readFileSync(join(srcDir, 'fonts', file)).toString('base64');
  return `url(data:font/woff2;base64,${data})`;
});

const bundled = await build({
  entryPoints: [join(srcDir, 'app.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  write: false,
  legalComments: 'none',
});
// Escape any closing-tag sequence so a string inside the JS/CSS can't terminate
// the inline <script>/<style> early. `<\/script` is still `</script` to the JS
// engine but is inert to the HTML parser.
const js = bundled.outputFiles[0].text.trimEnd().replace(/<\/(script)/gi, '<\\/$1');
const safeCss = css.trimEnd().replace(/<\/(style)/gi, '<\\/$1');

function replaceOnce(text, needle, replacement) {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`build-console: marker not found: ${needle}`);
  return text.slice(0, i) + replacement + text.slice(i + needle.length);
}

let out = replaceOnce(html, '<link rel="stylesheet" href="./styles.css">', `<style>\n${safeCss}\n</style>`);
out = replaceOnce(out, '<script src="./app.js"></script>', `<script>${js}</script>`);
if (!out.includes('__WOKEY_CSRF_JSON__')) throw new Error('build-console: CSRF placeholder missing from output');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), `${out}\n`);
console.log(`Wrote dist/console/index.html (${(out.length / 1024).toFixed(1)} KiB; js ${(js.length / 1024).toFixed(1)} KiB minified)`);
