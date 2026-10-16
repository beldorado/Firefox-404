import { PAD_COUNT } from '../shared/state.js';
import { fadeTo } from '../effects/lib.js';

const RELEASE = 0.006;
const PEAK_BINS = 48;

export function peaksOf(buffer, bins = PEAK_BINS, start = 0, end = buffer.duration) {
  const peaks = new Array(bins).fill(0);
  const from = Math.max(0, Math.floor(start * buffer.sampleRate));
  const to = Math.min(buffer.length, Math.ceil(end * buffer.sampleRate));
  const per = Math.max(1, to - from) / bins;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let b = 0; b < bins; b++) {
      let p = peaks[b];
      for (let i = from + Math.floor(b * per), stop = Math.min(to, from + Math.floor((b + 1) * per)); i < stop; i++) p = Math.max(p, Math.abs(data[i]));
      peaks[b] = p;
    }
  }
  return peaks.map((p) => Math.round(Math.min(1, p) * 100) / 100);
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
    const voice = { source, gain, startAt };
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

  setLoop(index, offset, duration) {
    const voice = this.voices.get(index);
    if (!voice?.source.loop) return;
    voice.source.loopStart = offset;
    voice.source.loopEnd = offset + duration;
  }

  setRate(index, rate) {
    this.voices.get(index)?.source.playbackRate.setTargetAtTime(rate, this.ctx.currentTime, 0.01);
  }

  setLevel(index, level) {
    this.voices.get(index)?.gain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.01);
  }
}
