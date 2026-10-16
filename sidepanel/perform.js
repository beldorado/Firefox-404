import { h } from './dom.js';
import { createKnob } from './knob.js';
import { MSG } from '../shared/messages.js';
import { BANKS, BUS_IDS, BUS_LABELS, CHOKE_GROUPS, PADS_PER_BANK, PAD_MODES, REC_LENGTHS, SOURCE_LEVEL_MAX, padLabel } from '../shared/state.js';
import { ctrlParams, getEffect } from '../effects/registry.js';
import { clamp, formatValue } from '../shared/params.js';
import { BPM_MAX, BPM_MIN } from '../shared/tempo.js';
import { confirmButton, fillEffectOptions, holdButton, routeSelect, setFill } from './widgets.js';
import { KEY_LABELS } from './keys.js';
import { exportPad, importSample } from './pad-files.js';
import { createEditor } from './editor.js';

const HOLD_MS = 280;
const DRAG_PX = 8;
const BANK_HOVER_MS = 500;
const DIALOG_GAP = 8;
const FX_NAMES = { bus1: 'Bus 1', bus2: 'Bus 2', bus3: 'Bus 3', bus4: 'Bus 4', input: 'Input', master: 'Master' };
const ROUTE_COLOR = { bus1: 'bus1', bus2: 'bus2', dry: 'bus3' };
const WAVE_W = 48;
const WAVE_H = 20;
const SVG = 'http://www.w3.org/2000/svg';

function stored(key, allowed, fallback) {
  const value = localStorage.getItem(key);
  return allowed.includes(value) ? value : fallback;
}

function wavePath(peaks) {
  const mid = WAVE_H / 2;
  const step = WAVE_W / peaks.length;
  return peaks.map((p, i) => {
    const x = (i + 0.5) * step;
    const half = Math.max(0.35, p * mid);
    return `M${x.toFixed(2)} ${(mid - half).toFixed(2)}V${(mid + half).toFixed(2)}`;
  }).join('');
}

function seconds(value) {
  return `${value.toFixed(value < 10 ? 2 : 1)} s`;
}

export function busLit(bus) {
  return bus.engaged && bus.slots.some((s) => s.enabled);
}

