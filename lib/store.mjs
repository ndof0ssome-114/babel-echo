// store.mjs — dependency-free persistence for meetings.
//
// One JSON document per meeting under data/meetings, plus the audio file
// under data/audio. Small enough to read whole, large enough to survive a
// server restart mid-meeting (the state is flushed as the meeting runs).

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, statSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { MEETINGS_DIR, AUDIO_DIR, ensureDirs } from './config.mjs';

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function meetingPath(id) {
  return join(MEETINGS_DIR, id + '.json');
}

export function saveMeeting(meeting) {
  if (!isValidId(meeting.id)) throw new Error('invalid meeting id');
  ensureDirs();
  const doc = {
    id: meeting.id,
    title: meeting.title,
    language: meeting.language,
    mode: meeting.mode || 'meeting',
    notesDetail: meeting.notesDetail || 'detailed',
    summaryMode: meeting.summaryMode || 'meeting',
    translateTo: meeting.translateTo,
    createdAt: meeting.createdAt,
    updatedAt: Date.now(),
    state: meeting.state,
    segments: meeting.segments,
    summary: meeting.summary,
    summaryUpTo: meeting.summaryUpTo,
    summaryAt: meeting.summaryAt,
    minutes: meeting.minutes,
    chapters: meeting.chapters || [],
    speakers: meeting.speakers || {},
    speakerBackup: meeting.speakerBackup || null,
    qa: meeting.qa || [],
    stats: meeting.stats,
    audio: meeting.audio || null,
    source: meeting.source || 'live',
    durationMs: meeting.durationMs || 0,
    upstream: meeting.upstream || null,
  };
  // Replace only after a complete write; a failed write must not truncate
  // the last readable version of a meeting. Keep both files on one filesystem.
  const target = meetingPath(meeting.id);
  const temporary = target + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(doc, null, 2), { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* best effort */ }
    }
  }
  return doc;
}

export function loadMeeting(id) {
  if (!isValidId(id)) return null;
  const p = meetingPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function listMeetings() {
  ensureDirs();
  const out = [];
  for (const name of readdirSync(MEETINGS_DIR)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    const doc = loadMeeting(id);
    if (!doc) continue;
    out.push({
      id: doc.id,
      title: doc.title,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      state: doc.state,
      durationMs: doc.durationMs,
      segments: (doc.segments || []).length,
      hasMinutes: !!doc.minutes,
      source: doc.source || 'live',
      preview: (doc.segments || []).slice(0, 2).map((s) => s.text).join(' ').slice(0, 120),
      upstream: doc.upstream || null,
    });
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

/** Startup only needs existence, not every transcript loaded into memory. */
export function hasMeetings() {
  ensureDirs();
  return readdirSync(MEETINGS_DIR).some((name) => name.endsWith('.json'));
}

export function deleteMeeting(id) {
  if (!isValidId(id)) return false;
  let removed = false;
  const p = meetingPath(id);
  if (existsSync(p)) {
    unlinkSync(p);
    removed = true;
  }
  for (const ext of ['.wav', '.mp3', '.webm', '.m4a', '.ogg']) {
    const a = join(AUDIO_DIR, id + ext);
    if (existsSync(a)) {
      unlinkSync(a);
      removed = true;
    }
  }
  return removed;
}

export function audioPath(id, ext) {
  return join(AUDIO_DIR, id + ext);
}

export function findAudio(id) {
  for (const ext of ['.mp3', '.wav', '.webm', '.m4a', '.ogg']) {
    const p = join(AUDIO_DIR, id + ext);
    if (existsSync(p)) return { path: p, ext, size: statSync(p).size };
  }
  return null;
}
