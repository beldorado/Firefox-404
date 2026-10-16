import { MSG, TARGET } from '../shared/messages.js';
import { BUS_IDS, BUS_LABELS, BUS_ROUTINGS, DECK_SIDES, DEFAULT_MASTER, MAX_SLOTS, SOURCE_LEVEL_MAX } from '../shared/state.js';
import { getEffect } from '../effects/registry.js';
import { clamp, formatValue, fromNormalized, toNormalized } from '../shared/params.js';
import { TapTempo } from '../shared/tempo.js';
import { BEATS_PER_BAR, QUANTIZE_OPTIONS, position } from '../shared/grid.js';
import { createPresets } from './presets.js';
import { MidiLearn } from './midi.js';
import { FocusModality, HoldKeys } from './keys.js';
import { h } from './dom.js';
import { EDITORS } from './editors/index.js';
import { LFO_PARAMS, isModulatable } from '../shared/lfo.js';
import { busLit, createPerform } from './perform.js';
import { fillEffectOptions, routeSelect, setFill } from './widgets.js';

const SLIDER_STEPS = 1000;
const AUTO_CONFIDENT = 0.2;
const GR_RANGE_DB = 24;
const MASTER_MAX = 1.5;
const READOUT_MS = 1600;
const VIEWS = ['perform', 'edit'];
const ROUTING_HINTS = {
  Parallel: 'Bus 1 and Bus 2 each feed Bus 3, then Bus 4.',
  Series: 'Bus 1 → Bus 2 → Bus 3 → Bus 4. Sources sent to Bus 2 skip Bus 1.'
};
const $ = (id) => document.getElementById(id);

let state = null;
let structureKey = '';
let pointerDown = false;
let pending = [];
let readoutTimer = null;
const editors = new Map();
const collapsed = new Set();
const tapTempo = new TapTempo();
const midi = new MidiLearn({ onControl: handleMidi, onButton: handleMidiButton, onStatus: showStatus });
const perform = createPerform({ root: $('perform'), send, getState: () => state, flash, armLearn, showStatus });
const focusModality = new FocusModality();
const keys = new HoldKeys({ press: pressAction, release: releaseAction, keyboardFocused: (el) => focusModality.has(el) });

function showStatus(message, kind = 'error') {
  const el = $('status');
  el.textContent = message;
  el.classList.toggle('info', kind === 'info');
  el.hidden = false;
}

async function send(type, payload = {}) {
  try {
    const response = await browser.runtime.sendMessage({ target: TARGET.OFFSCREEN, type, ...payload });
    if (!response?.ok) throw new Error(response?.error ?? 'Engine did not respond');
    setState(response.result);
    return response.result;
  } catch (err) {
    showStatus(err.message);
    return null;
  }
}

function busy(next) {
  return next.sources.length > 0 || next.recording !== null || next.pads.some((p) => p.playing);
}

function setState(next) {
  if (!next) return;
  state = next;
  const key = JSON.stringify([
    next.sources.map((s) => [s.id, s.label, s.route, s.inputFx]),
    next.inputRoute,
    BUS_IDS.map((id) => next.buses[id].slots.map((s) => [s.uid, s.effect, s.lfo?.target, s.lfo?.sync === 'Free', collapsed.has(s.uid)]))
  ]);
  if (key !== structureKey) {
    structureKey = key;
    renderSources();
    renderPending();
    renderBuses();
  }
  updateValues();
  perform.sync(next);
  if (!next.sources.length) updateMeter({ peak: 0 });
  if (!busy(next)) updateTransport(null);
}

function rerender() {
  structureKey = '';
  setState(state);
}

function flash(name, value) {
  $('readout-name').textContent = name;
  $('readout-value').textContent = value;
  $('readout').classList.add('touched');
  clearTimeout(readoutTimer);
  readoutTimer = setTimeout(() => {
    readoutTimer = null;
    idleReadout();
  }, READOUT_MS);
}

function idleReadout() {
  if (readoutTimer || !state) return;
  $('readout').classList.remove('touched');
  const { bus, effect } = perform.describeSelected(state);
  $('readout-name').textContent = bus;
  $('readout-value').textContent = effect;
}

function setView(view) {
  const next = VIEWS.includes(view) ? view : 'perform';
  document.body.dataset.view = next;
  localStorage.setItem('view', next);
  for (const id of VIEWS) {
    const tab = $(`view-${id}`);
    tab.setAttribute('aria-selected', String(id === next));
    tab.tabIndex = id === next ? 0 : -1;
  }
  $('perform').hidden = next !== 'perform';
  $('edit').hidden = next !== 'edit';
}

