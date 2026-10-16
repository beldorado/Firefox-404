import './offline-shim.js';
import { AudioEngine, sideGain } from '../engine/engine.js';
import { loadWorklets, ctrlParams, allEffects, CTRL_COUNT } from '../effects/registry.js';
import { nextBoundary, position, rebase } from '../shared/grid.js';
import { encodeWav } from '../shared/wav.js';
import { MidiLearn } from '../sidepanel/midi.js';
import { HoldKeys, actionFor } from '../sidepanel/keys.js';
import { PRESETS } from '../engine/presets.js';
import { FOUR_ON_FLOOR, RATE, drumLoop, sineBuffer } from './signals.js';
import { cleanChops, detectTransients, equalChops, extractSlice, slicesFrom, snapTime } from '../shared/chop.js';
import { PAD_COUNT, PADS_PER_BANK, migratePadIndex, padLabel, presetFrom } from '../shared/state.js';
import { getAllClips, padMoves } from '../shared/pad-store.js';
import { migrateMidiMap } from '../sidepanel/midi.js';
import { freePadsAfter } from '../sidepanel/editor.js';

const BPM = 120;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function session({ seconds = 2, signal = 'sine', frequency = 220, recorder = false, setup, at = [] } = {}) {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * RATE), RATE);
  await loadWorklets(ctx);
  const clips = [];
  const engine = new AudioEngine(ctx, { onClip: (index, buffer, meta) => clips.push({ index, buffer, meta }) });
  if (recorder) await engine.startRecorder();
  engine.setMaster(1);
  engine.setBpm(BPM);
  if (signal) {
    const source = ctx.createBufferSource();
    source.buffer = sineBuffer(ctx, frequency, seconds);
    engine.addSource(source, { id: 's', kind: 'test', label: 's' });
    source.start();
  }
  await setup?.(engine, ctx);
  for (const [time, fn] of at) {
    ctx.suspend(time).then(() => {
      fn(engine, ctx);
      ctx.resume();
    });
  }
  const out = await ctx.startRendering();
  return { l: out.getChannelData(0), r: out.getChannelData(1), engine, ctx, clips };
}

function segment(x, from, to) {
  return x.subarray(Math.round(from * RATE), Math.round(to * RATE));
}

function rms(x) {
  let sum = 0;
  for (const v of x) sum += v * v;
  return Math.sqrt(sum / Math.max(1, x.length));
}

