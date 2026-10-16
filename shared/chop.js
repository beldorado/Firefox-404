export const SLICE_FADE_SECONDS = 0.002;
export const MIN_SLICE_SECONDS = 0.02;

const HOP = 256;
const MIN_GAP_SECONDS = 0.06;
const ZERO_SEARCH_SECONDS = 0.004;

export function mono(channels, from = 0, to = channels[0].length) {
  const out = new Float32Array(Math.max(0, to - from));
  for (const data of channels) for (let i = 0; i < out.length; i++) out[i] += data[from + i] / channels.length;
  return out;
}

export function zeroCrossing(data, frame, radius) {
  const at = Math.round(frame);
  for (let d = 0; d <= radius; d++) {
    for (const i of [at - d, at + d]) {
      if (i > 0 && i < data.length && (data[i - 1] <= 0) !== (data[i] <= 0)) return i;
    }
  }
  return at;
}

export function crossingBefore(data, frame, radius) {
  const at = Math.round(frame);
  for (let i = at; i > Math.max(0, at - radius); i--) if ((data[i - 1] <= 0) !== (data[i] <= 0)) return i;
  return at;
}

export function snapTime(time, { data = null, sampleRate = 48000, zero = true } = {}) {
  if (zero && data) return zeroCrossing(data, time * sampleRate, Math.round(ZERO_SEARCH_SECONDS * sampleRate)) / sampleRate;
  return time;
}

export function equalChops(start, end, count) {
  const n = Math.max(1, Math.round(count));
  return Array.from({ length: n - 1 }, (_, i) => start + ((end - start) * (i + 1)) / n);
}

export function cleanChops(chops, start, end) {
  const sorted = [...new Set(chops.map((t) => Math.round(t * 1e6) / 1e6))].filter((t) => t > start + MIN_SLICE_SECONDS && t < end - MIN_SLICE_SECONDS).sort((a, b) => a - b);
  const out = [];
  for (const t of sorted) if (!out.length || t - out[out.length - 1] >= MIN_SLICE_SECONDS) out.push(t);
  return out;
}

export function slicesFrom(start, end, chops) {
  const points = [start, ...cleanChops(chops, start, end), end];
  return points.slice(0, -1).map((a, i) => ({ start: a, end: points[i + 1] }));
}

export function detectTransients(channels, sampleRate, { start = 0, end = channels[0].length / sampleRate, sensitivity = 0.5, max = 16 } = {}) {
  const from = Math.max(0, Math.round(start * sampleRate));
  const to = Math.min(channels[0].length, Math.round(end * sampleRate));
  const data = mono(channels, from, to);
  const frames = Math.floor(data.length / HOP);
  if (frames < 3) return [];
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * HOP; i < (f + 1) * HOP; i++) sum += data[i] * data[i];
    energy[f] = Math.log1p((1000 * sum) / HOP);
  }
  const flux = new Float32Array(frames);
  for (let f = 1; f < frames; f++) flux[f] = Math.max(0, energy[f] - energy[f - 1]);
  const peak = flux.reduce((a, b) => Math.max(a, b), 0);
  if (peak <= 0) return [];
  const threshold = peak * (0.6 - 0.5 * Math.min(1, Math.max(0, sensitivity)));
  const gap = Math.max(1, Math.round((MIN_GAP_SECONDS * sampleRate) / HOP));
  const candidates = [];
  for (let f = 1; f < frames - 1; f++) {
    if (flux[f] >= threshold && flux[f] >= flux[f - 1] && flux[f] > flux[f + 1]) candidates.push({ f, strength: flux[f] });
  }
  const picked = [];
  for (const c of candidates.sort((a, b) => b.strength - a.strength)) {
    if (picked.every((p) => Math.abs(p.f - c.f) >= gap)) picked.push(c);
  }
  const radius = Math.round(ZERO_SEARCH_SECONDS * sampleRate);
  return cleanChops(
    picked
      .map(({ f }) => {
        const lo = (f - 1) * HOP;
        const hi = Math.min(data.length, (f + 1) * HOP);
        let loudest = 0;
        for (let i = lo; i < hi; i++) loudest = Math.max(loudest, Math.abs(data[i]));
        let at = lo;
        while (at < hi && Math.abs(data[at]) < loudest * 0.25) at++;
        return (from + crossingBefore(data, at, radius)) / sampleRate;
      })
      .slice(0, Math.max(0, max - 1)),
    start,
    end
  );
}

// Cuts a stored pad record down to start–end for good. No fades, so it sounds exactly like the trimmed pad did.
export function truncateClip(record, start, end, chops = []) {
  const length = end - start;
  const named = /^(?:[\d.]+ s|\d+ bars?) at (\d+) BPM$/.exec(record.name ?? '');
  return {
    ...record,
    name: named ? `${length.toFixed(1)} s at ${named[1]} BPM` : record.name,
    channels: extractSlice(record.channels, record.sampleRate, start, end, 0),
    start: 0,
    end: null,
    chops: cleanChops(chops.map((t) => t - start), 0, length)
  };
}

export function extractSlice(channels, sampleRate, start, end, fade = SLICE_FADE_SECONDS) {
  const from = Math.max(0, Math.round(start * sampleRate));
  const to = Math.min(channels[0].length, Math.round(end * sampleRate));
  const ramp = Math.min(Math.round(fade * sampleRate), Math.floor((to - from) / 2));
  return channels.map((data) => {
    const out = data.slice(from, to);
    for (let i = 0; i < ramp; i++) {
      const g = i / ramp;
      out[i] *= g;
      out[out.length - 1 - i] *= g;
    }
    return out;
  });
}