function currentSource(id) {
  return state?.sources.find((s) => s.id === id) ?? null;
}

function renderSources() {
  $('sources').replaceChildren(...state.sources.map(renderSource));
  $('sources-empty').hidden = state.sources.length > 0;
}

function renderSource(source) {
  const update = (changes) => send(MSG.UPDATE_SOURCE, { sourceId: source.id, changes });
  const route = routeSelect(source.route, (value) => update({ route: value }), `Route for ${source.label}`);
  route.disabled = source.inputFx;
  route.title = source.inputFx ? 'Routed by Input FX' : 'Route';
  const sides = h(
    'div',
    { className: 'sides', role: 'group', 'aria-label': 'Crossfader side' },
    ...DECK_SIDES.map((side) =>
      h('button', {
        type: 'button',
        className: 'side',
        textContent: side,
        title: `Put this source on side ${side} of the crossfader`,
        dataset: { side },
        onclick: () => update({ side: currentSource(source.id)?.side === side ? null : side })
      })
    )
  );
  const level = h('input', {
    type: 'range',
    min: 0,
    max: SOURCE_LEVEL_MAX,
    step: 0.01,
    'aria-label': `Level for ${source.label}`,
    title: 'Double-click to reset',
    dataset: { role: 'level' },
    oninput: (e) => {
      setFill(e.target, e.target.value / SOURCE_LEVEL_MAX);
      update({ level: Number(e.target.value) });
    },
    ondblclick: () => update({ level: 1 })
  });
  return h(
    'li',
    { className: 'source', dataset: { source: source.id } },
    h(
      'div',
      { className: 'source-top' },
      sides,
      h('span', { className: 'source-label', title: source.label, textContent: source.label }),
      h('button', { type: 'button', className: 'source-remove', title: 'Stop capturing', 'aria-label': `Stop capturing ${source.label}`, textContent: '✕', onclick: () => send(MSG.REMOVE_SOURCE, { sourceId: source.id }) })
    ),
    h(
      'div',
      { className: 'source-controls' },
      h('button', { type: 'button', className: 'mute', textContent: 'Mute', dataset: { role: 'mute' }, onclick: () => update({ muted: !currentSource(source.id)?.muted }) }),
      level,
      h('output', { dataset: { role: 'level-readout' } }),
      route,
      h('label', { className: 'check', title: 'Send through Input FX first' }, h('input', { type: 'checkbox', checked: source.inputFx, onchange: (e) => update({ inputFx: e.target.checked }) }), ' In FX')
    )
  );
}

function renderPending() {
  const captured = new Set(state?.sources.map((s) => s.tabId) ?? []);
  const items = pending.filter((p) => !captured.has(p.tabId));
  $('pending-list').replaceChildren(
    ...items.map((p) =>
      h(
        'li',
        { className: 'pending-item' },
        h('span', { className: 'source-label', title: p.title, textContent: p.title }),
        h('button', { type: 'button', className: 'pending-capture', title: 'Send this tab through Firefox-404', textContent: 'Capture', onclick: () => send(MSG.CAPTURE_TAB, { tabId: p.tabId }) }),
        h('button', { type: 'button', title: 'Switch to this tab', textContent: 'Go', onclick: () => goToTab(p) })
      )
    )
  );
  $('pending').hidden = items.length === 0;
}

async function goToTab({ tabId, windowId }) {
  await browser.tabs.update(tabId, { active: true });
  await browser.windows.update(windowId, { focused: true });
}

function bindAddBar() {
  const bus = $('add-bus');
  const fx = $('add-fx');
  bus.append(...BUS_IDS.map((id) => h('option', { value: id, textContent: BUS_LABELS[id] })));
  bus.addEventListener('change', () => fillEffectOptions(fx, bus.value));
  fillEffectOptions(fx, bus.value);
  $('add-go').addEventListener('click', () => addSlot(bus.value, fx.value));
}

