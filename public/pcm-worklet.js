// pcm-worklet.js — capture thread for microphone audio.
//
// The recorder needs raw 16 kHz mono Int16 PCM because that is what both
// MiMo ASR (via a WAV container) and the server-side VAD expect. Doing the
// conversion here keeps the main thread free and lets us hand off buffers
// with zero copies.

const FRAME = 1024; // ~64 ms at 16 kHz

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rest = new Float32Array(0);
    this.muted = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'mute') this.muted = !!e.data.value;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    const ch = input[0];

    let merged;
    if (this.rest.length) {
      merged = new Float32Array(this.rest.length + ch.length);
      merged.set(this.rest, 0);
      merged.set(ch, this.rest.length);
    } else {
      merged = ch;
    }

    let off = 0;
    while (merged.length - off >= FRAME) {
      const out = new Int16Array(FRAME);
      if (this.muted) {
        // keep the timeline intact while muted
        this.port.postMessage(out, [out.buffer]);
      } else {
        for (let i = 0; i < FRAME; i++) {
          const s = Math.max(-1, Math.min(1, merged[off + i]));
          out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage(out, [out.buffer]);
      }
      off += FRAME;
    }

    this.rest = merged.length > off ? merged.slice(off) : new Float32Array(0);
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
