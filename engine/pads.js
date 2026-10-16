import { PAD_COUNT } from '../shared/state.js';
import { fadeTo } from '../effects/lib.js';

const RELEASE = 0.006;
const PEAK_BINS = 48;

const level = (v) => Math.round(Math.min(1, v) * 100) / 100;

// Peak and RMS per bin of the mono mix, the same signal the waveform editor draws.
export function waveOf(buffer, bins = PEAK_BINS, start = 0, end = buffer.duration) {
  const peaks = new Array(bins).fill(0);
  const rms = new Array(bins).fill(0);
  const from = Math.max(0, Math.floor(start * buffer.sampleRate));
  const to = Math.min(buffer.length, Math.ceil(end * buffer.sampleRate));
  const per = Math.max(1, to - from) / bins;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch));
  for (let b = 0; b < bins; b++) {
    const lo = from + Math.floor(b * per);
    const hi = Math.min(to, from + Math.floor((b + 1) * per));
    let peak = 0;
    let sum = 0;
    for (let i = lo; i < hi; i++) {
      let v = 0;
      for (const data of channels) v += data[i];
      v /= channels.length;
      peak = Math.max(peak, Math.abs(v));
      sum += v * v;
    }
    peaks[b] = level(peak);
    rms[b] = level(Math.sqrt(sum / Math.max(1, hi - lo)));
  }
  return { peaks, rms };
}

export class PadBank {
  constructor(ctx, { onEnded = () => {} } = {}) {
    this.ctx = ctx;
    this.onEnded = onEnded;
    this.output = ctx.createGain();
    this.buffers = new Array(PAD_COUNT).fill(null);
    this.voices = new Map();
  }

  setBuffer(index, buffer) {
    this.stop(index);
    if (this.previewOf === index) this.stop('preview');
    this.buffers[index] = buffer;
  }

  has(index) {
    return Boolean(this.buffers[index]);
  }

  playing(index) {
    return this.voices.has(index);
  }

  start(index, { loop = false, when = 0, rate = 1, level = 1, offset = 0, duration = null } = {}) {
    const buffer = this.buffers[typeof index === 'number' ? index : this.previewOf];
    if (!buffer) return false;
    this.stop(index);
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    const length = duration ?? buffer.duration - offset;
    source.buffer = buffer;
    source.loop = loop;
    if (loop) {
      source.loopStart = offset;
      source.loopEnd = offset + length;
    }
    source.playbackRate.value = rate;
    gain.gain.value = level;
    source.connect(gain).connect(this.output);
    const startAt = Math.max(this.ctx.currentTime, when);
    const voice = { source, gain, startAt, loop, rate, offset, length, anchorAt: startAt, anchorPos: offset };
    source.addEventListener('ended', () => {
      gain.disconnect();
      if (this.voices.get(index) !== voice) return;
      this.voices.delete(index);
      this.onEnded(index);
    });
    if (loop) source.start(startAt, offset);
    else source.start(startAt, offset, length);
    this.voices.set(index, voice);
    return true;
  }

  stop(index, when = 0) {
    const voice = this.voices.get(index);
    if (!voice) return false;
    this.voices.delete(index);
    const at = Math.max(this.ctx.currentTime, when);
    if (at <= voice.startAt) {
      voice.source.stop();
      return true;
    }
    fadeTo(voice.gain.gain, 0, at, at, RELEASE * 4);
    try {
      voice.source.stop(at + RELEASE * 8);
    } catch {}
    return true;
  }

  stopAll() {
    for (const index of [...this.voices.keys()]) this.stop(index);
  }

  preview(index, { offset, duration }) {
    if (!this.buffers[index]) return false;
    this.previewOf = index;
    return this.start('preview', { offset, duration });
  }

  positionOf(voice, time) {
    const at = voice.anchorPos + Math.max(0, time - voice.anchorAt) * voice.rate;
    const end = voice.offset + voice.length;
    if (!voice.loop) return Math.min(at, end);
    return at < end ? at : voice.offset + ((at - voice.offset) % voice.length);
  }

  // Where in the buffer a voice is at `time`, or null if it hasn't started yet.
  head(index, time = this.ctx.currentTime) {
    const voice = this.voices.get(index);
    if (!voice || time < voice.startAt) return null;
    return { at: this.positionOf(voice, time), rate: voice.rate, start: voice.offset, end: voice.offset + voice.length, loop: voice.loop };
  }

  reanchor(voice) {
    const now = this.ctx.currentTime;
    if (now <= voice.anchorAt) return;
    voice.anchorPos = this.positionOf(voice, now);
    voice.anchorAt = now;
  }

  setLoop(index, offset, duration) {
    const voice = this.voices.get(index);
    if (!voice?.source.loop) return;
    this.reanchor(voice);
    voice.offset = offset;
    voice.length = duration;
    voice.source.loopStart = offset;
    voice.source.loopEnd = offset + duration;
  }

  setRate(index, rate) {
    const voice = this.voices.get(index);
    if (!voice) return;
    this.reanchor(voice);
    voice.rate = rate;
    voice.source.playbackRate.setTargetAtTime(rate, this.ctx.currentTime, 0.01);
  }

  setLevel(index, level) {
    this.voices.get(index)?.gain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.01);
  }
}
