import { LEGACY_PADS_PER_BANK, PADS_PER_BANK, migratePadIndex } from '../shared/state.js';

const STORAGE_KEY = 'midiMap';
const LAYOUT_KEY = 'midiPadsPerBank';
const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;
const CONTROL_CHANGE = 0xb0;
const BUTTON_THRESHOLD = 64;

export function isButton(target) {
  return target?.kind === 'bus' || target?.kind === 'pad';
}

export function describe(target) {
  if (target.kind === 'bus') return target.busId;
  if (target.kind === 'pad') return `pad ${target.index + 1}`;
  if (target.kind === 'ctrl') return `${target.busId} CTRL ${target.index + 1}`;
  return `${target.busId} ${target.paramId}`;
}

export function migrateMidiMap(map, fromPerBank) {
  return Object.fromEntries(
    Object.entries(map).flatMap(([key, target]) => {
      if (target?.kind !== 'pad') return [[key, target]];
      const index = migratePadIndex(target.index, fromPerBank);
      return index < 0 ? [] : [[key, { ...target, index }]];
    })
  );
}

export class MidiLearn {
  constructor({ onControl, onButton = () => {}, onStatus }) {
    this.onControl = onControl;
    this.onButton = onButton;
    this.onStatus = onStatus;
    this.access = null;
    this.map = {};
    this.learning = false;
    this.target = null;
    this.down = new Set();
  }

  async start() {
    if (this.access) return true;
    if (!navigator.requestMIDIAccess) {
      this.onStatus('Web MIDI is not available in this browser.');
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess();
    } catch (err) {
      this.onStatus(`MIDI unavailable: ${err.message}`);
      return false;
    }
    const stored = await browser.storage.local.get([STORAGE_KEY, LAYOUT_KEY]);
    this.map = stored[STORAGE_KEY] ?? {};
    const layout = stored[LAYOUT_KEY] ?? LEGACY_PADS_PER_BANK;
    if (layout !== PADS_PER_BANK) {
      this.map = migrateMidiMap(this.map, layout);
      browser.storage.local.set({ [STORAGE_KEY]: this.map, [LAYOUT_KEY]: PADS_PER_BANK });
    }
    const attach = () => {
      for (const input of this.access.inputs.values()) input.onmidimessage = (e) => this.handle(e.data);
    };
    attach();
    this.access.onstatechange = attach;
    return true;
  }

  async toggleLearn() {
    if (!(await this.start())) return false;
    this.learning = !this.learning;
    this.target = null;
    return this.learning;
  }

  arm(target) {
    if (this.learning) this.target = target;
  }

  learn(key, label) {
    this.map[key] = this.target;
    browser.storage.local.set({ [STORAGE_KEY]: this.map, [LAYOUT_KEY]: PADS_PER_BANK });
    this.onStatus(`${label} → ${describe(this.target)}`, 'info');
    this.target = null;
  }

  handle([status, data1, data2 = 0]) {
    const type = status & 0xf0;
    const channel = status & 0x0f;
    if (type === NOTE_ON || type === NOTE_OFF) {
      const key = `n${channel}:${data1}`;
      const pressed = type === NOTE_ON && data2 > 0;
      if (this.learning && this.target) {
        if (pressed && isButton(this.target)) this.learn(key, `Note ${data1} (ch ${channel + 1})`);
        return;
      }
      const target = this.map[key];
      if (isButton(target)) this.button(key, target, pressed);
      return;
    }
    if (type !== CONTROL_CHANGE) return;
    const key = `${channel}:${data1}`;
    if (this.learning && this.target) {
      if (!isButton(this.target) || data2 >= BUTTON_THRESHOLD) this.learn(key, `CC ${data1} (ch ${channel + 1})`);
      return;
    }
    const target = this.map[key];
    if (!target) return;
    if (isButton(target)) this.button(key, target, data2 >= BUTTON_THRESHOLD);
    else this.onControl(target.kind ? target : { kind: 'param', ...target }, data2 / 127);
  }

  button(key, target, pressed) {
    if (pressed === this.down.has(key)) return;
    if (pressed) this.down.add(key);
    else this.down.delete(key);
    this.onButton(target, pressed);
  }
}
