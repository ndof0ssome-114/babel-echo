// Shared Windows/macOS entry point. Suites use temporary data and mock providers.
import { spawnSync } from 'node:child_process';
import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'babel-offline-'));
const env = { ...process.env, MIAOJI_DATA_DIR: sandbox,
  MIAOJI_CONFIG_PATH: join(sandbox, 'config.json'), MIAOJI_ALLOW_ENV_CREDENTIALS: '0' };
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed (${result.status})`);
}
function sources(relative) {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : sources(path);
    return /\.(mjs|cjs|js)$/.test(entry.name) ? [path] : [];
  });
}
try {
  const files = ['server.mjs', ...readdirSync(join(root, 'desktop')).filter((file) => file.endsWith('.cjs')).map((file) => join('desktop', file)),
    ...sources('lib'), ...sources('public'), ...sources('scripts')];
  for (const file of files) run(['--check', file]);
  console.log(`Syntax: ${files.length} files passed`);
  const suites = ['adapters', 'regressions', 'storage', 'llm-cost', 'local-access',
    'realtime-timing', 'language-migration', 'custom-providers', 'asr-limit', 'appearance', 'markdown', 'notes',
    'recording-lifecycle', 'sentences', 'quick-setup', 'review-fixes'];
  for (const name of suites) {
    console.log(`Running ${name}`);
    run([`scripts/test-${name}.mjs`]);
  }
  console.log(`Offline verification: ${suites.length}/${suites.length} suites passed (${process.platform}, ${process.version})`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
