import { Bus } from './bus.js';
import { PadBank, waveOf } from './pads.js';
import { TempoDetector } from './tempo-detector.js';
import {
  BUS_IDS,
  BUS_ROUTINGS,
  CHOKE_GROUPS,
  DECK_SIDES,
  LEGACY_PADS_PER_BANK,
  MAX_SLOTS,
  PADS_PER_BANK,
  PAD_COUNT,
  PAD_MODES,
  PAD_TRANSFERS,
  REC_LENGTHS,
  ROUTES,
  SOURCE_LEVEL_MAX,
  defaultPad,
  defaultState,
  migratePadIndex,
  settingsFrom
} from '../shared/state.js';
import { defaultParams, getEffect, isAvailable, isQuantized } from '../effects/registry.js';
import { clamp, fromNormalized, sanitizeParam, toNormalized } from '../shared/params.js';
import { LFO_PARAMS, Lfo, defaultLfo, isModulatable } from '../shared/lfo.js';
import { divisionBeats } from '../shared/sync.js';
import { clampBpm } from '../shared/tempo.js';
import { BEATS_PER_BAR, QUANTIZE_OPTIONS, beatAt, nextBoundary, rebase } from '../shared/grid.js';

const MASTER_MAX = 1.5;
const AUTO_BPM_CONFIDENCE = 0.2;
const AUTO_BPM_MIN_CHANGE = 0.5;
const MAX_TICK = 0.25;
const LFO_SEED = 0x9e3779b9;
const GAIN_SMOOTHING = 0.01;
const MAX_RECORD_SECONDS = 60;
const MIN_RECORD_SECONDS = 0.05;
const PHASE_TOLERANCE = 0.012;
const MIN_REGION_SECONDS = 0.01;

export function sideGain(side, crossfader) {
  if (side === 'A') return crossfader <= 0 ? 1 : Math.cos((crossfader * Math.PI) / 2);
  if (side === 'B') return crossfader >= 0 ? 1 : Math.cos((-crossfader * Math.PI) / 2);
  return 1;
}

export class AudioEngine {
  constructor(ctx, { destination = ctx.destination, onChange = () => {}, onClip = () => {} } = {}) {
    this.ctx = ctx;
    this.onChange = onChange;
    this.onClip = onClip;
    this.state = defaultState();
    this.sources = new Map();
    this.batchDepth = 0;
    this.tempo = null;
    this.recorder = null;
    this.recordJob = 0;
    this.lastTick = null;
    this.slotCounter = 0;
    this.lfos = new Map();
    this.origin = 0;

    this.buses = Object.fromEntries(BUS_IDS.map((id) => [id, new Bus(ctx, id)]));
    this.dry = ctx.createGain();
    this.analysisIn = ctx.createGain();
    this.master = ctx.createGain();
    this.master.gain.value = this.state.master;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.meterBuffer = new Float32Array(this.analyser.fftSize);
    this.pads = new PadBank(ctx, { onEnded: (index) => this.handlePadEnded(index) });

    const { bus1, bus2, bus3, bus4, input, master } = this.buses;
    bus1.output.connect(bus3.input);
    bus2.output.connect(bus3.input);
    this.dry.connect(bus3.input);
    bus3.output.connect(bus4.input);
    bus4.output.connect(master.input);
    master.output.connect(this.master);
    this.master.connect(destination);
    this.master.connect(this.analyser);
    input.output.connect(this.routeNode(this.state.inputRoute));
    this.pads.output.connect(this.routeNode(this.state.padRoute));
  }

  async startTempoDetection() {
    this.tempo ??= await TempoDetector.create(this.ctx, this.analysisIn, (estimate) => this.handleTempo(estimate));
  }

