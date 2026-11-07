// Optional frontend asset preparation; the HTTP/recording server stays dependency-free.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'desktop/package.json'));
const output = join(root, 'public/vendor/markdown');
const fingerprint = createHash('sha256').update(readFileSync(join(root, 'desktop/package-lock.json')))
  .update(readFileSync(join(root, 'scripts/markdown-vendor-entry.mjs'))).update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
try {
  const old = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
  if (old.fingerprint === fingerprint && old.files.every((file) => existsSync(join(output, file)))) {
    console.log('Local Markdown assets are current.');
    process.exit(0);
  }
} catch { /* First install or updated locked dependencies. */ }
mkdirSync(output, { recursive: true });
const { build } = require('esbuild');
const result = await build({ entryPoints: { engine: join(root, 'scripts/markdown-vendor-entry.mjs') },
  outdir: output, absWorkingDir: root, nodePaths: [join(root, 'desktop/node_modules')],
  bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
  minify: true, metafile: true, legalComments: 'eof', chunkNames: 'chunks/[name]-[hash]', logLevel: 'warning' });
const katexDir = dirname(require.resolve('katex/package.json'));
cpSync(join(katexDir, 'dist/katex.min.css'), join(output, 'katex.min.css'));
cpSync(join(katexDir, 'dist/fonts'), join(output, 'fonts'), { recursive: true });
// Collect licenses of packages actually present in the browser bundle.
const packages = new Map();
for (const file of Object.keys(result.metafile.inputs)) {
  let dir = dirname(resolve(root, file));
  while (dir.startsWith(join(root, 'desktop/node_modules'))) {
    if (existsSync(join(dir, 'package.json'))) {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name) packages.set(pkg.name, { dir, pkg });
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
const notices = [...packages.values()].map(({ dir, pkg }) => {
  const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'COPYING'].find((name) => existsSync(join(dir, name)));
  return `${pkg.name} ${pkg.version} (${typeof pkg.license === 'string' ? pkg.license : 'See package license'})\n` +
    (license ? readFileSync(join(dir, license), 'utf8') : 'License information: https://www.npmjs.com/package/' + pkg.name);
}).join('\n\n----------------------------------------\n\n');
writeFileSync(join(output, 'THIRD_PARTY_NOTICES.txt'), notices, 'utf8');
const files = Object.keys(result.metafile.outputs).map((file) => resolve(root, file).slice(output.length + 1).replaceAll('\\', '/'));
files.push('katex.min.css', 'fonts/KaTeX_Main-Regular.woff2', 'THIRD_PARTY_NOTICES.txt');
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ fingerprint, files }, null, 2) + '\n');
console.log(`Prepared local Markdown/Mermaid assets (${files.length} outputs, ${packages.size} package notices).`);
