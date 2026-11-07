import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { makeTestFixtures } from './make-test-fixtures.mjs';
import { READER_EXAMPLE } from '../public/reader-example.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(process.argv[2] || join(root, 'apps/desktop/.probe/mac-test-kit'));
mkdirSync(output, { recursive: true });
makeTestFixtures(output);
copyFileSync(join(root, 'docs/MAC_TESTING.md'), join(output, 'README.md'));
const version = JSON.parse(readFileSync(join(root, 'apps/desktop/desktop/package.json'), 'utf8')).version;
copyFileSync(join(root, `docs/DESKTOP-${version.split('-')[1]}-VERIFICATION.md`), join(output, 'WINDOWS-VERIFICATION.md'));
copyFileSync(join(root, 'docs/MARKDOWN_READER.md'), join(output, 'MARKDOWN-READER.md'));
copyFileSync(join(root, 'docs/CLASSROOM_NOTES.md'), join(output, 'CLASSROOM_NOTES.md'));
copyFileSync(join(root, `docs/MAC-${version.split('-')[1]}-VERIFICATION.md`), join(output, 'MAC-VERIFICATION.md'));
for (const filename of ['README.md', 'WINDOWS-VERIFICATION.md', 'MAC-VERIFICATION.md']) {
  const documentPath = join(output, filename);
  writeFileSync(documentPath, readFileSync(documentPath, 'utf8').replaceAll(`(MAC-${version.split('-')[1]}-VERIFICATION.md)`, '(MAC-VERIFICATION.md)').replaceAll('(MAC_TESTING.md)', '(README.md)'));
}
writeFileSync(join(output, 'markdown-reader-example.md'), READER_EXAMPLE, 'utf8');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ version, commit,
  repository: 'ndof0ssome-114/babelecho-monorepo', platform: 'darwin-arm64',
  containsPrivateData: false, fixtures: 'deterministic tones and silence; no speech' }, null, 2) + '\n');
console.log(`Mac test kit staged: ${output}`);
