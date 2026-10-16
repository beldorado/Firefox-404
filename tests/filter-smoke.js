import './offline-shim.js';
import { AudioEngine } from '../engine/engine.js';
import { PRESETS } from '../engine/presets.js';
import { listEffects, loadWorklets } from '../effects/registry.js';

const RATE = 48000;
const SECONDS = 1;
const SETTLE = 0.25;

const TICK = 512 / RATE;

function noiseBuffer(ctx, seconds) {
  const buffer = ctx.createBuffer(2, Math.round(RATE * seconds), RATE);
  let seed = 12345;
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 0xffffffff) * 1.2 - 0.6;
    }
  }
  return buffer;
}

async function render(configure, sourceOptions = {}, { seconds = SECONDS, modulate = false } = {}) {
  const ctx = new OfflineAudioContext(2, Math.round(RATE * seconds), RATE);
  await loadWorklets(ctx);
  const engine = new AudioEngine(ctx);
  engine.setMaster(1);
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx, seconds);
  engine.addSource(source, { id: 'noise', kind: 'test', label: 'noise', ...sourceOptions });
  configure(engine);
  if (modulate) {
    for (let t = TICK; t < seconds; t += TICK) {
      ctx.suspend(t).then(() => {
        engine.tickModulation(ctx.currentTime);
        ctx.resume();
      });
    }
  }
  source.start();
  const out = await ctx.startRendering();
  return { samples: out.getChannelData(0).subarray(SETTLE * RATE), engine };
}

function rms(x) {
  let sum = 0;
  for (const v of x) sum += v * v;
  return Math.sqrt(sum / x.length);
}

function highBand(x) {
  const d = new Float32Array(x.length - 1);
  for (let i = 1; i < x.length; i++) d[i - 1] = x[i] - x[i - 1];
  return rms(d);
}

function lowBand(x, width = 96) {
  const out = new Float32Array(x.length - width);
  let acc = 0;
  for (let i = 0; i < width; i++) acc += x[i];
  for (let i = width; i < x.length; i++) {
    out[i - width] = acc / width;
    acc += x[i] - x[i - width];
  }
  return rms(out);
}

function peak(x) {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
}

function maxDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

const db = (ratio) => 20 * Math.log10(ratio);
const filter = (busId, params, enabled = true) => (engine) => {
  engine.setBusEffect(busId, 'filter-drive', params);
  engine.setBusEnabled(busId, enabled);
};

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
}

