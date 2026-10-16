import './offline-shim.js';
import { AudioEngine } from '../engine/engine.js';
import { allEffects, loadWorklets } from '../effects/registry.js';
import { BOOM_BAP, RATE, drumLoop, sineBuffer } from './signals.js';

const BPM = 120;

function signalFor(ctx, { signal, signalSeconds, seconds, frequency }) {
  if (signal === 'silence') return ctx.createBuffer(2, Math.round(seconds * RATE), RATE);
  if (signal === 'sine') return sineBuffer(ctx, frequency, seconds);
  return drumLoop(ctx, BPM, signalSeconds, BOOM_BAP, seconds);
}

async function render({ effectId = null, busId = 'bus1', params = {}, enabled = true, seconds = 2, signal = 'drums', signalSeconds = seconds, frequency = 220 } = {}) {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * RATE), RATE);
  await loadWorklets(ctx);
  const engine = new AudioEngine(ctx);
  engine.setMaster(1);
  engine.setBpm(BPM);
  const source = ctx.createBufferSource();
  source.buffer = signalFor(ctx, { signal, signalSeconds, seconds, frequency });
  engine.addSource(source, { id: 's', kind: 'test', label: 's', inputFx: busId === 'input' });
  if (effectId) {
    engine.setBusEffect(busId, effectId, params);
    engine.setBusEnabled(busId, enabled);
  }
  source.start();
  const out = await ctx.startRendering();
  return { l: out.getChannelData(0), r: out.getChannelData(1), state: engine.state };
}

function segment(x, from = 0, to = x.length / RATE) {
  return x.subarray(Math.round(from * RATE), Math.round(to * RATE));
}

function rms(x) {
  let sum = 0;
  for (const v of x) sum += v * v;
  return Math.sqrt(sum / Math.max(1, x.length));
}

function peak(x) {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
}

function finite(...arrays) {
  return arrays.every((x) => x.every(Number.isFinite));
}

function maxDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function highBand(x) {
  const d = new Float32Array(x.length - 1);
  for (let i = 1; i < x.length; i++) d[i - 1] = x[i] - x[i - 1];
  return rms(d);
}

function lowBand(x, width = 96) {
  const out = new Float32Array(Math.max(0, x.length - width));
  let acc = 0;
  for (let i = 0; i < width; i++) acc += x[i];
  for (let i = width; i < x.length; i++) {
    out[i - width] = acc / width;
    acc += x[i] - x[i - width];
  }
  return rms(out);
}

function goertzel(x, frequency) {
  const w = (2 * Math.PI * frequency) / RATE;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (const v of x) {
    const s0 = v + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

function pitchNear(x, expected) {
  let best = 0;
  let bestPower = -Infinity;
  for (let f = expected * 0.85; f <= expected * 1.15; f += 0.5) {
    const power = goertzel(x, f);
    if (power > bestPower) {
      bestPower = power;
      best = f;
    }
  }
  return best;
}

function airBand(x) {
  let d = x;
  for (let k = 0; k < 3; k++) {
    const next = new Float32Array(d.length - 1);
    for (let i = 1; i < d.length; i++) next[i - 1] = d[i] - d[i - 1];
    d = next;
  }
  return rms(d);
}

function distinct(x) {
  return new Set(Array.from(x, (v) => Math.round(v * 1e5))).size;
}

const db = (a, b) => 20 * Math.log10(Math.max(a, 1e-9) / Math.max(b, 1e-9));
const extremes = (effect, pick) => Object.fromEntries(effect.params.map((p) => [p.id, p.kind === 'enum' ? p.options[pick === 'min' ? 0 : p.options.length - 1] : p[pick]]));
const busFor = (effect) => (effect.buses.includes('bus1') ? 'bus1' : 'input');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail });
}