function maxDiff(a, b) {
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function tone(x, frequency) {
  const w = (2 * Math.PI * frequency) / RATE;
  let re = 0;
  let im = 0;
  for (let i = 0; i < x.length; i++) {
    re += x[i] * Math.cos(w * i);
    im += x[i] * Math.sin(w * i);
  }
  return (2 * Math.hypot(re, im)) / x.length;
}

const db = (a, b) => 20 * Math.log10(Math.max(a, 1e-9) / Math.max(b, 1e-9));
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

async function gridTests() {
  check('nextBoundary snaps to the next 1/4 at 120 BPM', near(nextBoundary(0.6, 0, 120, '1/4'), 1.0, 1e-9), `${nextBoundary(0.6, 0, 120, '1/4')}`);
  check('nextBoundary keeps a time already on the grid', nextBoundary(1.0, 0, 120, '1/4') === 1.0, `${nextBoundary(1.0, 0, 120, '1/4')}`);
  check('nextBoundary with Off returns the time unchanged', nextBoundary(0.6, 0, 120, 'Off') === 0.6, 'Off');
  check('nextBoundary honours the origin', near(nextBoundary(0.6, 0.3, 120, '1 bar'), 2.3, 1e-9), `${nextBoundary(0.6, 0.3, 120, '1 bar')}`);
  check('rebase keeps the beat position when tempo changes', near(((1.0 - rebase(1.0, 0, 120, 60)) * 60) / 60, 2, 1e-9), `origin ${rebase(1.0, 0, 120, 60)}`);
  check('position reports bar 3 beat 2 for beat 9', position(9).bar === 3 && position(9).beat === 2, JSON.stringify(position(9)));

  const { engine } = await session({ seconds: 1.5, signal: null, at: [[1.0, (e) => e.setBpm(60)]] });
  check('setBpm mid-song keeps the current beat (beat 2 at 1.0 s stays beat 2)', near(engine.beat(1.0), 2, 1e-6) && near(engine.beat(2.0), 3, 1e-6), `beat(1.0)=${engine.beat(1.0).toFixed(4)}, beat(2.0)=${engine.beat(2.0).toFixed(4)}`);
}

const SCATTER_GATE = { type: '5', depth: 1 };

async function quantizeTests() {
  const ref = await session({ seconds: 1.5 });

  const free = await session({
    seconds: 1.5,
    setup: (e) => {
      e.setQuantize('Off');
      e.setBusEffect('bus1', 'scatter', SCATTER_GATE);
    },
    at: [[0.6, (e) => e.setBusEnabled('bus1', true)]]
  });
  const freeMuted = db(rms(segment(free.l, 0.65, 0.74)), rms(segment(ref.l, 0.65, 0.74)));
  const freeOpen = db(rms(segment(free.l, 0.76, 0.865)), rms(segment(ref.l, 0.76, 0.865)));
  check('Scatter engaged off-grid still follows the grid (step 5 at 0.625 s is muted)', freeMuted < -20 && Math.abs(freeOpen) < 0.5, `step 5 ${freeMuted.toFixed(1)} dB, step 6 ${freeOpen.toFixed(2)} dB`);

  const quantized = await session({
    seconds: 1.5,
    setup: (e) => {
      e.setQuantize('1/4');
      e.setBusEffect('bus1', 'scatter', SCATTER_GATE);
    },
    at: [[0.6, (e) => e.setBusEnabled('bus1', true)]]
  });
  const before = db(rms(segment(quantized.l, 0.6, 0.99)), rms(segment(ref.l, 0.6, 0.99)));
  const after = db(rms(segment(quantized.l, 1.14, 1.24)), rms(segment(ref.l, 1.14, 1.24)));
  check('Quantize 1/4: pressed at 0.6 s, Scatter waits for the beat at 1.0 s', Math.abs(before) < 0.1 && after < -20, `0.6–1.0 s ${before.toFixed(2)} dB, step 9 ${after.toFixed(1)} dB`);

  const tapped = await session({
    seconds: 1,
    setup: (e) => {
      e.setQuantize('Off');
      e.setBpm(100);
      e.alignGrid(0, 0.05);
      e.setBusEffect('bus1', 'scatter', SCATTER_GATE);
      e.setBusEnabled('bus1', true);
    }
  });
  const tapOpen = db(rms(segment(tapped.l, 0.07, 0.19)), rms(segment(ref.l, 0.07, 0.19)));
  const tapMuted = db(rms(segment(tapped.l, 0.215, 0.335)), rms(segment(ref.l, 0.215, 0.335)));
  check('Grid aligned at 0.05 s and 100 BPM moves the steps (16ths of 150 ms from 0.05 s)', Math.abs(tapOpen) < 0.5 && tapMuted < -20, `step 0 ${tapOpen.toFixed(2)} dB, step 1 ${tapMuted.toFixed(1)} dB`);

  const { engine: tapped2 } = await session({ seconds: 0.1, signal: null, setup: (e) => e.tap({ bpm: 100, beat: 1, time: 5 }) });
  check('Tap sets BPM and makes "now" the tapped beat (future times are clamped to now)', tapped2.state.bpm === 100 && near(tapped2.beat(0), 1, 1e-9), `bpm ${tapped2.state.bpm}, beat(0)=${tapped2.beat(0)}`);

  const slicer = await session({
    seconds: 1.5,
    setup: (e) => {
      e.setQuantize('Off');
      e.setBusEffect('bus1', 'slicer', { pattern: '4', division: '1/16', depth: 1, shape: 0.5 });
    },
    at: [[0.3, (e) => e.setBusEnabled('bus1', true)]]
  });
  const slicerMuted = db(rms(segment(slicer.l, 0.52, 0.99)), rms(segment(ref.l, 0.52, 0.99)));
  check('Slicer pattern 4 closes on bar-grid step 4 (0.5–1.0 s) even when engaged at 0.3 s', slicerMuted < -20, `${slicerMuted.toFixed(1)} dB`);
}

async function engageTests() {
  const run = await session({
    seconds: 1.5,
    frequency: 4000,
    setup: (e) => {
      e.addSlot('bus1', 'filter-drive', { params: { cutoff: 200 } });
      e.setBusEngaged('bus1', false);
    },
    at: [[0.7, (e) => e.setBusEngaged('bus1', true)]]
  });
  const ref4k = await session({ seconds: 1.5, frequency: 4000 });
  check('Disengaged bus passes audio dry', maxDiff(segment(run.l, 0, 0.69), segment(ref4k.l, 0, 0.69)) < 1e-4, `max diff ${maxDiff(segment(run.l, 0, 0.69), segment(ref4k.l, 0, 0.69)).toExponential(2)}`);
  check('Engaging the bus brings the effect back', db(rms(segment(run.l, 0.9, 1.5)), rms(segment(ref4k.l, 0.9, 1.5))) < -20, `${db(rms(segment(run.l, 0.9, 1.5)), rms(segment(ref4k.l, 0.9, 1.5))).toFixed(1)} dB`);

  const { engine } = await session({
    seconds: 0.2,
    signal: null,
    setup: (e) => {
      e.setBusEffect('bus2', 'lofi');
      e.setBusEngaged('bus2', true);
    }
  });
  const kit = await session({ seconds: 1, setup: (e) => e.loadPreset(PRESETS.glitchKit) });
  const kitRef = await session({ seconds: 1, setup: (e) => e.loadPreset({ buses: { ...PRESETS.glitchKit.buses, bus1: [], bus2: [], bus3: [] } }) });
  const armed = ['bus1', 'bus2', 'bus3'].every((b) => !kit.engine.state.buses[b].engaged && kit.engine.state.buses[b].slots[0]?.enabled);
  check('Glitch kit preset loads its glitch buses armed but silent', armed && kit.engine.state.buses.bus4.engaged && maxDiff(kit.l, kitRef.l) < 1e-4, `max diff vs no glitch buses ${maxDiff(kit.l, kitRef.l).toExponential(2)}`);

  check('Engaging a bus whose effects are all off turns them on', engine.state.buses.bus2.slots.every((s) => s.enabled), JSON.stringify(engine.state.buses.bus2.slots.map((s) => s.enabled)));
}

async function memoryTests() {
  const { engine } = await session({ seconds: 0.1, signal: null });
  const uid = engine.addSlot('bus1', 'filter-drive');
  engine.setParam('bus1', uid, 'cutoff', 500);
  engine.swapSlot('bus1', uid, 'lofi');
  engine.setParam('bus1', uid, 'rate', 4000);
  engine.swapSlot('bus1', uid, 'filter-drive');
  check('Swapping back recalls the last settings of that effect', engine.resolveSlot('bus1', uid).params.cutoff === 500, `cutoff ${engine.resolveSlot('bus1', uid).params.cutoff}`);
  engine.swapSlot('bus1', uid, 'lofi');
  check('…and of the other effect', engine.resolveSlot('bus1', uid).params.rate === 4000, `rate ${engine.resolveSlot('bus1', uid).params.rate}`);

  const recalled = engine.addSlot('bus1', 'filter-drive', { recall: true });
  const fresh = engine.addSlot('bus2', 'filter-drive', { recall: true });
  check('Adding with recall uses that bus’s memory only', engine.resolveSlot('bus1', recalled).params.cutoff === 500 && engine.resolveSlot('bus2', fresh).params.cutoff === 1200, `bus1 ${engine.resolveSlot('bus1', recalled).params.cutoff}, bus2 ${engine.resolveSlot('bus2', fresh).params.cutoff}`);

  engine.setQuantize('1/8');
  engine.setCrossfader(-0.5);
  engine.setBusEngaged('bus1', false);
  engine.updatePad(3, { mode: 'Gate', level: 0.7, sync: false });
  const saved = JSON.parse(JSON.stringify(engine.settings()));
  const { engine: restored } = await session({ seconds: 0.1, signal: null, setup: (e) => e.applySettings(saved) });
  const pad = restored.state.pads[3];
  const ok =
    restored.state.quantize === '1/8' &&
    restored.state.crossfader === -0.5 &&
    restored.state.buses.bus1.engaged === false &&
    restored.state.memory.bus1['filter-drive'].cutoff === 500 &&
    pad.mode === 'Gate' &&
    pad.level === 0.7 &&
    pad.sync === false;
  check('Settings round-trip quantize, crossfader, bus engage, memory, pad options', ok, JSON.stringify({ q: restored.state.quantize, x: restored.state.crossfader, engaged: restored.state.buses.bus1.engaged, pad }));
  check('Settings never persist pad audio or play state', !('clip' in saved.pads[0]) && !('playing' in saved.pads[0]), Object.keys(saved.pads[0]).join(','));
}

async function deckTests() {
  check('Crossfader curve: centre keeps both decks at full level', sideGain('A', 0) === 1 && sideGain('B', 0) === 1, 'unity');
  check('Crossfader curve: hard left silences deck B', sideGain('B', -1) < 1e-9 && sideGain('A', -1) === 1, `${sideGain('B', -1)}`);

  async function decks(setup) {
    const seconds = 0.6;
    const ctx = new OfflineAudioContext(2, seconds * RATE, RATE);
    const engine = new AudioEngine(ctx);
    engine.setMaster(1);
    for (const [id, f] of [['a', 440], ['b', 660]]) {
      const source = ctx.createBufferSource();
      source.buffer = sineBuffer(ctx, f, seconds, 0.3);
      engine.addSource(source, { id, kind: 'test', label: id, route: 'dry' });
      source.start();
    }
    engine.updateSource('a', { side: 'A' });
    engine.updateSource('b', { side: 'B' });
    setup(engine);
    const out = await ctx.startRendering();
    const x = segment(out.getChannelData(0), 0.2, 0.6);
    return { a: tone(x, 440), b: tone(x, 660) };
  }
  const centre = await decks(() => {});
  const left = await decks((e) => e.setCrossfader(-1));
  const right = await decks((e) => e.setCrossfader(1));
  const muted = await decks((e) => e.updateSource('a', { muted: true }));
  const half = await decks((e) => e.updateSource('b', { level: 0.5 }));
  check('Crossfader centre plays both decks at full level', near(centre.a, 0.3, 0.01) && near(centre.b, 0.3, 0.01), `A ${centre.a.toFixed(3)}, B ${centre.b.toFixed(3)}`);
  check('Crossfader hard left keeps A and silences B', near(left.a, 0.3, 0.01) && left.b < 0.003, `A ${left.a.toFixed(3)}, B ${left.b.toFixed(4)}`);
  check('Crossfader hard right keeps B and silences A', near(right.b, 0.3, 0.01) && right.a < 0.003, `A ${right.a.toFixed(4)}, B ${right.b.toFixed(3)}`);
  check('Muting a deck silences it', muted.a < 0.003 && near(muted.b, 0.3, 0.01), `A ${muted.a.toFixed(4)}`);
  check('Deck level 50% is −6 dB', near(db(half.b, centre.b), -6.02, 0.2), `${db(half.b, centre.b).toFixed(2)} dB`);
}

function burst(ctx, seconds, frequency = 880) {
  return sineBuffer(ctx, frequency, seconds, 0.5);
}

async function padTests() {
  const loop = await session({
    seconds: 2,
    signal: null,
    setup: (e, ctx) => {
      e.setQuantize('1/4');
      e.setPadClip(0, burst(ctx, 0.25), { name: 'burst', bpm: BPM });
    },
    at: [
      [0.1, (e) => e.padPress(0)],
      [1.5, (e) => e.padPress(0)]
    ]
  });
  const pre = rms(segment(loop.l, 0.12, 0.49));
  const first = rms(segment(loop.l, 0.51, 0.74));
  const again = rms(segment(loop.l, 1.01, 1.24));
  const stopped = rms(segment(loop.l, 1.6, 2.0));
  check('Loop pad pressed at 0.1 s starts on the beat at 0.5 s', pre < 1e-4 && first > 0.2, `before ${pre.toExponential(1)}, after ${first.toFixed(3)}`);
  check('Loop pad keeps looping until pressed again', again > 0.2 && stopped < 1e-4, `loop ${again.toFixed(3)}, after stop ${stopped.toExponential(1)}`);

  const gate = await session({
    seconds: 1,
    signal: null,
    setup: (e, ctx) => {
      e.setPadClip(1, burst(ctx, 1), { name: 'long' });
      e.updatePad(1, { mode: 'Gate' });
    },
    at: [
      [0.2, (e) => e.padPress(1)],
      [0.4, (e) => e.padRelease(1)]
    ]
  });
  check('Gate pad plays only while held', rms(segment(gate.l, 0.21, 0.39)) > 0.2 && rms(segment(gate.l, 0.45, 1)) < 1e-4, `held ${rms(segment(gate.l, 0.21, 0.39)).toFixed(3)}, released ${rms(segment(gate.l, 0.45, 1)).toExponential(1)}`);

  const shot = await session({
    seconds: 1,
    signal: null,
    setup: (e, ctx) => {
      e.setQuantize('1 bar');
      e.setPadClip(2, burst(ctx, 0.25), { name: 'hit' });
      e.updatePad(2, { mode: 'One-shot' });
    },
    at: [[0.2, (e) => e.padPress(2)]]
  });
  await wait(50);
  check('One-shot pad fires immediately (ignores quantize) and plays once', rms(segment(shot.l, 0.21, 0.44)) > 0.2 && rms(segment(shot.l, 0.5, 1)) < 1e-4, `hit ${rms(segment(shot.l, 0.21, 0.44)).toFixed(3)}, tail ${rms(segment(shot.l, 0.5, 1)).toExponential(1)}`);
  check('One-shot pad reports stopped when it ends', shot.engine.state.pads[2].playing === false, `playing ${shot.engine.state.pads[2].playing}`);

  const synced = await session({
    seconds: 0.3,
    signal: null,
    setup: (e, ctx) => {
      e.setQuantize('Off');
      e.setPadClip(0, burst(ctx, 1), { name: 'slow', bpm: 60 });
      e.padPress(0);
    }
  });
  const rate = synced.engine.pads.voices.get(0)?.source.playbackRate.value;
  check('Follow BPM plays a 60 BPM loop at 2× under 120 BPM', rate === 2, `rate ${rate}`);
  synced.engine.setPadClip(1, burst(synced.ctx, 1), { name: 'file.wav', bpm: null });
  const before = synced.engine.padRate(1);
  synced.engine.setPadBpm(1, 135);
  const after = synced.engine.padRate(1);
  check('Typing a BPM on a pad with none makes it follow the tempo (135 → 120)', before === 1 && synced.engine.state.pads[1].clip.bpm === 135 && Math.abs(after - 120 / 135) < 1e-9, `rate ${before} → ${after.toFixed(4)}`);
  synced.engine.setPadBpm(1, null);
  check('Clearing a pad BPM turns Follow BPM off', synced.engine.state.pads[1].clip.bpm === null && synced.engine.padRate(1) === 1, `bpm ${synced.engine.state.pads[1].clip.bpm}`);
  synced.engine.updatePad(0, { sync: false });
  check('Peaks are computed for the pad display', synced.engine.state.pads[0].clip.peaks.length === 48 && synced.engine.state.pads[0].clip.peaks.every((p) => p >= 0 && p <= 1), `${synced.engine.state.pads[0].clip.peaks.length} bins`);
}

async function waitFor(fn, ms = 2000) {
  const start = performance.now();
  while (!fn() && performance.now() - start < ms) await wait(20);
  return fn();
}

async function recordTests() {
  let recStart = null;
  const rec = await session({
    seconds: 4.5,
    frequency: 330,
    recorder: true,
    setup: (e) => e.setQuantize('1/16'),
    at: [
      [
        0.1,
        (e) => {
          e.startRecording({ pad: 0, length: '1 bar' });
          recStart = e.state.recording?.start;
        }
      ]
    ]
  });
  check('Recording pressed at 0.1 s waits for the next bar (2.0 s)', recStart === 2, `start ${recStart}`);
  await waitFor(() => rec.clips.length > 0);
  const clip = rec.clips[0];
  check('Resample of 1 bar at 120 BPM is exactly 2.000 s', clip && clip.buffer.length === 2 * RATE, `${clip?.buffer.length} frames`);
  const diff = clip ? maxDiff(clip.buffer.getChannelData(0), segment(rec.l, 2, 4)) : 1;
  check('Resample is sample-identical to the master output from 2.0 to 4.0 s', diff < 1e-6, `max diff ${diff.toExponential(2)}`);
  check('Resampled pad is named and tagged with its BPM', rec.engine.state.pads[0].clip?.name === '1 bar at 120 BPM' && rec.engine.state.pads[0].clip?.bpm === 120, JSON.stringify(rec.engine.state.pads[0].clip?.name));

  const free = await session({
    seconds: 1.5,
    recorder: true,
    setup: (e) => e.setQuantize('Off'),
    at: [
      [0.1, (e) => e.startRecording({ pad: 4, length: 'Free' })],
      [1.0, (e) => e.stopRecording()]
    ]
  });
  await waitFor(() => free.clips.length > 0);
  const len = free.clips[0]?.buffer.length ?? 0;
  check('Free recording with quantize off stops when asked (0.9 s)', Math.abs(len - 0.9 * RATE) <= 128, `${(len / RATE).toFixed(4)} s`);
  check('Free recording that is not whole bars still keeps its BPM', free.engine.state.pads[4].clip?.bpm === 120 && free.clips[0]?.meta.bpm === 120, `bpm ${free.engine.state.pads[4].clip?.bpm}`);

  const cancelled = await session({
    seconds: 1,
    recorder: true,
    setup: (e) => e.setQuantize('1/4'),
    at: [
      [0.1, (e) => e.startRecording({ pad: 1, length: '1 bar' })],
      [0.5, (e) => e.stopRecording()]
    ]
  });
  await wait(100);
  check('Stopping before the bar arrives cancels the recording', cancelled.clips.length === 0 && cancelled.engine.state.recording === null && cancelled.engine.state.pads[1].clip === null, `${cancelled.clips.length} clips`);
}

function midiTests() {
  if (!globalThis.browser) globalThis.browser = {};
  if (!globalThis.browser.storage) globalThis.browser.storage = { local: { set() {}, get: async () => ({}) } };
  const calls = [];
  const midi = new MidiLearn({ onControl: (t, v) => calls.push(['cc', t, v]), onButton: (t, d) => calls.push(['btn', t, d]), onStatus: () => {} });
  midi.map = { 'n0:36': { kind: 'pad', index: 0 }, '0:7': { busId: 'bus1', uid: 'fx1', paramId: 'cutoff' }, '0:20': { kind: 'bus', busId: 'bus2' } };
  midi.handle([0x90, 36, 100]);
  midi.handle([0x90, 36, 0]);
  midi.handle([0xb0, 7, 127]);
  midi.handle([0xb0, 20, 127]);
  midi.handle([0xb0, 20, 90]);
  midi.handle([0xb0, 20, 0]);
  const summary = calls.map(([k, t, v]) => `${k}:${t.kind}:${typeof v === 'number' ? v.toFixed(2) : v}`).join(' ');
  check('MIDI note on/off presses and releases a pad (velocity 0 = release)', summary.startsWith('btn:pad:true btn:pad:false'), summary);
  check('MIDI CC keeps working for mappings saved before this version', summary.includes('cc:param:1.00'), summary);
  check('MIDI CC on a button presses at ≥64 and ignores repeats', summary.endsWith('btn:bus:true btn:bus:false'), summary);

  midi.learning = true;
  midi.arm({ kind: 'pad', index: 5 });
  midi.handle([0xb0, 30, 10]);
  midi.handle([0x91, 40, 90]);
  check('Learning a pad takes a note, not a stray low CC', midi.map['n1:40']?.index === 5 && !midi.map['0:30'], JSON.stringify(midi.map['n1:40']));
  midi.arm({ kind: 'ctrl', busId: 'bus1', index: 0 });
  midi.handle([0x90, 50, 90]);
  midi.handle([0xb0, 21, 3]);
  check('Learning a CTRL knob takes a CC and ignores notes', midi.map['0:21']?.kind === 'ctrl' && !midi.map['n0:50'], JSON.stringify(midi.map['0:21']));
}

function keyTests() {
  const ev = (code, extra = {}) => ({ code, target: { tagName: 'BODY' }, preventDefault() {}, ...extra });
  check('Keys 1–6 map to the bus FX buttons', actionFor(ev('Digit1'))?.busId === 'bus1' && actionFor(ev('Digit6'))?.busId === 'master', 'ok');
  const padKeys = ['KeyQ', 'KeyR', 'KeyA', 'KeyF', 'KeyZ', 'KeyV'].map((code) => actionFor(ev(code))?.index).join();
  check('Keys Q–R, A–F and Z–V map to pads 1–12 row by row', padKeys === '0,3,4,7,8,11' && actionFor(ev('KeyK')) === null, padKeys);
  check('T records, G chops and B switches bank', actionFor(ev('KeyT'))?.kind === 'rec' && actionFor(ev('KeyG'))?.kind === 'chop' && actionFor(ev('KeyB'))?.kind === 'bank', 'ok');
  check('Typing in the BPM box does not trigger pads', actionFor(ev('KeyA', { target: { tagName: 'INPUT', type: 'number' } })) === null, 'ignored');
  check('Pad and bus keys still work after picking from a dropdown', actionFor(ev('KeyQ', { target: { tagName: 'SELECT' } }))?.index === 0 && actionFor(ev('Space', { target: { tagName: 'SELECT', matches: () => true } })) === null, 'ok');
  check('Space on a keyboard-focused button is left to the button', actionFor(ev('Space', { target: { tagName: 'BUTTON', matches: () => true } })) === null, 'ignored');
  check('Space after clicking a button with the mouse still taps', actionFor(ev('Space', { target: { tagName: 'BUTTON', matches: () => false } }))?.kind === 'tap', 'tap');
  check('Shortcuts with Ctrl are left to the browser', actionFor(ev('KeyS', { ctrlKey: true })) === null, 'ignored');
  const log = [];
  const keys = new HoldKeys({ press: (a) => log.push(`+${a.kind}`), release: (a) => log.push(`-${a.kind}`) });
  keys.down(ev('Digit2'));
  keys.down(ev('Digit2', { repeat: true }));
  keys.down(ev('KeyA'));
  keys.releaseAll();
  check('Held keys press once, ignore auto-repeat, and release on blur', log.join(' ') === '+bus +pad -bus -pad', log.join(' '));
}

function wavTests() {
  const wav = new DataView(encodeWav([new Float32Array([0, 0.5, -1, 1]), new Float32Array([0.25, 0, 0, -0.5])], 48000));
  const text = (o, n) => String.fromCharCode(...Array.from({ length: n }, (_, i) => wav.getUint8(o + i)));
  const samples = Array.from({ length: 8 }, (_, i) => wav.getInt16(44 + i * 2, true));
  check('WAV export writes a 16-bit stereo PCM header', text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE' && wav.getUint16(22, true) === 2 && wav.getUint16(34, true) === 16 && wav.getUint32(24, true) === 48000, `${text(0, 4)} ${text(8, 4)}`);
  check('WAV export interleaves and scales samples', samples.join() === [0, 8192, 16384, 0, -32768, 0, 32767, -16384].join(), samples.join());
}

function ctrlTests() {
  const bad = allEffects().filter((e) => ctrlParams(e.id).length !== CTRL_COUNT || new Set(ctrlParams(e.id)).size !== CTRL_COUNT);
  check('Every effect exposes three distinct CTRL knobs', bad.length === 0, bad.map((e) => e.id).join(', ') || `${allEffects().length} effects`);
  check('Filter + Drive CTRL is Cutoff / Reso / Drive', ctrlParams('filter-drive').map((p) => p.name).join(' / ') === 'Cutoff / Reso / Drive', ctrlParams('filter-drive').map((p) => p.name).join(' / '));
}

function twoTone(ctx) {
  const buffer = ctx.createBuffer(2, RATE, RATE);
  for (let ch = 0; ch < 2; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin((2 * Math.PI * (i < RATE / 2 ? 440 : 880) * i) / RATE);
  }
  return buffer;
}

async function chopTests() {
  check('Banks give 24 pads labelled A1–A12 and B1–B12', PAD_COUNT === 24 && PADS_PER_BANK === 12 && padLabel(11) === 'A12' && padLabel(12) === 'B1' && padLabel(23) === 'B12', `${PAD_COUNT} pads`);
  check('Equal split of 0–2 s into 4 puts chops at 0.5, 1.0, 1.5 s', equalChops(0, 2, 4).join() === '0.5,1,1.5', equalChops(0, 2, 4).join());
  check('Chops outside the trim or too close together are dropped', cleanChops([0.005, 0.5, 0.51, 1.2, 1.99, 3], 0, 2).join() === '0.5,1.2', cleanChops([0.005, 0.5, 0.51, 1.2, 1.99, 3], 0, 2).join());
  const slices = slicesFrom(0.25, 2, [1, 0.5]);
  check('Slices run between trim points and sorted chops', JSON.stringify(slices) === JSON.stringify([{ start: 0.25, end: 0.5 }, { start: 0.5, end: 1 }, { start: 1, end: 2 }]), JSON.stringify(slices));
  check('Grid snap at 120 BPM rounds to the nearest 1/16 (0.125 s)', snapTime(0.3, { bpm: 120 }) === 0.25 && snapTime(0.33, { bpm: 120 }) === 0.375, `${snapTime(0.3, { bpm: 120 })}, ${snapTime(0.33, { bpm: 120 })}`);
  const wave = new Float32Array(4800).map((_, i) => Math.sin((2 * Math.PI * 100 * i) / RATE));
  const z = snapTime(0.0049, { data: wave, sampleRate: RATE, grid: false });
  check('Without a BPM, chops snap to the nearest zero crossing', Math.abs(z - 0.005) < 1 / RATE + 1e-9, `${(z * 1000).toFixed(3)} ms`);
  const cut = extractSlice([new Float32Array(1000).fill(1)], 1000, 0.1, 0.5, 0.01);
  check('Extracted slices have the right length and fade in and out', cut[0].length === 400 && cut[0][0] === 0 && cut[0][399] === 0 && cut[0][200] === 1, `${cut[0].length} frames`);

  const clicks = [0.1, 0.5, 0.8, 1.3];
  const clickData = new Float32Array(1.6 * RATE);
  let seed = 7;
  for (const t of clicks) {
    for (let i = 0; i < 0.08 * RATE; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      clickData[Math.round(t * RATE) + i] = (seed / 0xffffffff - 0.5) * Math.exp(-i / (0.01 * RATE));
    }
  }
  const found = detectTransients([clickData], RATE);
  const worst = Math.max(...clicks.map((t) => Math.min(...found.map((f) => Math.abs(f - t)))));
  check('Find hits locates four clicks within 3 ms and nothing else', found.length === 4 && worst <= 0.003, `${found.map((f) => f.toFixed(4)).join(', ')}`);

  const loopCtx = new OfflineAudioContext(2, 2 * RATE, RATE);
  const loop = drumLoop(loopCtx, 120, 2, FOUR_ON_FLOOR);
  const hits = detectTransients([loop.getChannelData(0)], RATE, { sensitivity: 0.5 });
  const missed = [0.5, 1, 1.5].filter((t) => !hits.some((f) => Math.abs(f - t) <= 0.005));
  check('Find hits catches every kick of a 120 BPM four-on-the-floor loop', missed.length === 0, `${hits.length} hits, missed ${missed.join(', ') || 'none'}`);

  const pads = Array.from({ length: PAD_COUNT }, (_, i) => ({ clip: [0, 2, 3].includes(i) ? {} : null }));
  check('Slices go to the empty pads after the source, wrapping around', freePadsAfter(pads, 2).slice(0, 3).join() === '4,5,6' && freePadsAfter(pads, 2).at(-1) === 1, freePadsAfter(pads, 2).join());

  const shot = await session({
    seconds: 1,
    signal: null,
    setup: (e, ctx) => {
      e.setPadClip(0, twoTone(ctx), { name: 'tones' });
      e.updatePad(0, { mode: 'One-shot' });
      e.setPadRegion(0, 0.5, 0.75);
    },
    at: [[0.2, (e) => e.padPress(0)]]
  });
  const part = segment(shot.l, 0.22, 0.44);
  check('A trimmed one-shot plays only its region (the 880 Hz half)', tone(part, 880) > 0.4 && tone(part, 440) < 0.02 && rms(segment(shot.l, 0.47, 1)) < 1e-4, `880 Hz ${tone(part, 880).toFixed(3)}, 440 Hz ${tone(part, 440).toFixed(4)}`);
  check('Trim updates the pad length and waveform', near(shot.engine.state.pads[0].clip.end - shot.engine.state.pads[0].clip.start, 0.25, 1e-9) && shot.engine.state.pads[0].clip.peaks.length === 48, JSON.stringify({ start: shot.engine.state.pads[0].clip.start, end: shot.engine.state.pads[0].clip.end }));

  const looped = await session({
    seconds: 1.5,
    signal: null,
    setup: (e, ctx) => {
      e.setQuantize('Off');
      e.setPadClip(0, twoTone(ctx), { name: 'tones', start: 0, end: 0.25 });
      e.padPress(0);
    }
  });
  const later = segment(looped.l, 1.0, 1.25);
  check('A trimmed loop repeats only its region (restored from saved start/end)', tone(later, 440) > 0.4 && tone(later, 880) < 0.02, `440 Hz ${tone(later, 440).toFixed(3)}, 880 Hz ${tone(later, 880).toFixed(4)}`);

  const preview = await session({
    seconds: 1,
    signal: null,
    setup: (e, ctx) => {
      e.setPadClip(3, twoTone(ctx), { name: 'tones' });
      e.preview(3, 0.5, 0.7);
    }
  });
  check('Preview plays a slice once without marking the pad as playing', tone(segment(preview.l, 0.01, 0.19), 880) > 0.4 && rms(segment(preview.l, 0.25, 1)) < 1e-4 && !preview.engine.state.pads[3].playing, `880 Hz ${tone(segment(preview.l, 0.01, 0.19), 880).toFixed(3)}`);
}

async function chokeTests() {
  const cut = await session({
    seconds: 1,
    signal: null,
    setup: (e, ctx) => {
      e.setQuantize('Off');
      e.setPadClip(0, burst(ctx, 0.25, 880), { name: 'open hat' });
      e.setPadClip(1, burst(ctx, 1, 440), { name: 'closed hat' });
      e.setPadClip(2, burst(ctx, 0.25, 660), { name: 'other group' });
      e.updatePad(0, { choke: 1 });
      e.updatePad(1, { mode: 'One-shot', choke: 1 });
      e.updatePad(2, { choke: 2 });
    },
    at: [
      [0.1, (e) => (e.padPress(0), e.padPress(2))],
      [0.5, (e) => e.padPress(1)]
    ]
  });
  const before = tone(segment(cut.l, 0.15, 0.45), 880);
  const after = tone(segment(cut.l, 0.6, 0.9), 880);
  check('A pad in a choke group cuts off the playing pad in the same group', before > 0.4 && after < 0.01 && !cut.engine.state.pads[0].playing, `880 Hz ${before.toFixed(3)} → ${after.toExponential(1)}`);
  check('The choking pad plays and other groups keep going', tone(segment(cut.l, 0.6, 0.9), 440) > 0.4 && tone(segment(cut.l, 0.6, 0.9), 660) > 0.4 && cut.engine.state.pads[2].playing, `440 Hz ${tone(segment(cut.l, 0.6, 0.9), 440).toFixed(3)}, 660 Hz ${tone(segment(cut.l, 0.6, 0.9), 660).toFixed(3)}`);

  const free = await session({
    seconds: 1,
    signal: null,
    setup: (e, ctx) => {
      e.setQuantize('Off');
      e.setPadClip(0, burst(ctx, 0.25, 880), { name: 'a' });
      e.setPadClip(1, burst(ctx, 0.25, 440), { name: 'b' });
    },
    at: [
      [0.1, (e) => e.padPress(0)],
      [0.5, (e) => e.padPress(1)]
    ]
  });
  check('Pads with choke off play together', tone(segment(free.l, 0.6, 0.9), 880) > 0.4 && tone(segment(free.l, 0.6, 0.9), 440) > 0.4, `880 Hz ${tone(segment(free.l, 0.6, 0.9), 880).toFixed(3)}`);

  const quantized = await session({
    seconds: 2,
    signal: null,
    setup: (e, ctx) => {
      e.setQuantize('1/4');
      e.setPadClip(0, burst(ctx, 0.25, 880), { name: 'a' });
      e.setPadClip(1, burst(ctx, 0.25, 440), { name: 'b' });
      e.updatePad(0, { choke: 1 });
      e.updatePad(1, { choke: 1 });
    },
    at: [
      [0.1, (e) => e.padPress(0)],
      [1.1, (e) => e.padPress(1)]
    ]
  });
  const held = tone(segment(quantized.l, 1.15, 1.45), 880);
  const gone = tone(segment(quantized.l, 1.6, 1.9), 880);
  check('A quantized loop chokes on the beat it starts, not when pressed (1.5 s)', held > 0.4 && gone < 0.01 && tone(segment(quantized.l, 1.6, 1.9), 440) > 0.4, `880 Hz until 1.5 s ${held.toFixed(3)}, after ${gone.toExponential(1)}`);

  const early = await session({
    seconds: 1,
    signal: null,
    setup: (e, ctx) => {
      e.setQuantize('1/4');
      e.setPadClip(0, burst(ctx, 0.25, 880), { name: 'a' });
      e.setPadClip(1, burst(ctx, 0.25, 440), { name: 'b' });
      e.updatePad(0, { choke: 3 });
      e.updatePad(1, { choke: 3 });
    },
    at: [
      [0.1, (e) => e.padPress(0)],
      [0.2, (e) => e.padPress(1)]
    ]
  });
  check('Choking a loop that is still waiting for its beat means it never sounds', tone(segment(early.l, 0.5, 0.8), 880) < 0.01 && tone(segment(early.l, 0.5, 0.8), 440) > 0.4, `880 Hz ${tone(segment(early.l, 0.5, 0.8), 880).toExponential(1)}`);

  const saved = cut.engine.settings();
  const restored = await session({ seconds: 0.1, signal: null, setup: (e) => e.applySettings(saved) });
  check('Choke groups are saved and restored', saved.pads[1].choke === 1 && restored.engine.state.pads.slice(0, 3).map((p) => p.choke).join() === '1,1,2', restored.engine.state.pads.slice(0, 3).map((p) => p.choke).join());
}

async function routingTests() {
  const lowpassBus2 = (routing) => (e) => {
    e.addSlot('bus2', 'filter-drive', { params: { type: 'LPF', cutoff: 200, resonance: 0, drive: 0 } });
    e.setBusRouting(routing);
  };
  const parallel = await session({ seconds: 1, frequency: 2000, setup: lowpassBus2('Parallel') });
  const series = await session({ seconds: 1, frequency: 2000, setup: lowpassBus2('Series') });
  const dry = await session({ seconds: 1, frequency: 2000 });
  const level = (s) => tone(segment(s.l, 0.5, 0.8), 2000);
  check('Parallel routing: a source on Bus 1 skips Bus 2', Math.abs(db(level(parallel), level(dry))) < 0.5, `${db(level(parallel), level(dry)).toFixed(2)} dB vs dry`);
  check('Series routing: a source on Bus 1 runs through Bus 2', db(level(series), level(dry)) < -20, `${db(level(series), level(dry)).toFixed(1)} dB vs dry`);

  const back = await session({
    seconds: 1,
    frequency: 2000,
    setup: lowpassBus2('Series'),
    at: [[0.2, (e) => e.setBusRouting('Parallel')]]
  });
  check('Switching back to parallel takes Bus 2 out of the path again', Math.abs(db(level(back), level(dry))) < 0.5, `${db(level(back), level(dry)).toFixed(2)} dB vs dry`);

  const kept = await session({ seconds: 0.1, signal: null, setup: (e) => e.applySettings(series.engine.settings()) });
  check('Bus routing is saved and restored', series.engine.settings().busRouting === 'Series' && kept.engine.state.busRouting === 'Series', kept.engine.state.busRouting);
}

async function transferTests() {
  const t = await session({
    seconds: 0.1,
    signal: null,
    setup: (e, ctx) => {
      e.setPadClip(0, burst(ctx, 0.5, 880), { name: 'kick', bpm: 120 });
      e.updatePad(0, { mode: 'Gate', choke: 2, level: 0.7, sync: false });
      e.setPadRegion(0, 0.1, 0.3);
      e.setPadClip(1, burst(ctx, 0.5, 440), { name: 'snare' });
    }
  });
  const e = t.engine;
  const pad = (i) => {
    const p = e.state.pads[i];
    return [p.clip?.name ?? null, p.mode, p.choke, p.level, p.sync, p.clip?.start ?? null].join();
  };
  const kick = pad(0);
  e.transferPad(0, 2, 'copy');
  check('Copy puts the sample, its trim and the pad settings on the new pad and keeps the original', pad(2) === kick && pad(0) === kick && e.pads.buffers[2] === e.pads.buffers[0], pad(2));
  e.transferPad(0, 3, 'move');
  check('Move empties the source pad and resets its settings', pad(3) === kick && e.state.pads[0].clip === null && e.pads.buffers[0] === null && pad(0) === ',Loop,0,1,true,', `${pad(3)} / ${pad(0)}`);
  const snare = pad(1);
  e.transferPad(3, 1, 'swap');
  check('Swap trades two pads', pad(1) === kick && pad(3) === snare, `${pad(1)} / ${pad(3)}`);
  check('Moving an empty pad or onto itself does nothing', e.transferPad(5, 6, 'move') === false && e.transferPad(1, 1, 'copy') === false && e.transferPad(1, 4, 'teleport') === false, 'refused');
}

async function layoutTests() {
  check('Old 8-pad banks map onto the same pad numbers in 12-pad banks', [0, 7, 8, 15].map((i) => migratePadIndex(i, 8)).join() === '0,7,12,19', [0, 7, 8, 15].map((i) => migratePadIndex(i, 8)).join());
  check('Stored pads move highest first so none overwrite each other', JSON.stringify(padMoves([2, 8, 15, 9], 8)) === '[[15,19],[9,13],[8,12]]', JSON.stringify(padMoves([2, 8, 15, 9], 8)));

  const legacy = { pads: Array.from({ length: 16 }, (_, i) => ({ mode: i === 8 ? 'Gate' : 'Loop', level: i === 15 ? 0.4 : 1, sync: true })) };
  const moved = await session({ seconds: 0.1, signal: null, setup: (e) => e.applySettings(legacy) });
  const p = moved.engine.state.pads;
  check('Pad settings saved with 8-pad banks land on the same pads after the upgrade (B1 stays B1)', p[12].mode === 'Gate' && p[8].mode === 'Loop' && p[19].level === 0.4 && p[15].level === 1, `B1 ${p[12].mode}, B8 level ${p[19].level}`);

  const midiMap = migrateMidiMap({ 'n0:36': { kind: 'pad', index: 9 }, 'n0:37': { kind: 'pad', index: 3 }, '0:20': { kind: 'bus', busId: 'bus2' } }, 8);
  check('MIDI pad mappings follow their pads to the new layout', midiMap['n0:36'].index === 13 && midiMap['n0:37'].index === 3 && midiMap['0:20'].busId === 'bus2', JSON.stringify(midiMap));

  await new Promise((resolve) => {
    const gone = indexedDB.deleteDatabase('chrome404');
    gone.onsuccess = gone.onerror = gone.onblocked = resolve;
  });
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('chrome404', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('pads', { keyPath: 'index' });
      for (const index of [2, 8, 9, 15]) store.put({ index, name: `old ${index}`, sampleRate: RATE, channels: [new Float32Array(4)] });
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
  const upgraded = (await getAllClips()).map((r) => `${r.index}:${r.name}`).join();
  check('Pads stored with the old layout are moved when the database upgrades', upgraded === '2:old 2,12:old 8,13:old 9,19:old 15', upgraded);
}

async function presetTests() {
  const source = await session({
    seconds: 0.1,
    signal: null,
    setup: (e) => {
      e.addSlot('bus1', 'filter-drive', { params: { type: 'HPF', cutoff: 900 } });
      const uid = e.addSlot('bus4', 'delay', { params: { time: '1/4', feedback: 0.6 }, enabled: false });
      e.addSlot('bus4', 'reverb');
      e.setLfo('bus4', uid, { enabled: true, target: 'feedback', depth: 0.4 });
      e.setBusEngaged('bus1', false);
      e.setBusRouting('Series');
    }
  });
  const preset = JSON.parse(JSON.stringify(presetFrom(source.engine.state, 'Dusty')));
  const target = await session({ seconds: 0.1, signal: null, setup: (e) => e.loadPreset(preset) });
  const shape = (state) => JSON.stringify([state.busRouting, ['bus1', 'bus2', 'bus3', 'bus4', 'input', 'master'].map((id) => [state.buses[id].engaged, state.buses[id].slots.map((s) => [s.effect, s.enabled, s.params, s.lfo])])]);
  check('A saved preset loads back with the same effects, settings, LFOs, bus switches and routing', shape(target.engine.state) === shape(source.engine.state) && target.engine.state.busRouting === 'Series', `${preset.name}: ${Object.keys(preset.buses).join(', ')}`);
  check('Saving leaves out empty buses', Object.keys(preset.buses).join() === 'bus1,bus4', Object.keys(preset.buses).join());

  const junk = await session({ seconds: 0.1, signal: null, setup: (e) => e.loadPreset({ buses: { bus1: [null, 'x', { effect: 'nope' }, { effect: 'delay', params: 'bad' }], bus2: 'oops' }, busRouting: 'Sideways' }) });
  check('A damaged preset loads what it can and ignores the rest', junk.engine.state.buses.bus1.slots.map((s) => s.effect).join() === 'delay' && junk.engine.state.buses.bus2.slots.length === 0 && junk.engine.state.busRouting === 'Parallel', junk.engine.state.buses.bus1.slots.map((s) => s.effect).join());
}

async function run() {
  await gridTests();
  await quantizeTests();
  await engageTests();
  await memoryTests();
  await deckTests();
  await padTests();
  await chokeTests();
  await routingTests();
  await presetTests();
  await layoutTests();
  await transferTests();
  await recordTests();
  await chopTests();
  midiTests();
  keyTests();
  wavTests();
  ctrlTests();
}

run()
  .catch((err) => check('Harness crashed', false, err.stack))
  .finally(() => {
    const passed = results.filter((r) => r.pass).length;
    const lines = results.map((r) => `<span class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</span>  ${r.name}  —  ${r.detail}`);
    document.getElementById('out').innerHTML = [...lines, '', `${passed}/${results.length} passed`].join('\n');
    window.__smoke = { passed, total: results.length, results };
  });
