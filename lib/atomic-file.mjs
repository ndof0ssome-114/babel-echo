// atomic-file.mjs — crash-safe writes for small settings files.
//
// A settings file that is half written when the process dies must never
// become the reason the next save discards everything else in it. Writes go
// to a sibling temporary file first and replace the target by rename, which
// is atomic on one filesystem. Unreadable files are moved aside, not
// overwritten, so whatever they still hold can be recovered by hand.

import { writeFileSync, renameSync, existsSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

/** Write text to path atomically. `mode` restricts permissions (POSIX only). */
export function writeFileAtomic(path, text, { mode } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + '.' + randomBytes(6).toString('hex') + '.tmp';
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', ...(mode ? { mode } : {}) });
    renameSync(temporary, path);
    // rename keeps the temporary file's mode; an older target may have been
    // created world-readable, so tighten the final file explicitly too.
    if (mode && process.platform !== 'win32') {
      try { chmodSync(path, mode); } catch { /* best effort */ }
    }
  } finally {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* best effort */ }
    }
  }
}

/**
 * Move an unreadable file out of the way so the next write cannot destroy
 * it. Returns the backup path, or null if nothing was moved.
 */
export function quarantineFile(path) {
  if (!existsSync(path)) return null;
  const backup = path + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
  try {
    renameSync(path, backup);
    return backup;
  } catch {
    return null;
  }
}