const SPECIFIC = {
  isolator: async (dry) => {
    const flat = await render({ effectId: 'isolator', params: { low: 1, mid: 1, high: 1 } });
    const mids = await render({ effectId: 'isolator' });
    return [
      ['all bands at 100% stay flat', Math.abs(db(rms(flat.l), rms(dry.l))) < 1.5, `${db(rms(flat.l), rms(dry.l)).toFixed(2)} dB vs dry`],
      ['defaults isolate the mids (lows killed)', db(lowBand(mids.l), lowBand(dry.l)) < -10, `low band ${db(lowBand(mids.l), lowBand(dry.l)).toFixed(1)} dB`]
    ];
  },
  equalizer: async (dry) => {
    const flat = await render({ effectId: 'equalizer' });
    const ref = await render({ signal: 'sine', frequency: 1000 });
    const boosted = await render({ effectId: 'equalizer', signal: 'sine', frequency: 1000, params: { midGain: 12, midFreq: 1000 } });
    const gain = db(rms(segment(boosted.l, 0.2)), rms(segment(ref.l, 0.2)));
    return [
      ['defaults are transparent', maxDiff(flat.l, dry.l) < 1e-3, `max diff ${maxDiff(flat.l, dry.l).toExponential(2)}`],
      ['+12 dB mid band boosts a 1 kHz tone by 12 dB', Math.abs(gain - 12) < 0.5, `${gain.toFixed(2)} dB`]
    ];
  },
  'super-filter': async () => {
    const gentle = await render({ effectId: 'filter-drive', params: { cutoff: 300, resonance: 0 } });
    const steep = await render({ effectId: 'super-filter', params: { cutoff: 300, slope: '48dB', resonance: 0 } });
    const air = (x) => airBand(segment(x, 0.3));
    return [['48 dB slope cuts highs harder than 12 dB', db(air(steep.l), air(gentle.l)) < -6, `${db(air(steep.l), air(gentle.l)).toFixed(1)} dB vs Filter + Drive`]];
  },
  limiter: async () => {
    const ceiling = Math.pow(10, -6 / 20);
    const slammed = await render({ effectId: 'limiter', params: { gain: 24, ceiling: -6 } });
    const ref = await render({ signal: 'sine', frequency: 220 });
    const quiet = await render({ effectId: 'limiter', signal: 'sine', frequency: 220, params: { gain: 0, ceiling: 0 } });
    const shift = Math.round(0.005 * RATE);
    const aligned = maxDiff(segment(quiet.l, 0.1), segment(ref.l, 0.1 - shift / RATE, 2 - shift / RATE));
    return [
      ['+24 dB into a -6 dB ceiling never exceeds the ceiling (after the 10 ms switch-on fade)', peak(segment(slammed.l, 0.1)) <= ceiling + 1e-6 && peak(segment(slammed.r, 0.1)) <= ceiling + 1e-6, `peak ${(20 * Math.log10(peak(segment(slammed.l, 0.1)))).toFixed(2)} dBFS (first 0.1 s: ${(20 * Math.log10(peak(segment(slammed.l, 0, 0.1)))).toFixed(2)})`],
      ['signal below the ceiling passes untouched (5 ms lookahead)', aligned < 1e-4, `max diff ${aligned.toExponential(2)}`]
    ];
  },
  compressor: async (dry) => {
    const squashed = await render({ effectId: 'compressor', params: { threshold: -40, ratio: 12, attack: 0.001, makeup: 0 } });
    return [['pulls loud material down', db(rms(segment(squashed.l, 0.5)), rms(segment(dry.l, 0.5))) < -6, `${db(rms(segment(squashed.l, 0.5)), rms(segment(dry.l, 0.5))).toFixed(1)} dB vs dry`]];
  },
  'bit-crusher': async () => {
    const crushed = await render({ effectId: 'bit-crusher', params: { bits: 2, rate: 48000, mix: 1 } });
    return [['2 bits quantizes to a handful of levels', distinct(segment(crushed.l, 0.2)) <= 6, `${distinct(segment(crushed.l, 0.2))} distinct values`]];
  },
  lofi: async (dry) => {
    const out = await render({ effectId: 'lofi', params: { rate: 6000, tone: 3000 } });
    return [['darkens the signal', db(highBand(out.l), highBand(dry.l)) < -6, `high band ${db(highBand(out.l), highBand(dry.l)).toFixed(1)} dB`]];
  },
  'vinyl-sim': async () => {
    const out = await render({ effectId: 'vinyl-sim', signal: 'silence', params: { noise: 1, hiss: 1 } });
    const drift = await wowDepth('vinyl-sim', { wow: 1, noise: 0, hiss: 0, drive: 0, tone: 20000 });
    return [
      ['adds crackle and hiss on silence', rms(out.l) > 1e-3, `rms ${rms(out.l).toExponential(2)}`],
      ['Wow 100% bends pitch at least 1.5%', drift >= 1.5, `${drift.toFixed(2)}% pitch swing`]
    ];
  },
  'cassette-sim': async (dry) => {
    const out = await render({ effectId: 'cassette-sim' });
    const drift = await wowDepth('cassette-sim', { wow: 1, flutter: 0, hiss: 0, drive: 0, tone: 20000 });
    return [
      ['colors the signal', maxDiff(out.l, dry.l) > 0.02, `max diff ${maxDiff(out.l, dry.l).toFixed(3)}`],
      ['Wow 100% bends pitch at least 1.5%', drift >= 1.5, `${drift.toFixed(2)}% pitch swing`]
    ];
  },
  delay: async () => tail('delay', {}),
  'tape-echo': async () => {
    const runaway = await render({ effectId: 'tape-echo', params: { feedback: 1.1, drive: 1 }, seconds: 5, signalSeconds: 1 });
    return [...(await tail('tape-echo', {})), ['self-oscillation stays bounded', finite(runaway.l) && peak(runaway.l) < 3, `peak ${peak(runaway.l).toFixed(2)}`]];
  },
  reverb: async () => tail('reverb', { time: 3 }),
  chorus: async (dry) => differs('chorus', dry),
  flanger: async (dry) => differs('flanger', dry),
  phaser: async (dry) => differs('phaser', dry),
  scatter: async (dry) => {
    const out = await render({ effectId: 'scatter', params: { type: '5', depth: 1 } });
    return [['gate pattern (type 5) mutes half the steps', db(rms(out.l), rms(dry.l)) < -1.5, `${db(rms(out.l), rms(dry.l)).toFixed(2)} dB vs dry`]];
  },
  stopper: async (dry) => differs('stopper', dry, { length: 0.5, division: '1/2' }),
  downer: async (dry) => differs('downer', dry, { division: '1/2', length: 1 }),
  looper: async () => tail('looper', { length: '1/4' }),
  slicer: async () => {
    const ref = await render({ signal: 'sine' });
    const out = await render({ effectId: 'slicer', signal: 'sine', params: { pattern: '1', depth: 1 } });
    const level = db(rms(out.l), rms(ref.l));
    return [['50% pattern on a steady tone gives about −3 dB', level < -2.5 && level > -4, `${level.toFixed(2)} dB vs dry`]];
  },
  'grain-cloud': async () => tail('grain-cloud', { spread: 1, feedback: 0.5, mix: 1 }),
  resonator: async () => tail('resonator', { decay: 1, mix: 1 }),
  'auto-pitch': async () => {
    const tuned = await render({ effectId: 'auto-pitch', busId: 'input', signal: 'sine', frequency: 230, seconds: 1.5, params: { key: 'C', scale: 'Major', amount: 1, speed: 0, mix: 1 } });
    const shifted = await render({ effectId: 'auto-pitch', busId: 'input', signal: 'sine', frequency: 230, seconds: 1.5, params: { amount: 0, shift: 12, mix: 1 } });
    const f1 = pitchNear(segment(tuned.l, 0.5), 225);
    const f2 = pitchNear(segment(shifted.l, 0.5), 460);
    return [
      ['snaps 230 Hz to A3 (220 Hz) in C major', Math.abs(f1 - 220) < 4, `${f1.toFixed(1)} Hz`],
      ['+12 st shift doubles pitch', Math.abs(f2 - 460) < 8, `${f2.toFixed(1)} Hz`]
    ];
  },
  vocoder: async (dry) => {
    const voiced = await render({ effectId: 'vocoder', busId: 'input' });
    const quiet = await render({ effectId: 'vocoder', busId: 'input', signal: 'silence' });
    return [
      ['speaks with input', rms(voiced.l) > 1e-3, `${db(rms(voiced.l), rms(dry.l)).toFixed(1)} dB vs dry`],
      ['silent without input', rms(segment(quiet.l, 0.3)) < 1e-3, `rms ${rms(segment(quiet.l, 0.3)).toExponential(2)}`]
    ];
  },
  'amp-sim': async (dry) => differs('amp-sim', dry, {}, 'input')
};

