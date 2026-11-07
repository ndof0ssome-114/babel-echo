// sentences.mjs — sentence boundaries for transcript segments.
//
// ASR requests end wherever audio was cut, not where a sentence ends. These
// helpers let the meeting reassemble cut sentences and split long blocks, so
// one segment reads (and translates) as one complete thought.

// Terminal punctuation plus any closing quotes or brackets that belong to it.
// A Latin period only ends a sentence before whitespace or the end, which
// keeps decimals such as 3.5 and versions such as v1.2 intact.
const END = /(?:[。！？!?…]+|\.(?=\s|$))["'”’」』）)\]]*/gu;

/** Split text into sentences; the last element may be an unfinished one. */
export function splitSentences(text) {
  const value = String(text || '').trim();
  if (!value) return [];
  const out = [];
  let from = 0;
  for (const match of value.matchAll(END)) {
    const to = match.index + match[0].length;
    const sentence = value.slice(from, to).trim();
    if (sentence) out.push(sentence);
    from = to;
  }
  const rest = value.slice(from).trim();
  if (rest) out.push(rest);
  return out;
}

/** Whether text finishes on terminal punctuation. */
export function endsSentence(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  let last = null;
  for (const match of value.matchAll(END)) last = match;
  return !!last && last.index + last[0].length === value.length;
}

/** Concatenate two pieces, adding a space only between Latin words. */
export function joinText(left, right) {
  const a = String(left || '').trimEnd();
  const b = String(right || '').trimStart();
  if (!a) return b;
  if (!b) return a;
  const latin = /[\p{Script=Latin}\p{N}.,;:!?'"”’)\]]$/u.test(a) && /^[\p{Script=Latin}\p{N}("“‘[]/u.test(b);
  return a + (latin ? ' ' : '') + b;
}

/**
 * Group sentences into segments of roughly `target` characters. A sentence
 * longer than `target` stays whole; sentences are never split mid-way.
 */
export function groupSentences(sentences, target) {
  const groups = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > target) {
      groups.push(current);
      current = sentence;
    } else {
      current = joinText(current, sentence);
    }
  }
  if (current) groups.push(current);
  return groups;
}