  async startRecorder() {
    if (this.recorder) return;
    await this.ctx.audioWorklet.addModule(new URL('./worklets/recorder-processor.js', import.meta.url));
    const node = new AudioWorkletNode(this.ctx, 'chrome404-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit'
    });
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.master.connect(node).connect(sink).connect(this.ctx.destination);
    node.port.onmessage = ({ data }) => {
      if (data.type === 'done') this.finishRecording(data);
    };
    this.recorder = node;
  }

  handleTempo(estimate) {
    this.state.detected = estimate;
    if (this.state.autoBpm && estimate.confidence >= AUTO_BPM_CONFIDENCE) this.follow(estimate);
    else this.emit();
  }

  follow(estimate) {
    this.batch(() => {
      if (Math.abs(estimate.bpm - this.state.bpm) >= AUTO_BPM_MIN_CHANGE) this.setBpm(estimate.bpm);
      if (Number.isFinite(estimate.beat)) this.lockPhase(estimate.beat);
    });
  }

  lockPhase(beatTime) {
    const beat = this.beat(beatTime);
    const shift = ((beat - Math.round(beat)) * 60) / this.state.bpm;
    if (Math.abs(shift) >= PHASE_TOLERANCE) this.setGrid(this.origin + shift);
  }

  resetTempo() {
    this.tempo?.reset();
    this.state.detected = null;
  }

  setAutoBpm(enabled) {
    this.state.autoBpm = Boolean(enabled);
    const detected = this.state.detected;
    if (this.state.autoBpm && detected && detected.confidence >= AUTO_BPM_CONFIDENCE) this.follow(detected);
    else this.emit();
  }

  routeNode(route) {
    return route === 'dry' ? this.dry : this.buses[route].input;
  }

  findSource(id) {
    return this.state.sources.find((s) => s.id === id) ?? null;
  }

  hasTab(tabId) {
    return this.state.sources.some((s) => s.tabId === tabId);
  }

  addSource(node, { id, kind, label, route = 'bus1', inputFx = false, tabId = null, stream = null }) {
    if (this.sources.has(id)) this.removeSource(id);
    const gain = this.ctx.createGain();
    node.connect(gain);
    this.sources.set(id, { node, gain, stream });
    const meta = { id, kind, label, route: ROUTES.includes(route) ? route : 'bus1', inputFx, tabId, level: 1, muted: false, side: null };
    gain.gain.value = this.sourceGain(meta);
    this.state.sources.push(meta);
    this.connectSource(meta);
    this.resetTempo();
    this.emit();
    return meta;
  }

  addStreamSource(stream, options) {
    const node = this.ctx.createMediaStreamSource(stream);
    const meta = this.addSource(node, { ...options, stream });
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => this.removeSource(meta.id), { once: true });
    }
    return meta;
  }

  connectSource(meta) {
    const { gain } = this.sources.get(meta.id);
    gain.disconnect();
    gain.connect(meta.inputFx ? this.buses.input.input : this.routeNode(meta.route));
    gain.connect(this.analysisIn);
  }

  sourceGain(meta) {
    return meta.muted ? 0 : meta.level * sideGain(meta.side, this.state.crossfader);
  }

  applySourceGain(meta) {
    const { gain } = this.sources.get(meta.id);
    gain.gain.setTargetAtTime(this.sourceGain(meta), this.ctx.currentTime, GAIN_SMOOTHING);
  }

  updateSource(id, { route, inputFx, level, muted, side } = {}) {
    const meta = this.findSource(id);
    if (!meta) return;
    const wiring = [meta.route, meta.inputFx].join();
    if (ROUTES.includes(route)) meta.route = route;
    if (typeof inputFx === 'boolean') meta.inputFx = inputFx;
    if (level !== undefined && Number.isFinite(Number(level))) meta.level = clamp(Number(level), 0, SOURCE_LEVEL_MAX);
    if (typeof muted === 'boolean') meta.muted = muted;
    if (side !== undefined) meta.side = DECK_SIDES.includes(side) ? side : null;
    if ([meta.route, meta.inputFx].join() !== wiring) this.connectSource(meta);
    this.applySourceGain(meta);
    this.emit();
  }

  setCrossfader(value) {
    this.state.crossfader = clamp(Number(value) || 0, -1, 1);
    for (const meta of this.state.sources) this.applySourceGain(meta);
    this.emit();
  }

  removeSource(id) {
    const entry = this.sources.get(id);
    if (!entry) return;
    this.sources.delete(id);
    entry.gain.disconnect();
    entry.node.disconnect();
    entry.stream?.getTracks().forEach((track) => track.stop());
    this.state.sources = this.state.sources.filter((s) => s.id !== id);
    this.resetTempo();
    this.emit();
  }

  resolveSlot(busId, ref) {
    const slots = this.state.buses[busId]?.slots;
    if (!slots) return null;
    return (typeof ref === 'number' ? slots[ref] : slots.find((s) => s.uid === ref)) ?? null;
  }

  beat(time = this.ctx.currentTime) {
    return beatAt(time, this.origin, this.state.bpm);
  }

  switchTime(effectId) {
    const { quantize } = this.state;
    if (quantize === 'Off' || !isQuantized(effectId)) return 0;
    return nextBoundary(this.ctx.currentTime, this.origin, this.state.bpm, quantize);
  }

  applySlot(busId, slot) {
    const node = this.buses[busId].slot(slot.uid);
    const active = slot.enabled && this.state.buses[busId].engaged;
    if (!node || node.enabled === active) return;
    node.setEnabled(active, active ? this.switchTime(slot.effect) : 0);
  }

  recall(busId, effectId) {
    const merged = defaultParams(effectId);
    const saved = this.state.memory[busId]?.[effectId];
    if (saved) {
      for (const def of getEffect(effectId).params) {
        if (def.id in saved) merged[def.id] = sanitizeParam(def, saved[def.id]);
      }
    }
    return merged;
  }

  remember(busId, slot) {
    this.state.memory[busId][slot.effect] = { ...slot.params };
  }

  addSlot(busId, effectId, { params = {}, enabled = true, recall = false } = {}) {
    const bus = this.buses[busId];
    const busState = this.state.buses[busId];
    if (!bus || !isAvailable(effectId, busId) || busState.slots.length >= MAX_SLOTS) return null;
    const uid = `fx${++this.slotCounter}`;
    const merged = recall ? this.recall(busId, effectId) : defaultParams(effectId);
    for (const def of getEffect(effectId).params) {
      if (def.id in params) merged[def.id] = sanitizeParam(def, params[def.id]);
    }
    bus.add(uid, effectId, merged, { bpm: this.state.bpm, origin: this.origin });
    const slot = { uid, effect: effectId, enabled: Boolean(enabled), params: merged, lfo: defaultLfo() };
    busState.slots.push(slot);
    this.applySlot(busId, slot);
    this.remember(busId, slot);
    this.lfos.set(uid, new Lfo(LFO_SEED + this.slotCounter * 7919));
    this.emit();
    return uid;
  }

  swapSlot(busId, ref, effectId) {
    const slot = this.resolveSlot(busId, ref);
    if (!slot || slot.effect === effectId || !isAvailable(effectId, busId)) return;
    this.remember(busId, slot);
    const params = this.recall(busId, effectId);
    this.buses[busId].slot(slot.uid).setEffect(effectId, params, { bpm: this.state.bpm, origin: this.origin });
    const target = this.validTarget(effectId, slot.lfo?.target);
    Object.assign(slot, { effect: effectId, params, lfo: { ...defaultLfo(), ...slot.lfo, target } });
    this.remember(busId, slot);
    this.emit();
  }

  removeSlot(busId, ref) {
    const slot = this.resolveSlot(busId, ref);
    if (!slot) return;
    this.buses[busId].remove(slot.uid);
    this.state.buses[busId].slots = this.state.buses[busId].slots.filter((s) => s !== slot);
    this.lfos.delete(slot.uid);
    this.emit();
  }

  moveSlot(busId, ref, delta) {
    const slot = this.resolveSlot(busId, ref);
    if (!slot) return;
    const slots = this.state.buses[busId].slots;
    const index = clamp(slots.indexOf(slot) + Math.sign(delta), 0, slots.length - 1);
    slots.splice(slots.indexOf(slot), 1);
    slots.splice(index, 0, slot);
    this.buses[busId].move(slot.uid, index);
    this.emit();
  }

  clearBus(busId) {
    const busState = this.state.buses[busId];
    if (!busState) return;
    busState.slots.forEach((s) => this.lfos.delete(s.uid));
    busState.slots = [];
    this.buses[busId].clear();
    this.emit();
  }

  setSlotEnabled(busId, ref, enabled) {
    const slot = this.resolveSlot(busId, ref);
    if (!slot) return;
    slot.enabled = Boolean(enabled);
    this.applySlot(busId, slot);
    this.emit();
  }

  setBusEffect(busId, effectId, params = {}) {
    if (!this.buses[busId]) return;
    this.batch(() => {
      this.clearBus(busId);
      if (effectId) this.addSlot(busId, effectId, { params, enabled: false });
    });
  }

  setBusEnabled(busId, enabled) {
    const busState = this.state.buses[busId];
    if (!busState) return;
    this.batch(() => busState.slots.forEach((s) => this.setSlotEnabled(busId, s.uid, enabled)));
  }

  setBusEngaged(busId, engaged) {
    const busState = this.state.buses[busId];
    if (!busState) return;
    busState.engaged = Boolean(engaged);
    if (busState.engaged && !busState.slots.some((s) => s.enabled)) busState.slots.forEach((s) => (s.enabled = true));
    busState.slots.forEach((s) => this.applySlot(busId, s));
    this.emit();
  }

  setParam(busId, ref, paramId, value) {
    const slot = this.resolveSlot(busId, ref);
    if (!slot) return;
    const def = getEffect(slot.effect).params.find((p) => p.id === paramId);
    if (!def) return;
    const v = sanitizeParam(def, value);
    slot.params[paramId] = v;
    this.remember(busId, slot);
    this.buses[busId].slot(slot.uid).setParam(paramId, v);
    this.emit();
  }

  validTarget(effectId, target) {
    if (!effectId || !target) return null;
    const def = getEffect(effectId)?.params.find((p) => p.id === target);
    return def && isModulatable(def) ? target : null;
  }

  setLfo(busId, ref, changes = {}) {
    const slot = this.resolveSlot(busId, ref);
    if (!slot) return;
    const lfo = { ...defaultLfo(), ...slot.lfo };
    for (const def of LFO_PARAMS) {
      if (def.id in changes) lfo[def.id] = sanitizeParam(def, changes[def.id]);
    }
    const wasModulating = lfo.enabled && lfo.target;
    const previous = lfo.target;
    if ('enabled' in changes) lfo.enabled = Boolean(changes.enabled);
    if ('target' in changes) lfo.target = this.validTarget(slot.effect, changes.target);
    const stillModulating = lfo.enabled && lfo.target === previous;
    if (wasModulating && !stillModulating) this.buses[busId].slot(slot.uid).setParam(previous, slot.params[previous]);
    slot.lfo = lfo;
    this.emit();
  }

  tickModulation(now = this.ctx.currentTime) {
    const dt = this.lastTick === null ? 0 : clamp(now - this.lastTick, 0, MAX_TICK);
    this.lastTick = now;
    for (const busId of BUS_IDS) {
      for (const slot of this.state.buses[busId].slots) {
        const { lfo, params } = slot;
        if (!lfo?.enabled || !lfo.target) continue;
        const def = getEffect(slot.effect).params.find((p) => p.id === lfo.target);
        const osc = this.lfos.get(slot.uid);
        if (!def || !osc) continue;
        const cycle = lfo.sync === 'Free' ? 1 / lfo.rate : (divisionBeats(lfo.sync) * 60) / this.state.bpm;
        osc.advance(dt, cycle);
        const normalized = clamp(toNormalized(def, params[lfo.target]) + lfo.depth * 0.5 * osc.value(lfo.shape), 0, 1);
        this.buses[busId].slot(slot.uid).setParam(lfo.target, fromNormalized(def, normalized));
      }
    }
  }

  setInputRoute(route) {
    if (!ROUTES.includes(route)) return;
    this.buses.input.output.disconnect();
    this.buses.input.output.connect(this.routeNode(route));
    this.state.inputRoute = route;
    this.emit();
  }

  setBusRouting(routing) {
    if (!BUS_ROUTINGS.includes(routing)) return;
    const { bus1, bus2, bus3 } = this.buses;
    bus1.output.disconnect();
    bus1.output.connect(routing === 'Series' ? bus2.input : bus3.input);
    this.state.busRouting = routing;
    this.emit();
  }

  setPadRoute(route) {
    if (!ROUTES.includes(route)) return;
    this.pads.output.disconnect();
    this.pads.output.connect(this.routeNode(route));
    this.state.padRoute = route;
    this.emit();
  }

  setQuantize(quantize) {
    if (!QUANTIZE_OPTIONS.includes(quantize)) return;
    this.state.quantize = quantize;
    this.emit();
  }

  setGrid(origin) {
    this.origin = origin;
    for (const bus of Object.values(this.buses)) bus.setGrid(origin);
  }

  alignGrid(beat, time = this.ctx.currentTime) {
    this.setGrid(time - (Number(beat) * 60) / this.state.bpm);
    this.emit();
  }

  tap({ bpm = null, beat = 0, time = this.ctx.currentTime } = {}) {
    this.batch(() => {
      if (bpm) this.setBpm(bpm);
      this.alignGrid(beat, Math.min(time, this.ctx.currentTime));
    });
  }

  setBpm(bpm) {
    const next = clampBpm(bpm);
    if (next !== this.state.bpm) this.setGrid(rebase(this.ctx.currentTime, this.origin, this.state.bpm, next));
    this.state.bpm = next;
    for (const bus of Object.values(this.buses)) bus.setTempo(next);
    for (let i = 0; i < PAD_COUNT; i++) this.pads.setRate(i, this.padRate(i));
    this.emit();
  }

  setMaster(level) {
    const v = clamp(Number(level) || 0, 0, MASTER_MAX);
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
    this.state.master = v;
    this.emit();
  }

  padRate(index) {
    const pad = this.state.pads[index];
    return pad.sync && pad.clip?.bpm ? this.state.bpm / pad.clip.bpm : 1;
  }

  region(duration, start, end) {
    const s = clamp(Number(start) || 0, 0, Math.max(0, duration - MIN_REGION_SECONDS));
    const e = Number.isFinite(Number(end)) && end !== null ? clamp(Number(end), s + MIN_REGION_SECONDS, duration) : duration;
    return { start: s, end: Math.max(s + Math.min(MIN_REGION_SECONDS, duration), e) };
  }

  setPadClip(index, buffer, { name = `Pad ${index + 1}`, bpm = null, start = 0, end = null } = {}) {
    const pad = this.state.pads[index];
    if (!pad || !buffer) return;
    this.pads.setBuffer(index, buffer);
    pad.playing = false;
    const region = this.region(buffer.duration, start, end);
    pad.clip = { name: String(name), bpm: Number(bpm) > 0 ? Number(bpm) : null, duration: buffer.duration, ...region, ...waveOf(buffer, undefined, region.start, region.end) };
    this.emit();
  }

  setPadRegion(index, start, end) {
    const pad = this.state.pads[index];
    const buffer = this.pads.buffers[index];
    if (!pad?.clip || !buffer) return;
    Object.assign(pad.clip, this.region(buffer.duration, start, end));
    Object.assign(pad.clip, waveOf(buffer, undefined, pad.clip.start, pad.clip.end));
    this.pads.setLoop(index, pad.clip.start, pad.clip.end - pad.clip.start);
    this.emit();
  }

  transferPad(from, to, mode = 'copy') {
    const valid = (i) => Number.isInteger(i) && i >= 0 && i < PAD_COUNT;
    if (!valid(from) || !valid(to) || from === to || !PAD_TRANSFERS.includes(mode) || !this.state.pads[from].clip) return false;
    const take = (i) => {
      const { clip, mode: playMode, level, sync, choke } = this.state.pads[i];
      return { buffer: this.pads.buffers[i], clip: clip && { ...clip }, settings: { mode: playMode, level, sync, choke } };
    };
    const place = (i, { buffer, clip, settings }) => {
      this.stopPad(i);
      if (clip && buffer) this.setPadClip(i, buffer, clip);
      else this.clearPad(i);
      this.updatePad(i, settings);
    };
    const source = take(from);
    const target = take(to);
    const { mode: playMode, level, sync, choke } = defaultPad();
    this.batch(() => {
      place(to, source);
      if (mode === 'swap') place(from, target);
      else if (mode === 'move') place(from, { buffer: null, clip: null, settings: { mode: playMode, level, sync, choke } });
    });
    return true;
  }

  setPadBpm(index, bpm) {
    const pad = this.state.pads[index];
    if (!pad?.clip) return undefined;
    pad.clip.bpm = Number(bpm) > 0 ? clampBpm(bpm) : null;
    this.pads.setRate(index, this.padRate(index));
    this.emit();
    return pad.clip.bpm;
  }

  preview(index, start, end) {
    const buffer = this.pads.buffers[index];
    if (!buffer) return false;
    const region = this.region(buffer.duration, start, end);
    // One voice per pad: hearing it in the editor takes over from the pad.
    this.stopPad(index);
    return this.pads.preview(index, { offset: region.start, duration: region.end - region.start });
  }

  stopPreview() {
    this.pads.stop('preview');
  }

  setLatency(seconds) {
    this.state.latency = Math.max(0, Number(seconds) || 0);
  }

  clearPad(index) {
    const pad = this.state.pads[index];
    if (!pad) return;
    this.pads.setBuffer(index, null);
    Object.assign(pad, { clip: null, playing: false });
    this.emit();
  }

  updatePad(index, { mode, level, sync, choke } = {}) {
    const pad = this.state.pads[index];
    if (!pad) return;
    if (PAD_MODES.includes(mode) && mode !== pad.mode) {
      pad.mode = mode;
      this.stopPad(index);
    }
    if (level !== undefined && Number.isFinite(Number(level))) {
      pad.level = clamp(Number(level), 0, SOURCE_LEVEL_MAX);
      this.pads.setLevel(index, pad.level);
    }
    if (typeof sync === 'boolean') {
      pad.sync = sync;
      this.pads.setRate(index, this.padRate(index));
    }
    if (CHOKE_GROUPS.includes(Number(choke))) pad.choke = Number(choke);
    this.emit();
  }

  chokeOthers(index, when) {
    const group = this.state.pads[index].choke;
    if (!group) return;
    this.state.pads.forEach((other, i) => {
      if (i === index || other.choke !== group || !other.playing) return;
      this.pads.stop(i, when);
      other.playing = false;
    });
  }

  padPress(index) {
    const pad = this.state.pads[index];
    if (!pad?.clip || !this.pads.has(index)) return;
    if (pad.mode === 'Loop' && pad.playing) {
      this.stopPad(index);
      return;
    }
    const loop = pad.mode === 'Loop';
    const quantize = this.state.quantize;
    const when = loop && quantize !== 'Off' ? nextBoundary(this.ctx.currentTime, this.origin, this.state.bpm, quantize) : 0;
    this.chokeOthers(index, when);
    if (this.pads.previewOf === index) this.stopPreview();
    pad.playing = this.pads.start(index, { loop, when, rate: this.padRate(index), level: pad.level, offset: pad.clip.start, duration: pad.clip.end - pad.clip.start });
    this.emit();
  }

  padRelease(index) {
    if (this.state.pads[index]?.mode === 'Gate') this.stopPad(index);
  }

  stopPad(index) {
    const pad = this.state.pads[index];
    if (!pad) return;
    this.pads.stop(index);
    if (!pad.playing) return;
    pad.playing = false;
    this.emit();
  }

  stopPads() {
    this.stopPreview();
    this.batch(() => {
      for (let i = 0; i < PAD_COUNT; i++) this.stopPad(i);
    });
  }

  handlePadEnded(index) {
    const pad = this.state.pads[index];
    if (!pad?.playing) return;
    pad.playing = false;
    this.emit();
  }

  startRecording({ pad, length = '1 bar' } = {}) {
    const index = Number(pad);
    if (!this.recorder || this.state.recording || !this.state.pads[index] || !REC_LENGTHS.includes(length)) return false;
    const now = this.ctx.currentTime;
    const start = this.state.quantize === 'Off' ? now : nextBoundary(now, this.origin, this.state.bpm, '1 bar');
    const bars = length === 'Free' ? 0 : divisionBeats(length) / BEATS_PER_BAR;
    const end = bars ? start + (bars * BEATS_PER_BAR * 60) / this.state.bpm : start + MAX_RECORD_SECONDS;
    const id = ++this.recordJob;
    this.state.recording = { id, pad: index, length, bpm: this.state.bpm, start, end: bars ? end : null };
    this.recorder.port.postMessage({ type: 'start', id, start, end });
    this.emit();
    return true;
  }

  stopRecording() {
    const rec = this.state.recording;
    if (!rec) return;
    const now = this.ctx.currentTime;
    if (now < rec.start) {
      this.recorder.port.postMessage({ type: 'cancel', id: rec.id });
      this.state.recording = null;
      this.emit();
      return;
    }
    const end = this.state.quantize === 'Off' ? now : nextBoundary(now, this.origin, this.state.bpm, '1 bar');
    rec.end = rec.end === null ? end : Math.min(rec.end, end);
    rec.stopping = true;
    this.recorder.port.postMessage({ type: 'stop', id: rec.id, end: rec.end });
    this.emit();
  }

  finishRecording({ id, left, right, frames, sampleRate }) {
    const rec = this.state.recording;
    if (!rec || rec.id !== id) return;
    this.state.recording = null;
    const length = rec.end === null ? frames : Math.round((rec.end - rec.start) * sampleRate);
    if (length < MIN_RECORD_SECONDS * sampleRate) {
      this.emit();
      return;
    }
    const buffer = this.ctx.createBuffer(2, length, sampleRate);
    [left, right].forEach((chunks, ch) => {
      const data = buffer.getChannelData(ch);
      let offset = 0;
      for (const chunk of chunks) {
        if (offset >= length) break;
        const part = chunk.subarray(0, Math.min(chunk.length, length - offset));
        data.set(part, offset);
        offset += part.length;
      }
    });
    const name = rec.length === 'Free' ? `${(length / sampleRate).toFixed(1)} s at ${Math.round(rec.bpm)} BPM` : `${rec.length} at ${Math.round(rec.bpm)} BPM`;
    const meta = { name, bpm: rec.bpm };
    this.setPadClip(rec.pad, buffer, meta);
    this.onClip(rec.pad, buffer, meta);
  }

  transport(now = this.ctx.currentTime) {
    const rec = this.state.recording;
    return {
      beat: this.beat(now),
      rec: rec ? { pad: rec.pad, armed: now < rec.start, elapsed: Math.max(0, now - rec.start), total: rec.end === null ? null : rec.end - rec.start } : null,
      pads: this.padHeads(now)
    };
  }

  padHeads(now) {
    const heard = now - (this.ctx.outputLatency || 0) - (this.ctx.baseLatency || 0);
    const heads = {};
    this.state.pads.forEach((pad, i) => {
      const head = pad.playing ? this.pads.head(i, heard) : null;
      if (head) heads[i] = head;
    });
    return heads;
  }

  static slotsFromSaved(bus) {
    if (Array.isArray(bus.slots)) return bus.slots;
    return bus.effect ? [{ effect: bus.effect, enabled: bus.enabled, params: bus.params, lfo: bus.lfo }] : [];
  }

  applySettings(saved) {
    if (!saved) return;
    this.batch(() => {
      if (saved.bpm !== undefined) this.setBpm(saved.bpm);
      if (saved.autoBpm !== undefined) this.setAutoBpm(saved.autoBpm);
      if (saved.quantize !== undefined) this.setQuantize(saved.quantize);
      if (saved.master !== undefined) this.setMaster(saved.master);
      if (saved.inputRoute) this.setInputRoute(saved.inputRoute);
      if (saved.padRoute) this.setPadRoute(saved.padRoute);
      if (saved.busRouting) this.setBusRouting(saved.busRouting);
      if (saved.crossfader !== undefined) this.setCrossfader(saved.crossfader);
      for (const busId of BUS_IDS) {
        const memory = saved.memory?.[busId];
        if (memory && typeof memory === 'object') {
          for (const [effectId, params] of Object.entries(memory)) {
            if (getEffect(effectId) && params && typeof params === 'object') this.state.memory[busId][effectId] = { ...params };
          }
        }
      }
      for (const busId of BUS_IDS) {
        const bus = saved.buses?.[busId];
        if (!bus) continue;
        this.clearBus(busId);
        this.state.buses[busId].engaged = bus.engaged ?? true;
        for (const spec of AudioEngine.slotsFromSaved(bus)) {
          const uid = this.addSlot(busId, spec.effect, { params: spec.params, enabled: spec.enabled ?? true });
          if (uid && spec.lfo) this.setLfo(busId, uid, spec.lfo);
        }
      }
      const perBank = Number(saved.padsPerBank) || LEGACY_PADS_PER_BANK;
      (saved.pads ?? []).forEach((pad, i) => {
        const index = perBank === PADS_PER_BANK ? i : migratePadIndex(i, perBank);
        if (!pad || index < 0 || index >= PAD_COUNT) return;
        const { mode, level, sync, choke } = { ...defaultPad(), ...pad };
        this.updatePad(index, { mode, level, sync: Boolean(sync), choke });
      });
    });
  }

  static presetSlots(specs) {
    if (!Array.isArray(specs)) return [];
    const object = (value) => (value && typeof value === 'object' ? value : undefined);
    return specs.filter(object).map(({ effect, enabled, params, lfo }) => ({ effect, enabled, params: object(params) ?? {}, lfo: object(lfo) }));
  }

  loadPreset(preset) {
    const buses = Object.fromEntries(BUS_IDS.map((id) => [id, { engaged: preset.engaged?.[id] ?? true, slots: AudioEngine.presetSlots(preset.buses?.[id]) }]));
    this.applySettings({ buses, busRouting: preset.busRouting });
  }

  settings() {
    return structuredClone(settingsFrom(this.state));
  }

  snapshot() {
    return structuredClone(this.state);
  }

  level() {
    this.analyser.getFloatTimeDomainData(this.meterBuffer);
    let peak = 0;
    let sum = 0;
    for (const v of this.meterBuffer) {
      peak = Math.max(peak, Math.abs(v));
      sum += v * v;
    }
    const slots = {};
    for (const bus of Object.values(this.buses)) Object.assign(slots, bus.meters());
    return { peak, rms: Math.sqrt(sum / this.meterBuffer.length), slots };
  }

  batch(fn) {
    this.batchDepth++;
    try {
      fn();
    } finally {
      this.batchDepth--;
    }
    this.emit();
  }

  emit() {
    if (this.batchDepth === 0) this.onChange(this.snapshot());
  }
}