async function run() {
  const { samples: dry } = await render(() => {});
  const dryHigh = highBand(dry);
  const dryLow = lowBand(dry);

  const lpf = (await render(filter('bus1', { type: 'LPF', cutoff: 300, resonance: 0 }))).samples;
  check('LPF 300 Hz on Bus 1 cuts highs', db(highBand(lpf) / dryHigh) < -20, `high band ${db(highBand(lpf) / dryHigh).toFixed(1)} dB`);

  const hpf = (await render(filter('bus1', { type: 'HPF', cutoff: 8000, resonance: 0 }))).samples;
  check('HPF 8 kHz on Bus 1 cuts lows', db(lowBand(hpf) / dryLow) < -12, `low band ${db(lowBand(hpf) / dryLow).toFixed(1)} dB`);

  const bpf = (await render(filter('bus1', { type: 'BPF', cutoff: 1000, resonance: 0.6 }))).samples;
  check('BPF 1 kHz cuts both ends', db(highBand(bpf) / dryHigh) < -12 && db(rms(bpf) / rms(dry)) < -6, `high ${db(highBand(bpf) / dryHigh).toFixed(1)} dB, overall ${db(rms(bpf) / rms(dry)).toFixed(1)} dB`);

  const bypassed = (await render(filter('bus1', { type: 'LPF', cutoff: 300 }, false))).samples;
  check('Bus OFF passes dry signal untouched', maxDiff(bypassed, dry) < 1e-4, `max diff ${maxDiff(bypassed, dry).toExponential(2)}`);

  const dryRouted = (await render(filter('bus1', { type: 'LPF', cutoff: 300 }), { route: 'dry' })).samples;
  check('Source routed Dry skips Bus 1', maxDiff(dryRouted, dry) < 1e-4, `max diff ${maxDiff(dryRouted, dry).toExponential(2)}`);

  const bus2 = (await render(filter('bus2', { type: 'LPF', cutoff: 300 }), { route: 'bus2' })).samples;
  check('Source routed Bus 2 gets Bus 2 FX', db(highBand(bus2) / dryHigh) < -20, `high band ${db(highBand(bus2) / dryHigh).toFixed(1)} dB`);

  const bus4 = (await render(filter('bus4', { type: 'LPF', cutoff: 300 }))).samples;
  check('Bus 4 (master) FX applies to everything', db(highBand(bus4) / dryHigh) < -20, `high band ${db(highBand(bus4) / dryHigh).toFixed(1)} dB`);

  const masterFx = (await render(filter('master', { type: 'LPF', cutoff: 300 }), { route: 'dry' })).samples;
  check('Master FX processes the final mix', db(highBand(masterFx) / dryHigh) < -20, `high band ${db(highBand(masterFx) / dryHigh).toFixed(1)} dB`);

  const masterAfterBus4 = (await render((engine) => {
    filter('bus4', { type: 'HPF', cutoff: 8000, resonance: 0 })(engine);
    filter('master', { type: 'LPF', cutoff: 300, resonance: 0 })(engine);
  })).samples;
  check('Master FX stacks after Bus 4', db(rms(masterAfterBus4) / rms(dry)) < -30, `overall ${db(rms(masterAfterBus4) / rms(dry)).toFixed(1)} dB`);

  const inputFx = (await render(filter('input',{ type: 'LPF', cutoff: 300 }), { inputFx: true })).samples;
  check('Input FX bus processes flagged sources', db(highBand(inputFx) / dryHigh) < -20, `high band ${db(highBand(inputFx) / dryHigh).toFixed(1)} dB`);

  const driven = (await render(filter('bus1', { type: 'LPF', cutoff: 20000, resonance: 0, drive: 1 }))).samples;
  check('Drive saturates with level held near dry', peak(driven) <= 1.0 && Math.abs(db(rms(driven) / rms(dry))) < 3, `peak ${peak(driven).toFixed(3)}, rms ${rms(driven).toFixed(3)} vs dry ${rms(dry).toFixed(3)}`);

  const swept = await render((engine) => {
    filter('bus1', { type: 'LPF', cutoff: 20000 })(engine);
    engine.setParam('bus1', 0, 'cutoff', 300);
  });
  check('setParam sweeps cutoff live', db(highBand(swept.samples) / dryHigh) < -20, `high band ${db(highBand(swept.samples) / dryHigh).toFixed(1)} dB`);

  const cleared = await render((engine) => {
    filter('bus1', { type: 'LPF', cutoff: 300 })(engine);
    engine.setBusEffect('bus1', null);
    filter('bus1', { type: 'HPF', cutoff: 8000 })(engine);
    engine.setBusEffect('bus1', null);
  });
  check('Swapping/clearing effects leaves dry signal', maxDiff(cleared.samples, dry) < 1e-4, `max diff ${maxDiff(cleared.samples, dry).toExponential(2)}`);

  const clamped = (await render((engine) => {
    filter('bus1', { cutoff: 999999, type: 'NOPE' })(engine);
    engine.setParam('bus1', 0, 'resonance', -5);
    engine.setBpm(9999);
  })).engine.state;
  check(
    'Params and BPM are sanitized',
    slot0(clamped, 'bus1').params.cutoff === 20000 && slot0(clamped, 'bus1').params.type === 'LPF' && slot0(clamped, 'bus1').params.resonance === 0 && clamped.bpm === 240,
    JSON.stringify({ cutoff: slot0(clamped, 'bus1').params.cutoff, type: slot0(clamped, 'bus1').params.type, resonance: slot0(clamped, 'bus1').params.resonance, bpm: clamped.bpm })
  );

  const unknown = (await render((engine) => engine.setBusEffect('bus1', 'not-a-real-effect'))).engine.state;
  check('Unknown effects are refused', slot0(unknown, 'bus1').effect === null, `bus1.effect = ${slot0(unknown, 'bus1').effect}`);

  const wrongBus = (await render((engine) => engine.setBusEffect('input', 'scatter'))).engine.state;
  check('Effects are refused on buses they do not support', slot0(wrongBus, 'input').effect === null, `input.effect = ${slot0(wrongBus, 'input').effect}`);

  const preset = (await render((engine) => engine.loadPreset(PRESETS.classic))).engine.state;
  check(
    'Classic 404 preset loads its chains',
    JSON.stringify(preset.buses.bus4.slots.map((s) => s.effect)) === JSON.stringify(['lofi', 'vinyl-sim', 'compressor']) && slot0(preset, 'master').effect === 'limiter',
    JSON.stringify(BUS_EFFECTS(preset))
  );

  const smoke = await render((engine) => engine.loadPreset(PRESETS.filterSmoke));
  check('Filter smoke preset loads and filters', slot0(smoke.engine.state, 'bus1').effect === 'filter-drive' && db(highBand(smoke.samples) / dryHigh) < -15, `high band ${db(highBand(smoke.samples) / dryHigh).toFixed(1)} dB`);

  const roundTrip = await render((engine) => {
    const source = new AudioEngine(new OfflineAudioContext(2, RATE, RATE));
    source.loadPreset(PRESETS.filterSmoke);
    source.setBpm(123);
    engine.applySettings(JSON.parse(JSON.stringify(source.settings())));
  });
  check('Saved settings restore into a fresh engine', roundTrip.engine.state.bpm === 123 && slot0(roundTrip.engine.state, 'bus1').enabled && db(highBand(roundTrip.samples) / dryHigh) < -15, `bpm ${roundTrip.engine.state.bpm}`);

  const windowed = (x, size = 0.05) => {
    const out = [];
    for (let i = 0; i + size * RATE <= x.length; i += size * RATE) out.push(highBand(x.subarray(i, i + size * RATE)));
    return out;
  };
  const swing = (x) => db(Math.max(...windowed(x)) / Math.min(...windowed(x)));
  const lfoOn = (shape, extra = {}) => (engine) => {
    engine.setBpm(120);
    filter('bus1', { type: 'LPF', resonance: 0 })(engine);
    engine.setLfo('bus1', 0, { target: 'cutoff', shape, sync: '1/4', depth: 1, ...extra });
  };
  const steady = await render(filter('bus1', { type: 'LPF', resonance: 0 }), {}, { seconds: 2, modulate: true });
  const lfoSquare = await render(lfoOn('Square'), {}, { seconds: 2, modulate: true });
  check('LFO off: filtered noise stays steady', swing(steady.samples) < 3, `window swing ${swing(steady.samples).toFixed(1)} dB`);
  check('LFO square on cutoff (1/4 @120) swings the highs hard', swing(lfoSquare.samples) > 20, `window swing ${swing(lfoSquare.samples).toFixed(1)} dB`);
  check('LFO keeps the user base value in state', slot0(lfoSquare.engine.state, 'bus1').params.cutoff === 1200, `cutoff = ${slot0(lfoSquare.engine.state, 'bus1').params.cutoff}`);

  const free = await render(lfoOn('Sine', { sync: 'Free', rate: 2 }), {}, { seconds: 2, modulate: true });
  check('LFO free-running at 2 Hz modulates too', swing(free.samples) > 10, `window swing ${swing(free.samples).toFixed(1)} dB`);

  const lfoOff = await render((engine) => {
    lfoOn('Square')(engine);
    engine.setLfo('bus1', 0, { enabled: false });
  }, {}, { seconds: 2, modulate: true });
  const offLfo = slot0(lfoOff.engine.state, 'bus1').lfo;
  check('LFO switched off stops modulating but keeps its target', swing(lfoOff.samples) < 3 && offLfo.enabled === false && offLfo.target === 'cutoff', `window swing ${swing(lfoOff.samples).toFixed(1)} dB, target ${offLfo.target}`);

  const lfoBack = await render((engine) => {
    lfoOn('Square')(engine);
    engine.setLfo('bus1', 0, { enabled: false });
    engine.setLfo('bus1', 0, { enabled: true });
  }, {}, { seconds: 2, modulate: true });
  check('LFO switched back on resumes the sweep', swing(lfoBack.samples) > 20, `window swing ${swing(lfoBack.samples).toFixed(1)} dB`);

  const offTrip = await render((engine) => {
    const source = new AudioEngine(new OfflineAudioContext(2, RATE, RATE));
    source.addSlot('bus1', 'filter-drive');
    source.setLfo('bus1', 0, { target: 'cutoff', enabled: false });
    engine.applySettings(JSON.parse(JSON.stringify(source.settings())));
  });
  const offTripLfo = slot0(offTrip.engine.state, 'bus1').lfo;
  check('LFO off state survives save/restore', offTripLfo.enabled === false && offTripLfo.target === 'cutoff', JSON.stringify(offTripLfo));

  const sanitized = (await render((engine) => {
    filter('bus1', {})(engine);
    engine.setLfo('bus1', 0, { target: 'type', depth: 7, shape: 'Nope' });
  })).engine.state.buses.bus1.slots[0].lfo;
  check('LFO refuses enum targets and clamps settings', sanitized.target === null && sanitized.depth === 1 && sanitized.shape === 'Sine', JSON.stringify(sanitized));

  const reverbTime = (await render((engine) => {
    engine.setBusEffect('bus2', 'reverb');
    engine.setLfo('bus2', 0, { target: 'time' });
  })).engine.state;
  check('Non-modulatable params (Reverb Time) are refused', slot0(reverbTime, 'bus2').lfo.target === null, `target = ${slot0(reverbTime, 'bus2').lfo.target}`);

  const lfoTrip = await render((engine) => {
    const source = new AudioEngine(new OfflineAudioContext(2, RATE, RATE));
    source.addSlot('bus1', 'filter-drive');
    source.setLfo('bus1', 0, { target: 'mix', shape: 'Saw Up', depth: 0.8 });
    engine.applySettings(JSON.parse(JSON.stringify(source.settings())));
  });
  const tripLfo = slot0(lfoTrip.engine.state, 'bus1').lfo;
  check('Slot LFO settings survive save/restore', tripLfo.target === 'mix' && tripLfo.shape === 'Saw Up' && tripLfo.depth === 0.8, JSON.stringify(tripLfo));

  const lowPass = { type: 'LPF', cutoff: 300, resonance: 0 };
  const highPass = { type: 'HPF', cutoff: 8000, resonance: 0 };
  const lpfOnly = (await render((engine) => engine.addSlot('bus1', 'filter-drive', { params: lowPass }))).samples;
  const series = (await render((engine) => {
    engine.addSlot('bus1', 'filter-drive', { params: lowPass });
    engine.addSlot('bus1', 'filter-drive', { params: highPass });
  })).samples;
  check('Two slots on one bus run in series (LPF 300 then HPF 8k is near silence)', db(rms(series) / rms(dry)) < -30, `overall ${db(rms(series) / rms(dry)).toFixed(1)} dB`);

  const oneOff = (await render((engine) => {
    engine.addSlot('bus1', 'filter-drive', { params: lowPass });
    const uid = engine.addSlot('bus1', 'filter-drive', { params: highPass });
    engine.setSlotEnabled('bus1', uid, false);
  })).samples;
  check('Turning one slot off bypasses only that slot', maxDiff(oneOff, lpfOnly) < 1e-4, `max diff vs LPF alone ${maxDiff(oneOff, lpfOnly).toExponential(2)}`);

  const removed = await render((engine) => {
    engine.addSlot('bus1', 'filter-drive', { params: lowPass });
    const uid = engine.addSlot('bus1', 'filter-drive', { params: highPass });
    engine.removeSlot('bus1', uid);
  });
  check('Removing a slot rewires the chain', removed.engine.state.buses.bus1.slots.length === 1 && maxDiff(removed.samples, lpfOnly) < 1e-4, `max diff vs LPF alone ${maxDiff(removed.samples, lpfOnly).toExponential(2)}`);

  const chainOf = (moveIt) =>
    render((engine) => {
      engine.addSlot('bus1', 'filter-drive', { params: { type: 'LPF', cutoff: 2000, resonance: 0, drive: 1 } });
      engine.addSlot('bus1', 'bit-crusher', { params: { bits: 3, rate: 48000 } });
      if (moveIt) engine.moveSlot('bus1', 1, -1);
    });
  const original = await chainOf(false);
  const moved = await chainOf(true);
  const movedOrder = moved.engine.state.buses.bus1.slots.map((s) => s.effect);
  check(
    'Moving a slot reorders the chain (and changes the sound)',
    JSON.stringify(movedOrder) === JSON.stringify(['bit-crusher', 'filter-drive']) && maxDiff(original.samples, moved.samples) > 0.01,
    `order ${movedOrder.join(' > ')}, max diff ${maxDiff(original.samples, moved.samples).toFixed(3)}`
  );

  const swapped = await render((engine) => {
    engine.addSlot('bus1', 'filter-drive', { params: lowPass });
    const uid = engine.addSlot('bus1', 'filter-drive', { params: highPass });
    engine.setLfo('bus1', uid, { target: 'mix', shape: 'Square' });
    engine.swapSlot('bus1', uid, 'equalizer');
  });
  const swappedSlot = swapped.engine.state.buses.bus1.slots[1];
  check(
    'Swapping an effect keeps its position, on/off and LFO, with the new defaults',
    swappedSlot.uid === 'fx2' && swappedSlot.effect === 'equalizer' && swappedSlot.enabled && swappedSlot.lfo.target === 'mix' && swappedSlot.lfo.shape === 'Square' && swappedSlot.params.midGain === 0 && maxDiff(swapped.samples, lpfOnly) < 1e-4,
    `slot ${swappedSlot.uid} ${swappedSlot.effect}, max diff vs LPF alone ${maxDiff(swapped.samples, lpfOnly).toExponential(2)}`
  );

  const swapToVinyl = await render((engine) => {
    const uid = engine.addSlot('bus1', 'filter-drive', { params: { mix: 0 } });
    engine.swapSlot('bus1', uid, 'vinyl-sim');
    engine.setParam('bus1', uid, 'mix', 0);
  });
  const vinylShift = Math.round(0.016 * RATE);
  const vinylAligned = maxDiff(swapToVinyl.samples.subarray(vinylShift), dry.subarray(0, dry.length - vinylShift));
  check('Swapping updates latency compensation (Vinyl dry path is delayed)', vinylAligned < 1e-4, `max diff latency-aligned ${vinylAligned.toExponential(2)}`);

  const badSwap = (await render((engine) => {
    engine.addSlot('input', 'vocoder');
    engine.swapSlot('input', 0, 'scatter');
  })).engine.state;
  check('Swapping to an effect the bus does not allow is refused', badSwap.buses.input.slots[0].effect === 'vocoder', `input slot = ${badSwap.buses.input.slots[0].effect}`);

  const full = (await render((engine) => {
    for (let i = 0; i < 12; i++) engine.addSlot('bus1', 'equalizer');
  })).engine.state;
  check('A bus holds at most 8 effects', full.buses.bus1.slots.length === 8, `slots = ${full.buses.bus1.slots.length}`);

  const half = (await render(filter('bus1', { type: 'LPF', cutoff: 300, resonance: 0, mix: 0.5 }))).samples;
  check('Bus Mix 50% blends dry and wet (equal power)', db(highBand(half) / dryHigh) > -4 && db(highBand(half) / dryHigh) < -2, `high band ${db(highBand(half) / dryHigh).toFixed(2)} dB`);

  check('Catalog lists effects for every bus', ['bus1', 'bus2', 'bus3', 'bus4', 'master', 'input'].every((b) => listEffects(b).length > 3), ['bus1', 'master', 'input'].map((b) => `${b}:${listEffects(b).length}`).join(' '));

  const legacy = await render((engine) => {
    engine.applySettings({ bpm: 100, master: 0.8, inputRoute: 'bus1', buses: { bus1: { effect: 'filter-drive', enabled: true, params: { cutoff: 300 } } } });
  });
  const migrated = slot0(legacy.engine.state, 'bus1');
  check('Old single-effect buses migrate to a one-slot chain', legacy.engine.state.buses.bus1.slots.length === 1 && migrated.effect === 'filter-drive' && migrated.enabled && migrated.params.cutoff === 300, JSON.stringify(BUS_EFFECTS(legacy.engine.state)));
  check('Old saved settings (no Master FX/autoBpm) still load', slot0(legacy.engine.state, 'master').effect === null && legacy.engine.state.autoBpm === false && legacy.engine.state.bpm === 100, `master.effect=${slot0(legacy.engine.state, 'master').effect} autoBpm=${legacy.engine.state.autoBpm}`);
}

const BUS_EFFECTS = (state) => Object.values(state.buses).map((b) => b.slots.map((s) => s.effect));
const slot0 = (state, busId) => state.buses[busId].slots[0] ?? { effect: null };

run()
  .catch((err) => check('Harness crashed', false, err.stack))
  .finally(() => {
    const passed = results.filter((r) => r.pass).length;
    const lines = results.map((r) => `<span class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</span>  ${r.name}  —  ${r.detail}`);
    document.getElementById('out').innerHTML = [...lines, '', `${passed}/${results.length} passed`].join('\n');
    window.__smoke = { passed, total: results.length, results };
  });