async function addSlot(busId, effectId) {
  if (!effectId) return;
  if (state.buses[busId].slots.length >= MAX_SLOTS) {
    showStatus(`${BUS_LABELS[busId]} is full (${MAX_SLOTS} effects). Remove one to add another.`);
    return;
  }
  await send(MSG.ADD_SLOT, { busId, effectId });
  const slots = state.buses[busId].slots;
  document.querySelector(`.slot[data-slot="${slots[slots.length - 1]?.uid}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function pickBus(busId) {
  const bus = $('add-bus');
  bus.value = busId;
  fillEffectOptions($('add-fx'), busId);
  $('add-bar').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('add-fx').focus();
}

const ALWAYS_SHOWN = new Set(['input', 'master']);

function renderBuses() {
  editors.clear();
  const visible = BUS_IDS.filter((id) => ALWAYS_SHOWN.has(id) || state.buses[id].slots.length > 0);
  $('buses').replaceChildren(...visible.map(renderBus));
}

function renderBus(busId) {
  const bus = state.buses[busId];
  const engage = h('button', {
    type: 'button',
    className: 'switch',
    dataset: { role: 'engage' },
    onclick: () => send(MSG.SET_BUS_ENGAGED, { busId, engaged: !state.buses[busId].engaged })
  });
  const head = h(
    'div',
    { className: 'bus-head' },
    h('h2', { textContent: BUS_LABELS[busId] }),
    h('span', { className: 'bus-count', dataset: { role: 'count' } }),
    engage,
    h('button', { type: 'button', className: 'bus-add', title: `Add an effect to ${BUS_LABELS[busId]}`, textContent: '+', onclick: () => pickBus(busId) })
  );
  const el = h('div', { className: 'bus', dataset: { bus: busId } }, head);
  const busRows = [];
  if (busId === 'input') {
    busRows.push(h('div', { className: 'param' }, h('label', { textContent: 'Route' }), routeSelect(state.inputRoute, (route) => send(MSG.SET_INPUT_ROUTE, { route }), 'Input FX route'), h('output')));
  }
  if (busRows.length) el.append(h('div', { className: 'params' }, ...busRows));
  if (bus.slots.length) el.append(h('ol', { className: 'chain' }, ...bus.slots.map((slot, i) => renderSlot(busId, slot, i, bus.slots.length))));
  else el.append(h('p', { className: 'hint empty-bus', textContent: 'No effects. Press + to add one.' }));
  if (busId === 'master') el.append(h('div', { className: 'params' }, renderMasterVolume()));
  return el;
}

function renderSlot(busId, slot, index, count) {
  const effect = getEffect(slot.effect);
  const ref = { busId, slot: slot.uid };
  const open = !collapsed.has(slot.uid);
  const toggle = h('button', {
    type: 'button',
    className: 'bus-toggle',
    dataset: { role: 'toggle' },
    onclick: () => send(MSG.SET_SLOT_ENABLED, { ...ref, enabled: !currentSlot(busId, slot.uid)?.enabled })
  });
  const fold = h('button', {
    type: 'button',
    className: 'slot-fold',
    'aria-expanded': String(open),
    title: open ? `Hide ${effect.name} controls` : `Show ${effect.name} controls`,
    textContent: open ? '▾' : '▸',
    onclick: () => {
      if (open) collapsed.add(slot.uid);
      else collapsed.delete(slot.uid);
      rerender();
    }
  });
  const swap = h('select', {
    className: 'slot-effect',
    title: 'Swap this effect',
    'aria-label': `Effect in ${BUS_LABELS[busId]}, position ${index + 1}`,
    onchange: (e) => send(MSG.SWAP_SLOT, { ...ref, effectId: e.target.value })
  });
  fillEffectOptions(swap, busId);
  swap.value = slot.effect;
  const move = (delta, label, glyph, disabled) => h('button', { type: 'button', className: 'slot-tool', title: label, textContent: glyph, disabled, onclick: () => send(MSG.MOVE_SLOT, { ...ref, delta }) });
  const head = h(
    'div',
    { className: 'slot-head' },
    toggle,
    fold,
    swap,
    move(-1, 'Move earlier in the chain', '↑', index === 0),
    move(1, 'Move later in the chain', '↓', index === count - 1),
    h('button', { type: 'button', className: 'slot-tool', title: `Remove ${effect.name}`, textContent: '✕', onclick: () => send(MSG.REMOVE_SLOT, ref) })
  );
  const el = h('li', { className: 'slot', dataset: { slot: slot.uid } }, head);
  if (!open) return el;

  const body = h('div', { className: 'slot-body' });
  const editor = effect.ui && EDITORS[effect.ui] ? createEditor(busId, slot.uid, effect) : null;
  if (editor) {
    editors.set(slot.uid, editor);
    body.append(editor.el);
  }
  const rows = effect.params.filter((p) => !editor?.handles.includes(p.id)).map((p) => renderParam(busId, slot.uid, p));
  if (effect.meter === 'reduction') rows.push(renderReduction());
  if (rows.length) body.append(h('div', { className: 'params' }, ...rows));
  body.append(renderLfo(busId, slot, effect));
  el.append(body);
  return el;
}

function currentSlot(busId, uid) {
  return state.buses[busId]?.slots.find((s) => s.uid === uid) ?? null;
}

function createEditor(busId, uid, effect) {
  return EDITORS[effect.ui]({
    params: effect.params,
    getValues: () => currentSlot(busId, uid)?.params ?? {},
    setParam: (paramId, value) => send(MSG.SET_PARAM, { busId, slot: uid, paramId, value }),
    arm: (paramId, el) => armLearn({ kind: 'param', busId, uid, paramId }, el)
  });
}

function renderReduction() {
  return h(
    'div',
    { className: 'param gr-row', title: 'Gain reduction' },
    h('label', { textContent: 'Reduction' }),
    h('div', { className: 'gr-bar' }, h('div', { className: 'gr-bar-fill' })),
    h('output', { textContent: '0.0 dB' })
  );
}

function renderLfo(busId, slot, effect) {
  const setLfo = (changes) => send(MSG.SET_LFO, { busId, slot: slot.uid, changes });
  const target = h(
    'select',
    { 'aria-label': 'LFO target', onchange: (e) => setLfo({ target: e.target.value || null }) },
    h('option', { value: '', textContent: 'Off' }),
    ...effect.params.filter(isModulatable).map((p) => h('option', { value: p.id, textContent: p.name }))
  );
  target.value = slot.lfo?.target ?? '';
  const power = h('button', {
    type: 'button',
    className: 'lfo-toggle',
    dataset: { role: 'lfo-toggle' },
    onclick: () => setLfo({ enabled: !currentSlot(busId, slot.uid)?.lfo.enabled })
  });
  const rows = [h('div', { className: 'param lfo-head' }, h('label', { textContent: 'LFO' }), target, h('div', { className: 'lfo-power' }, power))];
  if (slot.lfo?.target) {
    for (const param of LFO_PARAMS) {
      if (param.id === 'rate' && slot.lfo.sync !== 'Free') continue;
      rows.push(controlRow(param, (value) => setLfo({ [param.id]: value }), { lfo: param.id }));
    }
  }
  return h('div', { className: 'lfo params' }, ...rows);
}

function renderMasterVolume() {
  const setLevel = (level) => send(MSG.SET_MASTER, { level });
  return h(
    'div',
    { className: 'param' },
    h('label', { textContent: 'Volume' }),
    h('input', {
      type: 'range',
      id: 'master-volume',
      min: 0,
      max: MASTER_MAX,
      step: 0.01,
      title: 'Double-click to reset',
      'aria-label': 'Master volume',
      oninput: (e) => {
        setFill(e.target, e.target.value / MASTER_MAX);
        setLevel(e.target.value);
      },
      ondblclick: () => setLevel(DEFAULT_MASTER)
    }),
    h('output', { id: 'master-readout' })
  );
}

function renderParam(busId, uid, param) {
  return controlRow(
    param,
    (value) => {
      send(MSG.SET_PARAM, { busId, slot: uid, paramId: param.id, value });
      flash(`${BUS_LABELS[busId]} ${param.name}`, formatValue(param, value));
    },
    { param: param.id },
    (row) => armLearn({ kind: 'param', busId, uid, paramId: param.id }, row)
  );
}

function controlRow(param, setValue, dataset, onArm) {
  const control =
    param.kind === 'enum'
      ? h('select', { 'aria-label': param.name, onchange: (e) => setValue(e.target.value) }, ...param.options.map((o) => h('option', { value: o, textContent: o })))
      : h('input', {
          type: 'range',
          min: 0,
          max: SLIDER_STEPS,
          step: 1,
          title: 'Double-click to reset',
          'aria-label': param.name,
          oninput: (e) => {
            setFill(e.target, e.target.value / SLIDER_STEPS);
            setValue(fromNormalized(param, e.target.value / SLIDER_STEPS));
          },
          ondblclick: () => setValue(param.default)
        });
  control.dataset.role = 'param';
  return h('div', { className: 'param', dataset, onpointerdown: (e) => onArm?.(e.currentTarget) }, h('label', { textContent: param.name }), control, h('output'));
}

function setIfIdle(el, value) {
  if (el === document.activeElement && (pointerDown || el.type === 'number')) return;
  el.value = value;
}

function updateRow(row, param, value) {
  const control = row.querySelector('[data-role="param"]');
  setIfIdle(control, param.kind === 'enum' ? value : Math.round(toNormalized(param, value) * SLIDER_STEPS));
  if (param.kind !== 'enum') setFill(control, control.value / SLIDER_STEPS);
  row.querySelector('output').textContent = param.kind === 'enum' ? '' : formatValue(param, value);
}

function setPressed(el, on, label) {
  el.classList.toggle('on', on);
  el.setAttribute('aria-pressed', String(on));
  if (label) {
    el.title = label;
    el.setAttribute('aria-label', label);
  }
}

function updateSources() {
  for (const source of state.sources) {
    const el = document.querySelector(`.source[data-source="${CSS.escape(source.id)}"]`);
    if (!el) continue;
    for (const btn of el.querySelectorAll('.side')) setPressed(btn, source.side === btn.dataset.side);
    setPressed(el.querySelector('[data-role="mute"]'), source.muted, source.muted ? `Unmute ${source.label}` : `Mute ${source.label}`);
    el.classList.toggle('muted', source.muted);
    const level = el.querySelector('[data-role="level"]');
    setIfIdle(level, source.level);
    setFill(level, level.value / SOURCE_LEVEL_MAX);
    el.querySelector('[data-role="level-readout"]').textContent = `${Math.round(source.level * 100)}%`;
  }
  const decks = state.sources.length >= 2 || state.sources.some((s) => s.side);
  $('xfader-row').hidden = !decks;
  setIfIdle($('xfader'), state.crossfader);
  $('xfader-row').classList.toggle('live', state.sources.some((s) => s.side));
}

function updateValues() {
  setIfIdle($('bpm'), state.bpm);
  $('auto').classList.toggle('on', state.autoBpm);
  $('auto').setAttribute('aria-pressed', String(state.autoBpm));
  $('quantize').textContent = state.quantize === 'Off' ? 'Q off' : `Q ${state.quantize}`;
  $('quantize').classList.toggle('on', state.quantize !== 'Off');
  const detected = state.detected;
  $('detected').textContent = detected ? `Heard ${detected.bpm.toFixed(1)} (${Math.round(detected.confidence * 100)}%)` : 'Heard —';
  $('detected').classList.toggle('confident', Boolean(detected && detected.confidence >= AUTO_CONFIDENT));
  idleReadout();
  updateSources();
  for (const btn of $('routing').children) btn.setAttribute('aria-checked', String(btn.dataset.routing === state.busRouting));
  $('routing-hint').textContent = ROUTING_HINTS[state.busRouting];

  const volume = $('master-volume');
  if (volume) {
    setIfIdle(volume, state.master);
    setFill(volume, volume.value / MASTER_MAX);
    $('master-readout').textContent = `${Math.round(state.master * 100)}%`;
  }

  for (const busId of BUS_IDS) {
    const bus = state.buses[busId];
    const { slots } = bus;
    const busEl = document.querySelector(`.bus[data-bus="${busId}"]`);
    if (!busEl) continue;
    busEl.classList.toggle('active', busLit(bus));
    busEl.classList.toggle('disengaged', !bus.engaged);
    const count = busEl.querySelector('[data-role="count"]');
    count.textContent = !slots.length ? '' : bus.engaged ? `${slots.filter((s) => s.enabled).length}/${slots.length} on` : 'Bus off';
    const engage = busEl.querySelector('[data-role="engage"]');
    setPressed(engage, bus.engaged, `${BUS_LABELS[busId]} ${bus.engaged ? 'on' : 'off'}. Switches every effect in the bus together.`);
    engage.disabled = slots.length === 0;
    busEl.querySelector('.bus-add').disabled = slots.length >= MAX_SLOTS;

    for (const slot of slots) {
      const el = busEl.querySelector(`.slot[data-slot="${slot.uid}"]`);
      if (!el) continue;
      const toggle = el.querySelector('[data-role="toggle"]');
      const name = getEffect(slot.effect).name;
      setPressed(toggle, slot.enabled, `${name} ${slot.enabled ? 'on' : 'off'}`);
      el.classList.toggle('active', slot.enabled && bus.engaged);

      for (const param of getEffect(slot.effect).params) {
        const row = el.querySelector(`.param[data-param="${param.id}"]`);
        if (!row) continue;
        updateRow(row, param, slot.params[param.id]);
        row.classList.toggle('modulated', Boolean(slot.lfo?.enabled) && slot.lfo?.target === param.id);
      }
      for (const param of LFO_PARAMS) {
        const row = el.querySelector(`.param[data-lfo="${param.id}"]`);
        if (row) updateRow(row, param, slot.lfo[param.id]);
      }
      const power = el.querySelector('[data-role="lfo-toggle"]');
      if (power) {
        const lfoOn = Boolean(slot.lfo?.enabled);
        setPressed(power, lfoOn, slot.lfo?.target ? `LFO ${lfoOn ? 'on' : 'off'}` : 'Pick an LFO target first');
        power.disabled = !slot.lfo?.target;
        el.querySelector('.lfo').classList.toggle('off', !lfoOn);
      }
      editors.get(slot.uid)?.update(slot.params);
    }
  }
}

function updateMeter({ peak }) {
  const db = 20 * Math.log10(Math.max(peak, 1e-5));
  $('meter').style.width = `${clamp((db + 60) / 60, 0, 1) * 100}%`;
}

function updateTransport(transport) {
  perform.meter(transport);
  const leds = $('beats').children;
  if (!transport) {
    for (const led of leds) led.classList.remove('on');
    $('position').textContent = '–.–';
    return;
  }
  const { bar, beat } = position(transport.beat);
  for (let i = 0; i < BEATS_PER_BAR; i++) leds[i].classList.toggle('on', i === beat - 1);
  $('position').textContent = `${bar}.${beat}`;
}

function updateSlotMeters(readings = {}) {
  for (const [uid, editor] of editors) editor.meter?.(readings[uid]);
  for (const row of document.querySelectorAll('.gr-row')) {
    const uid = row.closest('.slot').dataset.slot;
    const reduction = Math.min(0, readings[uid]?.reduction ?? 0);
    row.querySelector('.gr-bar-fill').style.width = `${clamp(-reduction / GR_RANGE_DB, 0, 1) * 100}%`;
    row.querySelector('output').textContent = `${reduction.toFixed(1)} dB`;
  }
}

function armLearn(target, el) {
  if (!midi.learning) return false;
  midi.arm(target);
  document.querySelectorAll('.learn-target').forEach((node) => node.classList.remove('learn-target'));
  el.classList.add('learn-target');
  return true;
}

function handleMidi(target, normalized) {
  if (target.kind === 'ctrl') {
    const resolved = perform.ctrlTarget(target.busId, target.index);
    if (!resolved) return;
    const value = fromNormalized(resolved.param, normalized);
    send(MSG.SET_PARAM, { busId: target.busId, slot: resolved.slot.uid, paramId: resolved.param.id, value });
    flash(`${BUS_LABELS[target.busId]} ${resolved.param.name}`, formatValue(resolved.param, value));
    return;
  }
  const { busId, uid, paramId } = target;
  const slot = uid && currentSlot(busId, uid);
  const param = slot && getEffect(slot.effect).params.find((p) => p.id === paramId);
  if (param) send(MSG.SET_PARAM, { busId, slot: uid, paramId, value: fromNormalized(param, normalized) });
}

function handleMidiButton(target, down) {
  if (target.kind === 'bus') (down ? perform.pressBus : perform.releaseBus)(target.busId);
  else if (target.kind === 'pad') (down ? perform.pressPad : perform.releasePad)(target.index);
}

function tap() {
  const bpm = tapTempo.tap();
  send(MSG.TAP, { bpm, beat: (tapTempo.count - 1) % BEATS_PER_BAR, at: Date.now() });
  flash('Tap', bpm ? `${bpm} BPM` : 'Beat 1 set');
}

function pressAction(action) {
  if (!state) return;
  if (action.kind === 'bus') perform.pressBus(action.busId);
  else if (action.kind === 'pad') {
    action.pad = perform.padAt(action.index);
    perform.pressPad(action.pad);
  } else if (action.kind === 'chop') perform.chop();
  else if (action.kind === 'bank') perform.nextBank();
  else if (action.kind === 'tap') tap();
  else if (action.kind === 'stop') perform.stopPads();
  else if (action.kind === 'rec') perform.toggleRecord();
}

function releaseAction(action) {
  if (action.kind === 'bus') perform.releaseBus(action.busId);
  else if (action.kind === 'pad' && action.pad !== undefined) perform.releasePad(action.pad);
}

function bindControls() {
  createPresets({ select: $('preset'), openButton: $('save-preset'), form: $('preset-form'), send, getState: () => state, flash, showStatus });

  for (const view of VIEWS) $(`view-${view}`).addEventListener('click', () => setView(view));
  $('view-perform').parentElement.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = VIEWS[(VIEWS.indexOf(document.body.dataset.view) + 1) % VIEWS.length];
    setView(next);
    $(`view-${next}`).focus();
  });
  setView(localStorage.getItem('view'));

  $('bpm').addEventListener('change', (e) => send(MSG.SET_BPM, { bpm: e.target.value }));
  $('tap').addEventListener('click', tap);
  $('half').addEventListener('click', () => send(MSG.SET_BPM, { bpm: state.bpm / 2 }));
  $('double').addEventListener('click', () => send(MSG.SET_BPM, { bpm: state.bpm * 2 }));
  $('auto').addEventListener('click', () => send(MSG.SET_AUTO_BPM, { enabled: !state.autoBpm }));
  $('quantize').addEventListener('click', () => {
    const next = QUANTIZE_OPTIONS[(QUANTIZE_OPTIONS.indexOf(state.quantize) + 1) % QUANTIZE_OPTIONS.length];
    send(MSG.SET_QUANTIZE, { quantize: next });
    flash('Quantize', next === 'Off' ? 'Off' : next);
  });
  $('learn').addEventListener('click', async () => {
    const on = await midi.toggleLearn();
    $('learn').classList.toggle('armed', on);
    $('learn').setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('learning', on);
    if (!on) document.querySelectorAll('.learn-target').forEach((el) => el.classList.remove('learn-target'));
  });

  $('xfader').addEventListener('input', (e) => send(MSG.SET_CROSSFADER, { value: Number(e.target.value) }));
  $('xfader').addEventListener('dblclick', () => send(MSG.SET_CROSSFADER, { value: 0 }));

  $('status').addEventListener('click', () => {
    $('status').hidden = true;
  });

  $('routing').append(
    ...BUS_ROUTINGS.map((routing) => h('button', { type: 'button', role: 'radio', textContent: routing, dataset: { routing }, onclick: () => send(MSG.SET_BUS_ROUTING, { routing }) }))
  );

  bindAddBar();

  document.addEventListener('keydown', (e) => {
    if (!document.querySelector('dialog[open]')) keys.down(e);
  });
  document.addEventListener('keyup', (e) => keys.up(e));
  window.addEventListener('blur', () => keys.releaseAll());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) keys.releaseAll();
  });

  document.addEventListener('pointerdown', () => {
    pointerDown = true;
  });
  for (const type of ['pointerup', 'pointercancel']) {
    document.addEventListener(type, () => {
      pointerDown = false;
    });
  }
}

browser.runtime.onMessage.addListener((message) => {
  if (message.target !== TARGET.BROADCAST) return false;
  if (message.type === MSG.STATE) setState(message.state);
  else if (message.type === MSG.METER) {
    updateMeter(message.level);
    updateSlotMeters(message.level.slots);
    updateTransport(message.transport ?? null);
  }
  return false;
});

browser.storage.session.onChanged.addListener((changes) => {
  if (changes.lastError?.newValue) showStatus(changes.lastError.newValue.message, changes.lastError.newValue.kind);
  if (changes.pendingTabs) {
    pending = changes.pendingTabs.newValue ?? [];
    renderPending();
  }
});

async function init() {
  bindControls();
  const engine = await browser.runtime.sendMessage({ target: TARGET.BACKGROUND, type: MSG.ENSURE_ENGINE }).catch((err) => ({ ok: false, error: err.message }));
  if (!engine?.ok) showStatus(`Engine failed to start: ${engine?.error}`);
  await send(MSG.GET_STATE);
  const { lastError, pendingTabs } = await browser.storage.session.get(['lastError', 'pendingTabs']);
  if (lastError) showStatus(lastError.message, lastError.kind);
  pending = pendingTabs ?? [];
  renderPending();
}

init();