async function wowDepth(effectId, params) {
  const out = await render({ effectId, params, signal: 'sine', frequency: 440, seconds: 4 });
  const estimates = [];
  for (let t = 0.5; t + 0.1 <= 4; t += 0.1) estimates.push(pitchNear(segment(out.l, t, t + 0.1), 440));
  return ((Math.max(...estimates) - Math.min(...estimates)) / 440) * 100;
}

async function tail(effectId, params) {
  const out = await render({ effectId, params, seconds: 2.5, signalSeconds: 1 });
  const level = rms(segment(out.l, 1.6, 2.5));
  return [['keeps sounding after the input stops', level > 1e-4, `tail rms ${level.toExponential(2)}`]];
}

async function differs(effectId, dry, params = {}, busId = 'bus1') {
  const ref = busId === 'input' ? await render({ busId: 'input' }) : dry;
  const out = await render({ effectId, params, busId });
  return [['audibly changes the signal', maxDiff(out.l, ref.l) > 0.02, `max diff ${maxDiff(out.l, ref.l).toFixed(3)}`]];
}

async function run() {
  const dry = await render();
  for (const effect of allEffects()) {
    const busId = busFor(effect);
    const ref = busId === 'input' ? await render({ busId: 'input' }) : dry;
    const label = effect.name;

    const def = await render({ effectId: effect.id, busId });
    check(`${label}: defaults are stable`, finite(def.l, def.r) && peak(def.l) < 4 && rms(def.l) > 1e-3 && def.state.buses[busId].slots[0]?.effect === effect.id, `peak ${peak(def.l).toFixed(2)}, ${db(rms(def.l), rms(ref.l)).toFixed(1)} dB vs dry`);

    for (const pick of ['min', 'max']) {
      const out = await render({ effectId: effect.id, busId, params: extremes(effect, pick) });
      check(`${label}: all params at ${pick} stay finite (no runaway)`, finite(out.l, out.r) && peak(out.l) < 50, `peak ${peak(out.l).toFixed(2)}`);
    }

    const off = await render({ effectId: effect.id, busId, enabled: false });
    check(`${label}: bus OFF is bypassed`, maxDiff(off.l, ref.l) < 1e-4, `max diff ${maxDiff(off.l, ref.l).toExponential(2)}`);

    const zero = await render({ effectId: effect.id, busId, params: { mix: 0 } });
    const shift = Math.round((effect.latency ?? 0) * RATE);
    const aligned = maxDiff(segment(zero.l, 0.1), segment(ref.l, 0.1 - shift / RATE, 2 - shift / RATE));
    check(`${label}: mix 0 is dry${shift ? ' (latency-aligned)' : ''}`, aligned < 1e-3, `max diff ${aligned.toExponential(2)}`);

    for (const [name, pass, detail] of (await SPECIFIC[effect.id]?.(dry)) ?? []) check(`${label}: ${name}`, pass, detail);
  }
}

run()
  .catch((err) => check('Harness crashed', false, err.stack))
  .finally(() => {
    const passed = results.filter((r) => r.pass).length;
    const lines = results.map((r) => `<span class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</span>  ${r.name}  —  ${r.detail}`);
    document.getElementById('out').innerHTML = [...lines, '', `${passed}/${results.length} passed`].join('\n');
    window.__smoke = { passed, total: results.length, results };
  });
