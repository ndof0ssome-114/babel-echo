// diarize.mjs — map a whole-recording diarization back onto segments.
//
// Live recognition sends one sentence per request, and diarizing engines
// number speakers per request, so "speaker 0" in one request is unrelated to
// "speaker 0" in the next. One pass over the complete recording gives
// speaker numbers that hold for the whole meeting; this module assigns them
// to the existing segments by time overlap without touching their text.

/**
 * @param segments [{ index, start, end }] in milliseconds
 * @param words    [{ start, end, speaker }] in seconds, as Deepgram returns
 * @returns Map(index -> speaker number). Segments no word overlaps take the
 *          previous segment's speaker (or the next one's at the start).
 */
export function assignSpeakers(segments, words) {
  const spoken = words
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.speaker !== undefined && w.speaker !== null)
    .map((w) => ({ start: w.start * 1000, end: Math.max(w.end, w.start) * 1000, speaker: Number(w.speaker) }))
    .sort((a, b) => a.start - b.start);
  const result = new Map();
  let first = 0;
  for (const seg of segments) {
    // Words are sorted, so skip the ones that end before this segment starts.
    while (first < spoken.length && spoken[first].end <= seg.start) first++;
    const overlap = new Map();
    for (let i = first; i < spoken.length && spoken[i].start < seg.end; i++) {
      const w = spoken[i];
      // A zero-length word still counts as a brief vote for its speaker.
      const amount = Math.max(1, Math.min(w.end, seg.end) - Math.max(w.start, seg.start));
      overlap.set(w.speaker, (overlap.get(w.speaker) || 0) + amount);
    }
    let best = null;
    for (const [speaker, amount] of overlap) if (best === null || amount > overlap.get(best)) best = speaker;
    result.set(seg.index, best);
  }
  let previous = null;
  for (const seg of segments) {
    if (result.get(seg.index) === null) result.set(seg.index, previous);
    else previous = result.get(seg.index);
  }
  let next = null;
  for (const seg of [...segments].reverse()) {
    if (result.get(seg.index) === null) result.set(seg.index, next);
    else next = result.get(seg.index);
  }
  return result;
}

/** Number speakers 1, 2, 3… in order of first appearance. */
export function speakerNames(segments, assignment, nameFor = (n) => '说话人' + n) {
  const names = new Map();
  for (const seg of segments) {
    const speaker = assignment.get(seg.index);
    if (speaker !== null && speaker !== undefined && !names.has(speaker)) names.set(speaker, nameFor(names.size + 1));
  }
  return names;
}