export function createPerform({ root, send, getState, flash, armLearn, showStatus }) {
  let selected = stored('selectedBus', BUS_IDS, 'bus1');
  let bankIndex = Math.max(0, BANKS.indexOf(localStorage.getItem('bank')));
  let selectedPad = bankIndex * PADS_PER_BANK;
  let selection = new Set([selectedPad]);
  let recLength = stored('recLength', REC_LENGTHS, '1 bar');
  let ctrlKey = '';
  let detailKey = '';
  let knobs = [];
  let lastBeat = null;
  let transport = null;
  const focus = new Map();
  const holds = new Map();

  const focusedSlot = (state, busId) => {
    const slots = state.buses[busId].slots;
    return slots.find((s) => s.uid === focus.get(busId)) ?? slots[0] ?? null;
  };

  // CTRL: three knobs for the selected bus, like the CTRL 1–3 row on the hardware.
  const ctrlPlate = h('section', { className: 'ctrl-plate', 'aria-label': 'Effect controls' });

  function renderCtrl(state) {
    const busId = selected;
    const bus = state.buses[busId];
    const slot = focusedSlot(state, busId);
    ctrlPlate.dataset.bus = busId;
    const select = h('select', {
      className: 'ctrl-effect',
      'aria-label': `Effect on ${BUS_LABELS[busId]}`,
      onchange: (e) => {
        e.target.blur();
        if (slot) send(MSG.SWAP_SLOT, { busId, slot: slot.uid, effectId: e.target.value });
        else send(MSG.ADD_SLOT, { busId, effectId: e.target.value });
      }
    });
    fillEffectOptions(select, busId, slot ? null : 'Choose an effect');
    select.value = slot ? slot.effect : '';
    const parts = [h('div', { className: 'ctrl-head' }, h('h2', { className: 'ctrl-bus', textContent: BUS_LABELS[busId] }), select)];

    if (bus.slots.length > 1) {
      parts.push(
        h(
          'div',
          { className: 'chips', role: 'group', 'aria-label': `Effects in ${BUS_LABELS[busId]}, in order` },
          ...bus.slots.map((s) =>
            h('button', {
              type: 'button',
              className: 'chip',
              textContent: getEffect(s.effect).name,
              title: s.enabled ? `Show ${getEffect(s.effect).name} on the knobs` : `${getEffect(s.effect).name} is switched off in Edit`,
              'aria-pressed': String(s === slot),
              dataset: { off: String(!s.enabled) },
              onclick: () => {
                focus.set(busId, s.uid);
                sync(getState(), true);
              }
            })
          )
        )
      );
    }

    knobs = [];
    if (slot) {
      const row = h('div', { className: 'ctrl-knobs' });
      ctrlParams(slot.effect).forEach((param, index) => {
        const knob = createKnob({
          param,
          onChange: (value) => {
            send(MSG.SET_PARAM, { busId, slot: slot.uid, paramId: param.id, value });
            flash(`${FX_NAMES[busId]} ${param.name}`, formatValue(param, value));
          },
          onArm: (el) => armLearn({ kind: 'ctrl', busId, index }, el)
        });
        knob.el.classList.add('ctrl-knob');
        knobs.push({ knob, param });
        row.append(knob.el);
      });
      parts.push(row);
    } else {
      parts.push(h('p', { className: 'hint ctrl-empty', textContent: `Choose an effect and its three main controls appear here.` }));
    }
    ctrlPlate.replaceChildren(...parts);
  }

  // Bus FX buttons: tap to latch, hold for momentary.
  const fxButtons = {};
  const fxRow = h('section', { className: 'fx-row', 'aria-label': 'Bus effects. Tap to switch on or off, hold to play only while held.' });
  for (const busId of BUS_IDS) {
    const effectName = h('span', { className: 'fx-effect' });
    const btn = h(
      'button',
      { type: 'button', className: 'fx', dataset: { bus: busId }, title: `${BUS_LABELS[busId]}. Tap to switch on or off, hold to play only while held. Key ${KEY_LABELS[busId]}.` },
      h('span', { className: 'fx-key', textContent: KEY_LABELS[busId], 'aria-hidden': 'true' }),
      h('span', { className: 'fx-name', textContent: FX_NAMES[busId] }),
      effectName
    );
    holdButton(btn, {
      press: () => {
        if (!armLearn({ kind: 'bus', busId }, btn)) pressBus(busId);
      },
      release: () => releaseBus(busId)
    });
    fxButtons[busId] = { btn, effectName };
    fxRow.append(btn);
  }

  function select(busId) {
    if (selected === busId) return;
    selected = busId;
    localStorage.setItem('selectedBus', busId);
    sync(getState(), true);
  }

  function pressBus(busId) {
    const state = getState();
    if (!state) return;
    select(busId);
    const bus = state.buses[busId];
    if (!bus.slots.length) return;
    const wasOn = busLit(bus);
    holds.set(busId, { at: performance.now(), wasOn });
    if (!wasOn) send(MSG.SET_BUS_ENGAGED, { busId, engaged: true });
  }

  function releaseBus(busId) {
    const hold = holds.get(busId);
    if (!hold) return;
    holds.delete(busId);
    const held = performance.now() - hold.at >= HOLD_MS;
    if (hold.wasOn !== held) send(MSG.SET_BUS_ENGAGED, { busId, engaged: false });
  }

  // Pad bank.
  const fileInput = h('input', { type: 'file', accept: 'audio/*', hidden: true, onchange: (e) => loadFile(selectedPad, e.target.files[0]) });
  const padEls = Array.from({ length: PADS_PER_BANK }, (_, slot) => {
    const at = () => bankIndex * PADS_PER_BANK + slot;
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', `0 0 ${WAVE_W} ${WAVE_H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('pad-wave');
    // Faint peaks behind, RMS (how loud it sounds) in front.
    const peakPath = document.createElementNS(SVG, 'path');
    peakPath.classList.add('wave-peak');
    const path = document.createElementNS(SVG, 'path');
    svg.append(peakPath, path);
    const name = h('span', { className: 'pad-name' });
    const num = h('span', { className: 'pad-num', 'aria-hidden': 'true' });
    const group = h('span', { className: 'pad-group', 'aria-hidden': 'true' });
    const el = h(
      'button',
      { type: 'button', className: 'pad', dataset: { slot: String(slot) } },
      num,
      group,
      h('span', { className: 'pad-key', textContent: KEY_LABELS[`pad${slot}`], 'aria-hidden': 'true' }),
      svg,
      name
    );
    let pressed = null;
    holdButton(el, {
      press: (e) => {
        const index = at();
        pressed = null;
        if (armLearn({ kind: 'pad', index }, el)) return;
        const quiet = e?.ctrlKey || e?.metaKey || e?.shiftKey;
        if (e?.ctrlKey || e?.metaKey) togglePad(index);
        else if (e?.shiftKey) selectPad(index);
        else {
          selectPad(index);
          pressed = index;
          playPad(index);
        }
        beginDrag(index, e, !quiet);
      },
      release: () => {
        if (pressed !== null) releasePad(pressed);
        pressed = null;
      }
    });
    el.addEventListener('pointermove', moveDrag);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', cancelDrag);
    el.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
      e.preventDefault();
      el.classList.add('drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop');
      const file = e.dataTransfer.files[0];
      if (file) loadFile(at(), file);
    });
    return { el, path, peakPath, name, num, group, peaksKey: '' };
  });

  const padRoute = h('div', { className: 'pad-route' });
  const stopAll = h('button', { type: 'button', className: 'key key-small', textContent: 'Stop all', title: 'Stop every pad (Esc)', onclick: () => stopPads() });
  const recButton = h('button', { type: 'button', className: 'key rec', title: 'Record what you hear into a pad (T). Starts on the next bar when quantize is on.', onclick: () => toggleRecord() });
  const recFill = h('span', { className: 'rec-fill', 'aria-hidden': 'true' });
  const recLabel = h('span', { className: 'rec-label' });
  recButton.append(recFill, recLabel);
  const recSelect = h(
    'select',
    {
      'aria-label': 'Recording length',
      onchange: (e) => {
        e.target.blur();
        recLength = e.target.value;
        localStorage.setItem('recLength', recLength);
      }
    },
    ...REC_LENGTHS.map((l) => h('option', { value: l, textContent: l === 'Free' ? 'Until stopped' : l }))
  );
  recSelect.value = recLength;
  const detail = h('div', { className: 'pad-detail' });
  const editor = createEditor({
    send,
    getState,
    showStatus,
    flash,
    onSlicesSent: (targets) => setBank(Math.floor(targets[0] / PADS_PER_BANK)),
    onClose: () => {
      detail.hidden = false;
      sync(getState());
    }
  });
  const bankButtons = BANKS.map((letter, i) =>
    h('button', { type: 'button', role: 'radio', textContent: letter, title: `Show bank ${letter} (B switches banks)`, onclick: () => setBank(i) })
  );
  const bankSwitch = h('div', { className: 'seg bank-switch', role: 'radiogroup', 'aria-label': 'Pad bank' }, ...bankButtons);

  const bank = h(
    'section',
    { className: 'bank', 'aria-label': 'Pads' },
    h('div', { className: 'bank-head' }, h('h2', { textContent: 'Pads' }), bankSwitch, padRoute, stopAll),
    h('div', { className: 'pads' }, ...padEls.map((p) => p.el)),
    h('div', { className: 'rec-row' }, recButton, recSelect),
    detail,
    editor.el,
    fileInput
  );

  // Drag a pad onto another pad to move, copy or swap it.
  const dragGhost = h('div', { className: 'drag-ghost', 'aria-hidden': 'true', hidden: true });
  const transferDialog = h('dialog', { className: 'transfer' });
  let drag = null;

  transferDialog.addEventListener('click', (e) => {
    if (e.target === transferDialog) transferDialog.close();
  });

  function beginDrag(index, e, played) {
    if (e?.type !== 'pointerdown' || !getState()?.pads[index].clip) return;
    drag = { from: index, pointerId: e.pointerId, x: e.clientX, y: e.clientY, played, active: false, over: null, bankTimer: null, bankHover: null };
  }

  function padAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    const el = hit?.closest('.pad');
    if (el && bank.contains(el)) return bankIndex * PADS_PER_BANK + Number(el.dataset.slot);
    return null;
  }

  function hoverBank(x, y) {
    const button = document.elementFromPoint(x, y)?.closest('.bank-switch button');
    const target = button ? bankButtons.indexOf(button) : -1;
    if (target === drag.bankHover) return;
    clearTimeout(drag.bankTimer);
    drag.bankHover = target;
    if (target >= 0 && target !== bankIndex) drag.bankTimer = setTimeout(() => setBank(target), BANK_HOVER_MS);
  }

  function moveDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_PX) return;
      drag.active = true;
      if (drag.played) send(MSG.STOP_PAD, { index: drag.from });
      const clip = getState().pads[drag.from].clip;
      dragGhost.replaceChildren(h('strong', { textContent: padLabel(drag.from) }), h('span', { textContent: clip?.name ?? '' }));
      dragGhost.hidden = false;
      bank.classList.add('dragging-pad');
      markDrag();
    }
    dragGhost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`;
    const over = padAt(e.clientX, e.clientY);
    drag.over = over === drag.from ? null : over;
    hoverBank(e.clientX, e.clientY);
    markDrag();
  }

  function markDrag() {
    padEls.forEach((p, slot) => {
      const i = bankIndex * PADS_PER_BANK + slot;
      p.el.classList.toggle('dragging', Boolean(drag?.active) && drag.from === i);
      p.el.classList.toggle('drop-target', Boolean(drag?.active) && drag.over === i);
    });
  }

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { active, from, over } = drag;
    cancelDrag();
    if (active && over !== null) askTransfer(from, over);
  }

  function cancelDrag() {
    if (!drag) return;
    clearTimeout(drag.bankTimer);
    drag = null;
    dragGhost.hidden = true;
    bank.classList.remove('dragging-pad');
    markDrag();
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drag?.active) cancelDrag();
  });

  function askTransfer(from, to) {
    const state = getState();
    const source = state?.pads[from];
    const target = state?.pads[to];
    if (!source?.clip || !target) return;
    const tag = (i, pad) => h('span', { className: 'transfer-pad' }, h('strong', { textContent: padLabel(i) }), h('span', { textContent: pad.clip ? pad.clip.name : 'Empty' }));
    const choice = (label, mode, primary = false) =>
      h('button', {
        type: 'button',
        className: primary ? 'key key-go' : 'key',
        textContent: label,
        onclick: () => {
          transferDialog.close();
          if (mode) transfer(from, to, mode);
        }
      });
    const buttons = [choice('Move', 'move', true), choice('Copy', 'copy')];
    if (target.clip) buttons.push(choice('Swap', 'swap'));
    buttons.push(choice('Cancel', null));
    const note = target.clip
      ? `${padLabel(to)} holds “${target.clip.name}”. Move and Copy replace it, Swap trades the two pads.`
      : `Move empties ${padLabel(from)}, Copy keeps it. The pad's settings go with the sample.`;
    transferDialog.setAttribute('aria-label', `Move or copy pad ${padLabel(from)} to pad ${padLabel(to)}`);
    transferDialog.replaceChildren(
      h('p', { className: 'transfer-route' }, tag(from, source), h('span', { className: 'transfer-arrow', textContent: '→', 'aria-hidden': 'true' }), tag(to, target)),
      h('p', { className: 'hint', textContent: note }),
      h('div', { className: 'transfer-actions' }, ...buttons)
    );
    transferDialog.showModal();
    placeDialog(to);
    buttons[0].focus();
  }

  function placeDialog(index) {
    const slot = index - bankIndex * PADS_PER_BANK;
    const anchor = slot >= 0 && slot < PADS_PER_BANK ? padEls[slot].el.getBoundingClientRect() : null;
    transferDialog.classList.toggle('anchored', Boolean(anchor));
    if (!anchor) return;
    const box = transferDialog.getBoundingClientRect();
    const left = clamp(anchor.left + anchor.width / 2 - box.width / 2, DIALOG_GAP, window.innerWidth - box.width - DIALOG_GAP);
    const below = anchor.bottom + DIALOG_GAP;
    const top = below + box.height <= window.innerHeight - DIALOG_GAP ? below : Math.max(DIALOG_GAP, anchor.top - box.height - DIALOG_GAP);
    transferDialog.style.left = `${left}px`;
    transferDialog.style.top = `${top}px`;
  }

  async function transfer(from, to, mode) {
    if ([from, to].includes(editor.editing())) editor.close();
    if (!(await send(MSG.TRANSFER_PAD, { from, to, mode }))) return;
    focusPad(to);
    sync(getState());
    flash({ move: 'Moved', copy: 'Copied', swap: 'Swapped' }[mode], `${padLabel(from)} to ${padLabel(to)}`);
  }

  function stopPads() {
    editor.halt();
    send(MSG.STOP_PADS);
  }

  function setBank(next) {
    const value = ((next % BANKS.length) + BANKS.length) % BANKS.length;
    if (value === bankIndex) return;
    bankIndex = value;
    localStorage.setItem('bank', BANKS[bankIndex]);
    sync(getState());
  }

  const selectedPads = () => [...selection].sort((a, b) => a - b);

  function focusPad(index) {
    selectedPad = index;
    selection = new Set([index]);
    bankIndex = Math.floor(index / PADS_PER_BANK);
  }

  function selectPad(index) {
    if (selectedPad === index && selection.size === 1) return;
    focusPad(index);
    sync(getState());
  }

  function togglePad(index) {
    if (selection.has(index)) {
      if (selection.size === 1) return;
      selection.delete(index);
      if (selectedPad === index) selectedPad = selectedPads()[0];
    } else {
      selection.add(index);
      selectedPad = index;
    }
    sync(getState());
  }

  function playPad(index) {
    if (getState()?.pads[index].clip) send(MSG.PAD_PRESS, { index });
  }

  function pressPad(index) {
    if (!getState()) return;
    if (!selection.has(index)) selectPad(index);
    else if (selectedPad !== index) {
      selectedPad = index;
      bankIndex = Math.floor(index / PADS_PER_BANK);
      sync(getState());
    }
    playPad(index);
  }

  function releasePad(index) {
    const state = getState();
    if (state?.pads[index].clip && state.pads[index].mode === 'Gate') send(MSG.PAD_RELEASE, { index });
  }

  function recTarget(state) {
    if (!state.pads[selectedPad].clip) return selectedPad;
    const inBank = state.pads.findIndex((p, i) => !p.clip && Math.floor(i / PADS_PER_BANK) === bankIndex);
    return inBank >= 0 ? inBank : state.pads.findIndex((p) => !p.clip);
  }

  function toggleRecord() {
    const state = getState();
    if (!state) return;
    if (state.recording) {
      send(MSG.STOP_RECORDING);
      return;
    }
    const target = recTarget(state);
    if (target < 0) {
      showStatus(`All ${state.pads.length} pads hold audio. Clear a pad to record a new loop.`, 'info');
      return;
    }
    focusPad(target);
    send(MSG.START_RECORDING, { pad: target, length: recLength });
  }

  async function loadFile(index, file) {
    if (!file) return;
    focusPad(index);
    try {
      const { name, truncated } = await importSample(index, file);
      await send(MSG.PAD_STORED, { index });
      if (truncated) showStatus(`Loaded the first 60 seconds of ${name} into pad ${padLabel(index)}.`, 'info');
    } catch (err) {
      showStatus(err.message);
    } finally {
      fileInput.value = '';
    }
  }

  function shared(pads, value) {
    const values = pads.map(value);
    return values.every((v) => v === values[0]) ? values[0] : undefined;
  }

  function padOptions(state, indices) {
    const pads = indices.map((i) => state.pads[i]);
    const loaded = indices.filter((i) => state.pads[i].clip);
    const timed = pads.filter((p) => p.clip?.bpm);
    const single = indices.length === 1 ? pads[0] : null;
    const name = single ? `Pad ${padLabel(indices[0])}` : `${indices.length} pads`;
    const modes = h(
      'div',
      { className: 'seg', role: 'radiogroup', 'aria-label': `${name} play mode` },
      ...PAD_MODES.map((mode) =>
        h('button', {
          type: 'button',
          role: 'radio',
          textContent: mode,
          dataset: { mode },
          title: { Loop: 'Tap to start looping on the grid, tap again to stop', Gate: 'Plays while held', 'One-shot': 'Plays once from the start on every tap' }[mode],
          onclick: () => send(MSG.UPDATE_PAD, { indices, changes: { mode } })
        })
      )
    );
    const follow = h('input', { type: 'checkbox', disabled: !timed.length, onchange: (e) => send(MSG.UPDATE_PAD, { indices, changes: { sync: e.target.checked } }) });
    let followTitle = "Type this sample's BPM to use this";
    if (single?.clip?.bpm) followTitle = `Speeds the loop up or down from ${Math.round(single.clip.bpm)} BPM to match the tempo. Pitch follows, like a turntable.`;
    else if (!single) followTitle = timed.length ? 'Speeds each pad up or down from its own BPM to match the tempo. Pitch follows, like a turntable.' : "Type the samples' BPM to use this";
    const tempo = h('input', {
      type: 'number',
      min: BPM_MIN,
      max: BPM_MAX,
      step: 0.1,
      placeholder: '—',
      disabled: !loaded.length,
      'aria-label': `${name} BPM`,
      title: single ? 'The tempo this sample plays at. Follow BPM speeds it up or down from here to match the tempo.' : 'Sets the same BPM on every selected pad that holds a sample',
      dataset: { role: 'pad-bpm' },
      onchange: (e) => send(MSG.SET_PAD_BPM, { indices: loaded, bpm: e.target.value === '' ? null : Number(e.target.value) })
    });
    const choke = h(
      'select',
      {
        'aria-label': `${name} choke group`,
        title: 'Pads in the same group cut each other off, like an open and closed hi-hat',
        dataset: { role: 'pad-choke' },
        onchange: (e) => {
          e.target.blur();
          send(MSG.UPDATE_PAD, { indices, changes: { choke: Number(e.target.value) } });
        }
      },
      h('option', { value: '', textContent: 'Mixed', disabled: true, hidden: true }),
      ...CHOKE_GROUPS.map((g) => h('option', { value: String(g), textContent: g ? `Group ${g}` : 'Off' }))
    );
    const level = h('input', {
      type: 'range',
      min: 0,
      max: SOURCE_LEVEL_MAX,
      step: 0.01,
      'aria-label': `${name} level`,
      title: single ? 'Double-click to reset' : 'Sets every selected pad to this level. Double-click to reset.',
      dataset: { role: 'pad-level' },
      oninput: (e) => {
        setFill(e.target, e.target.value / SOURCE_LEVEL_MAX);
        send(MSG.UPDATE_PAD, { indices, changes: { level: Number(e.target.value) } });
      },
      ondblclick: (e) => {
        e.target.value = 1;
        setFill(e.target, 1 / SOURCE_LEVEL_MAX);
        send(MSG.UPDATE_PAD, { indices, changes: { level: 1 } });
      }
    });
    const options = h(
      'div',
      { className: 'pad-options' },
      h('label', { className: 'check', title: followTitle }, follow, ' Follow BPM'),
      h('label', { className: 'pad-bpm' }, h('span', { textContent: 'BPM' }), tempo),
      h('label', { className: 'pad-choke' }, h('span', { textContent: 'Choke' }), choke),
      h('label', { className: 'pad-level' }, h('span', { textContent: 'Level' }), level)
    );
    return { modes, options, loaded };
  }

  function renderDetail(state) {
    const indices = selectedPads();
    if (indices.length > 1) {
      renderGroupDetail(state, indices);
      return;
    }
    const pad = state.pads[selectedPad];
    const index = selectedPad;
    const load = h('button', { type: 'button', className: 'key key-small', textContent: pad.clip ? 'Replace…' : 'Load sample…', onclick: () => fileInput.click() });
    if (!pad.clip) {
      detail.replaceChildren(
        h('p', { className: 'pad-title' }, h('strong', { textContent: `Pad ${padLabel(index)}` }), h('span', { className: 'dim', textContent: 'Empty' })),
        h('p', { className: 'hint', textContent: 'Record what’s playing, load a sample, or drop an audio file on a pad.' }),
        h('div', { className: 'pad-tools' }, load)
      );
      return;
    }
    const { modes, options } = padOptions(state, [index]);
    const exportBtn = h('button', {
      type: 'button',
      className: 'key key-small',
      textContent: 'Export WAV',
      onclick: () => exportPad(index).then((name) => showStatus(`Saved ${name} to your downloads.`, 'info'), (err) => showStatus(err.message))
    });
    const edit = h('button', {
      type: 'button',
      className: 'key key-small key-go',
      textContent: 'Edit / chop',
      title: 'Trim this sample and chop it into slices',
      onclick: () => openEditor(index)
    });
    const clear = confirmButton(h('button', { type: 'button', className: 'key key-small' }), {
      label: 'Clear',
      confirmLabel: 'Clear pad?',
      onConfirm: () => send(MSG.CLEAR_PAD, { index })
    });
    detail.replaceChildren(
      h('p', { className: 'pad-title' }, h('strong', { textContent: `Pad ${padLabel(index)}` }), h('span', { className: 'pad-clip', textContent: pad.clip.name, title: pad.clip.name }), h('span', { className: 'dim', dataset: { role: 'pad-length' }, textContent: seconds(pad.clip.end - pad.clip.start) })),
      modes,
      options,
      h('div', { className: 'pad-tools' }, edit, load, exportBtn, clear)
    );
  }

  function renderGroupDetail(state, indices) {
    const { modes, options, loaded } = padOptions(state, indices);
    const chips = h(
      'span',
      { className: 'pad-chips', role: 'group', 'aria-label': 'Selected pads' },
      ...indices.map((i) =>
        h('button', {
          type: 'button',
          className: 'pad-chip',
          textContent: padLabel(i),
          title: `Take ${padLabel(i)} out of the selection`,
          'aria-label': `Take pad ${padLabel(i)} out of the selection`,
          onclick: () => togglePad(i)
        })
      )
    );
    const count = loaded.length === 1 ? '1 pad' : `${loaded.length} pads`;
    const clear = confirmButton(h('button', { type: 'button', className: 'key key-small', disabled: !loaded.length }), {
      label: `Clear ${count}`,
      confirmLabel: `Clear ${count}?`,
      onConfirm: () => send(MSG.CLEAR_PAD, { indices: loaded })
    });
    detail.replaceChildren(
      h('div', { className: 'pad-title pad-title-group' }, h('strong', { textContent: `${indices.length} pads` }), chips),
      modes,
      options,
      h('p', { className: 'hint pad-group-hint', textContent: 'Changes here apply to every selected pad. Ctrl+click a pad to add or remove it, or click one pad to go back to it alone.' }),
      h('div', { className: 'pad-tools' }, clear)
    );
  }

  function openEditor(index) {
    detail.hidden = true;
    editor.open(index);
    editor.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function updateDetail(state) {
    const pads = selectedPads().map((i) => state.pads[i]);
    const loaded = pads.filter((p) => p.clip);
    const mode = shared(pads, (p) => p.mode);
    for (const btn of detail.querySelectorAll('[data-mode]')) btn.setAttribute('aria-checked', String(btn.dataset.mode === mode));
    const follow = detail.querySelector('.pad-options input[type="checkbox"]');
    if (follow) {
      const timed = pads.filter((p) => p.clip?.bpm);
      const synced = timed.filter((p) => p.sync).length;
      follow.checked = timed.length > 0 && synced === timed.length;
      follow.indeterminate = synced > 0 && synced < timed.length;
    }
    const tempo = detail.querySelector('[data-role="pad-bpm"]');
    if (tempo && document.activeElement !== tempo) {
      const bpm = loaded.length ? shared(loaded, (p) => p.clip.bpm) : null;
      tempo.value = bpm ?? '';
      tempo.placeholder = bpm === undefined ? 'Mixed' : '—';
    }
    const choke = detail.querySelector('[data-role="pad-choke"]');
    if (choke && document.activeElement !== choke) choke.value = String(shared(pads, (p) => p.choke) ?? '');
    const primary = state.pads[selectedPad];
    const length = detail.querySelector('[data-role="pad-length"]');
    if (length && primary.clip) length.textContent = seconds(primary.clip.end - primary.clip.start);
    const level = detail.querySelector('[data-role="pad-level"]');
    if (level && document.activeElement !== level) {
      level.value = primary.level;
      setFill(level, primary.level / SOURCE_LEVEL_MAX);
    }
  }

  function updateRec(state) {
    const rec = state.recording;
    const target = recTarget(state);
    recButton.classList.toggle('armed', Boolean(rec) && (transport?.rec?.armed ?? true));
    recButton.classList.toggle('recording', Boolean(rec) && transport?.rec?.armed === false);
    recButton.disabled = !rec && target < 0;
    recSelect.disabled = Boolean(rec);
    let label;
    let progress = 0;
    if (!rec) label = target < 0 ? 'Pads full' : `Rec to pad ${padLabel(target)}`;
    else if (transport?.rec?.armed !== false) label = rec.stopping ? 'Stopping…' : 'Waiting for the bar';
    else {
      const { elapsed, total } = transport.rec;
      label = rec.stopping ? 'Finishing bar…' : `Stop  ${seconds(elapsed)}`;
      progress = total ? elapsed / total : 0;
    }
    recLabel.textContent = label;
    recFill.style.width = `${Math.min(1, progress) * 100}%`;
  }

  function update(state) {
    for (const busId of BUS_IDS) {
      const bus = state.buses[busId];
      const { btn, effectName } = fxButtons[busId];
      const lit = busLit(bus);
      btn.classList.toggle('lit', lit);
      btn.classList.toggle('empty', bus.slots.length === 0);
      btn.classList.toggle('selected', busId === selected);
      btn.setAttribute('aria-pressed', String(lit));
      const first = bus.slots[0] ? getEffect(bus.slots[0].effect).name : 'Empty';
      effectName.textContent = bus.slots.length > 1 ? `${first} +${bus.slots.length - 1}` : first;
    }

    const slot = focusedSlot(state, selected);
    ctrlPlate.classList.toggle('lit', busLit(state.buses[selected]));
    if (slot) for (const { knob, param } of knobs) knob.setValue(slot.params[param.id]);

    const rec = state.recording;
    const target = rec ? rec.pad : recTarget(state);
    bank.dataset.route = ROUTE_COLOR[state.padRoute];
    bank.classList.toggle('multi', selection.size > 1);
    bankButtons.forEach((btn, i) => {
      btn.setAttribute('aria-checked', String(i === bankIndex));
      btn.classList.toggle('busy', state.pads.some((p, n) => p.playing && Math.floor(n / PADS_PER_BANK) === i));
    });
    padEls.forEach((p, slotIndex) => {
      const i = bankIndex * PADS_PER_BANK + slotIndex;
      const pad = state.pads[i];
      p.num.textContent = padLabel(i);
      const peaksKey = pad.clip ? `${pad.clip.peaks.join()}|${pad.clip.rms?.join()}` : '';
      if (peaksKey !== p.peaksKey) {
        p.peaksKey = peaksKey;
        p.peakPath.setAttribute('d', pad.clip ? wavePath(pad.clip.peaks) : '');
        p.path.setAttribute('d', pad.clip?.rms ? wavePath(pad.clip.rms) : '');
      }
      p.name.textContent = pad.clip ? pad.clip.name : '';
      p.group.textContent = pad.choke ? `G${pad.choke}` : '';
      p.el.classList.toggle('loaded', Boolean(pad.clip));
      p.el.classList.toggle('playing', pad.playing);
      p.el.classList.toggle('selected', selection.has(i));
      p.el.classList.toggle('rec-target', i === target && !rec);
      p.el.classList.toggle('recording', Boolean(rec) && rec.pad === i);
      p.el.classList.toggle('editing', editor.editing() === i);
      p.el.setAttribute('aria-label', `Pad ${padLabel(i)}, ${pad.clip ? `${pad.clip.name}, ${pad.mode}${pad.choke ? `, choke group ${pad.choke}` : ''}${pad.playing ? ', playing' : ''}` : 'empty'}. Key ${KEY_LABELS[`pad${slotIndex}`]}.`);
    });
    stopAll.disabled = !state.pads.some((p) => p.playing);
    const route = padRoute.querySelector('select');
    if (route) route.value = state.padRoute;
    updateRec(state);
    updateDetail(state);
    editor.update(state);
    markDrag();
  }

  function sync(state, force = false) {
    if (!state) return;
    const slot = focusedSlot(state, selected);
    const nextCtrl = JSON.stringify([selected, slot?.uid, slot?.effect, state.buses[selected].slots.map((s) => [s.uid, s.effect, s.enabled])]);
    if (force || nextCtrl !== ctrlKey) {
      ctrlKey = nextCtrl;
      renderCtrl(state);
    }
    const nextDetail = JSON.stringify([selectedPad, selectedPads().map((i) => [i, state.pads[i].clip?.name, state.pads[i].clip?.duration, Boolean(state.pads[i].clip?.bpm)])]);
    if (nextDetail !== detailKey) {
      detailKey = nextDetail;
      renderDetail(state);
    }
    if (!padRoute.firstChild) {
      const route = routeSelect(state.padRoute, (value) => {
        route.blur();
        send(MSG.SET_PAD_ROUTE, { route: value });
      }, 'Pads play into');
      padRoute.append(route);
    }
    update(state);
  }

  function meter(next) {
    transport = next;
    const state = getState();
    if (state) updateRec(state);
    editor.followPad(next?.pads?.[editor.editing()] ?? null);
    const beat = next ? Math.floor(next.beat) : null;
    if (beat !== lastBeat) {
      lastBeat = beat;
      if (beat !== null) {
        bank.classList.remove('tick');
        void bank.offsetWidth;
        bank.classList.add('tick');
      }
    }
  }

  function ctrlTarget(busId, index) {
    const state = getState();
    const slot = state && focusedSlot(state, busId);
    const param = slot && ctrlParams(slot.effect)[index];
    return param ? { slot, param } : null;
  }

  root.append(ctrlPlate, fxRow, bank, dragGhost, transferDialog);

  return {
    sync,
    meter,
    pressBus,
    releaseBus,
    pressPad,
    releasePad,
    toggleRecord,
    ctrlTarget,
    padAt: (slot) => bankIndex * PADS_PER_BANK + slot,
    nextBank: () => setBank(bankIndex + 1),
    chop: () => editor.chopAtPlayhead(),
    stopPads,
    selectedBus: () => selected,
    describeSelected(state) {
      const slot = focusedSlot(state, selected);
      return { bus: BUS_LABELS[selected], effect: slot ? getEffect(slot.effect).name : 'No effect' };
    }
  };
}
